/**
 * 知识库本地三张表的唯一读写入口（s2a-kb-ragflow design D6、D8、D9；knowledge-bases「迁移 050 知识库
 * schema」）。纯 DB：`node:sqlite` 同步读写，不发出站请求，不判定上限、重名与状态：这些由调用方在锁内做
 * （D20），这里只给读与计数。050 的约束是兜底，不是规则；约束错误原样抛出。
 *
 * 凭证：嵌入模型的密钥只经 `embeddingApiKey` 读出，`KbSettings` 不带它。事务：带 `within` 的写方法自己开一个
 * 事务（调用方不得已在事务里），`within` 在写入之后、COMMIT 之前调用（审计挂点），抛出即整体回滚。
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

type BaseState = "ready" | "rebuilding" | "rebuild_failed";
type ProbeResult = { status: "ok" | "failed"; at: number; message: string | null };

/** `kb_settings` 的读出形状：永不带密钥。 */
interface KbSettings {
  embedding: { name: string; baseUrl: string } | null;
  embeddingGeneration: number;
  probe: { status: "never" | "ok" | "failed"; at: number | null; message: string | null };
  chatModelId: string | null;
  rebuildActorId: string | null;
  updatedAt: number;
}

/** 嵌入模型的三列：既是写入内容，也是探活写回比对的身份。 */
interface EmbeddingConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface SettingsPatch {
  /**
   * 给了就整体替换三列；`apiKey` 由调用方先定好（省略时取 `embeddingApiKey()`，D7）。任一列变化时同一事务里把探活
   * 重置为 `never`，三列都不变时保留。
   */
  embedding?: EmbeddingConfig;
  chatModelId?: string | null;
  /** 给了即确认重建：同一事务里代数加一、全部知识库置 `rebuilding`、记下发起的管理员（D7）。 */
  rebuildActorId?: string;
}

