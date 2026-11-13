/**
 * RAGFlow 客户端的检索一块（`ragflow-client.ts` 的兄弟文件，s2b-kb-retrieval D2、D3；实测记录续篇 §19.1、§19.4）：
 * `POST /api/v1/retrieval`。`retrievalCalls` 只在 `createRagflowClient` 里调用，`json` 经闭包参数交进来。
 *
 * - body 整份在这里拼，恰为 D2 的形状：阈值与权重恒显式传，`page:1`、`page_size:6`；`rerank_id` 只在给了时带，不发 `null`；
 *   `top_k`、`keyword`、`highlight`、`use_kg`、`document_ids` 都不发。
 * - 路由专属组合：HTTP 200 的 `code:102` 是「检索失败」，只看 code、不看 message（message 原样带出上游错误体，§19.4）。
 *   其余照通用映射：`code:101` 为 `kb_rejected`，`code:404` 与其它为 `kb_unavailable`；挂起超期同样是 `kb_unavailable`。
 * - `code:0` 时读 `data.chunks`：须是数组（零命中为 `[]`），每项须有非空字符串 `document_id`、字符串 `content` 与数字
 *   `similarity`，读不到即「成功应答缺字段」。其余十三个切片键与 `doc_aggs`、`labels`、`total` 都丢弃。
 * - 中止（s2c-kb-session D6）：`signal` 原样交给 `json`，与重建器的方法同一写法：已中止的不发出，进行中被中止即放弃连接，
 *   结果与期限到期相同，为 `kb_unavailable`。
 */
import {
  API,
  fieldOf,
  isNonEmptyString,
  type JsonCall,
  type Result,
  type Route,
  UNAVAILABLE,
  usable,
} from "./ragflow-route.js";

const RETRIEVAL_FAILED = { kind: "retrieval_failed" } as const;
const PAGE_SIZE = 6;

/** 一条命中切片。`ragflowDocumentId` 是 RAGFlow 侧的文档 id，与本地文档 id 区分（D2 的关联在调用点）。 */
export interface RetrievalChunk {
  ragflowDocumentId: string;
  content: string;
  similarity: number;
}

export interface RetrievalQuery {
  question: string;
  datasetId: string;
  threshold: number;
  vectorWeight: number;
  /** 三段式 `<名称>@<实例>@<提供方>`；不给就不带重排。 */
  rerankId?: string;
  /** 调用方的中止信号；不给就只受期限管。 */
  signal?: AbortSignal | undefined;
}

function chunkOf(row: unknown): RetrievalChunk | undefined {
  const ragflowDocumentId = fieldOf(row, "document_id");
  const content = fieldOf(row, "content");
  const similarity = fieldOf(row, "similarity");
  return isNonEmptyString(ragflowDocumentId) &&
    typeof content === "string" &&
    typeof similarity === "number"
    ? { ragflowDocumentId, content, similarity }
    : undefined;
}

const RETRIEVE: Route<RetrievalChunk[], typeof RETRIEVAL_FAILED> = {
  typed: (envelope) => (envelope.code === 102 ? RETRIEVAL_FAILED : undefined),
  read(data) {
    const rows = fieldOf(data, "chunks");
    if (!Array.isArray(rows)) {
      return undefined;
    }
    const chunks = rows.flatMap((row: unknown) => chunkOf(row) ?? []);
    return chunks.length === rows.length ? chunks : undefined;
  },
};

/** 客户端的检索方法；`json` 是 `createRagflowClient` 里的 JSON 调用。 */
export function retrievalCalls(json: JsonCall) {
  return {
    /** 对一个数据集的一次检索。重排降级的重试由调用点做：不带 `rerankId` 再调一次。 */
    async retrieve(
      query: RetrievalQuery,
    ): Promise<Result<RetrievalChunk[], typeof RETRIEVAL_FAILED>> {
      if (!usable(query.datasetId)) {
        return UNAVAILABLE;
      }
      const body = {
        question: query.question,
        dataset_ids: [query.datasetId],
        similarity_threshold: query.threshold,
        vector_similarity_weight: query.vectorWeight,
        page: 1,
        page_size: PAGE_SIZE,
        ...(query.rerankId === undefined ? {} : { rerank_id: query.rerankId }),
      };
      return json("POST", `${API}/retrieval`, RETRIEVE, body, query.signal);
    },
  };
}
