/**
 * s2a-kb-ragflow tasks 9.8（#1870）：假 RAGFlow 数据集任务日志的自测。期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` §5.3 的字面量，不从夹具导入。这里用 `fetch` 直接打夹具，不经客户端。
 */
import { describe, expect, it } from "vitest";
import type { FakeRagflowServer } from "./support/fake-ragflow.mjs";
import { expectUnknownRoute, useFakeRagflow } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1870-fixture-key";

interface LogRow {
  id: string;
  task_type: string;
  operation_status: string;
  document_id: string;
  document_name: string;
  dsl: { entries: { doc_id: string; variants: string[] }[]; task_type: string };
}

let fake: FakeRagflowServer;
let dataset: string;
const call = useFakeRagflow(KEY, (started) => {
  fake = started;
  dataset = fake.addDataset();
});

const path = () => `/api/v1/datasets/${dataset}/ingestions`;

async function page(query: string): Promise<{ logs: LogRow[]; total: unknown }> {
  const answer = await call("GET", `${path()}?${query}`);
  expect(answer.status).toBe(200);
  expect(answer.body.code).toBe(0);
  return answer.body.data as { logs: LogRow[]; total: number };
}

/** `count` 份 `COMPLETED` 文档，每份一条 `Tree` 的 `DONE` 日志；返回文档 id，次序同日志的种子次序。 */
function seedTreeLogs(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const documentId = fake.addDocument(dataset, {
      name: `${String(index)}.txt`,
      content: "x",
      ingestionStatus: "COMPLETED",
      chunkCount: 1,
    });
    fake.addIngestionLog(dataset, { taskType: "Tree", operationStatus: "DONE", documentId });
    return documentId;
  });
}

const docIds = (logs: LogRow[]) => logs.flatMap(({ dsl }) => dsl.entries.map((e) => e.doc_id));

