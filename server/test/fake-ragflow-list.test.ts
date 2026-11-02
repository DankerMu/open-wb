/**
 * s2a-kb-ragflow tasks 11.2（#1848）：假 RAGFlow 文档列表的自测：分页、次序与八种运行状态。期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` §8.3、§8.4 的字面量，不从夹具导入。这里用 `fetch` 直接打夹具，不经客户端。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { callFake, expectUnknownRoute } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1848-fixture-key";
const LIST = "GET /api/v1/datasets/*/documents";

interface Row {
  id: string;
  name: string;
  status: string;
  ingestion_status: string;
  chunk_count: number;
  create_time: number;
  latest_ingestion_event?: { message: string };
}

let fake: FakeRagflowServer;
let dataset: string;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
  dataset = fake.addDataset();
});

afterEach(async () => {
  await fake.close();
});

const path = () => `/api/v1/datasets/${dataset}/documents`;

async function list(query: string): Promise<{ code: unknown; rows: Row[]; total: unknown }> {
  const answer = await callFake(fake.baseUrl, KEY, "GET", `${path()}?${query}`);
  expect(answer.status).toBe(200);
  const data = answer.body.data as { docs: Row[]; total: number };
  return { code: answer.body.code, rows: data.docs, total: data.total };
}

function seedSixteen(): string[] {
  return Array.from({ length: 16 }, (_, index) =>
    fake.addDocument(dataset, { name: `${String(index)}.txt`, content: "x" }),
  );
}

describe("分页（§8.3 的表）", () => {
  it.each([
    ["page=1&page_size=5", 5],
    ["page=4&page_size=5", 1],
    ["page=999&page_size=5", 0],
    ["page=1&page_size=100", 16],
    ["page=1&page_size=101", 10],
    ["page=1&page_size=1000", 10],
    ["page=1&page_size=0", 10],
    ["page=1&page_size=abc", 10],
    ["page=1", 10],
    ["page=0&page_size=5", 5],
    ["page=-1&page_size=5", 5],
  ])("%s：total 16，返回 %i 条", async (query, count) => {
    seedSixteen();
    const { code, rows, total } = await list(query);
    expect([code, rows.length, total]).toEqual([0, count, 16]);
  });

  it("page=0 与 page=-1 当作第 1 页", async () => {
    seedSixteen();
    const first = (await list("page=1&page_size=5")).rows.map(({ id }) => id);
    expect((await list("page=0&page_size=5")).rows.map(({ id }) => id)).toEqual(first);
    expect((await list("page=-1&page_size=5")).rows.map(({ id }) => id)).toEqual(first);
  });

  it("page_size 超过 100 时翻页也按 10 条算", async () => {
    seedSixteen();
    expect((await list("page=2&page_size=200")).rows).toHaveLength(6);
  });
});

describe("次序（§8.3）", () => {
  it("缺省按创建时间倒序，desc=false 生效", async () => {
    const ids = seedSixteen();
    const newest = [...ids].reverse().slice(0, 3);
    expect((await list("page=1&page_size=3")).rows.map(({ id }) => id)).toEqual(newest);
    expect((await list("page=1&page_size=3&orderby=create_time")).rows.map(({ id }) => id)).toEqual(
      newest,
    );
    const ascending = await list("page=1&page_size=3&orderby=create_time&desc=false");
    expect(ascending.rows.map(({ id }) => id)).toEqual(ids.slice(0, 3));
  });

  it("create_time 没有并列（逐份上传）", async () => {
    seedSixteen();
    const times = (await list("page=1&page_size=100")).rows.map((row) => row.create_time);
    expect(new Set(times).size).toBe(16);
  });

  it("orderby 的非法值回 101，HTTP 200", async () => {
    const answer = await callFake(fake.baseUrl, KEY, "GET", `${path()}?page=1&orderby=size`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 101, message: "invalid orderby field: size" });
  });
});

