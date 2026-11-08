/** 一条脚本化的检索命中（`setRetrievalHits`）：切片的其余十三个 §19.1 键由夹具补齐。 */
export interface FakeRagflowRetrievalHit {
  /** 切片的 `document_id`；数据集里种了这份文档时，`document_keyword` 取它的名称。 */
  documentId: string;
  content: string;
  /** 三个分数同值（§19.1 不带重排时恒等）。 */
  similarity: number;
}
