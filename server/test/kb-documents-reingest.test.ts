/**
 * s2a-kb-ragflow tasks 13.4（#1851）：`POST /api/kb/bases/:id/documents/reingest?doc=<id>`（knowledge-bases「重新入库与移出」的
 * 重新入库部分、「知识库端点」的「文档路由的所有权」、「知识库审计」的重新入库一腿，http-service-skeleton「知识库的归属路由」，
 * design D10、D13、D20）。经 `createApp` + `app.inject()` 打假 RAGFlow（`kb-ingest-helpers.ts`）。
 *
 * 能走真实入库的用例都先入库，行里的 `size` 与 `mtimeMs` 才是 `fstat` 写下的值；离线挂载与工作空间已删除的行由 store 直接插入。
 * 断言请求次数的用例把删除的重发期限拉长到 60 s；只有断言 `busy`（旧文档停不下来）的用例用 helper 的短期限。期望值是 spec 与
 * 实测记录（§7.1、§8.5）的字面量。
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { KbDocument } from "../src/kb/store.js";
import {
  BAD_REQUEST,
  CONTENT_SENTINEL,
  DELETE_DOCUMENT,
  type IngestWorld,
  ingestedRow,
  LIST,
  MESSAGE_SENTINEL,
  NOT_FOUND,
  PARSE,
  REBUILDING,
  STOP,
  UNSUPPORTED_MESSAGE,
  UPLOAD,
  UPLOAD_MAX_BYTES,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE } from "./kb-settings-helpers.js";
import { holdWriteLock, KB_FILE_UNSUPPORTED, KB_REJECTED } from "./kb-upload-helpers.js";
import { createSeam, put } from "./mounts-file-endpoints-helpers.js";
import { OWNER, W1 } from "./mounts-manager-helpers.js";
import { auditRows, CASE_MS, send } from "./mounts-rest-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

const open = useIngestWorlds();

const KB_SOURCE_UNREADABLE = {
  error: { code: "kb_source_unreadable", message: "源文件无法读取或已变动，未重新入库" },
};
const GENERIC_500 = { error: { message: "服务器内部错误" } };
/** 断言请求次数时用：到期远在用例结束之后。 */
const LONG = { documentDelete: { retryMs: 2, deadlineMs: 60_000 } };
const ABSENT_ID = "f".repeat(32);
const TITLE = "知识库重新入库文档";
const REWRITTEN = "第二版的正文";

type Who = "admin" | "member" | "anonymous";

interface ReingestOptions {
  who?: Who;
  baseId?: string;
  body?: unknown;
}

/** `query` 原样拼在路径后面，含 `?`。 */
const reingestWith = (
  world: IngestWorld,
  query: string,
  options: ReingestOptions = {},
): Promise<LightMyRequestResponse> =>
  send(
    world.fw.rest,
    options.who ?? "member",
    "POST",
    `/api/kb/bases/${options.baseId ?? world.baseId}/documents/reingest${query}`,
    options.body,
  );

const reingest = (world: IngestWorld, documentId: string, options?: ReingestOptions) =>
  reingestWith(world, `?doc=${documentId}`, options);

const ragflowIds = (world: IngestWorld): string[] =>
  world.fake.documents(world.datasetId).map(({ id }) => id);

const deleteBodies = (world: IngestWorld): unknown[] =>
  world.fake
    .requests()
    .filter(({ method }) => method === "DELETE")
    .map(({ json }) => json);

/** 一行直接插入的工作空间来源文档：RAGFlow 里有它的文档，源文件不必存在。 */
function seededWorkspaceRow(world: IngestWorld, workspaceId: string, sourcePath: string) {
  const ragflowDocumentId = world.fake.addDocument(world.datasetId, {
    name: "a.pdf",
    content: "a",
  });
  return world.store.addDocument({
    kbId: world.baseId,
    ragflowDocumentId,
    name: "a.pdf",
    size: 1,
    source: "workspace",
    workspaceId,
    sourcePath,
    sourceMtimeMs: 1,
  });
}

/** 失败的重新入库：行不变，旧文档还在 RAGFlow，没有新的 `kb.ingest`。 */
function expectUntouched(world: IngestWorld, document: KbDocument, ingests: number): void {
  expect(world.rows()).toEqual([document]);
  expect(ragflowIds(world)).toContain(document.ragflowDocumentId);
  expect(world.audits("kb.ingest")).toHaveLength(ingests);
}

