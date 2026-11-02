/**
 * s2a-kb-ragflow tasks 11.2（#1848）：`GET /api/kb/bases/:id/documents`（knowledge-bases「文档列表与状态」、「文档路由的所有权」
 * 的这一腿，ragflow-backend「每个请求带密钥」，design D12）。除最后一节读全函数的类型化结果外都经 `createApp` + `app.inject()`
 * 打假 RAGFlow。状态类用例的文档行由 store 直接插入；`sourceChanged` 的用例走真实入库，比对的 `size` 与 `mtimeMs` 才是
 * `fstat` 写下的那两个值。
 *
 * 「没有对挂载路径的同步调用」两头看：挂载测试缝看到的是适配器调用，`node:fs` 的 `*Sync` 记录器看到的是绕过适配器的调用。
 * 纯函数 `resolve` 不传挂载名时对普通目录同样解析成功，只看测试缝抓不住（`mounts-file-endpoints-online.test.ts` 同一写法）。
 * 期望值是 spec 与实测记录的字面量。
 */
import { renameSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { readRagflowDocuments } from "../src/kb/documents.js";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import type { KbDocument } from "../src/kb/store.js";
import {
  CONTENT_SENTINEL,
  type IngestWorld,
  LIST,
  MESSAGE_SENTINEL,
  NOT_FOUND,
  PARSE,
  RAGFLOW_KEY,
  scriptSecond,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE } from "./kb-settings-helpers.js";
import { EMBEDDING } from "./kb-store-helpers.js";
import { createSeam, isUnder, put } from "./mounts-file-endpoints-helpers.js";
import { W_LISI, W1, W2 } from "./mounts-manager-helpers.js";
import { auditRows, CASE_MS, send } from "./mounts-rest-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

/** 经模块对象发生的 `node:fs` 同步调用，按第一个参数记。 */
const syncCalls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const recorded = (value: unknown, name: string): unknown =>
    typeof value === "function" && name.endsWith("Sync")
      ? new Proxy(value, {
          apply(target, self, args) {
            syncCalls.push(String(args[0]));
            return Reflect.apply(target, self, args);
          },
        })
      : value;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, recorded(value, name)]),
  );
});

const open = useIngestWorlds();
const QUERY = "page_size=100&orderby=create_time&desc=false";
const ABSENT_ID = "f".repeat(32);
const FAILED_MESSAGE = "解析失败";

interface DocumentView {
  id: string;
  name: string;
  size: number;
  source: string;
  workspaceId: string | null;
  path: string | null;
  status: string;
  chunkCount: number | null;
  message: string | null;
  sourceChanged: boolean | null;
  createdAt: number;
}

type Who = "admin" | "member" | "anonymous";

const list = (
  world: IngestWorld,
  who: Who = "member",
  baseId = world.baseId,
): Promise<LightMyRequestResponse> =>
  send(world.fw.rest, who, "GET", `/api/kb/bases/${baseId}/documents`);

async function listed(world: IngestWorld): Promise<DocumentView[]> {
  const response = await list(world);
  expect(response.statusCode).toBe(200);
  return response.json<{ documents: DocumentView[] }>().documents;
}

const auditCount = (world: IngestWorld): number => auditRows(world.fw.world).length;

const listQueries = (world: IngestWorld): string[] =>
  world.fake.requests().map(({ method, query }) => `${method} ${query}`);

/** 一条上传来源的本地行：`sourceChanged` 恒为 `null`，状态类用例不碰文件。 */
function addLocal(world: IngestWorld, ragflowDocumentId: string, name = "a.txt"): KbDocument {
  const { baseId: kbId, store } = world;
  return store.addDocument({ kbId, ragflowDocumentId, name, size: 1, source: "upload" });
}

function setCreatedAt(world: IngestWorld, id: string, at: number): void {
  world.fw.world.db.prepare("UPDATE kb_documents SET created_at = ? WHERE id = ?").run(at, id);
}

