/**
 * 假 RAGFlow 的文档列表（`fake-ragflow.mjs` 的兄弟文件，s2a-kb-ragflow 组 11，design D17）：分页、次序与八种运行状态，抄自实测记录
 * §8.3、§8.4。这里只实现组 11 用到的查询，其余落到未知路由：`orderby=update_time` 与 `orderby=name`（文档静态，§8.3 的取值
 * 合法但没有可排的数据）、`name=` 与 `ingestion_status=` 过滤、`page` 不传或非数字、`page_size` 为负、`desc` 的其它取值、列表里
 * 有 §8.4 之外的状态。
 *
 * 外推，记录里没有原文，用例不要钉死：
 * - `page_size` 取 1–100 都照用：记录测过 3–40 与 100，超过 100 回落。
 * - `desc=true` 同缺省：记录只写了缺省倒序与 `desc=false` 生效。
 * - `has_active_tasks`：记录只有一处 `false`，这里按有没有在排队或运行的文档算。
 * - 行只带 §8.3 键集的一个子集，`latest_ingestion_event` 只有用例给了才有。
 * - `type`：记录只见过 `pdf` 与 `doc`（§7.4），`pdf` 之外一律 `doc`。
 */
import { failure, notFound, RUN_STATES, success } from "./fake-ragflow-script.mjs";

const MAX_PAGE_SIZE = 100;
const FALLBACK_PAGE_SIZE = 10;
const INTEGER = /^-?\d+$/u;
/** 组 11 用到的查询键；`id` 另有分支。 */
const QUERY_KEYS = new Set(["page", "page_size", "orderby", "desc"]);
/** §8.3：`orderby` 只接受这三个值，其它回 101。 */
const ORDER_FIELDS = new Set(["create_time", "update_time", "name"]);
const ACTIVE_STATES = new Set(["CREATED", "SCHEDULED", "RUNNING", "STOPPING"]);

export function suffixOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

/** 上传应答与列表共有的行（§7.1、§8.3）。 */
export function documentRow(dataset, document) {
  const suffix = suffixOf(document.name);
  return {
    chunk_count: document.chunkCount,
    dataset_id: dataset.id,
    id: document.id,
    ingestion_status: document.ingestionStatus,
    location: document.name,
    name: document.name,
    parser_id: dataset.parserId,
    size: document.content.length,
    suffix,
    token_count: 0,
    type: suffix.toLowerCase() === "pdf" ? "pdf" : "doc",
  };
}

function listedRow(dataset, document) {
  const event =
    document.eventMessage === undefined
      ? {}
      : {
          latest_ingestion_event: {
            component: "",
            event_type: 2,
            id: 1,
            message: document.eventMessage,
            phase: 0,
            ts: "",
          },
        };
  return {
    ...documentRow(dataset, document),
    ...event,
    create_time: document.createTime,
    progress_msg: "",
    status: "1",
  };
}

/** `0`、负数都当作第 1 页。 */
function pageOf(params) {
  const page = params.get("page");
  return page !== null && INTEGER.test(page) ? Math.max(Number(page), 1) : undefined;
}

/** 超过 100 静默回落到 10；`0`、非数字与不传同样是 10。 */
function pageSizeOf(params) {
  const size = params.get("page_size");
  if (size === null || !INTEGER.test(size)) {
    return FALLBACK_PAGE_SIZE;
  }
  const value = Number(size);
  if (value < 0) {
    return undefined;
  }
  return value === 0 || value > MAX_PAGE_SIZE ? FALLBACK_PAGE_SIZE : value;
}

/** 插入次序就是 `create_time` 升序；缺省倒序。 */
function ordered(documents, params) {
  const desc = params.get("desc");
  if (desc === null || desc === "true") {
    return [...documents].reverse();
  }
  return desc === "false" ? documents : undefined;
}

/** 表 B：`id=` 查不到时 102；查得到的过滤组 11 不用。 */
function filteredById(dataset, documentId) {
  return dataset.documents.has(documentId)
    ? undefined
    : failure(102, `you don't own the document ${documentId}`, { data: { docs: [], total: 0 } });
}

function pageAnswer(dataset, params) {
  const documents = [...dataset.documents.values()];
  const sorted = ordered(documents, params);
  const page = pageOf(params);
  const size = pageSizeOf(params);
  const known = documents.every(({ ingestionStatus }) => RUN_STATES.has(ingestionStatus));
  if (sorted === undefined || page === undefined || size === undefined || !known) {
    return undefined;
  }
  const rows = sorted.slice((page - 1) * size, page * size);
  return success({
    docs: rows.map((document) => listedRow(dataset, document)),
    has_active_tasks: documents.some(({ ingestionStatus }) => ACTIVE_STATES.has(ingestionStatus)),
    total: documents.length,
  });
}

export function listDocuments(state, { params }, [datasetId]) {
  const dataset = state.datasets.get(datasetId);
  if (dataset === undefined) {
    return notFound();
  }
  const documentId = params.get("id");
  if (documentId !== null) {
    return filteredById(dataset, documentId);
  }
  if ([...params.keys()].some((key) => !QUERY_KEYS.has(key))) {
    return undefined;
  }
  const orderby = params.get("orderby") ?? "create_time";
  if (!ORDER_FIELDS.has(orderby)) {
    return failure(101, `invalid orderby field: ${orderby}`);
  }
  return orderby === "create_time" ? pageAnswer(dataset, params) : undefined;
}
