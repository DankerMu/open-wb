/**
 * 知识库模型设置（s2a-kb-ragflow D7、D20，s2b-kb-retrieval D6；ragflow-backend「知识库模型设置」「嵌入模型更换与全量重建」）：
 * 读视图、body 校验、`chatModelId` 取值规则、下发到 RAGFlow 服务账号的固定序列、嵌入身份判定与探活写回。
 *
 * 校验分两段：body 的形状在取锁之前；要读库的（`chatModelId` 的存在与上游、嵌入与重排「首次配置要带密钥」、取值规则、身份判定）
 * 在设置锁内，读到的是锁内的 `models` 行与知识库行。锁内的次序：400、`kb_chat_model_locked`、`kb_rebuilding`、
 * `kb_rebuild_required`，都先于任何下发。
 *
 * 下发是固定序列（`provision`）：`PUT /providers` → `GET /models` → 实例不存在就 `POST`，存在就读它的模型列表再 `PUT` →
 * `PATCH /models/default`。先下发、后写库：下发失败本地不变，重试同一次保存即收敛（序列幂等）。
 *
 * 重排模型（D6）：`owb-rerank` 一轮排在嵌入、对话两轮之前，没有 `PATCH /models/default`（不设账号缺省），失败即停，后面各轮
 * 不发。`rerank:null` 只把本地三列置空。重排不是嵌入身份的一部分，换它不重建。只含 `rerank` 的保存不重发对话模型。
 *
 * 账号缺省不变量（D7，实测记录 §13）：这里只有设，没有清。取消指定与 `model_info` 里消失的模型都不存在于这条路径上：
 * 取消指定与清除重排模型只改本地，`model_info` 只增不减，`api_key` 恒为实际密钥（RAGFlow 按 trim 后的值写入，空值会清空实例密钥，§11.4）。
 *
 * 密钥只走两条路：出站请求与 `store.saveSettings`。读视图、审计 detail 与错误都不带它。
 *
 * 确认重建（组 14，#1852）：身份变化且已有知识库时，带 `confirmRebuild:true` 照常下发并保存，同一事务里代数加一、全部知识库置
 * `rebuilding`、`rebuild_actor_id` 记为本次的 principal，并审计 `kb.settings` 与 `kb.rebuild {bases, documents}` 两条；提交之后唤醒
 * 重建器（`kb/rebuild.ts`）。重试（`POST /api/kb/settings/rebuild`）同在设置锁内：全部 `rebuild_failed` 置回 `rebuilding`、改写
 * 发起者、审计 `{bases, documents, retry:true}`、唤醒；没有失败库时不写库、不审计、不唤醒。
 *
 * 探活逐次串行：一条进程级 Promise 链，「读身份 → 发请求 → 取锁写回」整段排队。它不并进设置锁，探活不能占锁 15 s。
 * 两种目标（D7）排在同一条链上，按 `PROBES` 的一行取身份、未配置的错误码、写回与审计：嵌入未配置 `kb_not_ready`，
 * 重排未配置 400 `bad_request`，都在轮到时判。
 *
 * `models` 写入钩子（`guardModelWrite`，D1、D7）：`plan`、引用判定、重新下发与 `models` 的那次写入整段在设置锁内，所以不会
 * 与一次保存交错：判定读到的是别的写者落库之后的 `chat_model_id`，保存读到的是写入之后的行。没有被引用的行不碰 RAGFlow；
 * 钩子不写 `kb_settings`，也不审计 `kb.settings`，审计是 `models` 的 `model.update`。
 */
import { validateUpstreamBaseUrl, validateUpstreamKey } from "../agent-config.js";
import { HttpError } from "../core/errors/index.js";
import type { createModelStore, ModelUpdatePlan } from "../models/store.js";
import type { createKbLocks } from "./locks.js";
import { type ModelProbeDeadlines, probeModel } from "./model-probe.js";
import {
  type createRagflowClient,
  isBlankApiKey,
  isRecord,
  type ModelInfo,
  PROVIDER,
} from "./ragflow-client.js";
import type { createKbStore } from "./store.js";

