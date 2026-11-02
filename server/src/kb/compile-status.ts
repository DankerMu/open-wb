/**
 * 知识库列表里的编译状态（s2a-kb-ragflow D9、D14；knowledge-bases「知识库端点」的编译状态判定）。
 *
 * 两份数据，每次现读：该库在 RAGFlow 的全部文档（`readRagflowDocuments`，组 11），与数据集任务日志（`listIngestionLogs`，逐页
 * 读到 `total`，读到空页也停：`total` 是这一页说的，翻页期间可能变）。不读 `compilation/status`：按类型读没有终态（§5.3）。
 * 本地文档行按 RAGFlow 文档 id 关联；RAGFlow 里没有本地行的文档（`kb_document_leak` 留下的）不参与判定。
 *
 * 对开着的每种类型按次序判定，任务日志按行上的 `task_type` 分类型（RAPTOR 为 `Tree`，知识图谱为 `Graph`），不看 `variants`：
 * 1. 有本地文档 `CREATED` / `SCHEDULED` / `RUNNING` / `STOPPING`，或该类型有 `RUNNING` 日志：`running`。文档这一半由文档
 *    列表就能定，这时两种都是 `running`，不读任务日志。
 * 2. 有本地文档 `FAILED`：`failed`。失败分不出类型，两种都算；这是 `failed` 的唯一来源。
 * 3. 除 `COMPLETED` 且 0 切片的文档外（编译不运行，表 C），其余本地文档非空，且每份都在该类型 `DONE` 日志的
 *    `dsl.entries[].doc_id` 并集里：`done`。要看到每份文档，所以日志不能提前停读。
 * 4. 其它：`pending`。`operation_status` 的未知取值落在这里。
 *
 * 读不到为 `null`：文档列表的数据集 not-found、任何一页失败、本地文档的 `ingestion_status` 在八种之外（协议漂移：不知道它是不是
 * 还在跑，不能判 `done`）。各库的读取并发发出，共用一个总期限（缺省 5 s，D9）；到期没读完的库为 `null`，之后不再发任何一页
 * （文档列表与任务日志都是）。本地行在发请求之前同步读完，RAGFlow 一侧不抛错，所以晚到的结果没有人要也不会成为未处理的拒绝。
 *
 * 已知限制：对话模型失败时 RAPTOR 没有任何信号（§5.4），文档照常 `COMPLETED`、任务日志没有记录，`raptor` 停在 `pending`，
 * 不声称 `failed` 或 `done`；第 3 步要逐份覆盖，所以中途才坏掉的情形同样不会显示 `done`。
 */
import { readRagflowDocuments } from "./documents.js";
import type { createRagflowClient, IngestionLog, ListedDocument } from "./ragflow-client.js";
import { UNAVAILABLE } from "./ragflow-route.js";
import type { createKbStore, KnowledgeBase } from "./store.js";

const DEFAULT_DEADLINE_MS = 5_000;
/** 两个开关都为 0 的库：恒定值，不发出站请求。 */
const COMPILE_OFF = { raptor: "off", graph: "off" } as const;
/** 第 1 步的文档状态（实测记录表 A 的 `queued` 与 `parsing`）。 */
const ACTIVE = new Set(["CREATED", "SCHEDULED", "RUNNING", "STOPPING"]);
/** 表 A 的八种：之外的是协议漂移。 */
const KNOWN = new Set([...ACTIVE, "UNSTART", "STOPPED", "COMPLETED", "FAILED"]);
const TASK_TYPES = { raptor: "Tree", graph: "Graph" } as const;

type Kind = keyof typeof TASK_TYPES;
type CompileState = "off" | "pending" | "running" | "done" | "failed";
export type CompileView = Record<Kind, CompileState> | null;

interface CompileStatusDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "listDocuments">;
  client: Pick<ReturnType<typeof createRagflowClient>, "listDocuments" | "listIngestionLogs">;
  /** 列表里全部编译状态读取的总期限（测试注入短期限）；省略时 5 s。 */
  deadlineMs?: number | undefined;
}

