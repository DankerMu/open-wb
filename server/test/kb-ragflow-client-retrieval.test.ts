/**
 * s2b-kb-retrieval tasks 3.3（#1913）：RAGFlow 客户端的检索调用，打假 RAGFlow（ragflow-backend「RAGFlow 出站请求」的
 * `POST /retrieval` 一行与「检索失败的映射」，design D2、D3）。请求形状是 D2 的字面量，应答是实测记录续篇 §19.1、§19.4 的
 * 字面量，映射是 spec 的通用五条加检索的路由专属组合；不从 `src/` 取期望值。
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1913-client-key";
const SENTINEL = "wb-issue1913-message-sentinel";
const ROUTE = "POST /api/v1/retrieval";
const ABSENT = "0123456789abcdef0123456789abcdef";
const RERANK_ID = "qwen3-rerank@owb-rerank@OpenAI-API-Compatible";
const UNAVAILABLE = { kind: "kb_unavailable" };
const REJECTED = { kind: "kb_rejected" };
const RETRIEVAL_FAILED = { kind: "retrieval_failed" };

type Client = ReturnType<typeof createRagflowClient>;

let fake: FakeRagflowServer;
let client: Client;
let dataset: string;
let logged: unknown[];
let stderr: MockInstance<typeof process.stderr.write>;

function clientOf(deadlines: Record<string, number> = {}): Client {
  return createRagflowClient({
    baseUrl: fake.baseUrl,
    key: { read: () => KEY },
    log: (record) => {
      logged.push(record);
    },
    deadlines,
  });
}

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
  dataset = fake.addDataset();
  logged = [];
  stderr = vi.spyOn(process.stderr, "write");
  client = clientOf();
});

afterEach(async () => {
  stderr.mockRestore();
  try {
    expect(fake.unknownRoutes()).toEqual([]);
  } finally {
    await fake.close();
  }
});

const query = (extra: { rerankId?: string; threshold?: number; datasetId?: string } = {}) => ({
  question: "销售额怎么统计",
  datasetId: extra.datasetId ?? dataset,
  threshold: extra.threshold ?? 0.2,
  vectorWeight: 0.3,
  ...(extra.rerankId === undefined ? {} : { rerankId: extra.rerankId }),
});

/** D2 的 body，恰这些键。 */
const D2_BODY = () => ({
  question: "销售额怎么统计",
  dataset_ids: [dataset],
  similarity_threshold: 0.2,
  vector_similarity_weight: 0.3,
  page: 1,
  page_size: 6,
});

describe("请求（design D2）", () => {
  it("不带 rerankId：POST /api/v1/retrieval，body 恰为 D2 形状，没有 rerank_id 键", async () => {
    await client.retrieve(query());
    const [sent] = fake.requests();
    expect(sent).toMatchObject({ method: "POST", path: "/api/v1/retrieval", bearer: "ok" });
    expect(sent?.json).toEqual(D2_BODY());
    expect(Object.keys(sent?.json as object)).not.toContain("rerank_id");
  });

  it("带 rerankId：D2 形状多一键 rerank_id", async () => {
    fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
    await client.retrieve(query({ rerankId: RERANK_ID }));
    expect(fake.requests()[0]?.json).toEqual({ ...D2_BODY(), rerank_id: RERANK_ID });
  });

  it.each([[""], ["."], [".."]])("拼不出路由的数据集 id %j：kb_unavailable，不发出", async (id) => {
    await expect(client.retrieve(query({ datasetId: id }))).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toEqual([]);
  });
});

describe("成功应答（§19.1）", () => {
  it("读出每条切片的三个字段，次序同应答，其余键丢弃", async () => {
    const sales = fake.addDocument(dataset, { name: "sales.md", content: "x" });
    fake.setRetrievalHits(dataset, [
      { documentId: sales, content: "# 销售额口径", similarity: 0.2028 },
      { documentId: "second-document", content: "第二条", similarity: 0.1 },
    ]);
    await expect(client.retrieve(query())).resolves.toEqual({
      kind: "ok",
      value: [
        { ragflowDocumentId: sales, content: "# 销售额口径", similarity: 0.2028 },
        { ragflowDocumentId: "second-document", content: "第二条", similarity: 0.1 },
      ],
    });
  });

  it("零命中：空数组", async () => {
    await expect(client.retrieve(query())).resolves.toEqual({ kind: "ok", value: [] });
  });

  it("带 rerankId 且重排模型可用：照常读出", async () => {
    fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
    fake.setRetrievalHits(dataset, [{ documentId: "d", content: "c", similarity: 0.5 }]);
    await expect(client.retrieve(query({ rerankId: RERANK_ID }))).resolves.toEqual({
      kind: "ok",
      value: [{ ragflowDocumentId: "d", content: "c", similarity: 0.5 }],
    });
  });
});

