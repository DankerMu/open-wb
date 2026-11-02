/**
 * 建库、列表与删库（s2a-kb-ragflow D2、D9、D20；knowledge-bases「知识库端点」「知识库审计」）。
 *
 * 两种库：两个开关都关的走 `parse_type:1`，没有模板组与画布；任一开关开的经 `kb/pipeline.ts` 的 `createPipeline` 建模板组、
 * 画布与 `parse_type:2` 数据集（#1869）。编译状态的读取属第三刀（#1870）：在那之前，列表里开了开关的库 `compile` 为 `null`。
 *
 * 建库：body 的键集、类型、名称与模板在取锁之前判定，不读库。其余判定在设置锁内，读到的是锁内的设置行与知识库行：
 * 嵌入就绪、开关为真而对话模型未指定、重名、数量上限，次序不变，都不发出站请求。建库全程持锁，所以不会建出代数过期的库，
 * 也不会与一次保存交错（取消指定排在前面，这里读到 `null`；排在后面，它读到开编译的库）。先建 RAGFlow 资源、后插行：插行
 * 或审计失败时按删除次序删掉这一代，删除失败写一行 leak，不改变应答。
 *
 * 删库：别人的或不存在的 id 一律 404，先于 `state`，不发出站请求，不写审计。快判到取锁之间没有 `await`：`locks.ts` 的
 * 准入是同步的，到达次序就是调用次序（D20）。取锁后重判，排队期间库可能已删除或转入重建。每一代走 `deletePipeline`，
 * `rebuild_failed` 时先删新一代；任一步失败行不动，重试从头走一遍，已删的按 `not_found` 跳过。
 *
 * 列表与 201 的 `BaseView` 都只读本地行：201 里开着的类型为 `pending`，关着的为 `off`。
 */
import { HttpError } from "../core/errors/index.js";
import { isLabel } from "../model-catalog.js";
import type { createKbLocks } from "./locks.js";
import type { createKbPipeline, PipelineResources } from "./pipeline.js";
import { type createRagflowClient, isRecord } from "./ragflow-client.js";
import { embeddingModelOf, unwrap } from "./settings.js";
import type { createKbStore, KnowledgeBase } from "./store.js";
import { templateOf } from "./templates.js";

const BODY_KEYS = new Set(["name", "template", "raptor", "graph"]);
const MAX_NAME_CODE_POINTS = 64;
const MAX_BASES_PER_OWNER = 50;
/** 两个开关都为 0 的库的 `compile`：恒定值，不发出站请求。 */
const COMPILE_OFF = { raptor: "off", graph: "off" } as const;

type CompileView = Record<"raptor" | "graph", "off" | "pending"> | null;

interface AuditEvent {
  kind: "kb.create" | "kb.delete";
  actorId: string;
  title: string;
  detail: object;
}

interface KbBasesDependencies {
  store: Pick<
    ReturnType<typeof createKbStore>,
    | "newId"
    | "settings"
    | "getBase"
    | "listBases"
    | "isBaseNameTaken"
    | "countBasesByOwner"
    | "countDocuments"
    | "createBase"
    | "removeBase"
  >;
  client: Pick<ReturnType<typeof createRagflowClient>, "createDataset">;
  pipeline: Pick<
    ReturnType<typeof createKbPipeline>,
    "createPipeline" | "deletePipeline" | "discard"
  >;
  locks: Pick<ReturnType<typeof createKbLocks>, "settings" | "write">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
}

/** 通过了形状校验的 body。 */
interface CreateRequest {
  name: string;
  template: string;
  parserId: string;
  raptor: boolean;
  graph: boolean;
}

function badRequest(): never {
  throw new HttpError("bad_request");
}

/** 别人的与不存在的不可区分。 */
export function ownedBase(
  store: Pick<ReturnType<typeof createKbStore>, "getBase">,
  id: string,
  ownerId: string,
): KnowledgeBase {
  const base = store.getBase(id);
  if (base === undefined || base.ownerId !== ownerId) {
    throw new HttpError("not_found");
  }
  return base;
}

const isSwitch = (value: unknown): value is boolean | undefined =>
  value === undefined || typeof value === "boolean";

/** 1–64 码点，无 C0 与 DEL：迁移 050 的 CHECK 是同一条规则。 */
const isBaseName = (value: unknown): value is string =>
  typeof value === "string" && isLabel(value) && [...value].length <= MAX_NAME_CODE_POINTS;

function parseCreate(body: unknown): CreateRequest {
  if (!isRecord(body) || Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    badRequest();
  }
  const { name, template, raptor, graph } = body;
  if (!isBaseName(name) || typeof template !== "string" || !isSwitch(raptor) || !isSwitch(graph)) {
    badRequest();
  }
  const entry = templateOf(template);
  if (entry === undefined) {
    badRequest();
  }
  return {
    name,
    template,
    parserId: entry.parserId,
    raptor: raptor === true,
    graph: graph === true,
  };
}

