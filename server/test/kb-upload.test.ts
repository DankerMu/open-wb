/**
 * s2a-kb-ragflow tasks 12.2（#1849）：本地上传入库（knowledge-bases「本地上传入库」、「知识库端点」的「文档路由的所有权」、
 * 「知识库审计」的上传一腿，http-service-skeleton「知识库的归属路由」）。经 `createApp` 打假 RAGFlow，上传走 `app.inject()`，
 * 连接层的用例走裸 socket（`kb-upload-helpers.ts`）。期望值是 spec 与实测记录的字面量。
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PARSER_INPUTS } from "./http-guard-helpers.js";
import {
  BAD_REQUEST,
  CONTENT_SENTINEL,
  DELETE_DOCUMENT,
  LIST,
  MESSAGE_SENTINEL,
  NOT_FOUND,
  PARSE,
  REBUILDING,
  UNSUPPORTED_MESSAGE,
  UPLOAD,
  UPLOAD_MAX_BYTES,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE } from "./kb-settings-helpers.js";
import {
  answerOf,
  countingBody,
  expectCompensated,
  expectNoIngestAudit,
  expectRejects,
  holdWriteLock,
  KB_FILE_UNSUPPORTED,
  KB_LIMIT,
  KB_REJECTED,
  listen,
  nameQuery,
  parsedId,
  seedDocuments,
  startUpload,
  upload,
  uploadedId,
  uploadRaw,
  withDiskWatch,
} from "./kb-upload-helpers.js";
import { OWNER, waitFor } from "./mounts-manager-helpers.js";
import { CASE_MS } from "./mounts-rest-helpers.js";
import {
  chunkOf,
  expectWire,
  OCTET_STREAM,
  UPLOAD_TOO_LARGE_ENVELOPE,
} from "./workspace-upload-helpers.js";

const open = useIngestWorlds();

const MIB = 1024 * 1024;
const GENERIC_500 = { error: { message: "服务器内部错误" } };

describe("上传不落盘", () => {
  it("1 MiB：字节原样到 RAGFlow，Content-Length 等于实际字节数，上传期间与之后三个目录都没有新增", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ kb: { uploadMaxBytes: 2 * MIB } });
    await withDiskWatch(world, async (expectDiskUnchanged) => {
      const content = randomBytes(MIB);
      const gate = world.fake.fault(UPLOAD, { kind: "hold" });
      const pending = upload(world, "big.pdf", content);
      await gate.reached;
      expectDiskUnchanged();
      gate.release();
      const response = await pending;

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        size: MIB,
        status: "queued",
        chunkCount: null,
        message: null,
        sourceChanged: null,
      });
      expectDiskUnchanged();

      const sent = world.uploads()[0];
      expect(sent?.multipart).toEqual([{ field: "file", filename: "big.pdf", bytes: MIB }]);
      expect(sent?.received).toBe(sent?.contentLength);
      expect((await world.contentOf(uploadedId(world))).equals(content)).toBe(true);
      expect(world.countOf(LIST)).toBe(0);
    });
  });

  it("请求体发到一半字节已经到了 RAGFlow，这时三个目录同样没有新增；发完得 201", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ kb: { uploadMaxBytes: 2 * MIB } });
    const port = await listen(world);
    await withDiskWatch(world, async (expectDiskUnchanged) => {
      const half = randomBytes(MIB / 2);
      const socket = await startUpload(world, port, {
        query: nameQuery("big.pdf"),
        headers: { "Content-Length": String(MIB), Connection: "close" },
        body: half,
      });
      const answer = answerOf(socket);
      await waitFor(() => (world.uploads()[0]?.received ?? 0) > 0);
      expectDiskUnchanged();
      socket.write(half);

      expect((await answer).status).toBe(201);
      expectDiskUnchanged();
      expect(world.fake.documents(world.datasetId).map(({ size }) => size)).toEqual([MIB]);
    });
  });
});

describe("201 的视图", () => {
  it("不读 RAGFlow：queued、三个 null，只有上传与解析触发，写一条 kb.ingest", async () => {
    const world = await open();
    const response = await upload(world, "说明.md", "hello");
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const [row] = world.rows();
    expect(response.json()).toEqual({
      id: row?.id,
      name: "说明.md",
      size: 5,
      source: "upload",
      workspaceId: null,
      path: null,
      status: "queued",
      chunkCount: null,
      message: null,
      sourceChanged: null,
      createdAt: row?.createdAt,
    });
    const documents = `/api/v1/datasets/${world.datasetId}/documents`;
    expect(world.lines()).toEqual([`POST ${documents}`, `POST ${documents}/parse`]);
    expect(world.uploads()[0]?.multipart).toEqual([
      { field: "file", filename: "说明.md", bytes: 5 },
    ]);
    expect(row).toMatchObject({
      ragflowDocumentId: uploadedId(world),
      source: "upload",
      workspaceId: null,
      sourcePath: null,
      sourceMtimeMs: null,
    });
  });

  it("文档列表里这一行 sourceChanged 为 null", async () => {
    const world = await open();
    await upload(world, "a.md");
    const listed = await world.fw.rest.app.inject({
      method: "GET",
      url: `/api/kb/bases/${world.baseId}/documents`,
      headers: { cookie: world.fw.rest.cookies.member },
    });
    expect(listed.json()).toMatchObject({
      documents: [{ name: "a.md", source: "upload", sourceChanged: null }],
    });
  });

  it("大写后缀：判定转小写，上传的文件名不改", async () => {
    const world = await open({ template: "paper" });
    const response = await upload(world, "B.PDF");
    expect(response.statusCode).toBe(201);
    expect(world.uploads()[0]?.multipart?.[0]?.filename).toBe("B.PDF");
  });

  it("恰 255 字节的文件名可以上传", async () => {
    const world = await open();
    const name = `${"a".repeat(252)}.md`;
    const response = await upload(world, name);
    expect(response.statusCode).toBe(201);
    expect(world.uploads()[0]?.multipart?.[0]?.filename).toBe(name);
  });

  it("同名再传一次是两行：文档名只来自本地记录", async () => {
    const world = await open();
    await upload(world, "a.md");
    expect((await upload(world, "a.md")).statusCode).toBe(201);
    expect(world.rows().map(({ name }) => name)).toEqual(["a.md", "a.md"]);
  });
});

describe("超限与缺少长度", () => {
  it("Content-Length 超过上限：413，一条 kb.ingest_reject，没有出站请求", async () => {
    const world = await open();
    const response = await upload(world, "a.md", "x", { contentLength: UPLOAD_MAX_BYTES + 1 });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual(UPLOAD_TOO_LARGE_ENVELOPE);
    expectRejects(world, [{ name: "a.md", reason: "too_large" }]);
    expect(world.lines()).toEqual([]);
  });

  it("恰好等于上限可以上传", async () => {
    const world = await open();
    const response = await upload(world, "a.md", Buffer.alloc(UPLOAD_MAX_BYTES, 0x61));
    expect(response.statusCode).toBe(201);
  });

  it("超限在连接上：不等请求体发完就应答并关连接", { timeout: CASE_MS }, async () => {
    const world = await open();
    const socket = await startUpload(world, await listen(world), {
      query: nameQuery("a.md"),
      headers: { "Content-Length": String(UPLOAD_MAX_BYTES + 1) },
      body: Buffer.alloc(16, 0x61),
    });
    const answer = await answerOf(socket);
    expectWire(answer, 413, UPLOAD_TOO_LARGE_ENVELOPE);
    expect(answer.closedByServer).toBe(true);
  });

  it("不带 Content-Length：400，没有出站请求，没有审计", async () => {
    const world = await open();
    const response = await uploadRaw(world, nameQuery("a.md"), undefined);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expectNoIngestAudit(world);
    expect(world.lines()).toEqual([]);
  });

  it("判定次序：长度先于后缀，paper 库的 a.txt 不带 Content-Length 也是 400，不写审计", async () => {
    const world = await open({ template: "paper" });
    const response = await uploadRaw(world, nameQuery("a.txt"), undefined);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expectNoIngestAudit(world);
    expect(world.lines()).toEqual([]);
  });

  it.each(["abc", "-1", "1.5", "0x10"])("Content-Length 为 %s：400", async (contentLength) => {
    const world = await open();
    const response = await upload(world, "a.md", "x", { contentLength });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(world.lines()).toEqual([]);
  });

  it("分块传输：400 并关连接，没有出站请求，没有审计", { timeout: CASE_MS }, async () => {
    const world = await open();
    const socket = await startUpload(world, await listen(world), {
      query: nameQuery("a.md"),
      headers: { "Transfer-Encoding": "chunked" },
      body: chunkOf(Buffer.from("hello")),
    });
    const answer = await answerOf(socket);
    expectWire(answer, 400, BAD_REQUEST);
    expect(answer.closedByServer).toBe(true);
    expectNoIngestAudit(world);
    expect(world.lines()).toEqual([]);
  });
});

describe("上传的后缀与空文件", () => {
  it("paper 库的 a.txt 与 0 字节的 b.pdf：都 400，reason 依次，没有出站请求", async () => {
    const world = await open({ template: "paper" });
    const suffix = await upload(world, "a.txt");
    const empty = await upload(world, "b.pdf", Buffer.alloc(0), { contentLength: 0 });
    for (const response of [suffix, empty]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(KB_FILE_UNSUPPORTED);
    }
    expectRejects(world, [
      { name: "a.txt", reason: "unsupported_type" },
      { name: "b.pdf", reason: "empty" },
    ]);
    expect(world.lines()).toEqual([]);
  });

  it.each(["noext", ".", "..", "a."])("没有后缀的 %s：unsupported_type", async (name) => {
    const world = await open();
    const response = await upload(world, name);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(KB_FILE_UNSUPPORTED);
    expectRejects(world, [{ name, reason: "unsupported_type" }]);
    expect(world.lines()).toEqual([]);
  });

  it("判定次序：超限先于后缀，后缀先于空文件", async () => {
    const world = await open({ template: "paper" });
    const big = await upload(world, "a.txt", "x", { contentLength: UPLOAD_MAX_BYTES + 1 });
    const empty = await upload(world, "b.txt", Buffer.alloc(0), { contentLength: 0 });
    expect(big.statusCode).toBe(413);
    expect(empty.statusCode).toBe(400);
    expectRejects(world, [
      { name: "a.txt", reason: "too_large" },
      { name: "b.txt", reason: "unsupported_type" },
    ]);
  });
});

describe("上传回不支持的文件", () => {
  it("code:500：400 kb_file_unsupported，一条 kb.ingest_reject，没有解析触发与删除", async () => {
    const world = await open();
    world.fake.answer(UPLOAD, { code: 500, message: UNSUPPORTED_MESSAGE("a.pdf") });
    const response = await upload(world, "a.pdf");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(KB_FILE_UNSUPPORTED);
    expectRejects(world, [{ name: "a.pdf", reason: "unsupported_type" }]);
    expect(world.audits("kb.ingest")).toEqual([]);
    expect(world.rows()).toEqual([]);
    expect(world.countOf(UPLOAD)).toBe(1);
    expect(world.countOf(PARSE)).toBe(0);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
  });
});

describe("上传失败", () => {
  it.each([
    ["code:101", { kind: "answer", code: 101, message: "bad" }, 400, KB_REJECTED],
    ["HTTP 503", { kind: "status" }, 503, KB_UNAVAILABLE],
    [
      "数据集不存在",
      { kind: "answer", code: 102, message: "Can't find the dataset with ID x!" },
      503,
      KB_UNAVAILABLE,
    ],
  ] as const)("%s：没有文档要删，没有行，不写审计", async (_name, reply, status, body) => {
    const world = await open();
    if (reply.kind === "status") {
      world.fake.fault(UPLOAD, { kind: "status", status: 503 });
    } else {
      world.fake.answer(UPLOAD, { code: reply.code, message: reply.message });
    }
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual(body);
    expect(world.rows()).toEqual([]);
    expect(world.countOf(PARSE)).toBe(0);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
    expectNoIngestAudit(world);
  });

  it("早应答发得到客户端：请求体没发完 RAGFlow 就不可达，503 照样回去", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ kb: { uploadMaxBytes: MIB } });
    await world.fake.close();
    const socket = await startUpload(world, await listen(world), {
      query: nameQuery("a.md"),
      headers: { "Content-Length": String(MIB) },
      body: Buffer.alloc(1024, 0x61),
    });
    const answer = await answerOf(socket);
    expectWire(answer, 503, KB_UNAVAILABLE);
    expect(answer.closedByServer).toBe(true);
    expect(world.rows()).toEqual([]);
  });
});

describe("上传的文档数上限", () => {
  it("已有 500 份：409 kb_limit，一条 kb.ingest_reject，没有出站请求", async () => {
    const world = await open();
    seedDocuments(world, 500);
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(KB_LIMIT);
    expectRejects(world, [{ name: "a.md", reason: "limit" }]);
    expect(world.lines()).toEqual([]);
    expect(world.rows()).toHaveLength(500);
  });

  it("已有 499 份时两个上传并发：恰一个 201、一个 409 kb_limit，最终 500 行", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open();
    seedDocuments(world, 499);
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const first = upload(world, "a.md");
    await gate.reached;
    const second = upload(world, "b.md");
    await waitFor(() => world.locks.writeWaiters(world.baseId) === 1);
    gate.release();

    const [winner, loser] = await Promise.all([first, second]);
    expect(winner.statusCode).toBe(201);
    expect(loser.statusCode).toBe(409);
    expect(loser.json()).toEqual(KB_LIMIT);
    expect(world.rows()).toHaveLength(500);
    expect(world.countOf(UPLOAD)).toBe(1);
    expectRejects(world, [{ name: "b.md", reason: "limit" }]);
  });
});

describe("解析触发失败", () => {
  it("HTTP 503：503 kb_unavailable，删除该文档，没有行", async () => {
    const world = await open();
    world.fake.fault(PARSE, { kind: "status", status: 503 });
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
    expectCompensated(world, parsedId(world));
  });

  it("code:0 且 success_count:0：400 kb_rejected，删除该文档，没有行", async () => {
    const world = await open();
    world.fake.answer(PARSE, { code: 0, data: { success_count: 0 } });
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(KB_REJECTED);
    expectCompensated(world, parsedId(world));
  });

  it("code:101：400 kb_rejected，删除该文档", async () => {
    const world = await open();
    world.fake.answer(PARSE, { code: 101, message: "bad" });
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(KB_REJECTED);
    expectCompensated(world, parsedId(world));
  });

  it("数据集不存在：503 kb_unavailable，删除该文档", async () => {
    const world = await open();
    world.fake.answer(PARSE, { code: 404, message: "Resource not found" });
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
    expectCompensated(world, parsedId(world));
  });

  it("删除不可达：恰一行 kb_document_leak，不改变应答", async () => {
    const world = await open();
    world.fake.fault(PARSE, { kind: "status", status: 503 });
    world.fake.fault(DELETE_DOCUMENT, { kind: "status", status: 503 });
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(KB_UNAVAILABLE);
    expect(world.logged).toEqual([{ event: "kb_document_leak", documentId: uploadedId(world) }]);
    expect(world.rows()).toEqual([]);
  });

  it("删除一直 deleted:0：走 D13 的写法，到期后恰一行 kb_document_leak", async () => {
    const world = await open();
    world.fake.answer(PARSE, { code: 0, data: { success_count: 0 } });
    world.fake.answer(DELETE_DOCUMENT, { code: 0, data: { deleted: 0 } }, { times: 10_000 });
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(KB_REJECTED);
    expect(world.logged).toEqual([{ event: "kb_document_leak", documentId: uploadedId(world) }]);
    expect(world.countOf("POST /api/v1/datasets/*/documents/stop")).toBe(1);
  });

  it.each([
    [
      "插行失败",
      "CREATE TRIGGER refuse BEFORE INSERT ON kb_documents BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
    [
      "审计失败",
      "CREATE TRIGGER refuse BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.ingest' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
  ])("%s：500，删掉刚上传的文档，没有行，没有 kb.ingest", async (_name, trigger) => {
    const world = await open();
    world.fw.world.db.exec(trigger);
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(GENERIC_500);
    expectCompensated(world, parsedId(world));
  });
});

