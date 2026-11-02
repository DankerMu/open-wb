/**
 * s2a-kb-ragflow tasks 10.2（#1847）：`POST /api/kb/bases/:id/documents` 的请求判定、逐条处理、视图与审计（knowledge-bases
 * 「工作空间来源入库」「知识库端点」的「文档路由的所有权」「知识库审计」，http-service-skeleton「知识库的归属路由」）。
 * RAGFlow 的失败、读取期间的变化、并发与挂载故障在 `kb-ingest-workspace-faults.test.ts`。经 `createApp` + `app.inject()`
 * 打假 RAGFlow，挂载是真实 manager（`kb-ingest-helpers.ts`）。期望值是 spec 的字面量。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAD_REQUEST,
  bytesOf,
  CONTENT_SENTINEL,
  MESSAGE_SENTINEL,
  NOT_FOUND,
  PARSE,
  REBUILDING,
  scriptSecondUpload,
  UNSUPPORTED_MESSAGE,
  UPLOAD,
  UPLOAD_MAX_BYTES,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { createSeam, handles, put } from "./mounts-file-endpoints-helpers.js";
import { OWNER, W_LISI, W1, W2 } from "./mounts-manager-helpers.js";
import { CASE_MS } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();

const MESSAGES = {
  outside: "目标路径不在你的沙箱内",
  not_file: "不是普通文件，或文件不存在",
  too_large: "文件超过大小上限",
  unsupported_type: "这个模板不支持这种文件",
  empty: "文件是空的，不能入库",
  offline: "挂载已离线",
  duplicate: "已在知识库里",
  limit: "知识库文档数已达上限",
  changed: "读取期间文件发生了变化",
  rejected: "知识库服务拒绝了这个文件",
  unavailable: "知识库服务暂不可用",
} as const;

type Reason = keyof typeof MESSAGES;

const rejection = (path: string, reason: Reason) => ({
  path,
  reason,
  message: MESSAGES[reason],
});

const DOCUMENT_KEYS = [
  "chunkCount",
  "createdAt",
  "id",
  "message",
  "name",
  "path",
  "size",
  "source",
  "sourceChanged",
  "status",
  "workspaceId",
];

interface Ingested {
  documents: Array<Record<string, unknown>>;
  rejected: Array<{ path: string; reason: string; message: string }>;
}

const pathsOf = (body: Ingested) => body.documents.map((document) => document.path);

describe("混合批次与路径", () => {
  it("混合批次：两条入库、五条被拒，审计与出站逐一对上，只读挂载可入库", {
    timeout: CASE_MS,
  }, async () => {
    const world = await open({ online: [{ name: "docs", readOnly: true }] });
    world.write("a.md", "# a\n");
    put(world.fw.point("docs"), "b.pdf", "%PDF-1.4 b");
    mkdirSync(join(world.root, "dir.md"));
    world.write("big.pdf", Buffer.alloc(UPLOAD_MAX_BYTES + 1, 7));
    world.write("real/c.md", "c");
    symlinkSync(join(world.root, "real"), join(world.root, "link"));

    const response = await world.ingest([
      "a.md",
      "docs/b.pdf",
      "../x",
      "dir.md",
      "big.pdf",
      "a.md",
      "link/c.md",
    ]);

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md", "docs/b.pdf"]);
    for (const document of body.documents) {
      expect(document).toMatchObject({
        status: "queued",
        chunkCount: null,
        message: null,
        sourceChanged: false,
      });
    }
    expect(body.rejected).toEqual([
      rejection("../x", "outside"),
      rejection("dir.md", "not_file"),
      rejection("big.pdf", "too_large"),
      rejection("a.md", "duplicate"),
      rejection("link/c.md", "outside"),
    ]);
    expect(world.audits("kb.ingest_reject")).toHaveLength(5);
    expect(world.audits("kb.ingest")).toHaveLength(2);
    expect(world.audits("sandbox.reject")).toHaveLength(2);
    expect(world.countOf(UPLOAD)).toBe(2);
    expect(world.countOf(PARSE)).toBe(2);
    expect(world.lines().filter((line) => line.startsWith("GET "))).toEqual([]);
    const [first, second] = world.rows();
    expect(await world.contentOf(String(first?.ragflowDocumentId))).toEqual(Buffer.from("# a\n"));
    expect(await world.contentOf(String(second?.ragflowDocumentId))).toEqual(
      Buffer.from("%PDF-1.4 b"),
    );
  });

  it("路径不存在：后缀判定在打开之前，没有 sandbox.reject", { timeout: CASE_MS }, async () => {
    const world = await open({ online: [{ name: "docs" }] });
    world.write("a.md", "a");
    const response = await world.ingest(["missing.md", "a.md", "docs/gone.pdf", "missing"]);
    expect(response.statusCode).toBe(201);
    const body = response.json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md"]);
    expect(body.rejected).toEqual([
      rejection("missing.md", "not_file"),
      rejection("docs/gone.pdf", "not_file"),
      rejection("missing", "unsupported_type"),
    ]);
    expect(world.audits("sandbox.reject")).toEqual([]);
    expect(world.countOf(UPLOAD)).toBe(1);
  });

  it("不是普通文件的路径：FIFO 不打开、不挂起，目录同样 not_file", async () => {
    const world = await open();
    mkdirSync(join(world.root, "d.pdf"));
    execFileSync("mkfifo", [join(world.root, "p.md")]);
    const body = (await world.ingest(["d.pdf", "p.md"])).json<Ingested>();
    expect(body.rejected).toEqual([rejection("d.pdf", "not_file"), rejection("p.md", "not_file")]);
    expect(world.lines()).toEqual([]);
  });

  it("同一文件的不同写法算同一路径：第二条 duplicate，文档行与审计用规范写法", async () => {
    const world = await open();
    world.write("sub/a.md", "a");
    const body = (await world.ingest(["./sub//a.md", "sub/a.md", "sub/./a.md/"])).json<Ingested>();
    expect(pathsOf(body)).toEqual(["sub/a.md"]);
    expect(body.rejected).toEqual([
      rejection("sub/a.md", "duplicate"),
      rejection("sub/./a.md/", "duplicate"),
    ]);
    expect(world.rows().map((row) => row.sourcePath)).toEqual(["sub/a.md"]);
    expect(world.audits("kb.ingest")[0]?.detail.path).toBe("sub/a.md");
    expect(world.countOf(UPLOAD)).toBe(1);
  });

  it("工作空间根本身：没有后缀，unsupported_type，不写 sandbox.reject", async () => {
    const world = await open();
    const body = (await world.ingest([""])).json<Ingested>();
    expect(body.rejected).toEqual([rejection("", "unsupported_type")]);
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it("路径含 NUL 或绝对路径：outside，照常写 sandbox.reject", async () => {
    const world = await open();
    const body = (await world.ingest(["a\u0000.md", "/etc/passwd.md"])).json<Ingested>();
    expect(body.rejected.map(({ reason }) => reason)).toEqual(["outside", "outside"]);
    expect(world.audits("sandbox.reject")).toHaveLength(2);
    expect(world.lines()).toEqual([]);
  });
});

describe("后缀与空文件", () => {
  it("manual：大写后缀按小写判定、无后缀拒绝、0 字节拒绝", async () => {
    const world = await open({ template: "manual" });
    world.write("a.txt", "a");
    world.write("b.PDF", "b");
    world.write("noext", "n");
    world.write("c.pdf", "");
    world.write("d.docx", "d");
    const response = await world.ingest(["a.txt", "b.PDF", "noext", "c.pdf", "d.docx"]);
    expect(response.statusCode).toBe(201);
    const body = response.json<Ingested>();
    expect(pathsOf(body)).toEqual(["b.PDF", "d.docx"]);
    expect(body.rejected).toEqual([
      rejection("a.txt", "unsupported_type"),
      rejection("noext", "unsupported_type"),
      rejection("c.pdf", "empty"),
    ]);
    expect(world.countOf(UPLOAD)).toBe(2);
    expect(world.audits("kb.ingest_reject")).toHaveLength(3);
  });

  it("转小写只用于判定：上传的文件名与文档名保持大写", async () => {
    const world = await open({ template: "manual" });
    world.write("b.PDF", "b");
    await world.ingest(["b.PDF"]);
    expect(world.uploads()[0]?.multipart).toEqual([{ field: "file", filename: "b.PDF", bytes: 1 }]);
    expect(world.rows()[0]?.name).toBe("b.PDF");
  });

  it("后缀按该库的模板：paper 库不收 .md，naive 库收", async () => {
    const world = await open({ template: "paper" });
    world.write("a.md", "a");
    expect((await world.ingest(["a.md"])).json<Ingested>().rejected).toEqual([
      rejection("a.md", "unsupported_type"),
    ]);
    const naive = world.addBase("naive");
    const body = (await world.ingest(["a.md"], { baseId: naive.baseId })).json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md"]);
  });

  it("不支持的后缀不中止整批：第二份 code:500，第一、三份入库，收到三次上传", async () => {
    const world = await open();
    for (const name of ["a.md", "b.md", "c.md"]) world.write(name, name);
    const response = await scriptSecondUpload(
      world,
      () => {
        world.fake.answer(UPLOAD, { code: 500, message: UNSUPPORTED_MESSAGE("b.md") });
      },
      () => world.ingest(["a.md", "b.md", "c.md"]),
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md", "c.md"]);
    expect(body.rejected).toEqual([rejection("b.md", "unsupported_type")]);
    expect(world.countOf(UPLOAD)).toBe(3);
  });
});

describe("文档数上限", () => {
  it("已有 499 份：第一份成功，第二份 limit，没有为它发上传", async () => {
    const world = await open();
    for (let index = 0; index < 499; index += 1) {
      world.store.addDocument({
        kbId: world.baseId,
        ragflowDocumentId: `seed-${String(index)}`,
        name: `seed-${String(index)}.md`,
        size: 1,
        source: "upload",
      });
    }
    world.write("a.md", "a");
    world.write("b.md", "b");
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md"]);
    expect(body.rejected).toEqual([rejection("b.md", "limit")]);
    expect(world.countOf(UPLOAD)).toBe(1);
    expect(world.rows()).toHaveLength(500);
  });

  it("已有 500 份时已入库的路径仍是 duplicate：查重在上限之前", async () => {
    const world = await open();
    world.write("a.md", "a");
    await world.ingest(["a.md"]);
    for (let index = 0; index < 499; index += 1) {
      world.store.addDocument({
        kbId: world.baseId,
        ragflowDocumentId: `seed-${String(index)}`,
        name: `seed-${String(index)}.md`,
        size: 1,
        source: "upload",
      });
    }
    const body = (await world.ingest(["a.md"])).json<Ingested>();
    expect(body.rejected).toEqual([rejection("a.md", "duplicate")]);
  });
});

describe("请求判定", () => {
  it("paths 为空、超过上限、类型不对或键集不对：400，零出站", async () => {
    const world = await open({ kb: { uploadMaxFiles: 2 } });
    for (const body of [
      { workspaceId: W1, paths: [] },
      { workspaceId: W1, paths: ["a.md", "b.md", "c.md"] },
      { workspaceId: W1, paths: "a.md" },
      { workspaceId: W1, paths: [1] },
      { workspaceId: W1 },
      { paths: ["a.md"] },
      { workspaceId: 7, paths: ["a.md"] },
      { workspaceId: W1, paths: ["a.md"], extra: true },
      ["a.md"],
    ]) {
      const response = await world.post(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toEqual(BAD_REQUEST);
    }
    expect(world.lines()).toEqual([]);
  });

  it("恰好等于上限的 paths 合法", async () => {
    const world = await open({ kb: { uploadMaxFiles: 2 } });
    world.write("a.md", "a");
    world.write("b.md", "b");
    expect((await world.ingest(["a.md", "b.md"])).statusCode).toBe(201);
  });

  it.each([
    ["malformed JSON", "{not json", "application/json"],
    ["空 JSON body", "", "application/json"],
    ["text/plain body", "{}", "text/plain"],
  ])("归属路由 %s：exact 400，发生在出站与文件读取之前", async (_name, raw, type) => {
    const world = await open();
    const response = await world.post({ raw, type });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(BAD_REQUEST);
    expect(world.lines()).toEqual([]);
  });

  it.each(["rebuilding", "rebuild_failed"] as const)(
    "知识库 state 为 %s：整个请求 409，零出站，没有审计",
    async (state) => {
      const world = await open();
      world.write("a.md", "a");
      world.setState(state);
      const response = await world.ingest(["a.md"]);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(REBUILDING);
      expect(world.lines()).toEqual([]);
      expect(world.audits("kb.ingest_reject")).toEqual([]);
    },
  );

  it("写锁被重建器持有：立即 409，不排队", async () => {
    const world = await open();
    world.write("a.md", "a");
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rebuild = world.locks.rebuild(world.baseId, () => held);
    const response = await world.ingest(["a.md"]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(REBUILDING);
    expect(world.lines()).toEqual([]);
    release();
    await rebuild;
  });
});

describe("所有权", () => {
  it("别人的工作空间：整个请求 404，零出站，没有 kb.ingest_reject；自己的空间同一路径照常", async () => {
    const world = await open();
    world.write("a.md", "a");
    put(world.fw.world.rootOf(W_LISI), "a.md", "别人的文件");
    const response = await world.ingest(["a.md"], { workspaceId: W_LISI });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
    expect(world.lines()).toEqual([]);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
    expect(world.audits("sandbox.reject")).toEqual([]);
    expect((await world.ingest(["a.md"])).statusCode).toBe(201);
  });

  it("不存在的工作空间：同样 404，判定在 state 之前；空间可见时才轮到 409", async () => {
    const world = await open();
    world.setState("rebuilding");
    const response = await world.ingest(["a.md"], { workspaceId: "f".repeat(32) });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
    expect((await world.ingest(["a.md"])).json()).toEqual(REBUILDING);
  });

  it("自己的另一个工作空间可以入库，审计的 workspaceId 随它", async () => {
    const world = await open();
    put(world.fw.world.rootOf(W2), "a.md", "a");
    const response = await world.ingest(["a.md"], { workspaceId: W2 });
    expect(response.json<Ingested>().documents[0]).toMatchObject({ workspaceId: W2, path: "a.md" });
    expect(world.audits("kb.ingest")[0]?.workspaceId).toBe(W2);
  });

  it("文档路由的所有权：别人的库与不存在的 id 都 404，判定先于 body，零出站，无审计", async () => {
    const world = await open();
    world.write("a.md", "a");
    const body = { workspaceId: W1, paths: ["a.md"] };
    const responses = [
      await world.post(body, { who: "admin" }),
      await world.post(body, { baseId: "e".repeat(32) }),
      await world.post({ raw: "{not json", type: "application/json" }, { who: "admin" }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(world.lines()).toEqual([]);
    expect(world.audits("kb.ingest")).toEqual([]);
    expect(world.audits("kb.ingest_reject")).toEqual([]);
  });

  it("未登录 401，先于所有权；同一请求登录后 201", async () => {
    const world = await open();
    world.write("a.md", "a");
    const response = await world.ingest(["a.md"], { who: "anonymous" });
    expect(response.statusCode).toBe(401);
    expect(world.lines()).toEqual([]);
    expect((await world.ingest(["a.md"])).statusCode).toBe(201);
  });
});

describe("上传与视图", () => {
  it("成功条目的视图恰为十一键，不经读取 RAGFlow 得出，与文档行一致", async () => {
    const world = await open();
    world.write("sub/a.md", "abcde");
    const response = await world.ingest(["sub/a.md"]);
    const [document] = response.json<Ingested>().documents;
    const [row] = world.rows();
    expect(Object.keys(document ?? {}).sort()).toEqual(DOCUMENT_KEYS);
    expect(document).toEqual({
      id: row?.id,
      name: "a.md",
      size: 5,
      source: "workspace",
      workspaceId: W1,
      path: "sub/a.md",
      status: "queued",
      chunkCount: null,
      message: null,
      sourceChanged: false,
      createdAt: row?.createdAt,
    });
    expect(world.lines().filter((line) => line.startsWith("GET "))).toEqual([]);
  });

  it("文档行记下 fstat 的大小与修改时间，RAGFlow 文档 id 属于当前数据集", async () => {
    const world = await open();
    world.write("a.md", "abc");
    await world.ingest(["a.md"]);
    const [row] = world.rows();
    const [remote] = world.fake.documents(world.datasetId);
    expect(row).toMatchObject({
      name: "a.md",
      size: 3,
      source: "workspace",
      workspaceId: W1,
      sourcePath: "a.md",
      ragflowDocumentId: remote?.id,
    });
    expect(row?.sourceMtimeMs).toBeGreaterThan(0);
  });

  it("上传字节与源文件一致，Content-Length 来自 fstat，字段名为 file，只解析这一份", async () => {
    const world = await open();
    const content = Buffer.from(
      Array.from({ length: UPLOAD_MAX_BYTES }, (_, index) => index % 251),
    );
    world.write("data.csv", content);
    await world.ingest(["data.csv"]);
    const [upload] = world.uploads();
    expect(upload?.multipart).toEqual([
      { field: "file", filename: "data.csv", bytes: UPLOAD_MAX_BYTES },
    ]);
    expect(upload?.aborted).toBe(false);
    expect(upload?.contentLength).toBeGreaterThan(UPLOAD_MAX_BYTES);
    const [row] = world.rows();
    expect(await world.contentOf(String(row?.ragflowDocumentId))).toEqual(
      bytesOf(world, "data.csv"),
    );
    const parse = world.fake.requests().find(({ path }) => path.endsWith("/parse"));
    expect(parse?.json).toEqual({ document_ids: [row?.ragflowDocumentId] });
  });

  it("恰为大小上限的文件可以入库", async () => {
    const world = await open();
    world.write("a.md", Buffer.alloc(UPLOAD_MAX_BYTES, 1));
    expect((await world.ingest(["a.md"])).json<Ingested>().documents).toHaveLength(1);
  });

  it("文件名按原始字符到达 RAGFlow，本地名不受 RAGFlow 改名影响", async () => {
    const world = await open();
    const name = `报告 "第1版" (终).md`;
    world.write(`甲/${name}`, "a");
    world.write(`乙/${name}`, "b");
    const body = (await world.ingest([`甲/${name}`, `乙/${name}`])).json<Ingested>();
    expect(body.documents.map((document) => document.name)).toEqual([name, name]);
    expect(world.uploads().map((upload) => upload.multipart?.[0]?.filename)).toEqual([name, name]);
    expect(world.fake.documents(world.datasetId).map((document) => document.name)).toEqual([
      name,
      `报告 "第1版" (终)(1).md`,
    ]);
  });

  it("文件名里的换行进不了 multipart 的头", async () => {
    const world = await open();
    const name = 'evil"\r\nContent-Type: x\r\n\r\n.md';
    world.write(name, "a");
    await world.ingest([name]);
    expect(world.uploads()[0]?.multipart).toEqual([{ field: "file", filename: name, bytes: 1 }]);
  });

  it("全程没有编译相关请求：只有上传与解析触发", async () => {
    const world = await open();
    world.write("a.md", "a");
    await world.ingest(["a.md"]);
    const documents = `/api/v1/datasets/${world.datasetId}/documents`;
    expect(world.lines()).toEqual([`POST ${documents}`, `POST ${documents}/parse`]);
  });

  it("只读挂载内的大文件也在打开之后才判大小，句柄都还回去", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({
      online: [{ name: "docs", readOnly: true }],
      overrides: { mountFs: seam.impl },
    });
    const point = world.fw.point("docs");
    put(point, "big.pdf", Buffer.alloc(UPLOAD_MAX_BYTES + 1, 1));
    put(point, "empty.pdf", "");
    put(point, "ok.pdf", "ok");
    const body = (
      await world.ingest(["docs/big.pdf", "docs/empty.pdf", "docs/ok.pdf"])
    ).json<Ingested>();
    expect(body.rejected).toEqual([
      rejection("docs/big.pdf", "too_large"),
      rejection("docs/empty.pdf", "empty"),
    ]);
    expect(pathsOf(body)).toEqual(["docs/ok.pdf"]);
    await expect.poll(() => handles(seam, point)).toEqual({ opened: 3, closed: 3 });
  });
});

describe("审计", () => {
  it("每份文档一条 kb.ingest、每个被拒条目一条 kb.ingest_reject，detail 键集同审计表", async () => {
    const world = await open();
    world.write("a.md", "a");
    await world.ingest(["a.md", "missing.md"]);
    const [row] = world.rows();
    expect(world.audits("kb.ingest")).toEqual([
      {
        actorId: OWNER,
        title: "知识库入库文档",
        detail: {
          id: world.baseId,
          source: "workspace",
          workspaceId: W1,
          path: "a.md",
          documentId: row?.id,
        },
        workspaceId: W1,
      },
    ]);
    expect(world.audits("kb.ingest_reject")).toEqual([
      {
        actorId: OWNER,
        title: "知识库入库被拒",
        detail: {
          id: world.baseId,
          source: "workspace",
          workspaceId: W1,
          path: "missing.md",
          reason: "not_file",
        },
        workspaceId: W1,
      },
    ]);
  });

  it("detail 不含敏感内容：文件内容与 RAGFlow message 的哨兵进不了审计、应答与 stderr 记录", async () => {
    const world = await open();
    world.write("a.md", `正文 ${CONTENT_SENTINEL}`);
    world.write("b.md", `正文 ${CONTENT_SENTINEL}`);
    const response = await scriptSecondUpload(
      world,
      () => {
        world.fake.answer(UPLOAD, { code: 101, message: MESSAGE_SENTINEL });
      },
      () => world.ingest(["a.md", "b.md"]),
    );
    expect(response.body).not.toContain(CONTENT_SENTINEL);
    expect(response.body).not.toContain(MESSAGE_SENTINEL);
    const audits = JSON.stringify([world.audits("kb.ingest"), world.audits("kb.ingest_reject")]);
    expect(world.audits("kb.ingest")).toHaveLength(1);
    expect(world.audits("kb.ingest_reject")).toHaveLength(1);
    expect(audits).not.toContain(CONTENT_SENTINEL);
    expect(audits).not.toContain(MESSAGE_SENTINEL);
    expect(JSON.stringify(world.logged)).not.toContain(MESSAGE_SENTINEL);
  });
});
