/**
 * 假 RAGFlow 的检索路由（`fake-ragflow.mjs` 的兄弟文件，s2b-kb-retrieval 组 3 #1913）：`POST /api/v1/retrieval`，协议抄自实测记录
 * 续篇 `docs/reviews/2026-11-08-ragflow-rc2-retrieval.md` §19.1、§19.3、§19.4。
 *
 * - 应答 `data` 恒为四键 `chunks`、`doc_aggs`、`labels`、`total`，切片恰 §19.1 的十六个键；`labels` 与成功应答的 `message` 恒为
 *   `null`。零命中是 §19.1 的原样。
 * - 命中由用例经 `setRetrievalHits` 脚本化（数据集 → 切片），夹具不实现检索算法，问句、阈值、权重与重排都不改变命中。
 * - 参数非法时一律 HTTP 200：§19.1 表里的六条 `code:101`，不存在的数据集为 `code:404`。
 * - `rerank_id`：账号里有这个重排实例而没有这个模型、或两段式，为 §19.4 的 `code:102`；`failRerank` 之后每个带 `rerank_id` 的
 *   请求都回 `code:102`，直到夹具关闭，message 缺省是 §19.4「模型名不存在」那行按请求的 `rerank_id` 拼出的原文。
 *
 * 记录里没有的行为落到未知路由，不猜（处理函数返回 `undefined`）：D2 之外的参数（`top_k`、`keyword`、`highlight`、`use_kg`、
 * `document_ids` 在记录里各有效果，夹具不模拟）；`dataset_ids` 不是恰一个字符串（§19.6 的跨库不实现）；`page` 不是正整数；
 * 阈值、权重、`page_size`、`question` 的其它类型；实例或提供方不存在、或模型不是重排类型的三段式 `rerank_id`。
 *
 * 外推，记录里没有原文，用例不要钉死：
 * - 多个参数同时非法时的次序，以及 `101` 与 `404`、`404` 与 `102` 谁先：这里按 `question`、`dataset_ids`、类型、取值范围、
 *   数据集、`rerank_id` 的次序。
 * - 阈值为字符串的 message 在记录里截断（`…`），这里只给记录的前缀；权重为字符串时沿用同一句。
 * - 带重排时实例上三个分数各异、排序也变（§19.3），这里照样三个同值、次序同脚本。
 * - 切片里 `content_ltks`、`row_id`、`id` 的取值，没有种文档时的 `document_keyword`。
 */
import { randomBytes } from "node:crypto";
import { API } from "./fake-ragflow-models.mjs";
import { failure, notFound } from "./fake-ragflow-script.mjs";

const PROVIDER = "OpenAI-API-Compatible";
/** D2 的 body 键；其余参数的效果夹具不模拟。 */
const FIELDS = new Set([
  "question",
  "dataset_ids",
  "similarity_threshold",
  "vector_similarity_weight",
  "page",
  "page_size",
  "rerank_id",
]);
const RANGED = ["similarity_threshold", "vector_similarity_weight"];
const MISMATCH = "Mismatch type float64 with value number";
const RERANK_UNAVAILABLE =
  "failed to get rerank model by rerank_id: model configuration unavailable";
/** 没有种文档时 `document_keyword` 的占位名。 */
const PLACEHOLDER_NAME = "document.md";
/** 校验函数的第三种结果：记录里没有，落到未知路由。 */
const UNRECORDED = Symbol("unrecorded");

const modelNotFound = (rerankId) =>
  failure(102, `${RERANK_UNAVAILABLE}: model config not found: ${rerankId}`);

const required = (field) =>
  failure(
    101,
    `Key: 'SearchDatasetsRequest.${field}' Error:Field validation for '${field}' failed on the 'required' tag`,
  );

export function createRetrievalState() {
  return {
    /** 数据集 id 到脚本化的命中 `{documentId, content, similarity}[]`。 */
    hits: new Map(),
    /** `failRerank` 之后为 `{message}`，`message` 为 `undefined` 时按请求的 `rerank_id` 拼 §19.4 的原文。 */
    rerankFailure: undefined,
  };
}

/** `question` 与 `dataset_ids` 的 `required`（§19.1）；类型不对的没有测过，为 `UNRECORDED`。 */
function requiredRejection(body) {
  if (body.question === undefined || body.question === "") {
    return required("Question");
  }
  if (body.dataset_ids === undefined) {
    return required("DatasetIDs");
  }
  const ids = body.dataset_ids;
  const single = Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string";
  return typeof body.question === "string" && single ? undefined : UNRECORDED;
}