const EMBEDDING_INSTANCE = "owb-embed";
const CHAT_INSTANCE = "owb-chat";
const RERANK_INSTANCE = "owb-rerank";
/** 嵌入与重排模型的 `max_tokens`，实测值（§11.1、§19.3）。 */
const MODEL_MAX_TOKENS = 8192;
const MAX_NAME_BYTES = 128;
const BODY_KEYS = new Set(["embedding", "chatModelId", "rerank", "confirmRebuild"]);
const MODEL_KEYS = new Set(["name", "baseUrl", "apiKey"]);
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
  rerank?: string | null;
}

type ProbeStatus = "ok" | "failed";

interface AuditEvent {
  kind: "kb.settings" | "kb.rebuild";
  actorId: string;
  title: string;
  detail: SaveDetail | { probe: ProbeStatus } | { rerankProbe: ProbeStatus } | RebuildDetail;
}

/** `kb.rebuild` 的确认与重试两支（knowledge-bases「知识库审计」）。 */
interface RebuildDetail {
  bases: number;
  documents: number;
  retry?: true;
}

type KbSettingsRead = ReturnType<ReturnType<typeof createKbStore>["settings"]>;

interface KbSettingsDependencies {
  store: Pick<
    ReturnType<typeof createKbStore>,
    | "settings"
    | "embeddingApiKey"
    | "rerankApiKey"
    | "saveSettings"
    | "recordEmbeddingProbe"
    | "recordRerankProbe"
    | "countBases"
    | "countCompileBases"
    | "countBasesInState"
    | "countAllDocuments"
    | "countDocuments"
    | "retryFailedRebuilds"
  >;
  models: Pick<ReturnType<typeof createModelStore>, "get" | "routeOf">;
  client: Client;
  locks: Pick<ReturnType<typeof createKbLocks>, "settings">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
  probeDeadlines?: ModelProbeDeadlines | undefined;
  /** 唤醒重建器：确认重建与重试的事务提交之后调用。 */
  onRebuild: () => void;
}

/** 嵌入或重排模型的 body 一项：两者同一规则（D6）。 */
interface ModelInput {
  name: string;
  baseUrl: string;
  /** 省略即保留已存的密钥。 */
  apiKey: string | undefined;
}

/** 通过了形状校验的 body。`undefined` 即没有这个键。 */
interface SaveRequest {
  embedding: ModelInput | undefined;
  chatModelId: string | null | undefined;
  rerank: ModelInput | null | undefined;
  confirmRebuild: boolean;
}

/** 一个实例的一轮下发。 */
interface Provision {
  instanceName: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  /** `rerank` 不设账号缺省（D6）。 */
  modelType: "embedding" | "chat" | "rerank";
  maxTokens: number;
}

interface ModelConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 这次要写的三列；`changed`：名称、地址或密钥与已存的不同。 */
interface ModelPlan {
  config: ModelConfig;
  changed: boolean;
}

interface SavePlan {
  /** 按序下发：先重排，再嵌入，后对话。 */
  provisions: Provision[];
  patch: { embedding?: ModelConfig; chatModelId?: string | null; rerank?: ModelConfig | null };
  detail: SaveDetail;
  /** 确认了的身份变化：这次保存同时发起重建。 */
  rebuild: boolean;
}

/** 探活的一种目标（D7）：身份取 `settings()[target]` 加 `apiKey`，未配置时的错误码，写回方法，审计的 title 与 detail。 */
interface ProbeSpec {
  apiKey: "embeddingApiKey" | "rerankApiKey";
  missing: "kb_not_ready" | "bad_request";
  record: "recordEmbeddingProbe" | "recordRerankProbe";
  title: string;
  detail(status: ProbeStatus): { probe: ProbeStatus } | { rerankProbe: ProbeStatus };
}

const PROBES: Record<"embedding" | "rerank", ProbeSpec> = {
  embedding: {
    apiKey: "embeddingApiKey",
    missing: "kb_not_ready",
    record: "recordEmbeddingProbe",
    title: "探活知识库嵌入模型",
    detail: (status) => ({ probe: status }),
  },
  rerank: {
    apiKey: "rerankApiKey",
    missing: "bad_request",
    record: "recordRerankProbe",
    title: "探活知识库重排模型",
    detail: (status) => ({ rerankProbe: status }),
  },
};