describe("文档路由的所有权", () => {
  it("别人的库：404，请求体不被读取，零出站，没有审计", async () => {
    const world = await open();
    const { payload, pulled } = countingBody();
    const response = await uploadRaw(world, nameQuery("a.md"), payload, {
      who: "admin",
      contentLength: 7,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(pulled()).toBe(0);
    expect(world.lines()).toEqual([]);
    expectNoIngestAudit(world);
  });

  it("所有者的同一个请求：请求体被读取（上一条用例的判据是灵的）", async () => {
    const world = await open();
    const { payload, pulled } = countingBody();
    const response = await uploadRaw(world, nameQuery("a.md"), payload, { contentLength: 7 });
    expect(response.statusCode).toBe(201);
    expect(pulled()).toBeGreaterThan(0);
  });

  it("不存在的 id：404，零出站", async () => {
    const world = await open();
    const response = await upload(world, "a.md", "x", { baseId: "f".repeat(32) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(world.lines()).toEqual([]);
  });

  it("判定先于媒体类型、文件名与长度：别人的库带什么都是 404", async () => {
    const world = await open();
    const media = await uploadRaw(world, nameQuery("a.md"), "x", {
      who: "admin",
      contentType: "text/plain",
    });
    const oversized = await upload(world, "a.md", "x", {
      who: "admin",
      contentLength: UPLOAD_MAX_BYTES + 1,
    });
    const nameless = await uploadRaw(world, "", "x", { who: "admin" });
    for (const response of [media, oversized, nameless]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expectNoIngestAudit(world);
  });

  it("只发请求头：不等请求体就 404 并关连接", { timeout: CASE_MS }, async () => {
    const world = await open();
    const socket = await startUpload(world, await listen(world), {
      baseId: "f".repeat(32),
      query: nameQuery("a.md"),
      headers: { "Content-Length": "100" },
    });
    const answer = await answerOf(socket);
    expectWire(answer, 404, NOT_FOUND);
    expect(answer.closedByServer).toBe(true);
    expect(world.lines()).toEqual([]);
  });

  it("未登录：401", async () => {
    const world = await open();
    const response = await upload(world, "a.md", "x", { who: "anonymous" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(world.lines()).toEqual([]);
  });
});

describe("文件名规则", () => {
  const encoded = (name: string) => nameQuery(name);
  const CASES = [
    ["缺失", ""],
    ["重复", "name=a.md&name=b.md"],
    ["空串", "name="],
    ["含 /", encoded("sub/a.md")],
    ["拒绝字符：控制字符", encoded("a\u0001.md")],
    ["拒绝字符：双向控制", encoded("a‮.md")],
    ["临时前缀", encoded(".upload-abc.md")],
    ["超 255 字节", encoded(`${"a".repeat(253)}.md`)],
    ["按字节算：88 个码点，256 字节", encoded(`${"中".repeat(84)}.pdf`)],
  ] as const;

  it.each(CASES)("%s：400，没有出站请求，没有审计", async (_name, query) => {
    const world = await open();
    const response = await uploadRaw(world, query, "content");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(world.lines()).toEqual([]);
    expectNoIngestAudit(world);
  });

  it.each(CASES)("%s：先于任何写审计的判定，超限也不进审计", async (_name, query) => {
    const world = await open();
    const response = await uploadRaw(world, query, "x", { contentLength: UPLOAD_MAX_BYTES + 1 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expectNoIngestAudit(world);
  });

  it("后缀不通过与上限：过长的名字同样不进审计", async () => {
    const world = await open();
    seedDocuments(world, 500);
    const suffix = await upload(world, `${"a".repeat(253)}.zz`);
    const limit = await upload(world, `${"a".repeat(253)}.md`);
    for (const response of [suffix, limit]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(BAD_REQUEST);
    }
    expectNoIngestAudit(world);
  });
});

describe("归属路由 POST /api/kb/bases/:id/uploads（http-service-skeleton「知识库的归属路由」）", () => {
  // 这条路由只认 octet-stream：别的媒体类型都是 parser 错误，octet-stream 是它的合法请求。
  const FOREIGN = [
    ...PARSER_INPUTS.filter(({ contentType }) => contentType !== OCTET_STREAM),
    { name: "text/plain", payload: "content", contentType: "text/plain" },
  ];

  it.each(FOREIGN)("$name：exact 400，发生在出站之前", async ({ payload, contentType }) => {
    const world = await open();
    const response = await uploadRaw(world, nameQuery("a.md"), payload, { contentType });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(world.lines()).toEqual([]);
    expectNoIngestAudit(world);
  });

  it("没有媒体类型也没有请求体：exact 400", async () => {
    const world = await open();
    const response = await world.fw.rest.app.inject({
      method: "POST",
      url: `/api/kb/bases/${world.baseId}/uploads?name=a.md`,
      headers: { cookie: world.fw.rest.cookies.member },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(world.lines()).toEqual([]);
  });
});

describe("知识库非 ready", () => {
  it.each(["rebuilding", "rebuild_failed"] as const)(
    "state 为 %s：409，零出站，没有审计",
    async (state) => {
      const world = await open();
      world.setState(state);
      const response = await upload(world, "a.md");
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(REBUILDING);
      expect(world.lines()).toEqual([]);
      expectNoIngestAudit(world);
    },
  );

  it("判定次序：超限与空文件都先于 state，写审计", async () => {
    const world = await open();
    world.setState("rebuilding");
    const big = await upload(world, "a.md", "x", { contentLength: UPLOAD_MAX_BYTES + 1 });
    const empty = await upload(world, "b.md", Buffer.alloc(0), { contentLength: 0 });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual(UPLOAD_TOO_LARGE_ENVELOPE);
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual(KB_FILE_UNSUPPORTED);
    expectRejects(world, [
      { name: "a.md", reason: "too_large" },
      { name: "b.md", reason: "empty" },
    ]);
    expect(world.lines()).toEqual([]);
  });

  it("写锁被重建器持有：立即 409，不排队", async () => {
    const world = await open();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rebuild = world.locks.rebuild(world.baseId, () => held);
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(REBUILDING);
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);
    release();
    await rebuild;
    expect(world.lines()).toEqual([]);
  });

  it("重建中的库不排队：写锁被占着也立即 409", async () => {
    const world = await open();
    const release = holdWriteLock(world);
    world.setState("rebuilding");
    const response = await upload(world, "a.md");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(REBUILDING);
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);
    await release();
  });

  it("排队期间转入重建：取锁后重判，409，零出站", { timeout: CASE_MS }, async () => {
    const world = await open();
    const release = holdWriteLock(world);
    const pending = upload(world, "a.md");
    await waitFor(() => world.locks.writeWaiters(world.baseId) === 1);
    world.setState("rebuilding");
    await release();
    const response = await pending;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(REBUILDING);
    expect(world.lines()).toEqual([]);
  });

  it("排队期间库被删除：取锁后重判，404，零出站", { timeout: CASE_MS }, async () => {
    const world = await open();
    const release = holdWriteLock(world);
    const pending = upload(world, "a.md");
    await waitFor(() => world.locks.writeWaiters(world.baseId) === 1);
    world.store.removeBase(world.baseId);
    await release();
    const response = await pending;
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
    expect(world.lines()).toEqual([]);
  });
});

describe("知识库审计", () => {
  const INGEST_KEYS = ["documentId", "id", "name", "size", "source"];
  const REJECT_KEYS = ["id", "name", "reason", "source"];

  it("kb.ingest 的键集恰如表，标题固定，workspace_id 为 null", async () => {
    const world = await open();
    const response = await upload(world, "a.md", "hello");
    const { id } = response.json<{ id: string }>();
    expect(world.audits("kb.ingest")).toEqual([
      {
        actorId: OWNER,
        title: "知识库入库文档",
        detail: { id: world.baseId, source: "upload", name: "a.md", size: 5, documentId: id },
        workspaceId: null,
      },
    ]);
  });

  it("detail 不含敏感内容：文件内容与 RAGFlow message 的哨兵不进应答、审计与日志", async () => {
    const world = await open();
    const accepted = await upload(world, "a.md", CONTENT_SENTINEL);
    world.fake.answer(UPLOAD, { code: 500, message: UNSUPPORTED_MESSAGE(MESSAGE_SENTINEL) });
    const refused = await upload(world, "b.md", CONTENT_SENTINEL);
    world.fake.answer(UPLOAD, { code: 101, message: MESSAGE_SENTINEL });
    const rejected = await upload(world, "c.md", CONTENT_SENTINEL);

    const ingests = world.audits("kb.ingest");
    const rejects = world.audits("kb.ingest_reject");
    expect(ingests.map(({ detail }) => Object.keys(detail).sort())).toEqual([INGEST_KEYS]);
    expect(rejects.map(({ detail }) => Object.keys(detail).sort())).toEqual([REJECT_KEYS]);
    const text = JSON.stringify([
      ingests,
      rejects,
      accepted.body,
      refused.body,
      rejected.body,
      world.logged,
    ]);
    expect(text).not.toContain(CONTENT_SENTINEL);
    expect(text).not.toContain(MESSAGE_SENTINEL);
  });
});
