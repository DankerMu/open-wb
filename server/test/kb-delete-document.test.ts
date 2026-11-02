/**
 * s2a-kb-ragflow tasks 10.2（#1847）：RAGFlow 文档的删除写法（knowledge-bases「重新入库与移出」的删除写法、design D13），这里在
 * helper 层，端点层在组 13。打假 RAGFlow，文档状态是静态的（`fake-ragflow.mjs` 文件头）：删除与停止的应答序列由用例脚本化，
 * 协议取自实测记录 §8.2、§8.5。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeRagflowDocument } from "../src/kb/documents.js";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1847-delete-key";
const DELETE = "DELETE /api/v1/datasets/*/documents";
const STOP = "POST /api/v1/datasets/*/documents/stop";
const DELETED_ZERO = { code: 0, data: { deleted: 0 } };
const QUICK = { retryMs: 2, deadlineMs: 30 };

let fake: FakeRagflowServer;
let datasetId: string;

const client = () =>
  createRagflowClient({
    baseUrl: fake.baseUrl,
    key: { read: () => KEY },
    log: () => undefined,
  });

const seeded = (ingestionStatus = "UNSTART"): string =>
  fake.addDocument(datasetId, { name: "a.txt", content: "abc", ingestionStatus });

const remove = (documentId: string, timing = QUICK) =>
  removeRagflowDocument(client(), { datasetId, documentId }, timing);

const lines = () =>
  fake.requests().map(({ method, path }) => `${method} ${path.split("/").at(-1) ?? ""}`);

const countOf = (line: string) => lines().filter((entry) => entry === line).length;

const DELETES = "DELETE documents";
const STOPS = "POST stop";

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
  datasetId = fake.addDataset();
});

afterEach(async () => {
  vi.useRealTimers();
  expect(fake.unknownRoutes()).toEqual([]);
  await fake.close();
});

describe("第 1 步", () => {
  it("deleted:1：完成，不发停止", async () => {
    const id = seeded();
    await expect(remove(id)).resolves.toEqual({ outcome: "deleted" });
    expect(lines()).toEqual([DELETES]);
    expect(fake.documents(datasetId)).toEqual([]);
  });

  it("文档不存在：完成，不发停止", async () => {
    await expect(remove("0123456789abcdef0123456789abcdef")).resolves.toEqual({
      outcome: "deleted",
    });
    expect(lines()).toEqual([DELETES]);
  });

  it("不可达：failed，带着可映射的结果，不重试", async () => {
    fake.fault(DELETE, { kind: "status", status: 503 });
    await expect(remove(seeded())).resolves.toEqual({
      outcome: "failed",
      kind: "kb_unavailable",
    });
    expect(lines()).toEqual([DELETES]);
  });

  it("被拒：failed，kb_rejected", async () => {
    fake.answer(DELETE, { code: 101, message: "Duplicate ids" });
    await expect(remove(seeded())).resolves.toEqual({ outcome: "failed", kind: "kb_rejected" });
    expect(lines()).toEqual([DELETES]);
  });
});