function expectError(response: LightMyRequestResponse, status: number, body: unknown): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toEqual(body);
  expect(response.headers["cache-control"]).toBe("no-store");
}

describe("重新入库", () => {
  it("重新入库：200 新的 DocumentView（queued、sourceChanged:false），依次上传、解析触发、删除旧文档，没有列表请求", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "docs/a.md", "第一版");
    world.write("docs/a.md", REWRITTEN);
    const sent = world.fake.requests().length;

    const response = await reingest(world, document.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const [row] = world.rows();
    const fresh = row?.ragflowDocumentId;
    expect(fresh).not.toBe(document.ragflowDocumentId);
    const size = Buffer.byteLength(REWRITTEN);
    expect(response.json()).toEqual({
      id: document.id,
      name: "a.md",
      size,
      source: "workspace",
      workspaceId: W1,
      path: "docs/a.md",
      status: "queued",
      chunkCount: null,
      message: null,
      sourceChanged: false,
      createdAt: document.createdAt,
    });
    expect(world.rows()).toEqual([
      {
        ...document,
        ragflowDocumentId: fresh,
        size,
        sourceMtimeMs: statSync(join(world.root, "docs/a.md")).mtimeMs,
      },
    ]);
    const documents = `/api/v1/datasets/${world.datasetId}/documents`;
    expect(world.lines().slice(sent)).toEqual([
      `POST ${documents}`,
      `POST ${documents}/parse`,
      `DELETE ${documents}`,
    ]);
    const requests = world.fake.requests().slice(sent);
    expect(requests[0]?.multipart).toEqual([{ field: "file", filename: "a.md", bytes: size }]);
    expect(requests[1]?.json).toEqual({ document_ids: [fresh] });
    expect(requests[2]?.json).toEqual({ ids: [document.ragflowDocumentId] });
    expect(world.countOf(LIST)).toBe(0);
    expect(ragflowIds(world)).toEqual([fresh]);
    expect((await world.contentOf(fresh as string)).toString()).toBe(REWRITTEN);
    expect(world.logged).toEqual([]);
  });

  it("之后的列表：该条 sourceChanged 为 false，状态来自新文档", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    world.write("a.md", REWRITTEN);
    expect((await reingest(world, document.id)).statusCode).toBe(200);
    const listed = await send(
      world.fw.rest,
      "member",
      "GET",
      `/api/kb/bases/${world.baseId}/documents`,
    );
    expect(listed.json()).toMatchObject({
      documents: [{ id: document.id, sourceChanged: false, status: "unparsed" }],
    });
  });

  it("审计：恰一条新的 kb.ingest，detail 恰为 {id, source, reingest, documentId}，workspace_id 为该工作空间", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    expect((await reingest(world, document.id)).statusCode).toBe(200);
    expect(world.audits("kb.ingest").at(-1)).toEqual({
      actorId: OWNER,
      title: TITLE,
      detail: { id: world.baseId, source: "workspace", reingest: true, documentId: document.id },
      workspaceId: W1,
    });
    expect(world.audits("kb.ingest")).toHaveLength(2);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
  });

  it("重新入库时旧文档在解析：删旧文档一直 deleted:0，200，行换成新文档，stderr 恰一行 kb_document_leak（旧 id）", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    const old = document.ragflowDocumentId;
    world.fake.setDocumentStatus(world.datasetId, old, "RUNNING");
    world.write("a.md", REWRITTEN);
    const response = await reingest(world, document.id);
    expect(response.statusCode, response.body).toBe(200);
    const fresh = world.rows()[0]?.ragflowDocumentId;
    expect(fresh).not.toBe(old);
    expect(world.logged).toEqual([{ event: "kb_document_leak", documentId: old }]);
    expect(world.countOf(STOP)).toBe(1);
    expect(ragflowIds(world).sort()).toEqual([old, fresh].sort());
    expect(world.audits("kb.ingest")).toHaveLength(2);
  });

  it("删旧文档不可达：照常 200，恰一行 kb_document_leak，不发停止", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    world.fake.fault(DELETE_DOCUMENT, { kind: "status", status: 503 });
    expect((await reingest(world, document.id)).statusCode).toBe(200);
    expect(world.logged).toEqual([
      { event: "kb_document_leak", documentId: document.ragflowDocumentId },
    ]);
    expect(world.countOf(STOP)).toBe(0);
    expect(world.rows()[0]?.ragflowDocumentId).not.toBe(document.ragflowDocumentId);
  });

  it("旧文档停下来了：删除、停止、删除，200，不写 leak", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    const old = document.ragflowDocumentId;
    world.fake.setDocumentStatus(world.datasetId, old, "RUNNING");
    const gate = world.fake.fault(STOP, { kind: "hold" });
    const pending = reingest(world, document.id);
    await gate.reached;
    world.fake.setDocumentStatus(world.datasetId, old, "STOPPED");
    gate.release();
    expect((await pending).statusCode).toBe(200);
    expect(world.logged).toEqual([]);
    expect(ragflowIds(world)).toEqual([world.rows()[0]?.ragflowDocumentId]);
  });
});