/** 一份本地文档在 RAGFlow 的状态；RAGFlow 里没有它时 `status` 为 `undefined`。 */
interface Run {
  id: string;
  status: string | undefined;
  chunkCount: number;
}

function runsOf(ragflowIds: readonly string[], listed: readonly ListedDocument[]): Run[] {
  const byId = new Map(listed.map((document) => [document.id, document]));
  return ragflowIds.map((id) => {
    const document = byId.get(id);
    return { id, status: document?.ingestionStatus, chunkCount: document?.chunkCount ?? 0 };
  });
}

/** 第 1–4 步里一种类型的判定，`logs` 是全部任务日志。 */
function judge(kind: Kind, runs: readonly Run[], logs: readonly IngestionLog[]): CompileState {
  const typed = logs.filter(({ taskType }) => taskType === TASK_TYPES[kind]);
  if (typed.some(({ operationStatus }) => operationStatus === "RUNNING")) {
    return "running";
  }
  if (runs.some(({ status }) => status === "FAILED")) {
    return "failed";
  }
  const covered = new Set(
    typed
      .filter(({ operationStatus }) => operationStatus === "DONE")
      .flatMap(({ documentIds }) => documentIds),
  );
  const counted = runs.filter(({ status, chunkCount }) => status !== "COMPLETED" || chunkCount > 0);
  return counted.length > 0 && counted.every(({ id }) => covered.has(id)) ? "done" : "pending";
}

export function createCompileStatus(dependencies: CompileStatusDependencies) {
  const { store, client, deadlineMs = DEFAULT_DEADLINE_MS } = dependencies;

  /** 读全任务日志；到期或任何一页失败为 `undefined`。 */
  async function readLogs(
    datasetId: string,
    expired: () => boolean,
  ): Promise<IngestionLog[] | undefined> {
    const logs: IngestionLog[] = [];
    for (let page = 1; !expired(); page += 1) {
      const result = await client.listIngestionLogs(datasetId, page);
      if (result.kind !== "ok") {
        return undefined;
      }
      logs.push(...result.value.logs);
      if (result.value.logs.length === 0 || logs.length >= result.value.total) {
        return logs;
      }
    }
    return undefined;
  }

  async function readBase(
    base: KnowledgeBase,
    ragflowIds: readonly string[],
    expired: () => boolean,
  ): Promise<CompileView> {
    // 到期后不再发下一页：读全文档的函数是组 11 的，期限从这里的客户端接进去。
    const bounded = {
      listDocuments: (datasetId: string, page: number) =>
        expired() ? Promise.resolve(UNAVAILABLE) : client.listDocuments(datasetId, page),
    };
    const listed = await readRagflowDocuments(bounded, base.datasetId);
    if (listed.kind !== "ok") {
      return null;
    }
    const runs = runsOf(ragflowIds, listed.value);
    if (runs.some(({ status }) => status !== undefined && !KNOWN.has(status))) {
      return null;
    }
    const active = runs.some(({ status }) => status !== undefined && ACTIVE.has(status));
    const logs = active ? [] : await readLogs(base.datasetId, expired);
    if (logs === undefined) {
      return null;
    }
    const state = (kind: Kind, on: boolean): CompileState => {
      if (!on) {
        return "off";
      }
      return active ? "running" : judge(kind, runs, logs);
    };
    return { raptor: state("raptor", base.raptor), graph: state("graph", base.graph) };
  }

  return {
    /** 列表里各库的 `compile`，次序同 `bases`。本地行读取失败照常抛出（500），RAGFlow 一侧读不到为 `null`。 */
    async read(bases: readonly KnowledgeBase[]): Promise<CompileView[]> {
      let expired = false;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(null);
        }, deadlineMs);
      });
      try {
        const reads = bases.map((base) => {
          if (!base.raptor && !base.graph) {
            return COMPILE_OFF;
          }
          const ragflowIds = store
            .listDocuments(base.id)
            .map(({ ragflowDocumentId }) => ragflowDocumentId);
          return Promise.race([readBase(base, ragflowIds, () => expired), deadline]);
        });
        return await Promise.all(reads);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
