/**
 * s2b-kb-retrieval tasks 4.1（#1916）：单轮检索 `retrieveForBase` 直接调用，真实 SQLite 与 store，接假 RAGFlow 与真实客户端
 * （knowledge-bases「单轮检索」的「参数显式传」「命中关联本地文档」「应答缺字段」「零命中」，design D1、D2、D3）。
 * 期望值是 spec 与 design 的字面量与本文件种下的本地行；不从 `src/` 取期望值。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { type RetrievalHit, retrieveForBase } from "../src/kb/retrieval.js";
import type { KnowledgeBase } from "../src/kb/store.js";
import { hex, PLAIN_BASE, type Store, useKbDatabases } from "./kb-store-helpers.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1916-ragflow-key";
const SENTINEL = "wb-issue1916-message-sentinel";
const ROUTE = "POST /api/v1/retrieval";
const UNAVAILABLE = { kind: "kb_unavailable" };
const REJECTED = { kind: "kb_rejected" };

const fresh = useKbDatabases();

let fake: FakeRagflowServer;
let store: Store;
let deps: Parameters<typeof retrieveForBase>[0];
let dataset: string;
let base: KnowledgeBase;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
  store = fresh().store;
  deps = {
    store,
    client: createRagflowClient({ baseUrl: fake.baseUrl, key: { read: () => KEY }, log: () => {} }),
  };
  dataset = fake.addDataset();
  base = store.createBase({ ...PLAIN_BASE, id: hex(1), name: "产品文档", datasetId: dataset });
});

afterEach(async () => {
  try {
    expect(fake.unknownRoutes()).toEqual([]);
  } finally {
    await fake.close();
  }
});

function addLocal(kbId: string, ragflowDocumentId: string, name: string) {
  return store.addDocument({ kbId, ragflowDocumentId, name, size: 3, source: "upload" });
}

const ok = (value: RetrievalHit[]) => ({ kind: "ok", value });

describe("参数显式传（design D2）", () => {
  it("库的检索参数 0.35 / 0.5：恰一次请求，body 恰为 D2 形状，没有 rerank_id", async () => {
    const saved = store.saveRetrieval(base.id, { threshold: 0.35, vectorWeight: 0.5 });
    expect(saved).toBeDefined();
    await retrieveForBase(deps, saved as KnowledgeBase, "工单超时");
    const sent = fake.requests();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api/v1/retrieval" });
    expect(sent[0]?.json).toEqual({
      question: "工单超时",
      dataset_ids: [dataset],
      similarity_threshold: 0.35,
      vector_similarity_weight: 0.5,
      page: 1,
      page_size: 6,
    });
  });

  it("新建库的缺省参数 0.2 / 0.7 照样显式传", async () => {
    await retrieveForBase(deps, base, "q");
    expect(fake.requests()[0]?.json).toMatchObject({
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.7,
    });
  });

  it("库在重建中（rebuildDatasetId 非空）：dataset_ids 仍是当前 datasetId", async () => {
    const next = fake.addDataset();
    const rebuilding = store.setRebuildGeneration(base.id, {
      datasetId: next,
      canvasId: null,
      templateGroupId: null,
    });
    expect(rebuilding?.rebuildDatasetId).toBe(next);
    await retrieveForBase(deps, rebuilding as KnowledgeBase, "q");
    expect(fake.requests()[0]?.json).toMatchObject({ dataset_ids: [dataset] });
  });
});

describe("命中关联本地文档（design D2）", () => {
  it("三条切片：前两条关联本地行，第三条没有本地行被丢弃；名称取本地记录，次序同应答", async () => {
    const notesRf = fake.addDocument(dataset, { name: "notes(1).md", content: "n" });
    const briefRf = fake.addDocument(dataset, { name: "brief.pdf", content: "b" });
    const brief = addLocal(base.id, briefRf, "brief.pdf");
    const notes = addLocal(base.id, notesRf, "notes.md");
    fake.setRetrievalHits(dataset, [
      { documentId: notesRf, content: "# 超时口径", similarity: 0.61 },
      { documentId: briefRf, content: "工单 SLA", similarity: 0.42 },
      { documentId: "rf-orphan", content: "无本地行", similarity: 0.9 },
    ]);
    await expect(retrieveForBase(deps, base, "工单超时")).resolves.toEqual(
      ok([
        { documentId: notes.id, name: "notes.md", similarity: 0.61, content: "# 超时口径" },
        { documentId: brief.id, name: "brief.pdf", similarity: 0.42, content: "工单 SLA" },
      ]),
    );
  });

  it("同一本地文档两条切片：两条命中，不去重，次序同应答", async () => {
    const doc = addLocal(base.id, "rf-a", "a.md");
    fake.setRetrievalHits(dataset, [
      { documentId: "rf-a", content: "第二段", similarity: 0.3 },
      { documentId: "rf-a", content: "第一段", similarity: 0.8 },
    ]);
    await expect(retrieveForBase(deps, base, "q")).resolves.toEqual(
      ok([
        { documentId: doc.id, name: "a.md", similarity: 0.3, content: "第二段" },
        { documentId: doc.id, name: "a.md", similarity: 0.8, content: "第一段" },
      ]),
    );
  });

  it("切片的 document_id 只对得上另一个库的本地行：丢弃，不泄露别人的文档名", async () => {
    const other = store.createBase({
      ...PLAIN_BASE,
      id: hex(2),
      ownerId: "u2",
      name: "别人的库",
      datasetId: fake.addDataset(),
    });
    addLocal(other.id, "rf-foreign", "secret-plan.md");
    const mine = addLocal(base.id, "rf-mine", "mine.md");
    fake.setRetrievalHits(dataset, [
      { documentId: "rf-foreign", content: "别人的内容", similarity: 0.9 },
      { documentId: "rf-mine", content: "我的内容", similarity: 0.5 },
    ]);
    const result = await retrieveForBase(deps, base, "q");
    expect(result).toEqual(
      ok([{ documentId: mine.id, name: "mine.md", similarity: 0.5, content: "我的内容" }]),
    );
    expect(JSON.stringify(result)).not.toContain("secret-plan.md");
  });

  it("全部命中关联不上：空数组，不是错误", async () => {
    addLocal(base.id, "rf-local", "local.md");
    fake.setRetrievalHits(dataset, [
      { documentId: "rf-x", content: "x", similarity: 0.7 },
      { documentId: "rf-y", content: "y", similarity: 0.6 },
    ]);
    await expect(retrieveForBase(deps, base, "q")).resolves.toEqual(ok([]));
  });

  it("零命中（§19.1 原样应答）：空数组，不是 kb_unavailable", async () => {
    addLocal(base.id, "rf-local", "local.md");
    await expect(retrieveForBase(deps, base, "q")).resolves.toEqual(ok([]));
  });
});

describe("失败映射（design D3）", () => {
  it("应答缺字段（某条切片缺 similarity）：kb_unavailable", async () => {
    addLocal(base.id, "rf-a", "a.md");
    fake.fault(ROUTE, {
      kind: "combo",
      code: 0,
      data: {
        chunks: [{ document_id: "rf-a", content: "c" }],
        doc_aggs: [],
        labels: null,
        total: 1,
      },
    });
    await expect(retrieveForBase(deps, base, "q")).resolves.toEqual(UNAVAILABLE);
  });

  it("HTTP 200 code:102（未带重排）：kb_unavailable，不带 message", async () => {
    fake.answer(ROUTE, { code: 102, message: `retrieval search failed: ${SENTINEL}` });
    const result = await retrieveForBase(deps, base, "q");
    expect(result).toEqual(UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(fake.requests()).toHaveLength(1);
  });

  it("code:101：kb_rejected，不带 message", async () => {
    fake.answer(ROUTE, { code: 101, message: SENTINEL });
    const result = await retrieveForBase(deps, base, "q");
    expect(result).toEqual(REJECTED);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