describe("源不可读", () => {
  it("源不可读：源文件已被删除，409 kb_source_unreadable，该行不变，假 RAGFlow 没有收到上传", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    rmSync(join(world.root, "a.md"));
    const sent = world.fake.requests().length;
    expectError(await reingest(world, document.id), 409, KB_SOURCE_UNREADABLE);
    expect(world.fake.requests()).toHaveLength(sent);
    expectUntouched(world, document, 1);
  });

  /** 每例：开世界、造出读不了的行，返回 `[world, document, 已有的 kb.ingest 数]`。 */
  const cases: Array<[string, () => Promise<[IngestWorld, KbDocument, number]>]> = [
    [
      "工作空间已删除",
      async () => {
        const world = await open();
        const document = await ingestedRow(world, "a.md", "a");
        world.fw.world.db.prepare("DELETE FROM workspaces WHERE id = ?").run(W1);
        return [world, document, 1];
      },
    ],
    [
      "工作空间目录已不在（行还在）",
      async () => {
        const world = await open();
        const document = await ingestedRow(world, "a.md", "a");
        rmSync(world.root, { recursive: true });
        return [world, document, 1];
      },
    ],
    [
      "outside（路径上的分量成了符号链接）",
      async () => {
        const world = await open();
        const document = await ingestedRow(world, "dir/a.md", "a");
        renameSync(join(world.root, "dir"), join(world.root, "moved"));
        symlinkSync(join(world.root, "moved"), join(world.root, "dir"));
        return [world, document, 1];
      },
    ],
    [
      "not_file（成了目录）",
      async () => {
        const world = await open();
        const document = await ingestedRow(world, "a.md", "a");
        rmSync(join(world.root, "a.md"));
        mkdirSync(join(world.root, "a.md"));
        return [world, document, 1];
      },
    ],
    [
      "offline（挂载已离线，挂载点下的宿主路径上有这个文件）",
      async () => {
        const world = await open({ offline: ["docs"] });
        put(world.fw.point("docs"), "a.pdf", "abc");
        return [world, seededWorkspaceRow(world, W1, "docs/a.pdf"), 0];
      },
    ],
    [
      "empty（成了 0 字节）",
      async () => {
        const world = await open();
        const document = await ingestedRow(world, "a.md", "a");
        world.write("a.md", "");
        return [world, document, 1];
      },
    ],
    [
      "too_large（超过上限）",
      async () => {
        const world = await open();
        const document = await ingestedRow(world, "a.md", "a");
        world.write("a.md", "x".repeat(UPLOAD_MAX_BYTES + 1));
        return [world, document, 1];
      },
    ],
    [
      "changed（fstat 之后被追加）",
      async () => {
        let armed = false;
        const world = await open({
          kb: {
            onSourceStat(absPath) {
              if (armed) appendFileSync(absPath, " appended");
            },
          },
        });
        const document = await ingestedRow(world, "a.md", "a");
        armed = true;
        return [world, document, 1];
      },
    ],
  ];

  it.each(cases)(
    "%s：409 kb_source_unreadable，行不变，没有删除，RAGFlow 里没有新文档",
    { timeout: CASE_MS },
    async (label, arrange) => {
      const [world, document, ingests] = await arrange();
      const sent = world.fake.requests().length;
      expectError(await reingest(world, document.id), 409, KB_SOURCE_UNREADABLE);
      expect(ragflowIds(world)).toEqual([document.ragflowDocumentId]);
      expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
      expect(world.countOf(PARSE)).toBe(ingests);
      if (label.startsWith("changed")) {
        // 读到多出来的字节时上传已经发出，被中止的那一个请求可能已到达假 RAGFlow。
        expect(world.fake.requests().length - sent).toBeLessThanOrEqual(1);
      } else {
        expect(world.fake.requests()).toHaveLength(sent);
      }
      expect(world.audits("sandbox.reject")).toHaveLength(label.startsWith("outside") ? 1 : 0);
      expectUntouched(world, document, ingests);
      expect(world.audits("kb.ingest_reject")).toEqual([]);
      expect(world.logged).toEqual([]);
    },
  );

  it("outside 照常由 facade 写一条 sandbox.reject；其余读取被拒不写", async () => {
    const world = await open();
    const document = await ingestedRow(world, "dir/a.md", "a");
    const gone = await ingestedRow(world, "b.md", "b");
    rmSync(join(world.root, "b.md"));
    expectError(await reingest(world, gone.id), 409, KB_SOURCE_UNREADABLE);
    expect(world.audits("sandbox.reject")).toEqual([]);
    renameSync(join(world.root, "dir"), join(world.root, "moved"));
    symlinkSync(join(world.root, "moved"), join(world.root, "dir"));
    expectError(await reingest(world, document.id), 409, KB_SOURCE_UNREADABLE);
    expect(world.audits("sandbox.reject")).toEqual([
      {
        actorId: OWNER,
        title: "越界访问被沙箱拦截",
        detail: expect.objectContaining({ relPath: "dir/a.md", op: "read" }),
        workspaceId: W1,
      },
    ]);
    expect(world.countOf(UPLOAD)).toBe(2);
  });

  it("挂载内的源在出站已经开始时变了：上传被中止，409，假 RAGFlow 上没有这份文档", {
    timeout: CASE_MS,
  }, async () => {
    let armed = false;
    const seam = createSeam();
    const world = await open({
      online: [{ name: "docs" }],
      overrides: { mountFs: seam.impl },
      kb: {
        onSourceStat(absPath) {
          if (armed) appendFileSync(absPath, " appended");
        },
      },
    });
    const point = world.fw.point("docs");
    put(point, "a.pdf", "abc");
    expect((await world.ingest(["docs/a.pdf"])).statusCode).toBe(201);
    const [document] = world.rows();
    armed = true;
    const release = seam.hold(join(point, "a.pdf"), ["read"]);
    const pending = reingest(world, document?.id ?? "");
    await expect.poll(() => world.uploads()).toHaveLength(2);
    release();
    expectError(await pending, 409, KB_SOURCE_UNREADABLE);
    await expect.poll(() => world.uploads()[1]?.aborted).toBe(true);
    expect(world.uploads()[1]?.multipart).toBeNull();
    expect(ragflowIds(world)).toEqual([document?.ragflowDocumentId]);
    expect(world.rows()).toEqual([document]);
  });

  it("本地上传的文档：400 bad_request，零出站，行不变", async () => {
    const world = await open();
    const ragflowDocumentId = world.fake.addDocument(world.datasetId, {
      name: "a.md",
      content: "a",
    });
    const document = world.store.addDocument({
      kbId: world.baseId,
      ragflowDocumentId,
      name: "a.md",
      size: 1,
      source: "upload",
    });
    expectError(await reingest(world, document.id), 400, BAD_REQUEST);
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toEqual([document]);
    expect(world.audits("kb.ingest")).toEqual([]);
  });
});