function badRequest(): never {
  throw new HttpError("bad_request");
}

function isModelName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !NOT_A_MODEL_NAME.test(value);
}

/** `embedding` 与 `rerank` 共用。 */
function parseModel(value: unknown): ModelInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !MODEL_KEYS.has(key))) {
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
  const { embedding, chatModelId, rerank, confirmRebuild } = body;
  if (embedding === undefined && chatModelId === undefined && rerank === undefined) {
    badRequest();
  }
  if (confirmRebuild !== undefined && confirmRebuild !== true) {
    badRequest();
  }
  if (chatModelId !== undefined && chatModelId !== null && !isModelName(chatModelId)) {
    badRequest();
  }
  return {
    embedding: embedding === undefined ? undefined : parseModel(embedding),
    chatModelId,
    rerank: rerank === undefined || rerank === null ? rerank : parseModel(rerank),
    confirmRebuild: confirmRebuild === true,
  };
}

/** RAGFlow 调用的结果：成功取值，失败抛 `kb_unavailable` / `kb_rejected`，只有 `kind`，不带 RAGFlow 的原文。 */
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
  if (modelType !== "rerank") {
    unwrap(await client.setDefaultModel({ instanceName, modelName, modelType }));
  }
}

/** 数据集引用嵌入模型的三段式（§4.4）：恒显式传，不传时回落到账号缺省甚至空值。 */
export function embeddingModelOf(name: string): string {
  return `${name}@${EMBEDDING_INSTANCE}@${PROVIDER}`;
}

/** 检索带重排时 `rerank_id` 的三段式（§19.3、D2）：实例 `owb-rerank`。 */
export function rerankModelOf(name: string): string {
  return `${name}@${RERANK_INSTANCE}@${PROVIDER}`;
}

/** 身份是 `(name, baseUrl)`，只改密钥不算（D7）。 */
function isNewIdentity(input: ModelInput, current: KbSettingsRead["embedding"]): boolean {
  return input.name !== current?.name || input.baseUrl !== current?.baseUrl;
}

/** 嵌入或重排模型的一轮：实例名是常量，`max_tokens` 是实测值。 */
function modelProvision(
  modelType: "embedding" | "rerank",
  { name, baseUrl, apiKey }: ModelConfig,
): Provision {
  return {
    instanceName: modelType === "embedding" ? EMBEDDING_INSTANCE : RERANK_INSTANCE,
    apiKey,
    baseUrl,
    modelName: name,
    modelType,
    maxTokens: MODEL_MAX_TOKENS,
  };
}

function chatTarget(
  id: string,
  upstream: { apiKey: string; baseUrl: string },
  maxTokens: number,
): Provision {
  return {
    instanceName: CHAT_INSTANCE,
    apiKey: upstream.apiKey,
    baseUrl: upstream.baseUrl,
    modelName: id,
    modelType: "chat",
    maxTokens,
  };
}

/** `null` 到 `null` 与没有这个键一样：不写、不审计。 */
function isUnchanged(requested: unknown, current: unknown): boolean {
  return requested === undefined || (requested === null && current === null);
}

/** 重排一项的写与审计：变化即名称，由非 `null` 清为 `null` 即 `null`，其余不出现（knowledge-bases「知识库审计」）。 */
function rerankWrites(
  next: ModelPlan | null | undefined,
  current: KbSettingsRead["rerank"],
  { patch, detail }: Pick<SavePlan, "patch" | "detail">,
): void {
  if (next === undefined || (next === null && current === null)) {
    return;
  }
  patch.rerank = next?.config ?? null;
  if (next === null || next.changed) {
    detail.rerank = next?.config.name ?? null;
  }
}