/** 阈值、权重与 `page_size`（§19.1）；`UNRECORDED` 同上。 */
function valueRejection(body) {
  const present = RANGED.filter((field) => body[field] !== undefined);
  if (present.some((field) => typeof body[field] === "string")) {
    return failure(101, `${MISMATCH} …`);
  }
  if (present.some((field) => typeof body[field] !== "number")) {
    return UNRECORDED;
  }
  const outside = present.find((field) => body[field] < 0 || body[field] > 1);
  if (outside !== undefined) {
    return failure(101, `${outside} must be between 0 and 1`);
  }
  const pageSize = body.page_size;
  if (pageSize !== undefined && !Number.isInteger(pageSize)) {
    return UNRECORDED;
  }
  if (pageSize !== undefined && pageSize < 1) {
    return failure(101, "page_size must be greater than or equal to 1");
  }
  const page = body.page;
  return page === undefined || (Number.isInteger(page) && page >= 1) ? undefined : UNRECORDED;
}

/** §19.4 的两行；记录之外的写法为 `UNRECORDED`。 */
function rerankRejection(models, rerankId) {
  if (typeof rerankId !== "string") {
    return UNRECORDED;
  }
  const parts = rerankId.split("@");
  if (parts.length === 2) {
    return failure(
      102,
      `${RERANK_UNAVAILABLE}: provider "${parts[1]}" lookup failed: record not found`,
    );
  }
  const [name, instanceName, provider] = parts;
  const instance =
    parts.length === 3 && provider === PROVIDER && models.providers.has(provider)
      ? models.instances.get(instanceName)
      : undefined;
  const model = instance?.models.get(name);
  if (instance === undefined || (model !== undefined && !model.modelType.includes("rerank"))) {
    return UNRECORDED;
  }
  return model === undefined ? modelNotFound(rerankId) : undefined;
}

function chunkOf(dataset, hit, index) {
  const name = dataset.documents.get(hit.documentId)?.name ?? PLACEHOLDER_NAME;
  return {
    content: hit.content,
    content_ltks: hit.content,
    dataset_id: dataset.id,
    doc_type_kwd: "",
    document_id: hit.documentId,
    document_keyword: name,
    id: randomBytes(16).toString("hex"),
    image_id: "",
    important_keywords: [],
    mom_id: "",
    positions: [],
    row_id: index,
    similarity: hit.similarity,
    tag_kwd: [],
    term_similarity: hit.similarity,
    vector_similarity: hit.similarity,
  };
}

/** `doc_aggs`：每份文档一项，次序同它在切片里首次出现。 */
function docAggs(chunks) {
  const aggs = new Map();
  for (const chunk of chunks) {
    const agg = aggs.get(chunk.document_id) ?? {
      count: 0,
      doc_id: chunk.document_id,
      doc_name: chunk.document_keyword,
    };
    agg.count += 1;
    aggs.set(chunk.document_id, agg);
  }
  return [...aggs.values()];
}

/** `failRerank` 优先于账号里的模型。 */
function rerankAnswer(state, rerankId) {
  if (rerankId === undefined) {
    return undefined;
  }
  const forced = state.retrieval.rerankFailure;
  if (forced === undefined) {
    return rerankRejection(state.models, rerankId);
  }
  return forced.message === undefined ? modelNotFound(rerankId) : failure(102, forced.message);
}

function retrieve(state, { body }) {
  if (Object.keys(body).some((field) => !FIELDS.has(field))) {
    return undefined;
  }
  const rejection = requiredRejection(body) ?? valueRejection(body);
  if (rejection !== undefined) {
    return rejection === UNRECORDED ? undefined : rejection;
  }
  const dataset = state.datasets.get(body.dataset_ids[0]);
  if (dataset === undefined) {
    return notFound();
  }
  const rerank = rerankAnswer(state, body.rerank_id);
  if (rerank !== undefined) {
    return rerank === UNRECORDED ? undefined : rerank;
  }
  const hits = state.retrieval.hits.get(dataset.id) ?? [];
  const chunks = hits.map((hit, index) => chunkOf(dataset, hit, index));
  const data = { chunks, doc_aggs: docAggs(chunks), labels: null, total: chunks.length };
  return { json: { code: 0, data, message: null } };
}

/** `[方法, 路径, 处理函数]`，同 `fake-ragflow.mjs` 的 `ROUTES`。 */
export const RETRIEVAL_ROUTES = [["POST", `${API}/retrieval`, retrieve]];

/** 用例的脚本：`state` 是 `fake-ragflow.mjs` 的整份状态，命中要按数据集找已种的文档名。 */
export function retrievalViews(state) {
  return {
    setRetrievalHits(datasetId, hits) {
      if (!state.datasets.has(datasetId)) {
        throw new Error("fake-ragflow has no such dataset");
      }
      state.retrieval.hits.set(
        datasetId,
        hits.map((hit) => ({ ...hit })),
      );
    },
    failRerank(message) {
      state.retrieval.rerankFailure = { message };
    },
  };
}