describe("第 2 步：deleted:0 之后恰一次停止", () => {
  it("deleted:0、停止成功、下一次 deleted:1：完成，依次删除、停止、删除", async () => {
    const id = seeded("RUNNING");
    const gate = fake.fault(STOP, { kind: "hold" });
    const pending = remove(id);
    await gate.reached;
    fake.setDocumentStatus(datasetId, id, "STOPPED");
    gate.release();
    await expect(pending).resolves.toEqual({ outcome: "deleted" });
    expect(lines()).toEqual([DELETES, STOPS, DELETES]);
  });

  it("停止回 success_count:0：继续，下一次删除成功", async () => {
    const id = seeded("COMPLETED");
    fake.answer(DELETE, DELETED_ZERO);
    await expect(remove(id)).resolves.toEqual({ outcome: "deleted" });
    expect(lines()).toEqual([DELETES, STOPS, DELETES]);
  });

  it("停止回 not_found：继续，下一次删除得到不存在即完成", async () => {
    const id = seeded("RUNNING");
    fake.answer(DELETE, DELETED_ZERO);
    fake.answer(STOP, { code: 100, message: `Documents not found: ['${id}']` });
    fake.answer(DELETE, {
      code: 102,
      message: `These documents do not belong to dataset ${datasetId} or Document not found: ${id}`,
    });
    await expect(remove(id)).resolves.toEqual({ outcome: "deleted" });
    expect(lines()).toEqual([DELETES, STOPS, DELETES]);
  });

  it("停止不可达：failed，不再删除", async () => {
    const id = seeded("RUNNING");
    fake.fault(STOP, { kind: "status", status: 503 });
    await expect(remove(id)).resolves.toEqual({ outcome: "failed", kind: "kb_unavailable" });
    expect(lines()).toEqual([DELETES, STOPS]);
  });

  it("停止被拒：failed，不再删除", async () => {
    const id = seeded("RUNNING");
    fake.answer(STOP, { code: 101, message: "bad request" });
    await expect(remove(id)).resolves.toEqual({ outcome: "failed", kind: "kb_rejected" });
    expect(lines()).toEqual([DELETES, STOPS]);
  });
});

describe("第 3、4 步：重发删除", () => {
  it("STOPPING：恰一次停止、四次删除，文档变为 STOPPED 后完成", async () => {
    const id = seeded("STOPPING");
    fake.answer(DELETE, DELETED_ZERO, { times: 3 });
    const gate = fake.fault(DELETE, { kind: "hold" });
    const pending = remove(id, { retryMs: 2, deadlineMs: 60_000 });
    await gate.reached;
    fake.setDocumentStatus(datasetId, id, "STOPPED");
    gate.release();
    await expect(pending).resolves.toEqual({ outcome: "deleted" });
    expect(countOf(STOPS)).toBe(1);
    expect(countOf(DELETES)).toBe(4);
    expect(fake.documents(datasetId)).toEqual([]);
  });

  it("一直 deleted:0：到期 busy，文档还在，恰一次停止", async () => {
    const id = seeded("RUNNING");
    await expect(remove(id)).resolves.toEqual({ outcome: "busy" });
    expect(countOf(STOPS)).toBe(1);
    expect(countOf(DELETES)).toBeGreaterThan(1);
    expect(fake.documents(datasetId).map((document) => document.id)).toEqual([id]);
  });

  it("重试期间不可达：立即 failed，不等到期", async () => {
    const id = seeded("RUNNING");
    fake.answer(DELETE, DELETED_ZERO);
    fake.fault(DELETE, { kind: "status", status: 503 });
    const pending = remove(id, { retryMs: 2, deadlineMs: 60_000 });
    await expect(pending).resolves.toEqual({ outcome: "failed", kind: "kb_unavailable" });
    expect(countOf(DELETES)).toBe(2);
  });

  it("重试期间被拒：立即 failed", async () => {
    const id = seeded("RUNNING");
    fake.answer(DELETE, DELETED_ZERO);
    fake.answer(DELETE, { code: 101, message: "Duplicate ids" });
    await expect(remove(id, { retryMs: 2, deadlineMs: 60_000 })).resolves.toEqual({
      outcome: "failed",
      kind: "kb_rejected",
    });
  });

  it("缺省节奏：每 500 ms 重发一次，5 s 到期，共十次重发", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const id = seeded("RUNNING");
    const pending = removeRagflowDocument(client(), { datasetId, documentId: id });
    await expect.poll(() => countOf(STOPS)).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(countOf(DELETES)).toBe(1);
    for (let retry = 1; retry <= 10; retry += 1) {
      await vi.advanceTimersByTimeAsync(retry === 1 ? 1 : 500);
      await expect.poll(() => countOf(DELETES)).toBe(retry + 1);
    }
    await expect(pending).resolves.toEqual({ outcome: "busy" });
    expect(countOf(DELETES)).toBe(11);
  });
});