/** 写什么与审计什么：写入按 body，detail 只含实际变化的键。 */
function writesOf(
  next: { embedding: ModelPlan | undefined; rerank: ModelPlan | null | undefined },
  chatModelId: string | null | undefined,
  current: KbSettingsRead,
): Pick<SavePlan, "patch" | "detail"> {
  const writes: Pick<SavePlan, "patch" | "detail"> = { patch: {}, detail: {} };
  const { patch, detail } = writes;
  if (next.embedding !== undefined) {
    patch.embedding = next.embedding.config;
    if (next.embedding.changed) {
      detail.embedding = next.embedding.config.name;
    }
  }
  if (chatModelId !== undefined) {
    patch.chatModelId = chatModelId;
    if (chatModelId !== current.chatModelId) {
      detail.chatModelId = chatModelId;
    }
  }
  rerankWrites(next.rerank, current.rerank, writes);
  return writes;
}

/**
 * 这次要下发的对话模型：body 给了 `chatModelId` 就用它；只给了 `embedding` 时重发已存的值；只含 `rerank` 时不发（D6）。
 */
function chatToSend(request: SaveRequest, current: string | null): string | null {
  if (request.chatModelId !== undefined) {
    return request.chatModelId;
  }
  return request.embedding === undefined ? null : current;
}