describe("重新入库的失败不动行", () => {
  it("依次五次：400 kb_rejected、400 kb_file_unsupported、503、503、400 kb_rejected；后两次删除新文档，五次行都不变，旧文档都没有被删", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    world.write("a.md", REWRITTEN);
    const steps: Array<[() => void, number, unknown, number]> = [
      [
        () =>
          world.fake.answer(UPLOAD, { code: 101, message: "File name must be 255 bytes or less." }),
        400,
        KB_REJECTED,
        0,
      ],
      [
        () => world.fake.answer(UPLOAD, { code: 500, message: UNSUPPORTED_MESSAGE("a.md") }),
        400,
        KB_FILE_UNSUPPORTED,
        0,
      ],
      [() => world.fake.fault(UPLOAD, { kind: "status", status: 503 }), 503, KB_UNAVAILABLE, 0],
      [() => world.fake.fault(PARSE, { kind: "status", status: 503 }), 503, KB_UNAVAILABLE, 1],
      [
        () => world.fake.answer(PARSE, { code: 0, data: { success_count: 0 } }),
        400,
        KB_REJECTED,
        2,
      ],
    ];
    for (const [script, status, body, deletes] of steps) {
      script();
      expectError(await reingest(world, document.id), status, body);
      expect(world.countOf(DELETE_DOCUMENT)).toBe(deletes);
      expect(ragflowIds(world)).toEqual([document.ragflowDocumentId]);
      expectUntouched(world, document, 1);
    }
    expect(world.countOf(UPLOAD)).toBe(6);
    expect(deleteBodies(world)).not.toContainEqual({ ids: [document.ragflowDocumentId] });
    expect(deleteBodies(world)).toHaveLength(2);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
    expect(world.logged).toEqual([]);
  });

  it("上传得知数据集不存在（code:102）：503 kb_unavailable，行不变", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    world.fake.answer(UPLOAD, {
      code: 102,
      message: `Can't find the dataset with ID ${world.datasetId}!`,
    });
    expectError(await reingest(world, document.id), 503, KB_UNAVAILABLE);
    expectUntouched(world, document, 1);
  });

  it("删新文档失败：应答不变，恰一行 kb_document_leak（新 id），行不变", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    world.fake.answer(PARSE, { code: 101, message: "bad request" });
    world.fake.fault(DELETE_DOCUMENT, { kind: "status", status: 503 });
    expectError(await reingest(world, document.id), 400, KB_REJECTED);
    const leaked = ragflowIds(world).filter((id) => id !== document.ragflowDocumentId);
    expect(leaked).toHaveLength(1);
    expect(world.logged).toEqual([{ event: "kb_document_leak", documentId: leaked[0] }]);
    expectUntouched(world, document, 1);
  });

  it.each([
    [
      "换行失败",
      "CREATE TRIGGER refuse BEFORE UPDATE ON kb_documents BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
    [
      "审计失败",
      "CREATE TRIGGER refuse BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.ingest' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
  ])("%s：500，行不变，删掉新文档，旧文档不动，没有新的 kb.ingest", async (_name, trigger) => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    world.fw.world.db.exec(trigger);
    expectError(await reingest(world, document.id), 500, GENERIC_500);
    expect(deleteBodies(world)).toHaveLength(1);
    expect(deleteBodies(world)).not.toContainEqual({ ids: [document.ragflowDocumentId] });
    expect(ragflowIds(world)).toEqual([document.ragflowDocumentId]);
    expectUntouched(world, document, 1);
  });
});

