/**
 * 知识库模型设置（s2a-kb-ragflow D7、D20；ragflow-backend「知识库模型设置」「嵌入模型更换与全量重建」）：读视图、body 校验、
 * `chatModelId` 取值规则、下发到 RAGFlow 服务账号的固定序列、嵌入身份判定与探活写回。
 *
 * 校验分两段：body 的形状在取锁之前；要读库的（`chatModelId` 的存在与上游、「首次配置要带密钥」、取值规则、身份判定）
 * 在设置锁内，读到的是锁内的 `models` 行与知识库行。锁内的次序：400、`kb_chat_model_locked`、`kb_rebuilding`、
 * `kb_rebuild_required`，都先于任何下发。
 *
 * 下发是固定序列（`provision`）：`PUT /providers` → `GET /models` → 实例不存在就 `POST`，存在就读它的模型列表再 `PUT` →
 * `PATCH /models/default`。先下发、后写库：下发失败本地不变，重试同一次保存即收敛（序列幂等）。
 *
 * 账号缺省不变量（D7，实测记录 §13）：这里只有设，没有清。取消指定与 `model_info` 里消失的模型都不存在于这条路径上：
 * 取消指定只改本地，`model_info` 只增不减，`api_key` 恒为实际密钥（RAGFlow 按 trim 后的值写入，空值会清空实例密钥，§11.4）。
 *
 * 密钥只走两条路：出站请求与 `store.saveSettings`。读视图、审计 detail 与错误都不带它。
 *
 * `confirmRebuild` 本组只校验类型：确认重建由组 14 开放，这之前身份变化且已有知识库一律 409 `kb_rebuild_required`。
 *
 * 探活逐次串行：一条进程级 Promise 链，「读身份 → 发请求 → 取锁写回」整段排队。它不并进设置锁，探活不能占锁 15 s。
 */
import { validateUpstreamBaseUrl, validateUpstreamKey } from "../agent-config.js";
import { HttpError } from "../core/errors/index.js";
import type { createModelStore } from "../models/store.js";
import { type EmbeddingProbeDeadlines, probeEmbedding } from "./embedding-probe.js";
import type { createKbLocks } from "./locks.js";
import {
  type createRagflowClient,
  isBlankApiKey,
  isRecord,
  type ModelInfo,
} from "./ragflow-client.js";
import type { createKbStore } from "./store.js";

const EMBEDDING_INSTANCE = "owb-embed";
const CHAT_INSTANCE = "owb-chat";
/** 实测值（§11.1）。 */
const EMBEDDING_MAX_TOKENS = 8192;
const MAX_NAME_BYTES = 128;
const BODY_KEYS = new Set(["embedding", "chatModelId", "confirmRebuild"]);
const EMBEDDING_KEYS = new Set(["name", "baseUrl", "apiKey"]);
/** `name` 与 `chatModelId` 要拼成 `<name>@<实例>@<提供方>`（D7），所以两者都不能含 `@`。 */
const NOT_A_MODEL_NAME = /[\p{Cc}@]/u;

type Client = Pick<
  ReturnType<typeof createRagflowClient>,
  | "ensureProvider"
  | "listModelInstances"
  | "listInstanceModels"
  | "createModelInstance"
  | "updateModelInstance"
  | "setDefaultModel"
>;

/** `kb.settings` 保存一支的 detail：只含实际变化的键，可以为空（knowledge-bases「知识库审计」）。 */
interface SaveDetail {
  embedding?: string;
  chatModelId?: string | null;
}

interface AuditEvent {
  kind: "kb.settings";
  actorId: string;
  title: string;
  detail: SaveDetail | { probe: "ok" | "failed" };
}

type KbSettingsRead = ReturnType<ReturnType<typeof createKbStore>["settings"]>;

interface KbSettingsDependencies {
  store: Pick<
    ReturnType<typeof createKbStore>,
    | "settings"
    | "embeddingApiKey"
    | "saveSettings"
    | "recordEmbeddingProbe"
    | "countBases"
    | "countCompileBases"
    | "countBasesInState"
    | "countAllDocuments"
  >;
  models: Pick<ReturnType<typeof createModelStore>, "get" | "routeOf">;
  client: Client;
  locks: Pick<ReturnType<typeof createKbLocks>, "settings">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
  probeDeadlines?: EmbeddingProbeDeadlines | undefined;
}

interface EmbeddingInput {
  name: string;
  baseUrl: string;
  /** 省略即保留已存的密钥。 */
  apiKey: string | undefined;
}

/** 通过了形状校验的 body。`undefined` 即没有这个键。 */
interface SaveRequest {
  embedding: EmbeddingInput | undefined;
  chatModelId: string | null | undefined;
}

/** 一个实例的一轮下发。 */
interface Provision {
  instanceName: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  modelType: "embedding" | "chat";
  maxTokens: number;
}