/** `knowledge_bases` 的一行。`template` 的取值由 050 的 CHECK 钉住。 */
interface KnowledgeBase {
  id: string;
  ownerId: string;
  name: string;
  template: string;
  raptor: boolean;
  graph: boolean;
  datasetId: string;
  canvasId: string | null;
  templateGroupId: string | null;
  rebuildDatasetId: string | null;
  rebuildCanvasId: string | null;
  rebuildTemplateGroupId: string | null;
  embeddingGeneration: number;
  state: BaseState;
  stateMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 建库的输入：`id` 由调用方经 `newId` 先取，RAGFlow 资源的名字要用它（D9）；代数取当前代数。 */
type NewBase = Pick<
  KnowledgeBase,
  | "id"
  | "ownerId"
  | "name"
  | "template"
  | "raptor"
  | "graph"
  | "datasetId"
  | "canvasId"
  | "templateGroupId"
>;

/** 新一代的 RAGFlow id。普通库的画布与模板组为 `null`。 */
interface RebuildGeneration {
  datasetId: string;
  canvasId: string | null;
  templateGroupId: string | null;
}

/** 切换时对该库全部文档的处置：每一行恰在两个清单之一（D8 第 4 步）。 */
interface SwitchDocuments {
  replaced: readonly { id: string; ragflowDocumentId: string }[];
  skipped: readonly string[];
}

/** `kb_documents` 的一行：`upload` 的三个来源字段为 `null`。 */
interface KbDocument {
  id: string;
  kbId: string;
  ragflowDocumentId: string;
  name: string;
  size: number;
  source: "workspace" | "upload";
  workspaceId: string | null;
  sourcePath: string | null;
  sourceMtimeMs: number | null;
  createdAt: number;
}

type NewDocument = Pick<KbDocument, "kbId" | "ragflowDocumentId" | "name" | "size"> &
  (
    | { source: "upload" }
    | { source: "workspace"; workspaceId: string; sourcePath: string; sourceMtimeMs: number }
  );

type Raw = Record<string, SQLOutputValue>;

const SELECT_SETTINGS = "SELECT * FROM kb_settings WHERE id = 'kb'";
const SELECT_EMBEDDING_KEY = "SELECT embedding_api_key FROM kb_settings WHERE id = 'kb'";
const UPDATE_EMBEDDING =
  "UPDATE kb_settings SET embedding_name = ?, embedding_base_url = ?, embedding_api_key = ?, updated_at = ? WHERE id = 'kb'";
/** 探活结果属于写入它的那个身份：名称、地址、密钥任一变化即作废，比对口径同 `UPDATE_PROBE`。 */
const RESET_PROBE =
  "UPDATE kb_settings SET embedding_probe_status = 'never', embedding_probe_at = NULL, embedding_probe_message = NULL WHERE id = 'kb' AND (embedding_name IS NOT ? OR embedding_base_url IS NOT ? OR embedding_api_key IS NOT ?)";
const UPDATE_CHAT_MODEL =
  "UPDATE kb_settings SET chat_model_id = ?, updated_at = ? WHERE id = 'kb'";
const UPDATE_REBUILD_START =
  "UPDATE kb_settings SET embedding_generation = embedding_generation + 1, rebuild_actor_id = ?, updated_at = ? WHERE id = 'kb'";
const UPDATE_REBUILD_ACTOR =
  "UPDATE kb_settings SET rebuild_actor_id = ?, updated_at = ? WHERE id = 'kb'";
/** 探活写回只在嵌入身份不变时生效，`IS` 比较同 `models/store.ts` 的 `RECORD_PROBE`。 */
const UPDATE_PROBE =
  "UPDATE kb_settings SET embedding_probe_status = ?, embedding_probe_at = ?, embedding_probe_message = ? WHERE id = 'kb' AND embedding_name IS ? AND embedding_base_url IS ? AND embedding_api_key IS ?";

const BASE_ORDER = "ORDER BY created_at, id";
const SELECT_BASE = "SELECT * FROM knowledge_bases WHERE id = ?";
const SELECT_BASES_BY_OWNER = `SELECT * FROM knowledge_bases WHERE owner_id = ? ${BASE_ORDER}`;
const SELECT_BASES_BY_STATE = `SELECT * FROM knowledge_bases WHERE state = ? ${BASE_ORDER}`;
const SELECT_BASE_NAME_TAKEN = "SELECT 1 FROM knowledge_bases WHERE owner_id = ? AND name = ?";
const COUNT_BASES = "SELECT COUNT(*) AS count FROM knowledge_bases";
const COUNT_BASES_BY_OWNER = "SELECT COUNT(*) AS count FROM knowledge_bases WHERE owner_id = ?";
const COUNT_BASES_BY_STATE = "SELECT COUNT(*) AS count FROM knowledge_bases WHERE state = ?";
const COUNT_COMPILE_BASES =
  "SELECT COUNT(*) AS count FROM knowledge_bases WHERE raptor = 1 OR graph = 1";
const CURRENT_GENERATION = "(SELECT embedding_generation FROM kb_settings WHERE id = 'kb')";
const INSERT_BASE = `INSERT INTO knowledge_bases(id, owner_id, name, template, raptor, graph, dataset_id, canvas_id, template_group_id, embedding_generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${CURRENT_GENERATION}, 'ready', ?, ?)`;
const DELETE_BASE = "DELETE FROM knowledge_bases WHERE id = ?";
const MARK_ALL_REBUILDING =
  "UPDATE knowledge_bases SET state = 'rebuilding', state_message = NULL, updated_at = ?";
const RETRY_FAILED_BASES =
  "UPDATE knowledge_bases SET state = 'rebuilding', state_message = NULL, updated_at = ? WHERE state = 'rebuild_failed' RETURNING *";
const UPDATE_REBUILD_GENERATION =
  "UPDATE knowledge_bases SET rebuild_dataset_id = ?, rebuild_canvas_id = ?, rebuild_template_group_id = ?, updated_at = ? WHERE id = ?";
const MARK_REBUILD_FAILED =
  "UPDATE knowledge_bases SET state = 'rebuild_failed', state_message = ?, updated_at = ? WHERE id = ?";
const SWITCH_GENERATION = `UPDATE knowledge_bases SET dataset_id = rebuild_dataset_id, canvas_id = rebuild_canvas_id, template_group_id = rebuild_template_group_id, rebuild_dataset_id = NULL, rebuild_canvas_id = NULL, rebuild_template_group_id = NULL, embedding_generation = ${CURRENT_GENERATION}, state = 'ready', state_message = NULL, updated_at = ? WHERE id = ?`;

const SELECT_DOCUMENT = "SELECT * FROM kb_documents WHERE kb_id = ? AND id = ?";
const SELECT_DOCUMENT_BY_SOURCE =
  "SELECT * FROM kb_documents WHERE kb_id = ? AND workspace_id = ? AND source_path = ?";
const SELECT_DOCUMENTS = "SELECT * FROM kb_documents WHERE kb_id = ? ORDER BY created_at, id";
const COUNT_DOCUMENTS = "SELECT COUNT(*) AS count FROM kb_documents WHERE kb_id = ?";
const COUNT_ALL_DOCUMENTS = "SELECT COUNT(*) AS count FROM kb_documents";
const INSERT_DOCUMENT =
  "INSERT INTO kb_documents(id, kb_id, ragflow_document_id, name, size, source, workspace_id, source_path, source_mtime_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const DELETE_DOCUMENT = "DELETE FROM kb_documents WHERE kb_id = ? AND id = ?";
const UPDATE_DOCUMENT_RAGFLOW_ID =
  "UPDATE kb_documents SET ragflow_document_id = ? WHERE kb_id = ? AND id = ?";

export function createKbStore(db: DatabaseSync) {
  const settings = (): KbSettings => toSettings(db.prepare(SELECT_SETTINGS).get() as Raw);
  const base = (id: string): KnowledgeBase | undefined => {
    const row = db.prepare(SELECT_BASE).get(id);
    return row === undefined ? undefined : toBase(row);
  };
  const document = (kbId: string, id: string): KbDocument | undefined => {
    const row = db.prepare(SELECT_DOCUMENT).get(kbId, id);
    return row === undefined ? undefined : toDocument(row);
  };
  const count = (sql: string, ...params: string[]): number =>
    Number((db.prepare(sql).get(...params) as { count: number }).count);

  return {
    newId,

    settings,

    /** 密钥的唯一读出处：未配置嵌入模型时为 `null`。 */
    embeddingApiKey: (): string | null =>
      (db.prepare(SELECT_EMBEDDING_KEY).get() as { embedding_api_key: string | null })
        .embedding_api_key,

    /** 只写 `patch` 里给出的键；`chatModelId: null` 即取消指定。 */
    saveSettings(patch: SettingsPatch, within?: (view: KbSettings) => void): KbSettings {
      return inTransaction(db, () => {
        const at = Date.now();
        const { embedding, chatModelId, rebuildActorId } = patch;
        if (embedding !== undefined) {
          db.prepare(RESET_PROBE).run(embedding.name, embedding.baseUrl, embedding.apiKey);
          db.prepare(UPDATE_EMBEDDING).run(embedding.name, embedding.baseUrl, embedding.apiKey, at);
        }
        if (chatModelId !== undefined) {
          db.prepare(UPDATE_CHAT_MODEL).run(chatModelId, at);
        }
        if (rebuildActorId !== undefined) {
          db.prepare(UPDATE_REBUILD_START).run(rebuildActorId, at);
          db.prepare(MARK_ALL_REBUILDING).run(at);
        }
        const view = settings();
        within?.(view);
        return view;
      });
    },

    /**
     * 探活结果写三列，不动 `updated_at`，只在嵌入模型仍是 `identity` 时写（同 `models/store.ts` 的
     * `recordProbe`）。身份已变：结果丢弃、不调 `within`，`recorded` 为 `false`，`view` 是当前设置。
     */
    recordEmbeddingProbe(
      identity: EmbeddingConfig,
      result: ProbeResult,
      within?: (view: KbSettings) => void,
    ): { view: KbSettings; recorded: boolean } {
      return inTransaction(db, () => {
        const { changes } = db
          .prepare(UPDATE_PROBE)
          .run(
            result.status,
            result.at,
            result.message,
            identity.name,
            identity.baseUrl,
            identity.apiKey,
          );
        const view = settings();
        const recorded = Number(changes) !== 0;
        if (recorded) {
          within?.(view);
        }
        return { view, recorded };
      });
    },

    /** 全部 `rebuild_failed` 置回 `rebuilding` 并改写发起者；没有失败库时不写库、不调 `within`（D8）。 */
    retryFailedRebuilds(
      actorId: string,
      within?: (bases: KnowledgeBase[]) => void,
    ): KnowledgeBase[] {
      return inTransaction(db, () => {
        const at = Date.now();
        const retried = db.prepare(RETRY_FAILED_BASES).all(at).map(toBase);
        if (retried.length > 0) {
          db.prepare(UPDATE_REBUILD_ACTOR).run(actorId, at);
          within?.(retried);
        }
        return retried;
      });
    },

    getBase: base,

    /** 该账号的知识库，按 `created_at`、`id` 升序。 */
    listBases: (ownerId: string): KnowledgeBase[] =>
      db.prepare(SELECT_BASES_BY_OWNER).all(ownerId).map(toBase),

    /** 全部账号里处于该状态的库，次序同上：重建器的工作清单。 */
    listBasesInState: (state: BaseState): KnowledgeBase[] =>
      db.prepare(SELECT_BASES_BY_STATE).all(state).map(toBase),

    isBaseNameTaken: (ownerId: string, name: string): boolean =>
      db.prepare(SELECT_BASE_NAME_TAKEN).get(ownerId, name) !== undefined,

    countBases: (): number => count(COUNT_BASES),
    countBasesByOwner: (ownerId: string): number => count(COUNT_BASES_BY_OWNER, ownerId),
    countBasesInState: (state: BaseState): number => count(COUNT_BASES_BY_STATE, state),

    /** 开编译的库：`raptor` 或 `graph` 为 1 的行，含重建中与重建失败的库（D7）。 */
    countCompileBases: (): number => count(COUNT_COMPILE_BASES),

    createBase(input: NewBase, within?: (record: KnowledgeBase) => void): KnowledgeBase {
      return inTransaction(db, () => {
        const at = Date.now();
        db.prepare(INSERT_BASE).run(
          input.id,
          input.ownerId,
          input.name,
          input.template,
          input.raptor ? 1 : 0,
          input.graph ? 1 : 0,
          input.datasetId,
          input.canvasId,
          input.templateGroupId,
          at,
          at,
        );
        const record = base(input.id) as KnowledgeBase;
        within?.(record);
        return record;
      });
    },

    /** 文档行级联删除；未知 id 为 `undefined`。 */
    removeBase(id: string, within?: (record: KnowledgeBase) => void): KnowledgeBase | undefined {
      return inTransaction(db, () => {
        const record = base(id);
        if (record === undefined) {
          return undefined;
        }
        db.prepare(DELETE_BASE).run(id);
        within?.(record);
        return record;
      });
    },

    /** 三个 `rebuild_*` 列一起写入；`null` 一起置空（D8 第 1、2 步）。未知 id 为 `undefined`。 */
    setRebuildGeneration(
      id: string,
      generation: RebuildGeneration | null,
    ): KnowledgeBase | undefined {
      db.prepare(UPDATE_REBUILD_GENERATION).run(
        generation?.datasetId ?? null,
        generation?.canvasId ?? null,
        generation?.templateGroupId ?? null,
        Date.now(),
        id,
      );
      return base(id);
    },

    /** 留着 `rebuild_*`：重试的第一步要按它们删掉残留的一代（D8）。未知 id 为 `undefined`。 */
    failRebuild(
      id: string,
      message: string,
      within?: (record: KnowledgeBase) => void,
    ): KnowledgeBase | undefined {
      return inTransaction(db, () => {
        db.prepare(MARK_REBUILD_FAILED).run(message, Date.now(), id);
        const record = base(id);
        if (record !== undefined) {
          within?.(record);
        }
        return record;
      });
    },

    /**
     * 单事务切换（D8 第 4 步）：删被跳过的文档，其余换新 id，三列整体换入并置空，代数取当前代数，
     * 状态 `ready`。切换之后该库每一行都要指向新数据集，所以清单与该库的行对不上时抛出，整体回滚。
     */
    switchGeneration(
      id: string,
      documents: SwitchDocuments,
      within?: (record: KnowledgeBase) => void,
    ): KnowledgeBase {
      return inTransaction(db, () => {
        if (base(id)?.rebuildDatasetId == null) {
          throw new Error("knowledge base has no rebuild generation to switch to");
        }
        assertEachListedOnce(documents);
        for (const documentId of documents.skipped) {
          assertOneRow(db.prepare(DELETE_DOCUMENT).run(id, documentId).changes);
        }
        for (const { id: documentId, ragflowDocumentId } of documents.replaced) {
          const update = db.prepare(UPDATE_DOCUMENT_RAGFLOW_ID);
          assertOneRow(update.run(ragflowDocumentId, id, documentId).changes);
        }
        if (count(COUNT_DOCUMENTS, id) !== documents.replaced.length) {
          throw new Error(DOCUMENT_SET_MISMATCH);
        }
        db.prepare(SWITCH_GENERATION).run(Date.now(), id);
        const record = base(id) as KnowledgeBase;
        within?.(record);
        return record;
      });
    },

    getDocument: document,

    findDocumentBySource(
      kbId: string,
      workspaceId: string,
      sourcePath: string,
    ): KbDocument | undefined {
      const row = db.prepare(SELECT_DOCUMENT_BY_SOURCE).get(kbId, workspaceId, sourcePath);
      return row === undefined ? undefined : toDocument(row);
    },

    /** 该库的文档，按 `created_at`、`id` 升序。 */
    listDocuments: (kbId: string): KbDocument[] =>
      db.prepare(SELECT_DOCUMENTS).all(kbId).map(toDocument),

    countDocuments: (kbId: string): number => count(COUNT_DOCUMENTS, kbId),
    countAllDocuments: (): number => count(COUNT_ALL_DOCUMENTS),

    addDocument(input: NewDocument, within?: (record: KbDocument) => void): KbDocument {
      const workspace = input.source === "workspace" ? input : null;
      return inTransaction(db, () => {
        const id = newId();
        db.prepare(INSERT_DOCUMENT).run(
          id,
          input.kbId,
          input.ragflowDocumentId,
          input.name,
          input.size,
          input.source,
          workspace?.workspaceId ?? null,
          workspace?.sourcePath ?? null,
          workspace?.sourceMtimeMs ?? null,
          Date.now(),
        );
        const record = document(input.kbId, id) as KbDocument;
        within?.(record);
        return record;
      });
    },

    /** 未知 id 或不属于这个库：`undefined`，不删。 */
    removeDocument(
      kbId: string,
      id: string,
      within?: (record: KbDocument) => void,
    ): KbDocument | undefined {
      return inTransaction(db, () => {
        const record = document(kbId, id);
        if (record === undefined) {
          return undefined;
        }
        db.prepare(DELETE_DOCUMENT).run(kbId, id);
        within?.(record);
        return record;
      });
    },
  };
}

const DOCUMENT_SET_MISMATCH = "switch document set mismatch";

function newId(): string {
  return randomBytes(16).toString("hex");
}

/** 一个 id 只能列一次：`replaced` 里的重复让条数虚高，最后的计数查不出，漏掉的行还指向旧数据集。 */
function assertEachListedOnce({ replaced, skipped }: SwitchDocuments): void {
  const ids = [...replaced.map(({ id }) => id), ...skipped];
  if (new Set(ids).size !== ids.length) {
    throw new Error(DOCUMENT_SET_MISMATCH);
  }
}

function assertOneRow(changes: number | bigint): void {
  if (Number(changes) !== 1) {
    throw new Error(DOCUMENT_SET_MISMATCH);
  }
}

function text(value: SQLOutputValue | undefined): string | null {
  return value == null ? null : String(value);
}

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value == null ? null : Number(value);
}

