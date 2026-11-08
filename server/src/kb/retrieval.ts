/**
 * 单轮检索（s2b-kb-retrieval D1、D2、D3；knowledge-bases「单轮检索」，ADR-0017）：kb 模块里唯一的检索实现。检索测试端点
 * 与 S2c 的会话内检索工具都只经 `retrieveForBase` 检索；这里没有改写问句、充分性判定与第二轮。
 *
 * - 请求：对该库当前的 `datasetId`（不是 `rebuildDatasetId`）调一次客户端的检索方法，阈值与向量权重取该库行上已存的值，
 *   恒显式传，调用方不逐次覆盖。不判 `state`：`state` 的判定只约束检索测试端点（D4）。
 * - 映射：「检索失败」（本刀不带重排）为 `kb_unavailable`（D3）；`kb_rejected` / `kb_unavailable` 原样。调用方照 `bases.ts`
 *   的写法 `throw new HttpError(result.kind)`。
 * - 命中关联：切片的 RAGFlow 文档 id 只对本库的本地文档行（`listDocuments(base.id)`）关联，名称取本地记录；关联不上的丢弃，
 *   不暴露 RAGFlow 侧或别的库的文档名。同一文档的多条切片各成一条命中，次序同应答。零候选或全部丢弃时为空数组。
 */
import type { createRagflowClient } from "./ragflow-client.js";
import { type Result, UNAVAILABLE } from "./ragflow-route.js";
import type { createKbStore, KbDocument, KnowledgeBase } from "./store.js";

/** 一条命中（D2）：`documentId` 是本地文档 id，`similarity` 与 `content` 原样取 RAGFlow 的值。 */
export interface RetrievalHit {
  documentId: string;
  name: string;
  similarity: number;
  content: string;
}

interface RetrievalDependencies {
  store: Pick<ReturnType<typeof createKbStore>, "listDocuments">;
  client: Pick<ReturnType<typeof createRagflowClient>, "retrieve">;
}

/** 对一个知识库的一次检索。 */
export async function retrieveForBase(
  deps: RetrievalDependencies,
  base: KnowledgeBase,
  question: string,
): Promise<Result<RetrievalHit[]>> {
  const result = await deps.client.retrieve({
    question,
    datasetId: base.datasetId,
    threshold: base.retrievalThreshold,
    vectorWeight: base.retrievalVectorWeight,
  });
  if (result.kind === "retrieval_failed") {
    return UNAVAILABLE;
  }
  if (result.kind !== "ok") {
    return result;
  }
  const local = new Map<string, KbDocument>(
    deps.store.listDocuments(base.id).map((document) => [document.ragflowDocumentId, document]),
  );
  const hits = result.value.flatMap((chunk): RetrievalHit[] => {
    const document = local.get(chunk.ragflowDocumentId);
    return document === undefined
      ? []
      : [
          {
            documentId: document.id,
            name: document.name,
            similarity: chunk.similarity,
            content: chunk.content,
          },
        ];
  });
  return { kind: "ok", value: hits };
}