interface EmbeddingConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 这次要写的三列；`changed`：名称、地址或密钥与已存的不同。 */
interface EmbeddingPlan {
  config: EmbeddingConfig;
  changed: boolean;
}

interface SavePlan {
  /** 按序下发：先嵌入，后对话。 */
  provisions: Provision[];
  patch: { embedding?: EmbeddingConfig; chatModelId?: string | null };
  detail: SaveDetail;
}

function badRequest(): never {
  throw new HttpError("bad_request");
}

function isModelName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !NOT_A_MODEL_NAME.test(value);
}

function parseEmbedding(value: unknown): EmbeddingInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !EMBEDDING_KEYS.has(key))) {
    badRequest();
  }
  const { name, baseUrl, apiKey } = value;
  if (
    !isModelName(name) ||
    Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES ||
    typeof baseUrl !== "string" ||
    !validateUpstreamBaseUrl(baseUrl)
  ) {
    badRequest();
  }
  if (
    apiKey !== undefined &&
    (typeof apiKey !== "string" || !validateUpstreamKey(apiKey) || isBlankApiKey(apiKey))
  ) {
    badRequest();
  }
  return { name, baseUrl, apiKey };
}

function parseSave(body: unknown): SaveRequest {
  if (!isRecord(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    badRequest();
  }
  const { embedding, chatModelId, confirmRebuild } = body;
  if (embedding === undefined && chatModelId === undefined) {
    badRequest();
  }
  if (confirmRebuild !== undefined && confirmRebuild !== true) {
    badRequest();
  }
  if (chatModelId !== undefined && chatModelId !== null && !isModelName(chatModelId)) {
    badRequest();
  }
  return {
    embedding: embedding === undefined ? undefined : parseEmbedding(embedding),
    chatModelId,
  };
}

/** 下发的结果：成功取值，失败抛 `kb_unavailable` / `kb_rejected`，只有 `kind`，不带 RAGFlow 的原文。 */
function unwrap<T>(
  result: { kind: "ok"; value: T } | { kind: "kb_unavailable" | "kb_rejected" },
): T {
  if (result.kind !== "ok") {
    throw new HttpError(result.kind);
  }
  return result.value;
}

/** D7 的固定序列。`model_info` 为现有模型加本次的模型，同名项以本次为准。 */
async function provision(client: Client, target: Provision): Promise<void> {
  const { instanceName, apiKey, baseUrl, modelName, modelType, maxTokens } = target;
  const item: ModelInfo = {
    model_name: modelName,
    model_type: [modelType],
    max_tokens: maxTokens,
  };
  unwrap(await client.ensureProvider());
  const instances = unwrap(await client.listModelInstances());
  if (instances.includes(instanceName)) {
    const existing = unwrap(await client.listInstanceModels(instanceName));
    const kept = existing.filter((model) => model.model_name !== modelName);
    const modelInfo = [...kept, item];
    unwrap(await client.updateModelInstance({ instanceName, apiKey, baseUrl, modelInfo }));
  } else {
    const modelInfo = [item];
    unwrap(await client.createModelInstance({ instanceName, apiKey, baseUrl, modelInfo }));
  }
  unwrap(await client.setDefaultModel({ instanceName, modelName, modelType }));
}

/** 身份是 `(name, baseUrl)`，只改密钥不算（D7）。 */
function isNewIdentity(input: EmbeddingInput, current: KbSettingsRead["embedding"]): boolean {
  return input.name !== current?.name || input.baseUrl !== current?.baseUrl;
}

function embeddingProvision({ name, baseUrl, apiKey }: EmbeddingConfig): Provision {
  return {
    instanceName: EMBEDDING_INSTANCE,
    apiKey,
    baseUrl,
    modelName: name,
    modelType: "embedding",
    maxTokens: EMBEDDING_MAX_TOKENS,
  };
}

/** 写什么与审计什么：写入按 body，detail 只含实际变化的键。 */
function writesOf(
  next: EmbeddingPlan | undefined,
  chatModelId: string | null | undefined,
  currentChatModelId: string | null,
): Pick<SavePlan, "patch" | "detail"> {
  const patch: SavePlan["patch"] = {};
  const detail: SaveDetail = {};
  if (next !== undefined) {
    patch.embedding = next.config;
    if (next.changed) {
      detail.embedding = next.config.name;
    }
  }
  if (chatModelId !== undefined) {
    patch.chatModelId = chatModelId;
    if (chatModelId !== currentChatModelId) {
      detail.chatModelId = chatModelId;
    }
  }
  return { patch, detail };
}

export function createKbSettings(dependencies: KbSettingsDependencies) {
  const { store, models, client, locks, audit, probeDeadlines } = dependencies;
  /** 探活链的尾：`models/rest.ts` 的 `perIdChain` 写法，只有一个 key。前一个无论成败都轮到下一个。 */
  let probeTail: Promise<unknown> = Promise.resolve();

  function inProbeOrder<T>(work: () => Promise<T>): Promise<T> {
    const run = probeTail.then(work, work);
    probeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function view() {
    const { embedding, probe, chatModelId } = store.settings();
    return {
      embedding: embedding === null ? null : { ...embedding, probe },
      chatModelId,
      bases: store.countBases(),
      compileBases: store.countCompileBases(),
      documents: store.countAllDocuments(),
      rebuilding: store.countBasesInState("rebuilding"),
      rebuildFailed: store.countBasesInState("rebuild_failed"),
    };
  }

  /** 这一行的对话模型下发；没有指定或该行没有上游时为 `undefined`。 */
  function chatProvision(id: string | null): Provision | undefined {
    const upstream = id === null ? undefined : models.routeOf(id);
    const row = id === null ? undefined : models.get(id);
    if (id === null || upstream == null || row === undefined) {
      return undefined;
    }
    return {
      instanceName: CHAT_INSTANCE,
      apiKey: upstream.apiKey,
      baseUrl: upstream.baseUrl,
      modelName: id,
      modelType: "chat",
      maxTokens: row.maxTokens,
    };
  }

  /** `chatModelId` 的取值规则（D7 的表）：没有 `null` 到 `null` 的特判，那是下面的无操作。 */
  function checkChatModel(requested: string | null | undefined, current: string | null): void {
    if (requested === undefined) {
      return;
    }
    if (requested !== null && chatProvision(requested) === undefined) {
      badRequest();
    }
    if (current !== null && requested !== current && store.countCompileBases() > 0) {
      throw new HttpError("kb_chat_model_locked");
    }
  }

  function checkIdentity(input: EmbeddingInput, current: KbSettingsRead["embedding"]): void {
    if (!isNewIdentity(input, current) || store.countBases() === 0) {
      return;
    }
    if (store.countBasesInState("rebuilding") > 0) {
      throw new HttpError("kb_rebuilding");
    }
    throw new HttpError("kb_rebuild_required");
  }

  /** 省略 `apiKey` 取已存的值，首次配置没有可取即 400。 */
  function embeddingPlan(
    input: EmbeddingInput,
    current: KbSettingsRead["embedding"],
  ): EmbeddingPlan {
    const storedKey = store.embeddingApiKey();
    const apiKey = input.apiKey ?? storedKey;
    if (apiKey === null) {
      badRequest();
    }
    const { name, baseUrl } = input;
    const changed = isNewIdentity(input, current) || apiKey !== storedKey;
    return { config: { name, baseUrl, apiKey }, changed };
  }

  /** 锁内定下这次保存：要下发什么、写什么、审计什么。没有实际写入时为 `undefined`。 */
  function planSave({ embedding, chatModelId }: SaveRequest): SavePlan | undefined {
    const current = store.settings();
    const next = embedding && embeddingPlan(embedding, current.embedding);
    checkChatModel(chatModelId, current.chatModelId);
    if (embedding !== undefined) {
      checkIdentity(embedding, current.embedding);
    }
    if (next === undefined && chatModelId === null && current.chatModelId === null) {
      return undefined;
    }
    const chat = chatProvision(chatModelId === undefined ? current.chatModelId : chatModelId);
    const provisions = [next && embeddingProvision(next.config), chat];
    return {
      provisions: provisions.flatMap((target) => target ?? []),
      ...writesOf(next, chatModelId, current.chatModelId),
    };
  }

  async function probeOnce(actorId: string) {
    const { embedding } = store.settings();
    const apiKey = store.embeddingApiKey();
    if (embedding === null || apiKey === null) {
      throw new HttpError("kb_not_ready");
    }
    const identity = { ...embedding, apiKey };
    const result = await probeEmbedding(identity, probeDeadlines);
    return locks.settings(async () => {
      store.recordEmbeddingProbe(identity, { ...result, at: Date.now() }, () => {
        audit({
          kind: "kb.settings",
          actorId,
          title: "探活知识库嵌入模型",
          detail: { probe: result.status },
        });
      });
      return view();
    });
  }

  async function saveLocked(request: SaveRequest, actorId: string) {
    const plan = planSave(request);
    if (plan !== undefined) {
      for (const target of plan.provisions) {
        await provision(client, target);
      }
      store.saveSettings(plan.patch, () => {
        audit({
          kind: "kb.settings",
          actorId,
          title: "保存知识库模型设置",
          detail: plan.detail,
        });
      });
    }
    return view();
  }

  return {
    view,

    /** `PUT /api/kb/settings`。 */
    save(body: unknown, actorId: string) {
      const request = parseSave(body);
      return locks.settings(() => saveLocked(request, actorId));
    },

    /** `POST /api/kb/settings/probe`：逐次串行，身份在排到时读取；请求在锁外，写回在锁内，身份已变时丢弃，不审计（D20）。 */
    probe(actorId: string) {
      return inProbeOrder(() => probeOnce(actorId));
    },
  };
}
