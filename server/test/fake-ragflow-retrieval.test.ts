/**
 * s2b-kb-retrieval tasks 3.2（#1913）：假 RAGFlow 检索路由的自测。期望值都是实测记录续篇
 * `docs/reviews/2026-11-08-ragflow-rc2-retrieval.md` §19.1、§19.4 的字面量，不从夹具导入；用 `fetch` 直接打夹具，不经客户端。
 * 每例结束时断言没有请求落到未知路由：路由没挂上时 §12 的 404 不能让用例假通过。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FakeRagflowServer } from "./support/fake-ragflow.mjs";
import { expectUnknownRoute, useFakeRagflow } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1913-fixture-key";
const ROUTE = "POST /api/v1/retrieval";
const PATH = "/api/v1/retrieval";
const ABSENT = "0123456789abcdef0123456789abcdef";
const PROVIDER = "OpenAI-API-Compatible";
/** §19.1 的零命中应答原样。 */
const ZERO_HITS =
  '{"code":0,"data":{"chunks":[],"doc_aggs":[],"labels":null,"total":0},"message":null}';
/** §19.1 的切片键，恰十六个。 */
const CHUNK_KEYS = [
  "content",
  "content_ltks",
  "dataset_id",
  "doc_type_kwd",
  "document_id",
  "document_keyword",
  "id",
  "image_id",
  "important_keywords",
  "mom_id",
  "positions",
  "row_id",
  "similarity",
  "tag_kwd",
  "term_similarity",
  "vector_similarity",
];
const REQUIRED = (field: string) =>
  `Key: 'SearchDatasetsRequest.${field}' Error:Field validation for '${field}' failed on the 'required' tag`;
/** §19.4 第三行的前缀。 */
const RERANK_FAILED = "failed to get rerank model";

let fake: FakeRagflowServer;
let dataset: string;
let unknownExpected: boolean;
const call = useFakeRagflow(KEY, (started) => {
  fake = started;
  dataset = fake.addDataset();
  unknownExpected = false;
});

afterEach(() => {
  if (!unknownExpected) {
    expect(fake.unknownRoutes()).toEqual([]);
  }
});

type Chunk = Record<string, unknown>;

const retrieve = (json: Record<string, unknown>) => call("POST", PATH, { json });
const question = (extra: Record<string, unknown> = {}) => ({
  question: "销售额怎么统计",
  dataset_ids: [dataset],
  ...extra,
});

describe("参数非法（§19.1 的表，一律 HTTP 200）", () => {
  it.each<[string, (body: Record<string, unknown>) => Record<string, unknown>, string]>([
    [
      "similarity_threshold:1.5",
      (body) => ({ ...body, similarity_threshold: 1.5 }),
      "similarity_threshold must be between 0 and 1",
    ],
    [
      "vector_similarity_weight:-1",
      (body) => ({ ...body, vector_similarity_weight: -1 }),
      "vector_similarity_weight must be between 0 and 1",
    ],
    [
      "page_size:0",
      (body) => ({ ...body, page_size: 0 }),
      "page_size must be greater than or equal to 1",
    ],
    ['question:""', (body) => ({ ...body, question: "" }), REQUIRED("Question")],
    ["缺 dataset_ids", ({ dataset_ids: _ignored, ...body }) => body, REQUIRED("DatasetIDs")],
  ])("%s：code 101 与原样 message", async (_label, edit, message) => {
    const answer = await retrieve(edit(question()));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 101, message });
  });

  it('similarity_threshold:"0.1"（字符串）：code 101，message 以记录的原文开头', async () => {
    const answer = await retrieve(question({ similarity_threshold: "0.1" }));
    expect(answer.status).toBe(200);
    expect(answer.body.code).toBe(101);
    expect(String(answer.body.message)).toMatch(/^Mismatch type float64 with value number/u);
  });

  it("不存在的数据集 id：HTTP 200、code 404、Resource not found", async () => {
    const answer = await retrieve(question({ dataset_ids: [ABSENT] }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 404, message: "Resource not found" });
  });
});