describe("行（§8.3、§8.4）", () => {
  it("信封：code 0，message success，data 带 docs、has_active_tasks 与 total", async () => {
    fake.addDocument(dataset, { name: "a.txt", content: "x", ingestionStatus: "COMPLETED" });
    const answer = await callFake(fake.baseUrl, KEY, "GET", `${path()}?page=1&page_size=100`);
    expect(answer.body).toMatchObject({
      code: 0,
      message: "success",
      data: { has_active_tasks: false, total: 1 },
    });
  });

  it.each([
    ["UNSTART"],
    ["CREATED"],
    ["SCHEDULED"],
    ["RUNNING"],
    ["STOPPING"],
    ["STOPPED"],
    ["COMPLETED"],
    ["FAILED"],
  ])('运行状态 %s：status 恒为 "1"，运行状态在 ingestion_status', async (ingestionStatus) => {
    fake.addDocument(dataset, { name: "a.txt", content: "x", ingestionStatus });
    const { rows } = await list("page=1&page_size=100");
    expect(rows).toMatchObject([
      { status: "1", ingestion_status: ingestionStatus, chunk_count: 0 },
    ]);
  });

  it("切片数在 chunk_count，失败原因在 latest_ingestion_event.message", async () => {
    fake.addDocument(dataset, {
      name: "a.txt",
      content: "x",
      ingestionStatus: "COMPLETED",
      chunkCount: 12,
    });
    fake.addDocument(dataset, {
      name: "b.txt",
      content: "x",
      ingestionStatus: "FAILED",
      eventMessage: "Task failed: pipeline",
    });
    const { rows } = await list("page=1&page_size=100&desc=false");
    expect(rows).toMatchObject([
      { name: "a.txt", chunk_count: 12 },
      { name: "b.txt", latest_ingestion_event: { message: "Task failed: pipeline" } },
    ]);
  });

  it("上传改过的名字原样在列表里（§7.1）", async () => {
    fake.addDocument(dataset, { name: "a(1).txt", content: "x" });
    expect((await list("page=1&page_size=100")).rows).toMatchObject([{ name: "a(1).txt" }]);
  });
});

describe("记录里没有的", () => {
  it.each([
    ["page=abc&page_size=5"],
    ["page_size=5"],
    ["page=1&page_size=-1"],
    ["page=1&desc=maybe"],
    ["page=1&orderby=update_time"],
    ["page=1&orderby=name"],
    ["page=1&ingestion_status=RUNNING"],
  ])("%s：未知路由", async (query) => {
    fake.addDocument(dataset, { name: "a.txt", content: "x" });
    const answer = await callFake(fake.baseUrl, KEY, "GET", `${path()}?${query}`);
    expectUnknownRoute(fake, answer, path());
  });

  it("八种之外的状态只能走故障注入：列表落到未知路由", async () => {
    const document = fake.addDocument(dataset, { name: "a.txt", content: "x" });
    fake.setDocumentStatus(dataset, document, "PAUSED");
    const answer = await callFake(fake.baseUrl, KEY, "GET", `${path()}?page=1&page_size=100`);
    expectUnknownRoute(fake, answer, path());
  });

  it("chunk_count 只有 COMPLETED 能播种", () => {
    expect(() => fake.addDocument(dataset, { name: "a.txt", content: "x", chunkCount: 3 })).toThrow(
      /chunkCount/u,
    );
  });
});

describe("漂移值的故障注入", () => {
  it("回一行八种之外的 ingestion_status", async () => {
    fake.fault(LIST, { kind: "ingestion_status", documentId: "doc-1", value: "PAUSED" });
    const { rows } = await list("page=1&page_size=100");
    expect(rows).toMatchObject([{ id: "doc-1", ingestion_status: "PAUSED", status: "1" }]);
  });

  it("八种之内的值不是漂移，直接抛", () => {
    expect(() => {
      fake.fault(LIST, { kind: "ingestion_status", documentId: "doc-1", value: "RUNNING" });
    }).toThrow(/outside the rc2 record/u);
  });
});
