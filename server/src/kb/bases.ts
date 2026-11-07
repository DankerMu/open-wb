/**
 * 建库、列表与删库（s2a-kb-ragflow D2、D9、D20；knowledge-bases「知识库端点」「知识库审计」）。
 *
 * 两种库：两个开关都关的走 `parse_type:1`，没有模板组与画布；任一开关开的经 `kb/pipeline.ts` 的 `createPipeline` 建模板组、
 * 画布与 `parse_type:2` 数据集（#1869）。建一代的这一步是 `createGeneration`，重建器（`kb/rebuild.ts`，#1852）共用：普通库不读
 * 账号缺省。
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
 * 列表只依赖本地行；`compile` 由 `kb/compile-status.ts` 现读（#1870），读不到为 `null`，不影响列表。201 的 `BaseView` 不读
 * RAGFlow：开着的类型为 `pending`，关着的为 `off`。
 */
import { HttpError } from "../core/errors/index.js";
import { isLabel } from "../model-catalog.js";
import type { CompileView, createCompileStatus } from "./compile-status.js";
import type { createKbLocks } from "./locks.js";
import { type createKbPipeline, type PipelineResources, resourceName } from "./pipeline.js";
import { type createRagflowClient, isRecord } from "./ragflow-client.js";
import { embeddingModelOf } from "./settings.js";
import type { createKbStore, KnowledgeBase } from "./store.js";
import { templateOf } from "./templates.js";

const BODY_KEYS = new Set(["name", "template", "raptor", "graph"]);
const MAX_NAME_CODE_POINTS = 64;
const MAX_BASES_PER_OWNER = 50;

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
  /** 列表的编译状态；由装配注入，`compile-status.ts` 经 `documents.ts` 间接依赖本文件。 */
  compileStatus: Pick<ReturnType<typeof createCompileStatus>, "read">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
}

/** 一代 RAGFlow 资源的输入：`name` 是 `resourceName(id, 代数)`，`embeddingModel` 是三段式（D2、D7）。 */
interface GenerationInput {
  name: string;
  parserId: string;
  raptor: boolean;
  graph: boolean;
  embeddingModel: string;
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

/**
 * 建一代 RAGFlow 资源（D9），建库与重建共用：普通库只建 `parse_type:1` 数据集，不读账号缺省；开了开关的库经 `createPipeline`，
 * 它自己逆序回滚。结果是类型化的，不抛。
 */
export async function createGeneration(
  dependencies: Pick<KbBasesDependencies, "client" | "pipeline">,
  input: GenerationInput,
  signal?: AbortSignal,
) {
  const { name, parserId, raptor, graph, embeddingModel } = input;
  if (raptor || graph) {
    return dependencies.pipeline.createPipeline(input, signal);
  }
  const dataset = await dependencies.client.createDataset(
    { name, parserId, embeddingModel },
    signal,
  );
  if (dataset.kind !== "ok") {
    return dataset;
  }
  const value = { datasetId: dataset.value.id, canvasId: null, templateGroupId: null };
  return { kind: "ok" as const, value };
}

function viewOf(base: KnowledgeBase, documents: number, compile: CompileView) {
  const { id, name, template, raptor, graph, state, stateMessage, createdAt } = base;
  return { id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt };
}

/** 201：不读 RAGFlow，开着的类型还没有产出。 */
const createdCompile = ({ raptor, graph }: KnowledgeBase): CompileView => ({
  raptor: raptor ? "pending" : "off",
  graph: graph ? "pending" : "off",
});

export function createKbBases(dependencies: KbBasesDependencies) {
  const { store, pipeline, locks, compileStatus, audit } = dependencies;

  function deletable(id: string, ownerId: string): KnowledgeBase {
    const base = ownedBase(store, id, ownerId);
    if (base.state === "rebuilding") {
      throw new HttpError("kb_rebuilding");
    }
    return base;
  }

  /** 这一代的 RAGFlow 资源：失败按 D4 映射成应答。 */
  async function createResources(request: CreateRequest, name: string, embeddingModel: string) {
    const created = await createGeneration(dependencies, { ...request, name, embeddingModel });
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
    const generationName = resourceName(id, embeddingGeneration);
    const embeddingModel = embeddingModelOf(embedding.name);
    const resources = await createResources(request, generationName, embeddingModel);
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
    /** `GET /api/kb/bases`：按 `created_at` 升序。库与文档数只读本地行，`compile` 各库并发现读、共用总期限。 */
    async list(ownerId: string) {
      const bases = store.listBases(ownerId);
      const compiles = await compileStatus.read(bases);
      return bases.map((base, index) =>
        viewOf(base, store.countDocuments(base.id), compiles[index] ?? null),
      );
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