describe("请求判定", () => {
  it.each([
    ["缺失", ""],
    ["为空", "?doc="],
    ["多值", `?doc=${ABSENT_ID}&doc=${ABSENT_ID}`],
  ])("doc %s：400，零出站，没有审计", async (_label, query) => {
    const world = await open();
    const audited = auditRows(world.fw.world).length;
    expectError(await reingestWith(world, query), 400, BAD_REQUEST);
    expect(world.lines()).toEqual([]);
    expect(auditRows(world.fw.world)).toHaveLength(audited);
  });

  it("文档不属于该库：自己另一个库的文档、不存在的 id 与 RAGFlow 文档 id 都 404，零出站", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    const other = world.addBase("naive");
    const ragflowDocumentId = world.fake.addDocument(other.datasetId, {
      name: "b.md",
      content: "b",
    });
    const elsewhere = world.store.addDocument({
      kbId: other.baseId,
      ragflowDocumentId,
      name: "b.md",
      size: 1,
      source: "workspace",
      workspaceId: W1,
      sourcePath: "a.md",
      sourceMtimeMs: 1,
    });
    const sent = world.fake.requests().length;
    for (const id of [elsewhere.id, ABSENT_ID, document.ragflowDocumentId]) {
      expectError(await reingest(world, id), 404, NOT_FOUND);
    }
    expect(world.fake.requests()).toHaveLength(sent);
    expect(world.rows()).toEqual([document]);
  });

  it("判定次序：doc 参数先于 state，state 先于文档归属", async () => {
    const world = await open();
    world.setState("rebuilding");
    expectError(await reingestWith(world, ""), 400, BAD_REQUEST);
    expectError(await reingest(world, ABSENT_ID), 409, REBUILDING);
    expect(world.lines()).toEqual([]);
  });

  it.each([
    ["{}", "{}", "application/json"],
    ["在 body 上限内的 1", "1", "application/json"],
    ["malformed JSON", '{"a":', "application/json"],
    ["空 JSON body", "", "application/json"],
    ["text/plain body", "{}", "text/plain"],
  ])("归属路由 %s：exact 400，发生在出站与文件读取之前", async (_name, raw, type) => {
    let stats = 0;
    const world = await open({
      kb: {
        onSourceStat() {
          stats += 1;
        },
      },
    });
    const document = await ingestedRow(world, "a.md", "a");
    const sent = world.fake.requests().length;
    expectError(await reingest(world, document.id, { body: { raw, type } }), 400, BAD_REQUEST);
    expect(world.fake.requests()).toHaveLength(sent);
    expect(stats).toBe(1);
    expect(world.rows()).toEqual([document]);
  });

  it("未登录 401，先于所有权", async () => {
    const world = await open();
    const response = await reingest(world, ABSENT_ID, { who: "anonymous" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(world.lines()).toEqual([]);
  });
});

describe("文档路由的所有权", () => {
  it("POST …/documents/reingest：别人的库与不存在的 id 都 404，先于 body 与 doc 参数，零出站，没有审计，A 的行不变", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    const audited = auditRows(world.fw.world).length;
    const sent = world.fake.requests().length;
    const responses = [
      await reingest(world, document.id, { who: "admin" }),
      await reingest(world, document.id, { baseId: "e".repeat(32) }),
      await reingestWith(world, "", { who: "admin" }),
      await reingest(world, document.id, {
        who: "admin",
        body: { raw: "{not json", type: "application/json" },
      }),
      await reingest(world, document.id, { who: "admin", body: {} }),
    ];
    for (const response of responses) {
      expectError(response, 404, NOT_FOUND);
    }
    expect(responses[1]?.body).toBe(responses[0]?.body);
    expect(world.fake.requests()).toHaveLength(sent);
    expect(auditRows(world.fw.world)).toHaveLength(audited);
    expect(world.rows()).toEqual([document]);
  });

  it("重建中的别人的库：404 先于 state", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    world.setState("rebuilding");
    expectError(await reingest(world, document.id, { who: "admin" }), 404, NOT_FOUND);
    expectError(await reingest(world, document.id), 409, REBUILDING);
  });
});