function addWorkspaceRow(world: IngestWorld, workspaceId: string, sourcePath: string): KbDocument {
  return world.store.addDocument({
    kbId: world.baseId,
    ragflowDocumentId: "not-in-ragflow",
    name: "a.md",
    size: 1,
    source: "workspace",
    workspaceId,
    sourcePath,
    sourceMtimeMs: 1,
  });
}

/** RAGFlow 里 `count` 份 `COMPLETED` 的文档，`chunk_count` 是序号，返回 id。 */
function fillDataset(world: IngestWorld, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    world.fake.addDocument(world.datasetId, {
      name: `${String(index)}.txt`,
      content: "x",
      ingestionStatus: "COMPLETED",
      chunkCount: index,
    }),
  );
}

async function ingested(world: IngestWorld, paths: string[]): Promise<void> {
  expect((await world.ingest(paths)).statusCode).toBe(201);
}

const changedByPath = (views: DocumentView[]) =>
  Object.fromEntries(views.map(({ path, sourceChanged }) => [path, sourceChanged]));

describe("状态映射", () => {
  it('八种运行状态与不在列表里的第九份，status 字段都是 "1" 也不读它', async () => {
    const world = await open();
    const states = [
      "UNSTART",
      "CREATED",
      "SCHEDULED",
      "RUNNING",
      "STOPPING",
      "STOPPED",
      "COMPLETED",
      "FAILED",
    ];
    states.forEach((ingestionStatus, index) => {
      const chunks = ingestionStatus === "COMPLETED" ? { chunkCount: 12 } : {};
      const seed = { name: `${ingestionStatus}.txt`, content: "x", ingestionStatus, ...chunks };
      const local = addLocal(world, world.fake.addDocument(world.datasetId, seed));
      setCreatedAt(world, local.id, 1000 + index);
    });
    setCreatedAt(world, addLocal(world, "not-in-ragflow").id, 2000);

    const views = await listed(world);
    expect(views.map(({ status, chunkCount, message }) => [status, chunkCount, message])).toEqual([
      ["unparsed", null, null],
      ["queued", null, null],
      ["queued", null, null],
      ["parsing", null, null],
      ["parsing", null, null],
      ["cancelled", null, null],
      ["done", 12, null],
      ["failed", null, FAILED_MESSAGE],
      ["missing", null, null],
    ]);
  });

  it("0 切片：done，chunkCount 为 0", async () => {
    const world = await open();
    const seed = { name: "a.md", content: "x", ingestionStatus: "COMPLETED", chunkCount: 0 };
    addLocal(world, world.fake.addDocument(world.datasetId, seed));
    expect(await listed(world)).toMatchObject([{ status: "done", chunkCount: 0, message: null }]);
  });

  it("失败原因是 RAGFlow 原文，不透出：message 是固定句子", async () => {
    const world = await open();
    const seed = {
      name: "a.pdf",
      content: "x",
      ingestionStatus: "FAILED",
      eventMessage: MESSAGE_SENTINEL,
    };
    addLocal(world, world.fake.addDocument(world.datasetId, seed));
    const response = await list(world);
    expect(response.json()).toMatchObject({ documents: [{ message: FAILED_MESSAGE }] });
    expect(response.body).not.toContain(MESSAGE_SENTINEL);
  });

  it.each([["PAUSED"], ["completed"], ["constructor"], ["__proto__"]])(
    "未知运行状态 %s：整个请求 503",
    async (value) => {
      const world = await open();
      const documentId = world.fake.addDocument(world.datasetId, { name: "a.md", content: "x" });
      addLocal(world, documentId);
      world.fake.fault(LIST, { kind: "ingestion_status", documentId, value });
      const response = await list(world);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(KB_UNAVAILABLE);
    },
  );

  it("未知运行状态在没有本地行的文档上同样 503：是协议漂移，不看归属", async () => {
    const world = await open();
    addLocal(world, "not-in-ragflow");
    const fault = { kind: "ingestion_status", documentId: "leaked", value: "PAUSED" } as const;
    world.fake.fault(LIST, fault);
    expect((await list(world)).statusCode).toBe(503);
  });
});