describe("应答形状（§19.1）", () => {
  it("零命中：应答原样，含 message:null", async () => {
    const answer = await retrieve(question());
    expect(answer.status).toBe(200);
    expect(answer.text).toBe(ZERO_HITS);
  });

  it("带命中：data 恰四键、切片恰十六键，次序同脚本，三个分数同值", async () => {
    const sales = fake.addDocument(dataset, { name: "sales.md", content: "x" });
    fake.setRetrievalHits(dataset, [
      { documentId: sales, content: "# 销售额口径", similarity: 0.2028 },
      { documentId: "unseeded-document", content: "第二条", similarity: 0.1 },
    ]);
    const answer = await retrieve(question());
    expect(answer.status).toBe(200);
    expect(answer.body.code).toBe(0);
    expect(answer.body.message).toBeNull();
    const data = answer.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["chunks", "doc_aggs", "labels", "total"]);
    expect(data.labels).toBeNull();
    expect(data.total).toBe(2);
    const chunks = data.chunks as Chunk[];
    for (const chunk of chunks) {
      expect(Object.keys(chunk).sort()).toEqual(CHUNK_KEYS);
      expect(chunk.dataset_id).toBe(dataset);
      expect(chunk.term_similarity).toBe(chunk.similarity);
      expect(chunk.vector_similarity).toBe(chunk.similarity);
    }
    expect(
      chunks.map(({ document_id, content, similarity }) => [document_id, content, similarity]),
    ).toEqual([
      [sales, "# 销售额口径", 0.2028],
      ["unseeded-document", "第二条", 0.1],
    ]);
    expect(chunks[0]?.document_keyword).toBe("sales.md");
    expect(typeof chunks[1]?.document_keyword).toBe("string");
    expect(data.doc_aggs).toEqual([
      { count: 1, doc_id: sales, doc_name: "sales.md" },
      { count: 1, doc_id: "unseeded-document", doc_name: chunks[1]?.document_keyword },
    ]);
  });

  it("命中只属于脚本化的那个数据集", async () => {
    const other = fake.addDataset("owb-other");
    fake.setRetrievalHits(other, [{ documentId: "d", content: "c", similarity: 0.5 }]);
    const answer = await retrieve(question());
    expect(answer.text).toBe(ZERO_HITS);
  });

  it("记录收到的 JSON body", async () => {
    const body = question({ similarity_threshold: 0.2, vector_similarity_weight: 0.3 });
    await retrieve({ ...body, page: 1, page_size: 6 });
    expect(fake.requests()[0]?.json).toEqual({ ...body, page: 1, page_size: 6 });
  });
});

describe("rerank_id（§19.3、§19.4）", () => {
  const reference = (instance: string, name: string) => `${name}@${instance}@${PROVIDER}`;

  it("实例里没有这个模型：HTTP 200、code 102", async () => {
    fake.addModel("owb-rerank", "other-rerank", "rerank");
    const rerankId = reference("owb-rerank", "qwen3-rerank");
    const answer = await retrieve(question({ rerank_id: rerankId }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 102,
      message: `failed to get rerank model by rerank_id: model configuration unavailable: model config not found: ${rerankId}`,
    });
  });

  it("两段式 rerank_id：code 102，provider 是实例名", async () => {
    fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
    const answer = await retrieve(question({ rerank_id: "qwen3-rerank@owb-rerank" }));
    expect(answer.body).toMatchObject({
      code: 102,
      message:
        'failed to get rerank model by rerank_id: model configuration unavailable: provider "owb-rerank" lookup failed: record not found',
    });
  });

  it("账号里有这个重排模型：code 0 与脚本化的命中", async () => {
    fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
    fake.setRetrievalHits(dataset, [{ documentId: "d", content: "c", similarity: 0.5 }]);
    const answer = await retrieve(question({ rerank_id: reference("owb-rerank", "qwen3-rerank") }));
    expect(answer.body.code).toBe(0);
    expect((answer.body.data as { total: number }).total).toBe(1);
  });
});

describe("故障注入", () => {
  it("failRerank：此后每个带 rerank_id 的请求都是 code 102，缺省 message 是 §19.4 的前缀原文", async () => {
    fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
    fake.failRerank();
    const rerankId = `qwen3-rerank@owb-rerank@${PROVIDER}`;
    for (let round = 0; round < 3; round += 1) {
      const answer = await retrieve(question({ rerank_id: rerankId }));
      expect(answer.status).toBe(200);
      expect(answer.body.code).toBe(102);
      expect(String(answer.body.message)).toMatch(new RegExp(`^${RERANK_FAILED}`, "u"));
    }
  });

  it("failRerank 不影响不带 rerank_id 的请求，message 可自定", async () => {
    fake.setRetrievalHits(dataset, [{ documentId: "d", content: "c", similarity: 0.5 }]);
    fake.failRerank("retrieval search failed: wb-issue1913-sentinel");
    const plain = await retrieve(question());
    expect(plain.body.code).toBe(0);
    const reranked = await retrieve(question({ rerank_id: `m@i@${PROVIDER}` }));
    expect(reranked.body).toMatchObject({
      code: 102,
      message: "retrieval search failed: wb-issue1913-sentinel",
    });
  });

  it.each([[101], [102]])("answer 注入 code %i：带不带 rerank_id 都是它", async (code) => {
    fake.answer(ROUTE, { code, message: "scripted" }, { times: 2 });
    const plain = await retrieve(question());
    const reranked = await retrieve(question({ rerank_id: `m@i@${PROVIDER}` }));
    for (const answer of [plain, reranked]) {
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ code, message: "scripted" });
    }
  });
});

describe("记录里没有的请求落到未知路由", () => {
  it.each<[string, () => Record<string, unknown>]>([
    ["top_k 等未实现效果的参数", () => ({ top_k: 2 })],
    ["跨库（§19.6 没有实现）", () => ({ dataset_ids: [dataset, fake.addDataset("owb-other")] })],
    ["实例不存在的 rerank_id（§19.4 没有测）", () => ({ rerank_id: `m@absent@${PROVIDER}` })],
  ])("%s", async (_label, extra) => {
    unknownExpected = true;
    expectUnknownRoute(fake, await retrieve(question(extra())), PATH);
  });

  it("别的方法照旧回 404 并标 unknown", async () => {
    unknownExpected = true;
    expectUnknownRoute(fake, await call("GET", PATH), PATH);
  });
});