describe("state 与写锁（design D20）", () => {
  it("重建失败后移出：rebuild_failed 时移出 204、该行已删除；再对它重新入库 409 kb_rebuilding", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    world.setState("rebuild_failed");
    const removed = await send(
      world.fw.rest,
      "member",
      "DELETE",
      `/api/kb/bases/${world.baseId}/documents?doc=${document.id}`,
    );
    expect(removed.statusCode).toBe(204);
    expect(world.rows()).toEqual([]);
    const sent = world.fake.requests().length;
    expectError(await reingest(world, document.id), 409, REBUILDING);
    expect(world.fake.requests()).toHaveLength(sent);
  });

  it.each(["rebuilding", "rebuild_failed"] as const)(
    "state 为 %s：409 kb_rebuilding，零出站，行不变",
    async (state) => {
      const world = await open();
      const document = await ingestedRow(world, "a.md", "a");
      world.setState(state);
      const sent = world.fake.requests().length;
      expectError(await reingest(world, document.id), 409, REBUILDING);
      expect(world.fake.requests()).toHaveLength(sent);
      expectUntouched(world, document, 1);
    },
  );

  it("写锁被重建器持有：不排队，立即 409 kb_rebuilding，零出站", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rebuild = world.locks.rebuild(world.baseId, () => held);
    const sent = world.fake.requests().length;
    expectError(await reingest(world, document.id), 409, REBUILDING);
    expect(world.fake.requests()).toHaveLength(sent);
    expect(world.rows()).toEqual([document]);
    release();
    await rebuild;
  });

  it("在途写操作结束之后才上传", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    const sent = world.fake.requests().length;
    const finish = holdWriteLock(world);
    const pending = reingest(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    expect(world.fake.requests()).toHaveLength(sent);
    await finish();
    expect((await pending).statusCode).toBe(200);
  });

  it.each([
    ["库转入 rebuilding", 409, REBUILDING],
    ["该行被移出", 404, NOT_FOUND],
  ] as const)("排队期间%s：取锁后重判，零出站", async (label, status, body) => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", "a");
    const sent = world.fake.requests().length;
    const finish = holdWriteLock(world);
    const pending = reingest(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    if (label === "库转入 rebuilding") {
      world.setState("rebuilding");
    } else {
      world.store.removeDocument(world.baseId, document.id);
    }
    await finish();
    expectError(await pending, status, body);
    expect(world.fake.requests()).toHaveLength(sent);
  });

  it("排队期间该行换了 RAGFlow 文档：删的是取锁后读到的那一份", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    const replacement = world.fake.addDocument(world.datasetId, { name: "a.md", content: "a2" });
    const finish = holdWriteLock(world);
    const pending = reingest(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    world.fw.world.db
      .prepare("UPDATE kb_documents SET ragflow_document_id = ? WHERE id = ?")
      .run(replacement, document.id);
    await finish();
    expect((await pending).statusCode).toBe(200);
    expect(deleteBodies(world)).toEqual([{ ids: [replacement] }]);
    const fresh = world.rows()[0]?.ragflowDocumentId;
    expect(ragflowIds(world).sort()).toEqual([document.ragflowDocumentId, fresh].sort());
  });

  it("同一文档的两个重新入库并发：串行，后到的删掉先到的新文档，最终 RAGFlow 只剩行里那一份", async () => {
    const world = await open({ kb: LONG });
    const document = await ingestedRow(world, "a.md", "a");
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const first = reingest(world, document.id);
    await gate.reached;
    const second = reingest(world, document.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    });
    gate.release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(world.countOf(UPLOAD)).toBe(3);
    expect(ragflowIds(world)).toEqual([world.rows()[0]?.ragflowDocumentId]);
    expect(world.audits("kb.ingest")).toHaveLength(3);
  });
});