function toSettings(row: Raw): KbSettings {
  return {
    embedding:
      row.embedding_name === null
        ? null
        : { name: String(row.embedding_name), baseUrl: String(row.embedding_base_url) },
    embeddingGeneration: Number(row.embedding_generation),
    probe: {
      status: row.embedding_probe_status as KbSettings["probe"]["status"],
      at: nullableNumber(row.embedding_probe_at),
      message: text(row.embedding_probe_message),
    },
    chatModelId: text(row.chat_model_id),
    rebuildActorId: text(row.rebuild_actor_id),
    updatedAt: Number(row.updated_at),
  };
}

function toBase(row: Raw): KnowledgeBase {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    template: String(row.template),
    raptor: row.raptor === 1,
    graph: row.graph === 1,
    datasetId: String(row.dataset_id),
    canvasId: text(row.canvas_id),
    templateGroupId: text(row.template_group_id),
    rebuildDatasetId: text(row.rebuild_dataset_id),
    rebuildCanvasId: text(row.rebuild_canvas_id),
    rebuildTemplateGroupId: text(row.rebuild_template_group_id),
    embeddingGeneration: Number(row.embedding_generation),
    state: row.state as BaseState,
    stateMessage: text(row.state_message),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toDocument(row: Raw): KbDocument {
  return {
    id: String(row.id),
    kbId: String(row.kb_id),
    ragflowDocumentId: String(row.ragflow_document_id),
    name: String(row.name),
    size: Number(row.size),
    source: row.source as KbDocument["source"],
    workspaceId: text(row.workspace_id),
    sourcePath: text(row.source_path),
    sourceMtimeMs: nullableNumber(row.source_mtime_ms),
    createdAt: Number(row.created_at),
  };
}

/** 本模块自己的事务，同 `models/store.ts`、`connectors/store.ts`、`workspaces/mounts/store.ts`。 */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "kb store rollback failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}