describe("RAGFlow 的失败", () => {
  it("数据集丢失：code:404 时 200，全部 missing", async () => {
    const world = await open();
    addLocal(world, "doc-1", "a.md");
    addLocal(world, "doc-2", "b.md");
    world.fake.answer(LIST, { code: 404, message: "Resource not found" });
    const views = await listed(world);
    expect(views.map(({ status, chunkCount, message }) => [status, chunkCount, message])).toEqual([
      ["missing", null, null],
      ["missing", null, null],
    ]);
  });

  it("数据集在翻页途中没了：同样全部 missing，读到的第一页不算数", async () => {
    const world = await open();
    const ids = fillDataset(world, 150);
    addLocal(world, ids[0] as string);
    const response = await scriptSecond(
      world,
      LIST,
      () => {
        world.fake.answer(LIST, { code: 404, message: "Resource not found" });
      },
      () => list(world),
    );
    expect(response.json()).toMatchObject({ documents: [{ status: "missing", chunkCount: null }] });
  });

  it("RAGFlow 不可达：503 kb_unavailable", async () => {
    const world = await open();
    addLocal(world, "doc-1");
    world.fake.fault(LIST, { kind: "reset" });
    const response = await list(world);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
  });

  it("空库也读 RAGFlow，不可达同样 503", async () => {
    const world = await open();
    world.fake.fault(LIST, { kind: "status", status: 502 });
    expect((await list(world)).statusCode).toBe(503);
  });

  it("翻页途中不可达：整个请求 503，不给半张表", async () => {
    const world = await open();
    addLocal(world, fillDataset(world, 150)[0] as string);
    const response = await scriptSecond(
      world,
      LIST,
      () => {
        world.fake.fault(LIST, { kind: "reset" });
      },
      () => list(world),
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
    expect(world.countOf(LIST)).toBe(2);
  });

  it("code:102 走通用映射 kb_rejected，RAGFlow 的 message 不进响应", async () => {
    const world = await open();
    world.fake.answer(LIST, { code: 102, message: MESSAGE_SENTINEL });
    const response = await list(world);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("kb_rejected");
    expect(response.body).not.toContain(MESSAGE_SENTINEL);
  });

  it("权限错误的防御性映射：HTTP 200 code:403 为 503，恰一行 kb_upstream_auth_failed", async () => {
    const world = await open();
    world.fake.fault(LIST, { kind: "combo", code: 403, message: MESSAGE_SENTINEL });
    const response = await list(world);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
    expect(world.logged).toEqual([{ event: "kb_upstream_auth_failed" }]);
  });
});

describe("分页读全", () => {
  it("超过一页时读到 total，每个请求都带 page_size=100、orderby=create_time、desc=false", async () => {
    const world = await open();
    const ids = fillDataset(world, 230);
    for (const index of [0, 99, 100, 229]) {
      const local = addLocal(world, ids[index] as string);
      setCreatedAt(world, local.id, 1000 + index);
    }
    const views = await listed(world);
    expect(views.map(({ status, chunkCount }) => [status, chunkCount])).toEqual([
      ["done", 0],
      ["done", 99],
      ["done", 100],
      ["done", 229],
    ]);
    expect(listQueries(world)).toEqual([
      `GET page=1&${QUERY}`,
      `GET page=2&${QUERY}`,
      `GET page=3&${QUERY}`,
    ]);
  });

  it("total 大于 500 时不截断：第 530 份不是 missing", async () => {
    const world = await open();
    const ids = fillDataset(world, 530);
    addLocal(world, ids[529] as string);
    expect(await listed(world)).toMatchObject([{ status: "done", chunkCount: 529 }]);
    expect(world.countOf(LIST)).toBe(6);
  });

  it("恰好整页时不多发一页", async () => {
    const world = await open();
    fillDataset(world, 200);
    await listed(world);
    expect(listQueries(world)).toEqual([`GET page=1&${QUERY}`, `GET page=2&${QUERY}`]);
  });

  it("没有文档时一个请求就结束", async () => {
    const world = await open();
    expect(await listed(world)).toEqual([]);
    expect(listQueries(world)).toEqual([`GET page=1&${QUERY}`]);
  });

  it("读不到 total 就空页了：结束，漏掉的那条是 missing，不死循环", async () => {
    const world = await open();
    const row = { id: "doc-1", ingestion_status: "COMPLETED", chunk_count: 3 };
    addLocal(world, "doc-1");
    addLocal(world, "doc-2");
    world.fake.answer(LIST, { code: 0, data: { docs: [row], total: 3 } });
    // 留够余量：循环不停时第三个请求还是这个空页，请求数就不是 2。
    world.fake.answer(LIST, { code: 0, data: { docs: [], total: 3 } }, { times: 5 });
    const views = await listed(world);
    expect(views.map(({ status }) => status).sort()).toEqual(["done", "missing"]);
    expect(world.countOf(LIST)).toBe(2);
  });

  it("先读本地行：翻页期间才提交的文档不进这次应答，不会显示成 missing", async () => {
    const world = await open();
    const gate = world.fake.fault(LIST, { kind: "hold" });
    const pending = listed(world);
    await gate.reached;
    addLocal(world, "committed-while-paging");
    gate.release();
    expect(await pending).toEqual([]);
  });

  it("状态每次请求现读：不缓存", async () => {
    const world = await open();
    const seed = { name: "a.md", content: "x", ingestionStatus: "RUNNING" };
    const documentId = world.fake.addDocument(world.datasetId, seed);
    addLocal(world, documentId);
    expect(await listed(world)).toMatchObject([{ status: "parsing" }]);
    world.fake.setDocumentStatus(world.datasetId, documentId, "STOPPED");
    expect(await listed(world)).toMatchObject([{ status: "cancelled" }]);
  });
});

describe("视图", () => {
  it("{documents} 精确键集，no-store；name 取本地记录，假 RAGFlow 里是 a(1).txt", async () => {
    const world = await open();
    const seed = {
      name: "a(1).txt",
      content: "xx",
      ingestionStatus: "COMPLETED",
      chunkCount: 3,
    };
    const local = world.store.addDocument({
      kbId: world.baseId,
      ragflowDocumentId: world.fake.addDocument(world.datasetId, seed),
      name: "a.txt",
      size: 7,
      source: "upload",
    });
    const response = await list(world);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      documents: [
        {
          id: local.id,
          name: "a.txt",
          size: 7,
          source: "upload",
          workspaceId: null,
          path: null,
          status: "done",
          chunkCount: 3,
          message: null,
          sourceChanged: null,
          createdAt: local.createdAt,
        },
      ],
    });
  });

  it("工作空间来源的完整视图，本地名不受同名改名影响", async () => {
    const world = await open();
    world.write("a.txt", "hello");
    world.write("sub/a.txt", "world!");
    await ingested(world, ["a.txt", "sub/a.txt"]);
    const [first, second] = world.rows().sort((a, b) => a.size - b.size);
    const names = world.fake.documents(world.datasetId).map(({ name }) => name);
    expect(names).toEqual(["a.txt", "a(1).txt"]);
    const views = await listed(world);
    expect(views.sort((a, b) => a.size - b.size)).toEqual([
      {
        id: first?.id,
        name: "a.txt",
        size: 5,
        source: "workspace",
        workspaceId: W1,
        path: "a.txt",
        status: "unparsed",
        chunkCount: null,
        message: null,
        sourceChanged: false,
        createdAt: first?.createdAt,
      },
      {
        id: second?.id,
        name: "a.txt",
        size: 6,
        source: "workspace",
        workspaceId: W1,
        path: "sub/a.txt",
        status: "unparsed",
        chunkCount: null,
        message: null,
        sourceChanged: false,
        createdAt: second?.createdAt,
      },
    ]);
  });

  it("按 created_at 升序，不看 RAGFlow 的次序", async () => {
    const world = await open();
    const [first, second, third] = fillDataset(world, 3);
    setCreatedAt(world, addLocal(world, first as string, "晚.md").id, 3000);
    setCreatedAt(world, addLocal(world, second as string, "早.md").id, 1000);
    setCreatedAt(world, addLocal(world, third as string, "中.md").id, 2000);
    const views = await listed(world);
    expect(views.map(({ name }) => name)).toEqual(["早.md", "中.md", "晚.md"]);
    expect(views.map(({ createdAt }) => createdAt)).toEqual([1000, 2000, 3000]);
  });

  it.each([["rebuilding"], ["rebuild_failed"]] as const)(
    "state 为 %s 时照常读：列表不取写锁，也不判 state",
    async (state) => {
      const world = await open();
      addLocal(world, fillDataset(world, 1)[0] as string);
      world.setState(state);
      expect(await listed(world)).toMatchObject([{ status: "done" }]);
    },
  );

  it("读取不产生任何审计", async () => {
    const world = await open();
    world.write("a.md", "a");
    await ingested(world, ["a.md"]);
    addLocal(world, "not-in-ragflow");
    const before = auditCount(world);
    expect(before).toBeGreaterThan(0);
    await listed(world);
    expect(auditCount(world)).toBe(before);
  });
});