describe("结果映射（design D3）", () => {
  it("rerank_id 指向实例里没有的模型（§19.4 的 code:102）：检索失败", async () => {
    fake.addModel("owb-rerank", "other-rerank", "rerank");
    await expect(client.retrieve(query({ rerankId: RERANK_ID }))).resolves.toEqual(
      RETRIEVAL_FAILED,
    );
  });

  it("failRerank：带 rerankId 的是检索失败，不带的照常", async () => {
    fake.failRerank();
    await expect(client.retrieve(query({ rerankId: RERANK_ID }))).resolves.toEqual(
      RETRIEVAL_FAILED,
    );
    await expect(client.retrieve(query())).resolves.toEqual({ kind: "ok", value: [] });
  });

  it("不带 rerankId 的 code:102 同样是检索失败：只看 code", async () => {
    fake.answer(ROUTE, { code: 102, message: "retrieval search failed: x" });
    await expect(client.retrieve(query())).resolves.toEqual(RETRIEVAL_FAILED);
  });

  it("参数非法的 code:101（§19.1 的表）：kb_rejected", async () => {
    await expect(client.retrieve(query({ threshold: 1.5 }))).resolves.toEqual(REJECTED);
  });

  it("不存在的数据集（HTTP 200 code:404）：kb_unavailable，不是检索失败", async () => {
    await expect(client.retrieve(query({ datasetId: ABSENT }))).resolves.toEqual(UNAVAILABLE);
  });

  it("HTTP 404 + code:404：kb_unavailable", async () => {
    fake.answer(ROUTE, { status: 404, code: 404, message: "Resource not found" });
    await expect(client.retrieve(query())).resolves.toEqual(UNAVAILABLE);
  });

  it("非 200 的 code:102 不是检索失败：路由专属组合只认 HTTP 200，落到通用第 3 条", async () => {
    const body = JSON.stringify({ code: 102, message: "retrieval search failed: x" });
    fake.fault(ROUTE, { kind: "status", status: 500, body });
    await expect(client.retrieve(query())).resolves.toEqual(REJECTED);
  });

  it("挂起超过总期限：kb_unavailable，不是检索失败，只发一次", async () => {
    client = clientOf({ totalMs: 50 });
    fake.fault(ROUTE, { kind: "hang" });
    await expect(client.retrieve(query({ rerankId: RERANK_ID }))).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toHaveLength(1);
  });
});

describe("成功应答缺字段：kb_unavailable", () => {
  const chunk = { document_id: "d", content: "c", similarity: 0.5 };
  it.each<[string, unknown]>([
    ["chunks 是 null", { chunks: null, doc_aggs: [], labels: null, total: 0 }],
    ["没有 chunks", { doc_aggs: [], labels: null, total: 0 }],
    ["data 不是对象", null],
    ["缺 similarity", { chunks: [{ document_id: "d", content: "c" }] }],
    ["similarity 是字符串", { chunks: [{ ...chunk, similarity: "0.5" }] }],
    ["缺 content", { chunks: [{ document_id: "d", similarity: 0.5 }] }],
    ["content 是数字", { chunks: [{ ...chunk, content: 1 }] }],
    ["缺 document_id", { chunks: [{ content: "c", similarity: 0.5 }] }],
    ["document_id 是空串", { chunks: [{ ...chunk, document_id: "" }] }],
    ["一条好一条缺", { chunks: [chunk, { document_id: "e", content: "c" }] }],
  ])("%s", async (_label, data) => {
    fake.fault(ROUTE, { kind: "combo", code: 0, data });
    await expect(client.retrieve(query())).resolves.toEqual(UNAVAILABLE);
  });
});

describe("RAGFlow 的 message 不进结果与 stderr（凭证泄露）", () => {
  it.each<[string, () => void, { rerankId?: string }]>([
    [
      "failRerank 的 102",
      () => fake.failRerank(`retrieval search failed: ${SENTINEL}`),
      { rerankId: RERANK_ID },
    ],
    ["脚本化的 101", () => fake.answer(ROUTE, { code: 101, message: SENTINEL }), {}],
    ["脚本化的 404", () => fake.answer(ROUTE, { code: 404, message: SENTINEL }), {}],
    [
      "HTTP 500 的 102",
      () =>
        fake.fault(ROUTE, {
          kind: "status",
          status: 500,
          body: JSON.stringify({ code: 102, message: SENTINEL }),
        }),
      {},
    ],
    [
      "缺字段的 code:0",
      () =>
        fake.fault(ROUTE, { kind: "combo", code: 0, data: { chunks: [{}] }, message: SENTINEL }),
      {},
    ],
  ])("%s：结果、日志与 stderr 都没有哨兵与 key", async (_label, arrange, extra) => {
    arrange();
    const result = await client.retrieve(query(extra));
    expect(result.kind).not.toBe("ok");
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    for (const text of [JSON.stringify(result), JSON.stringify(logged), written]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(KEY);
    }
  });
});