describe("分页（§5.3「任务日志：分页」）", () => {
  it.each([
    ["page=1&page_size=100&orderby=id", 100],
    ["page=2&page_size=100&orderby=id", 100],
    ["page=3&page_size=100&orderby=id", 0],
    ["page=21&page_size=10&orderby=id", 0],
    ["page=999&page_size=10&orderby=id", 0],
    ["page=1&orderby=id", 30],
    ["page=1&page_size=201&orderby=id", 200],
    ["page=1&page_size=100000&orderby=id", 200],
    ["page=0&page_size=50&orderby=id", 50],
    ["page=-1&page_size=50&orderby=id", 50],
  ])("%s：total 200 不变，返回 %i 行", async (query, count) => {
    seedTreeLogs(200);
    const { logs, total } = await page(query);
    expect([logs.length, total]).toEqual([count, 200]);
  });

  it("orderby=id 逐页读到 total：每行恰读到一次", async () => {
    const documents = seedTreeLogs(23);
    const read: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      read.push(...docIds((await page(`page=${String(n)}&page_size=5&orderby=id`)).logs));
    }
    expect(read.sort()).toEqual([...documents].sort());
  });

  it("page=0 与 page=-1 同第 1 页", async () => {
    seedTreeLogs(12);
    const first = (await page("page=1&page_size=5&orderby=id")).logs.map(({ id }) => id);
    expect((await page("page=0&page_size=5&orderby=id")).logs.map(({ id }) => id)).toEqual(first);
    expect((await page("page=-1&page_size=5&orderby=id")).logs.map(({ id }) => id)).toEqual(first);
  });

  it.each([
    ["page=abc&page_size=5&orderby=id", "page must be an integer"],
    ["page=1&page_size=abc&orderby=id", "page_size must be an integer"],
  ])("%s：HTTP 200，code 101", async (query, message) => {
    const answer = await call("GET", `${path()}?${query}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 101, message });
  });
});

describe("过滤（§5.3「过滤」）", () => {
  it("task_type= 不是过滤：回全部行，total 不变", async () => {
    const [tree] = seedTreeLogs(1);
    fake.addIngestionLog(dataset, {
      taskType: "Graph",
      operationStatus: "RUNNING",
      documentId: String(tree),
    });
    const { logs, total } = await page("page=1&page_size=100&orderby=id&task_type=Tree");
    expect(total).toBe(2);
    expect(logs.map(({ task_type: type }) => type).sort()).toEqual(["Graph", "Tree"]);
  });
});

describe("行（§5.3 的原文与「类型与 entries」的表）", () => {
  it("task_type、operation_status 在行上；document_id 恒为 graph_raptor_x，document_name 是类型；entries 恰 1 项", async () => {
    const [documentId] = seedTreeLogs(1);
    fake.addIngestionLog(dataset, {
      taskType: "Graph",
      operationStatus: "DONE",
      documentId: String(documentId),
    });
    const { logs } = await page("page=1&page_size=100&orderby=id");
    expect(logs).toMatchObject([
      {
        task_type: "Graph",
        operation_status: "DONE",
        document_id: "graph_raptor_x",
        document_name: "Graph",
        dsl: { task_type: "Graph", entries: [{ doc_id: documentId, variants: ["structure"] }] },
      },
      {
        task_type: "Tree",
        document_name: "Tree",
        dsl: { task_type: "Tree", entries: [{ doc_id: documentId, variants: ["tree"] }] },
      },
    ]);
  });

  it("两种都开时 variants 由种子给出", async () => {
    const [documentId] = seedTreeLogs(1);
    fake.addIngestionLog(dataset, {
      taskType: "Graph",
      operationStatus: "DONE",
      documentId: String(documentId),
      variants: ["structure", "tree"],
    });
    const { logs } = await page("page=1&page_size=100&orderby=id");
    expect(logs[0]?.dsl.entries[0]?.variants).toEqual(["structure", "tree"]);
  });

  it("不存在的数据集回 404", async () => {
    const answer = await call(
      "GET",
      "/api/v1/datasets/0123456789abcdef0123456789abcdef/ingestions?page=1&page_size=100&orderby=id",
    );
    expect(answer.body).toMatchObject({ code: 404 });
  });
});

describe("记录里没有的", () => {
  it.each([
    ["page=1&page_size=100"],
    ["page=1&page_size=100&orderby=create_time"],
    ["page=1&page_size=100&orderby=update_time"],
    ["page_size=100&orderby=id"],
    ["page=1&page_size=0&orderby=id"],
    ["page=1&page_size=-1&orderby=id"],
    ["page=1&page_size=100&orderby=id&keywords=Tree"],
    ["page=1&page_size=100&orderby=id&log_type=file"],
    ["page=1&page_size=100&orderby=id&operation_status=DONE"],
    ["page=1&page_size=100&orderby=id&desc=false"],
  ])("%s：未知路由", async (query) => {
    const answer = await call("GET", `${path()}?${query}`);
    expectUnknownRoute(fake, answer, path());
  });

  it("种子只收 Tree / Graph、RUNNING / DONE，COMPLETED 且切片非 0 的文档，每种类型一条", () => {
    const [done] = seedTreeLogs(1);
    const empty = fake.addDocument(dataset, {
      name: "e.txt",
      content: "x",
      ingestionStatus: "COMPLETED",
    });
    const running = fake.addDocument(dataset, {
      name: "r.txt",
      content: "x",
      ingestionStatus: "RUNNING",
    });
    const seeds = [
      { taskType: "Wiki", operationStatus: "DONE", documentId: String(done) },
      { taskType: "Graph", operationStatus: "FAILED", documentId: String(done) },
      { taskType: "Tree", operationStatus: "DONE", documentId: String(done) },
      { taskType: "Tree", operationStatus: "DONE", documentId: empty },
      { taskType: "Tree", operationStatus: "DONE", documentId: running },
    ] as const;
    for (const seed of seeds) {
      expect(() => fake.addIngestionLog(dataset, seed as never)).toThrow(/fake-ragflow/u);
    }
  });
});
