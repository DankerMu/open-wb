/**
 * 假 RAGFlow 的数据集任务日志（`fake-ragflow.mjs` 的兄弟文件，s2a-kb-ragflow 组 9 第三刀 #1870，design D17）：
 * `GET /api/v1/datasets/<id>/ingestions`，抄自实测记录 §5.3「任务日志」三节与 §18 #26–#29。
 *
 * - `total` 是日志行数，不是文档数，翻页时不变；越界页回 `code:0` 与空 `logs`。
 * - `page_size` 不传为 30，没有测到上限，不回落；`page=0`、`page=-1` 同第 1 页；`page`、`page_size` 非数字回 `101`。
 * - `task_type=` 没有这个参数，静默忽略，回全部行，`total` 不变。
 * - 不存在的数据集回 `404`。
 * - 一份文档一种类型一条日志，`dsl.entries` 恰 1 项；种子只收 `COMPLETED` 且切片非 0 的文档：0 切片的文档编译不运行（表 C）。
 *
 * 记录里没有的行为落到未知路由，不猜（处理函数返回 `undefined`）：不带 `orderby=id`（缺省 `create_time` 次序在并列时翻页丢行，
 * 夹具不模拟；`update_time` 等别的次序同样不做）、`keywords=`、`log_type=`、`operation_status=`、`document_id=`、`desc`、
 * `sort` 与别的查询键、不传 `page`、`page_size` 为 0 或负数（只在 16 行的库上测过，与缺省 30 相容）。
 *
 * 外推，记录里没有原文，用例不要钉死：
 * - 日志 `id` 是按种子次序递增的 32 位十六进制，`orderby=id` 按它倒序（记录写了缺省倒序、`desc=false` 升序，`orderby=id`
 *   的方向没有单独记）。实例的 `id` 不随时间递增（design D14）。
 * - `RUNNING` 行的 `dsl` 与已完成的一样形状：记录只有 `DONE` 行的原文。
 * - 行只带 §5.3 键集的一个子集，`latest_ingestion_event`、时间与 `tenant_id` 不给。
 */
import { failure, notFound, success } from "./fake-ragflow-script.mjs";

const DEFAULT_PAGE_SIZE = 30;
const INTEGER = /^-?\d+$/u;
/** 这里实现的查询键：`task_type` 被静默忽略。 */
const QUERY_KEYS = new Set(["page", "page_size", "orderby", "task_type"]);
/** §5.3 的表：只开这一种时的 `variants`；两种都开时两条都是 `["structure","tree"]`，由种子给出。 */
const VARIANTS = new Map([
  ["Tree", ["tree"]],
  ["Graph", ["structure"]],
]);
/** §5.3 观察到的 `operation_status`。 */
const OPERATION_STATUSES = new Set(["RUNNING", "DONE"]);

function logRow(dataset, log) {
  return {
    dataset_id: dataset.id,
    document_id: "graph_raptor_x",
    document_name: log.taskType,
    document_suffix: "",
    dsl: {
      entries: [
        {
          doc_id: log.documentId,
          event_type: "doc_completed",
          task_type: log.taskType,
          variants: log.variants,
        },
      ],
      task_type: log.taskType,
    },
    id: log.id,
    operation_status: log.operationStatus,
    source_from: "knowledgebase",
    status: "1",
    task_type: log.taskType,
  };
}

/** `page` 必须给；`0`、负数当作第 1 页。 */
function windowOf(params) {
  const page = params.get("page");
  const size = params.get("page_size");
  if (page === null) {
    return undefined;
  }
  if (!INTEGER.test(page)) {
    return { rejection: failure(101, "page must be an integer") };
  }
  if (size !== null && !INTEGER.test(size)) {
    return { rejection: failure(101, "page_size must be an integer") };
  }
  const pageSize = size === null ? DEFAULT_PAGE_SIZE : Number(size);
  if (pageSize <= 0) {
    return undefined;
  }
  return { from: (Math.max(Number(page), 1) - 1) * pageSize, pageSize };
}

export function listIngestions(state, { params }, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return notFound();
  }
  const known = [...params.keys()].every((key) => QUERY_KEYS.has(key));
  const window = known && params.get("orderby") === "id" ? windowOf(params) : undefined;
  if (window === undefined || window.rejection !== undefined) {
    return window?.rejection;
  }
  const sorted = [...dataset.logs].sort((a, b) => b.id.localeCompare(a.id));
  return success({
    logs: sorted
      .slice(window.from, window.from + window.pageSize)
      .map((log) => logRow(dataset, log)),
    total: dataset.logs.length,
  });
}

function assertSeed(dataset, seed) {
  const document = dataset.documents.get(seed.documentId);
  if (!VARIANTS.has(seed.taskType) || !OPERATION_STATUSES.has(seed.operationStatus)) {
    throw new Error(`fake-ragflow ingestion log takes Tree / Graph and RUNNING / DONE`);
  }
  if (document?.ingestionStatus !== "COMPLETED" || document.chunkCount === 0) {
    throw new Error("fake-ragflow ingestion log needs a COMPLETED document with chunks");
  }
  const twice = dataset.logs.some(
    (log) => log.documentId === seed.documentId && log.taskType === seed.taskType,
  );
  if (twice) {
    throw new Error("fake-ragflow has one ingestion log per document and task type");
  }
}

/** 用例的种子：日志 id 按种子次序递增。 */
export function ingestionViews(state) {
  let next = 0;
  return {
    addIngestionLog(datasetId, seed) {
      const dataset = state.datasets.get(datasetId);
      if (dataset === undefined) {
        throw new Error("fake-ragflow has no such dataset");
      }
      assertSeed(dataset, seed);
      next += 1;
      const log = {
        id: next.toString(16).padStart(32, "0"),
        taskType: seed.taskType,
        operationStatus: seed.operationStatus,
        documentId: seed.documentId,
        variants: seed.variants ?? VARIANTS.get(seed.taskType),
      };
      dataset.logs.push(log);
      return log.id;
    },
  };
}