describe("源文件变更", () => {
  it("改写、删除、未动：依次 true、true、false，这次读取不产生审计", async () => {
    const world = await open();
    world.write("changed.md", CONTENT_SENTINEL);
    world.write("gone.md", "two");
    world.write("kept.md", "three");
    world.write("dir/inner.md", "four");
    await ingested(world, ["changed.md", "gone.md", "kept.md", "dir/inner.md"]);
    world.write("changed.md", `${CONTENT_SENTINEL} rewritten`);
    rmSync(join(world.root, "gone.md"));
    rmSync(join(world.root, "dir"), { recursive: true });
    const before = auditCount(world);
    const response = await list(world);
    expect(response.body).not.toContain(CONTENT_SENTINEL);
    const { documents } = response.json<{ documents: DocumentView[] }>();
    expect(changedByPath(documents)).toEqual({
      "changed.md": true,
      "gone.md": true,
      "kept.md": false,
      "dir/inner.md": true,
    });
    expect(auditCount(world)).toBe(before);
  });

  it("只有大小变了：true", async () => {
    const world = await open();
    const at = new Date("2026-10-01T00:00:00Z");
    const path = join(world.root, "a.md");
    world.write("a.md", "abc");
    utimesSync(path, at, at);
    await ingested(world, ["a.md"]);
    world.write("a.md", "abcd");
    utimesSync(path, at, at);
    expect(changedByPath(await listed(world))).toEqual({ "a.md": true });
  });

  it("只有修改时间变了：true", async () => {
    const world = await open();
    const path = join(world.root, "a.md");
    world.write("a.md", "abc");
    utimesSync(path, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    await ingested(world, ["a.md"]);
    utimesSync(path, new Date("2026-10-02T00:00:00Z"), new Date("2026-10-02T00:00:00Z"));
    expect(changedByPath(await listed(world))).toEqual({ "a.md": true });
  });

  it("源路径已不是普通文件：文件已不在，true", async () => {
    const world = await open();
    world.write("a.md", "abc");
    await ingested(world, ["a.md"]);
    rmSync(join(world.root, "a.md"));
    world.write("a.md/inner.md", "x");
    expect(changedByPath(await listed(world))).toEqual({ "a.md": true });
  });

  it("上传来源不 stat：null", async () => {
    const world = await open();
    addLocal(world, "not-in-ragflow");
    expect(await listed(world)).toMatchObject([{ sourceChanged: null }]);
  });

  it("源路径变成符号链接：两次都是 null，没有新增审计", async () => {
    const world = await open();
    world.write("dir/a.md", "a");
    await ingested(world, ["dir/a.md"]);
    renameSync(join(world.root, "dir"), join(world.root, "moved"));
    symlinkSync(join(world.root, "moved"), join(world.root, "dir"));
    const before = auditCount(world);
    expect(changedByPath(await listed(world))).toEqual({ "dir/a.md": null });
    expect(changedByPath(await listed(world))).toEqual({ "dir/a.md": null });
    expect(auditCount(world)).toBe(before);
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it("解析被拒的路径：null，不写 sandbox.reject", async () => {
    const world = await open();
    addWorkspaceRow(world, W1, "../outside.md");
    expect(await listed(world)).toMatchObject([{ sourceChanged: null }]);
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it.each([
    ["别人的工作空间", W_LISI],
    ["不存在的工作空间", ABSENT_ID],
  ])("%s：null，没有审计", async (_label, workspaceId) => {
    const world = await open();
    addWorkspaceRow(world, workspaceId, "a.md");
    const before = auditCount(world);
    expect(await listed(world)).toMatchObject([{ sourceChanged: null }]);
    expect(auditCount(world)).toBe(before);
  });

  it("工作空间已删除：行与根都不在，null；别的文档照常", async () => {
    const world = await open();
    world.write("a.md", "a");
    await ingested(world, ["a.md"]);
    addWorkspaceRow(world, W2, "gone.md");
    world.fw.world.db.prepare("DELETE FROM workspaces WHERE id = ?").run(W2);
    expect(changedByPath(await listed(world))).toEqual({ "a.md": false, "gone.md": null });
  });

  it("工作空间的根不在了：null", async () => {
    const world = await open();
    world.write("a.md", "a");
    await ingested(world, ["a.md"]);
    rmSync(world.root, { recursive: true });
    expect(changedByPath(await listed(world))).toEqual({ "a.md": null });
  });
});

describe("挂载来源", () => {
  it("远端改写：true，未动的 false；全程经适配器，没有对挂载路径的同步调用", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const world = await open({ online: [{ name: "docs" }], overrides: { mountFs: seam.impl } });
    const point = world.fw.point("docs");
    put(point, "a.pdf", "abcd");
    put(point, "b.pdf", "kept");
    await ingested(world, ["docs/a.pdf", "docs/b.pdf"]);
    put(point, "a.pdf", "rewritten");
    seam.calls.length = 0;
    syncCalls.length = 0;

    const views = await listed(world);

    expect(changedByPath(views)).toEqual({ "docs/a.pdf": true, "docs/b.pdf": false });
    expect(seam.under(point).map(({ op }) => op)).toEqual(["lstat", "lstat"]);
    expect(syncCalls.filter((path) => isUnder(path, point))).toEqual([]);
  });

  it("RAGFlow 失败时不 stat：503 之前不碰挂载", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({ online: [{ name: "docs" }], overrides: { mountFs: seam.impl } });
    addWorkspaceRow(world, W1, "docs/a.pdf");
    world.fake.fault(LIST, { kind: "reset" });
    expect((await list(world)).statusCode).toBe(503);
    expect(seam.under(world.fw.point("docs"))).toEqual([]);
  });

  it("挂载离线：null，不碰挂载点", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({ offline: ["docs"], overrides: { mountFs: seam.impl } });
    addWorkspaceRow(world, W1, "docs/a.pdf");
    expect(await listed(world)).toMatchObject([{ sourceChanged: null }]);
    expect(seam.under(world.fw.point("docs"))).toEqual([]);
  });

  it("stat 时挂载到期：null，请求照常 200", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({
      online: [{ name: "docs" }],
      overrides: { mountFs: seam.impl, mountFsDeadlineMs: 1000 },
    });
    const point = world.fw.point("docs");
    addWorkspaceRow(world, W1, "docs/a.pdf");
    seam.hang(point);
    const pending = listed(world);
    await expect.poll(() => seam.under(point).length).toBe(1);
    world.fw.world.clock.advance(1000);
    expect(await pending).toMatchObject([{ sourceChanged: null }]);
  });
});

describe("文档路由的所有权", () => {
  it("别人的库与不存在的 id：404，假 RAGFlow 零请求，没有新增审计", async () => {
    const world = await open();
    const local = addLocal(world, "doc-1");
    const before = auditCount(world);
    for (const baseId of [world.baseId, ABSENT_ID]) {
      const response = await list(world, "admin", baseId);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(world.fake.requests()).toEqual([]);
    expect(auditCount(world)).toBe(before);
    expect(world.rows()).toEqual([local]);
  });

  it("未登录 401，先于所有权", async () => {
    const world = await open();
    const response = await list(world, "anonymous");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(world.fake.requests()).toEqual([]);
  });
});

describe("每个请求带密钥", () => {
  it("建库、上传、列表、删除与版本都经端点触发：版本之外都带密钥，版本不带", async () => {
    const world = await open();
    world.store.saveSettings({ embedding: EMBEDDING });
    world.fake.addModel("owb-embed", EMBEDDING.name, "embedding");
    const { rest } = world.fw;
    const created = await send(rest, "member", "POST", "/api/kb/bases", {
      name: "新库",
      template: "naive",
    });
    expect(created.statusCode).toBe(201);
    const { id: baseId } = created.json<{ id: string }>();
    const dataset = world.store.getBase(baseId)?.datasetId ?? "";
    world.write("a.md", "a");
    world.write("b.md", "b");
    expect((await world.ingest(["a.md"], { baseId })).statusCode).toBe(201);
    world.fake.answer(PARSE, { code: 102, message: MESSAGE_SENTINEL });
    expect((await world.ingest(["b.md"], { baseId })).statusCode).toBe(201);
    expect((await list(world, "member", baseId)).statusCode).toBe(200);
    expect((await send(rest, "member", "GET", "/api/kb/status")).statusCode).toBe(200);
    expect((await send(rest, "member", "DELETE", `/api/kb/bases/${baseId}`)).statusCode).toBe(204);

    const documents = `/api/v1/datasets/${dataset}/documents`;
    expect(world.fake.requests().map(({ method, path, bearer }) => [method, path, bearer])).toEqual(
      [
        ["POST", "/api/v1/datasets", "ok"],
        ["POST", documents, "ok"],
        ["POST", `${documents}/parse`, "ok"],
        ["POST", documents, "ok"],
        ["POST", `${documents}/parse`, "ok"],
        ["DELETE", documents, "ok"],
        ["GET", documents, "ok"],
        ["GET", "/api/v1/system/version", "missing"],
        ["DELETE", "/api/v1/datasets", "ok"],
      ],
    );
  });

  it("没有请求跟随重定向：列表的 3xx 是 503，跳转目标没有收到请求", async () => {
    const world = await open();
    const location = `${world.fake.baseUrl}/api/v1/followed`;
    world.fake.fault(LIST, { kind: "redirect", location });
    expect((await list(world)).statusCode).toBe(503);
    expect(world.fake.requests()).toHaveLength(1);
  });
});

describe("读全 RAGFlow 文档的函数（组 9 第三刀复用）", () => {
  const clientOf = (world: IngestWorld) =>
    createRagflowClient({
      baseUrl: world.fake.baseUrl,
      key: { read: () => RAGFLOW_KEY },
      log: () => undefined,
    });

  it("结果是类型化的：全部行，或 not-found 与失败，不抛错，由调用方映射", async () => {
    const world = await open();
    fillDataset(world, 101);
    const client = clientOf(world);
    const all = await readRagflowDocuments(client, world.datasetId);
    expect(all.kind === "ok" ? all.value.length : all.kind).toBe(101);
    await expect(readRagflowDocuments(client, ABSENT_ID)).resolves.toEqual({ kind: "not_found" });
    world.fake.fault(LIST, { kind: "reset" });
    await expect(readRagflowDocuments(client, world.datasetId)).resolves.toEqual({
      kind: "kb_unavailable",
    });
  });
});