/** 删除的次序：`rebuild_failed` 的库先删新一代，再删当前一代；重建没走到建库那一步时没有新一代。 */
function generationsOf(base: KnowledgeBase): PipelineResources[] {
  const current = {
    datasetId: base.datasetId,
    canvasId: base.canvasId,
    templateGroupId: base.templateGroupId,
  };
  const next = {
    datasetId: base.rebuildDatasetId,
    canvasId: base.rebuildCanvasId,
    templateGroupId: base.rebuildTemplateGroupId,
  };
  return next.datasetId === null ? [current] : [next, current];
}

function viewOf(base: KnowledgeBase, documents: number, compile: CompileView) {
  const { id, name, template, raptor, graph, state, stateMessage, createdAt } = base;
  return { id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt };
}

/** 列表：开了开关的库读不到编译状态，是 `null`，不是 `off`（第三刀接上读取）。 */
const listedCompile = ({ raptor, graph }: KnowledgeBase): CompileView =>
  raptor || graph ? null : COMPILE_OFF;

/** 201：不读 RAGFlow，开着的类型还没有产出。 */
const createdCompile = ({ raptor, graph }: KnowledgeBase): CompileView => ({
  raptor: raptor ? "pending" : "off",
  graph: graph ? "pending" : "off",
});

export function createKbBases(dependencies: KbBasesDependencies) {
  const { store, client, pipeline, locks, audit } = dependencies;

  function deletable(id: string, ownerId: string): KnowledgeBase {
    const base = ownedBase(store, id, ownerId);
    if (base.state === "rebuilding") {
      throw new HttpError("kb_rebuilding");
    }
    return base;
  }

  /** 这一代的 RAGFlow 资源：普通库只有数据集，开了开关的库经 `createPipeline`。 */
  async function createResources(request: CreateRequest, name: string, embeddingModel: string) {
    const { parserId, raptor, graph } = request;
    if (!raptor && !graph) {
      const dataset = unwrap(await client.createDataset({ name, parserId, embeddingModel }));
      return { datasetId: dataset.id, canvasId: null, templateGroupId: null };
    }
    const created = await pipeline.createPipeline({
      name,
      parserId,
      embeddingModel,
      raptor,
      graph,
    });
    if (created.kind !== "ok") {
      throw new HttpError(created.kind);
    }
    return created.value;
  }

  async function createLocked(request: CreateRequest, ownerId: string) {
    const { name, template, raptor, graph } = request;
    const { embedding, embeddingGeneration, chatModelId } = store.settings();
    if (embedding === null) {
      throw new HttpError("kb_not_ready");
    }
    if ((raptor || graph) && chatModelId === null) {
      badRequest();
    }
    if (store.isBaseNameTaken(ownerId, name)) {
      throw new HttpError("conflict");
    }
    if (store.countBasesByOwner(ownerId) >= MAX_BASES_PER_OWNER) {
      throw new HttpError("kb_limit");
    }
    const id = store.newId();
    const resourceName = `owb-${id}-g${String(embeddingGeneration)}`;
    const embeddingModel = embeddingModelOf(embedding.name);
    const resources = await createResources(request, resourceName, embeddingModel);
    try {
      const base = store.createBase(
        { id, ownerId, name, template, raptor, graph, ...resources },
        () => {
          audit({
            kind: "kb.create",
            actorId: ownerId,
            title: "新建知识库",
            detail: { id, template, raptor, graph },
          });
        },
      );
      return viewOf(base, 0, createdCompile(base));
    } catch (error) {
      await pipeline.discard(resources);
      throw error;
    }
  }

  async function removeLocked(id: string, ownerId: string): Promise<void> {
    for (const generation of generationsOf(deletable(id, ownerId))) {
      const result = await pipeline.deletePipeline(generation);
      if (result.kind !== "ok") {
        throw new HttpError(result.kind);
      }
    }
    store.removeBase(id, () => {
      audit({ kind: "kb.delete", actorId: ownerId, title: "删除知识库", detail: { id } });
    });
  }

  return {
    /** `GET /api/kb/bases`：按 `created_at` 升序，只读本地行。 */
    list(ownerId: string) {
      return store
        .listBases(ownerId)
        .map((base) => viewOf(base, store.countDocuments(base.id), listedCompile(base)));
    },

    /** `POST /api/kb/bases`。 */
    create(body: unknown, ownerId: string) {
      const request = parseCreate(body);
      return locks.settings(() => createLocked(request, ownerId));
    },

    /** 所有权判定先于 body 解析（knowledge-bases「知识库端点」）。 */
    assertOwned(id: string, ownerId: string): void {
      ownedBase(store, id, ownerId);
    },

    /** `DELETE /api/kb/bases/:id`：在该库的写锁下。 */
    async remove(id: string, ownerId: string): Promise<void> {
      deletable(id, ownerId);
      const result = await locks.write(id, () => removeLocked(id, ownerId));
      if (result.outcome === "rebuilding") {
        throw new HttpError("kb_rebuilding");
      }
    },
  };
}