export function createKbSettings(dependencies: KbSettingsDependencies) {
  const { store, models, client, locks, audit, probeDeadlines, onRebuild } = dependencies;
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
    const { embedding, probe, chatModelId, rerank, rerankProbe } = store.settings();
    return {
      embedding: embedding === null ? null : { ...embedding, probe },
      chatModelId,
      rerank: rerank === null ? null : { ...rerank, probe: rerankProbe },
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
    return chatTarget(id, upstream, row.maxTokens);
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

  /** 身份变化且已有知识库：重建中 409，未确认 409，确认了即这次保存发起重建（`true`）。 */
  function checkIdentity(
    input: ModelInput,
    current: KbSettingsRead["embedding"],
    confirmed: boolean,
  ): boolean {
    if (!isNewIdentity(input, current) || store.countBases() === 0) {
      return false;
    }
    if (store.countBasesInState("rebuilding") > 0) {
      throw new HttpError("kb_rebuilding");
    }
    if (!confirmed) {
      throw new HttpError("kb_rebuild_required");
    }
    return true;
  }

  /** 嵌入与重排共用：省略 `apiKey` 取已存的值，首次配置没有可取即 400。 */
  function modelPlan(
    input: ModelInput,
    current: KbSettingsRead["embedding"],
    storedKey: string | null,
  ): ModelPlan {
    const apiKey = input.apiKey ?? storedKey;
    if (apiKey === null) {
      badRequest();
    }
    const { name, baseUrl } = input;
    const changed = isNewIdentity(input, current) || apiKey !== storedKey;
    return { config: { name, baseUrl, apiKey }, changed };
  }

  /**
   * 锁内定下这次保存：要下发什么、写什么、审计什么。没有实际写入时为 `undefined`：没有 `embedding`，`chatModelId` 与
   * `rerank` 各自缺省或由 `null` 到 `null`。两种「首次要带密钥」的 400 先于 `kb_chat_model_locked`。
   */
  function planSave(request: SaveRequest): SavePlan | undefined {
    const { embedding, chatModelId, rerank, confirmRebuild } = request;
    const current = store.settings();
    const next = {
      rerank: rerank && modelPlan(rerank, current.rerank, store.rerankApiKey()),
      embedding: embedding && modelPlan(embedding, current.embedding, store.embeddingApiKey()),
    };
    checkChatModel(chatModelId, current.chatModelId);
    const rebuild =
      embedding !== undefined && checkIdentity(embedding, current.embedding, confirmRebuild);
    if (
      embedding === undefined &&
      isUnchanged(chatModelId, current.chatModelId) &&
      isUnchanged(rerank, current.rerank)
    ) {
      return undefined;
    }
    const provisions = [
      next.rerank && modelProvision("rerank", next.rerank.config),
      next.embedding && modelProvision("embedding", next.embedding.config),
      chatProvision(chatToSend(request, current.chatModelId)),
    ];
    return {
      provisions: provisions.flatMap((target) => target ?? []),
      ...writesOf(next, chatModelId, current),
      rebuild,
    };
  }

  async function probeOnce(actorId: string, target: keyof typeof PROBES) {
    const spec = PROBES[target];
    const model = store.settings()[target];
    const apiKey = store[spec.apiKey]();
    if (model === null || apiKey === null) {
      throw new HttpError(spec.missing);
    }
    const identity = { ...model, apiKey };
    const result = await probeModel(target, identity, probeDeadlines);
    return locks.settings(async () => {
      store[spec.record](identity, { ...result, at: Date.now() }, () => {
        audit({
          kind: "kb.settings",
          actorId,
          title: spec.title,
          detail: spec.detail(result.status),
        });
      });
      return view();
    });
  }

  /** 确认重建的那条：在 `saveSettings` 的事务里，已全部置 `rebuilding`，两个数就是受影响的库与文档。 */
  function auditConfirmedRebuild(actorId: string): void {
    audit({
      kind: "kb.rebuild",
      actorId,
      title: "确认重建知识库",
      detail: { bases: store.countBases(), documents: store.countAllDocuments() },
    });
  }

  async function saveLocked(request: SaveRequest, actorId: string) {
    const plan = planSave(request);
    if (plan !== undefined) {
      for (const target of plan.provisions) {
        await provision(client, target);
      }
      const patch = plan.rebuild ? { ...plan.patch, rebuildActorId: actorId } : plan.patch;
      store.saveSettings(patch, () => {
        audit({
          kind: "kb.settings",
          actorId,
          title: "保存知识库模型设置",
          detail: plan.detail,
        });
        if (plan.rebuild) {
          auditConfirmedRebuild(actorId);
        }
      });
      if (plan.rebuild) {
        onRebuild();
      }
    }
    return view();
  }

  /** 重试：在设置锁内，见文件头。 */
  async function retryLocked(actorId: string) {
    const retried = store.retryFailedRebuilds(actorId, (bases) => {
      const documents = bases.reduce((sum, { id }) => sum + store.countDocuments(id), 0);
      audit({
        kind: "kb.rebuild",
        actorId,
        title: "重试重建知识库",
        detail: { bases: bases.length, documents, retry: true },
      });
    });
    if (retried.length > 0) {
      onRebuild();
    }
    return view();
  }

  /**
   * 被引用的那一行落库之前：删除与清空上游 409，上游变化时按候选上游重新下发。纯空白密钥在这里拦，不在 `models` 的校验里：
   * 知识库关闭与没有被引用的行不下发，不受这条约束。
   */
  async function syncChatModel(id: string, planned: ModelUpdatePlan | undefined): Promise<void> {
    if (planned === undefined || planned.next === null) {
      throw new HttpError("kb_model_in_use");
    }
    if (planned.changed) {
      if (isBlankApiKey(planned.next.apiKey)) {
        badRequest();
      }
      await provision(client, chatTarget(id, planned.next, planned.model.maxTokens));
    }
  }

  return {
    view,

    /** `models` 的 `DELETE` / `PUT` 经这里写入：`plan` 排第一，所以非法 body 400，不发 RAGFlow 请求。 */
    guardModelWrite<T>(id: string, write: () => T, plan?: () => ModelUpdatePlan): Promise<T> {
      return locks.settings(async (): Promise<T> => {
        const planned = plan?.();
        if (store.settings().chatModelId === id) {
          await syncChatModel(id, planned);
        }
        return write();
      });
    },

    /** `PUT /api/kb/settings`。 */
    save(body: unknown, actorId: string) {
      const request = parseSave(body);
      return locks.settings(() => saveLocked(request, actorId));
    },

    /** `POST /api/kb/settings/rebuild`：在设置锁内重试全部失败的重建（D8、D20）。 */
    retry(actorId: string) {
      return locks.settings(() => retryLocked(actorId));
    },

    /**
     * `POST /api/kb/settings/probe?target=`：两种目标逐次串行，身份在排到时读取；请求在锁外，写回在锁内，身份已变时丢弃，
     * 不审计（D7、D20）。`target` 由 `rest.ts` 解析。
     */
    probe(actorId: string, target: keyof typeof PROBES) {
      return inProbeOrder(() => probeOnce(actorId, target));
    },
  };
}
