/**
 * 建库、列表与删库（s2a-kb-ragflow D2、D9、D20；knowledge-bases「知识库端点」「知识库审计」）。
 *
 * 组 9 首刀只有普通模板：`raptor` 或 `graph` 为真一律 400，数据集走 `parse_type:1`，没有模板组与画布。开关的开放、
 * `createPipeline` 与 `deletePipeline` 属第二刀（#1869），编译状态的读取属第三刀（#1870）。
 *
 * 建库：body 的键集、类型、名称与模板在取锁之前判定，不读库。其余判定在设置锁内，读到的是锁内的设置行与知识库行：
 * 嵌入就绪、开关、重名、数量上限，次序不变。建库全程持锁，所以不会建出代数过期的库，也不会与一次保存交错。先建
 * 数据集、后插行：插行或审计失败时删掉刚建的数据集，这个删除失败写一行 `kb_dataset_leak`，不改变应答。
 *
 * 删库：别人的或不存在的 id 一律 404，先于 `state`，不发出站请求，不写审计。快判到取锁之间没有 `await`：`locks.ts` 的
 * 准入是同步的，到达次序就是调用次序（D20）。取锁后重判，排队期间库可能已删除或转入重建。一代的数据集删除确认之前
 * 不发下一代，任一步失败行不动，重试从头走一遍，已删的按 `not_found` 跳过。
 *
 * 列表与 201 的 `BaseView` 都只读本地行。
 */
import { HttpError } from "../core/errors/index.js";
import { isLabel } from "../model-catalog.js";
import type { createKbLocks } from "./locks.js";
import { type createRagflowClient, isRecord } from "./ragflow-client.js";
import { embeddingModelOf, unwrap } from "./settings.js";
import type { createKbStore, KnowledgeBase } from "./store.js";
import { templateOf } from "./templates.js";

const BODY_KEYS = new Set(["name", "template", "raptor", "graph"]);
const MAX_NAME_CODE_POINTS = 64;
const MAX_BASES_PER_OWNER = 50;
/** 两个开关都为 0 的库的 `compile`：恒定值，不发出站请求。 */
const COMPILE_OFF = { raptor: "off", graph: "off" } as const;

/** 数据集留在了 RAGFlow、本地却没有行：回滚删除失败时写的 stderr 记录（D9）。 */
export interface KbBaseRecord {
  event: "kb_dataset_leak";
  datasetId: string;
}

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
  client: Pick<ReturnType<typeof createRagflowClient>, "createDataset" | "deleteDataset">;
  locks: Pick<ReturnType<typeof createKbLocks>, "settings" | "write">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
  /** 受管 stderr writer。 */
  log: (record: KbBaseRecord) => void;
}

/** 通过了形状校验的 body。 */
interface CreateRequest {
  name: string;
  template: string;
  parserId: string;
  /** 开关为真：本刀一律拒绝，判定排在嵌入就绪之后（spec 的第 3 步）。 */
  compile: boolean;
}

function badRequest(): never {
  throw new HttpError("bad_request");
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
  return { name, template, parserId: entry.parserId, compile: raptor === true || graph === true };
}

/** 删除的次序：`rebuild_failed` 的库先删新一代，再删当前一代；重建没走到建库那一步时没有新一代。 */
function datasetsOf({ datasetId, rebuildDatasetId }: KnowledgeBase): string[] {
  return rebuildDatasetId === null ? [datasetId] : [rebuildDatasetId, datasetId];
}

function viewOf(base: KnowledgeBase, documents: number) {
  const { id, name, template, raptor, graph, state, stateMessage, createdAt } = base;
  // 开了开关的行这一刀建不出来；读不到的编译状态是 `null`，不是 `off`（第三刀接上读取）。
  const compile = raptor || graph ? null : COMPILE_OFF;
  return { id, name, template, raptor, graph, state, stateMessage, documents, compile, createdAt };
}

export function createKbBases(dependencies: KbBasesDependencies) {
  const { store, client, locks, audit, log } = dependencies;

  /** 别人的与不存在的不可区分。 */
  function owned(id: string, ownerId: string): KnowledgeBase {
    const base = store.getBase(id);
    if (base === undefined || base.ownerId !== ownerId) {
      throw new HttpError("not_found");
    }
    return base;
  }

  function deletable(id: string, ownerId: string): KnowledgeBase {
    const base = owned(id, ownerId);
    if (base.state === "rebuilding") {
      throw new HttpError("kb_rebuilding");
    }
    return base;
  }

  async function discardDataset(datasetId: string): Promise<void> {
    const result = await client.deleteDataset(datasetId);
    if (result.kind !== "ok" && result.kind !== "not_found") {
      log({ event: "kb_dataset_leak", datasetId });
    }
  }

  async function createLocked(request: CreateRequest, ownerId: string) {
    const { name, template, parserId, compile } = request;
    const { embedding, embeddingGeneration } = store.settings();
    if (embedding === null) {
      throw new HttpError("kb_not_ready");
    }
    if (compile) {
      badRequest();
    }
    if (store.isBaseNameTaken(ownerId, name)) {
      throw new HttpError("conflict");
    }
    if (store.countBasesByOwner(ownerId) >= MAX_BASES_PER_OWNER) {
      throw new HttpError("kb_limit");
    }
    const id = store.newId();
    const dataset = await client.createDataset({
      name: `owb-${id}-g${String(embeddingGeneration)}`,
      parserId,
      embeddingModel: embeddingModelOf(embedding.name),
    });
    const { id: datasetId } = unwrap(dataset);
    try {
      const base = store.createBase(
        {
          id,
          ownerId,
          name,
          template,
          raptor: false,
          graph: false,
          datasetId,
          canvasId: null,
          templateGroupId: null,
        },
        () => {
          audit({
            kind: "kb.create",
            actorId: ownerId,
            title: "新建知识库",
            detail: { id, template, raptor: false, graph: false },
          });
        },
      );
      return viewOf(base, 0);
    } catch (error) {
      await discardDataset(datasetId);
      throw error;
    }
  }

  async function removeLocked(id: string, ownerId: string): Promise<void> {
    for (const datasetId of datasetsOf(deletable(id, ownerId))) {
      const result = await client.deleteDataset(datasetId);
      if (result.kind !== "ok" && result.kind !== "not_found") {
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
      return store.listBases(ownerId).map((base) => viewOf(base, store.countDocuments(base.id)));
    },

    /** `POST /api/kb/bases`。 */
    create(body: unknown, ownerId: string) {
      const request = parseCreate(body);
      return locks.settings(() => createLocked(request, ownerId));
    },

    /** 所有权判定先于 body 解析（knowledge-bases「知识库端点」）。 */
    assertOwned(id: string, ownerId: string): void {
      owned(id, ownerId);
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