describe("审计", () => {
  it("detail 不含敏感内容：文件内容与 RAGFlow message 的哨兵进不了应答、审计与 stderr 记录", async () => {
    const world = await open();
    const document = await ingestedRow(world, "a.md", `正文 ${CONTENT_SENTINEL}`);
    world.write("a.md", `第二版 ${CONTENT_SENTINEL}`);
    world.fake.answer(UPLOAD, { code: 101, message: MESSAGE_SENTINEL });
    const rejected = await reingest(world, document.id);
    expect(rejected.statusCode).toBe(400);
    world.fake.answer(PARSE, { code: 0, data: { success_count: 0 }, message: MESSAGE_SENTINEL });
    world.fake.fault(DELETE_DOCUMENT, { kind: "status", status: 503, body: MESSAGE_SENTINEL });
    const unparsed = await reingest(world, document.id);
    expect(unparsed.statusCode).toBe(400);
    const done = await reingest(world, document.id);
    expect(done.statusCode).toBe(200);
    for (const response of [rejected, unparsed, done]) {
      expect(response.body).not.toContain(CONTENT_SENTINEL);
      expect(response.body).not.toContain(MESSAGE_SENTINEL);
    }
    const ingests = world.audits("kb.ingest");
    expect(ingests.map(({ detail }) => Object.keys(detail).sort())).toEqual([
      ["documentId", "id", "path", "source", "workspaceId"],
      ["documentId", "id", "reingest", "source"],
    ]);
    const text = JSON.stringify(auditRows(world.fw.world));
    expect(text).not.toContain(CONTENT_SENTINEL);
    expect(text).not.toContain(MESSAGE_SENTINEL);
    expect(world.logged).toHaveLength(1);
    expect(JSON.stringify(world.logged)).not.toContain(MESSAGE_SENTINEL);
  });
});
