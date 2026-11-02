/**
 * s2a-kb-ragflow tasks 10.2（#1847）：入库的失败面（knowledge-bases「工作空间来源入库」的 RAGFlow 失败与读取期间变化、
 * 「同一知识库的写操作串行」的入库场景、「知识库审计」的「写入失败不留审计」）。请求判定与成功路径在
 * `kb-ingest-workspace.test.ts`。期望值是 spec 与实测记录的字面量。
 */
import { appendFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DELETE_DOCUMENT,
  NOT_FOUND,
  PARSE,
  REBUILDING,
  STOP,
  scriptSecondUpload,
  UPLOAD,
  UPLOAD_MAX_BYTES,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { createSeam, handles, put, SENTINEL } from "./mounts-file-endpoints-helpers.js";
import { waitFor } from "./mounts-manager-helpers.js";
import { CASE_MS, send } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();

const GENERIC_500 = { error: { message: "服务器内部错误" } };

interface Ingested {
  documents: Array<{ path: string }>;
  rejected: Array<{ path: string; reason: string; message: string }>;
}

const pathsOf = (body: Ingested) => body.documents.map(({ path }) => path);
const reasonsOf = (body: Ingested) => body.rejected.map(({ path, reason }) => [path, reason]);

describe("RAGFlow 失败", () => {
  it("中途不可达：第二份 503，第二、三份 unavailable，恰两次上传", async () => {
    const world = await open();
    for (const name of ["a.md", "b.md", "c.md"]) world.write(name, name);
    const response = await scriptSecondUpload(
      world,
      () => {
        world.fake.fault(UPLOAD, { kind: "status", status: 503 });
      },
      () => world.ingest(["a.md", "b.md", "c.md"]),
    );
    expect(response.statusCode).toBe(201);
    const body = response.json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md"]);
    expect(reasonsOf(body)).toEqual([
      ["b.md", "unavailable"],
      ["c.md", "unavailable"],
    ]);
    expect(body.rejected[0]?.message).toBe("知识库服务暂不可用");
    expect(world.countOf(UPLOAD)).toBe(2);
    expect(world.audits("kb.ingest_reject")).toHaveLength(2);
  });

  it("不可达之后不再处理：其后的越界路径同样 unavailable，不写 sandbox.reject", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.fake.fault(UPLOAD, { kind: "status", status: 503 });
    const body = (await world.ingest(["a.md", "../x", "missing.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([
      ["a.md", "unavailable"],
      ["../x", "unavailable"],
      ["missing.md", "unavailable"],
    ]);
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it("上传得知数据集不存在（code:102）：该条与其后都 unavailable", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.write("b.md", "b");
    world.fake.answer(UPLOAD, {
      code: 102,
      message: `Can't find the dataset with ID ${world.datasetId}!`,
    });
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([
      ["a.md", "unavailable"],
      ["b.md", "unavailable"],
    ]);
    expect(world.countOf(UPLOAD)).toBe(1);
  });

  it("逐条被拒：第一份 code:101，第二份照常入库", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.write("b.md", "b");
    world.fake.answer(UPLOAD, { code: 101, message: "File name must be 255 bytes or less." });
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(pathsOf(body)).toEqual(["b.md"]);
    expect(reasonsOf(body)).toEqual([["a.md", "rejected"]]);
    expect(body.rejected[0]?.message).toBe("知识库服务拒绝了这个文件");
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
  });

  it("解析触发 HTTP 503：unavailable，删掉刚上传的文档，没有行，第二份不发请求", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.write("b.md", "b");
    world.fake.fault(PARSE, { kind: "status", status: 503 });
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([
      ["a.md", "unavailable"],
      ["b.md", "unavailable"],
    ]);
    expect(world.countOf(UPLOAD)).toBe(1);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(1);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
    expect(world.rows()).toEqual([]);
    expect(world.audits("kb.ingest")).toEqual([]);
  });

  it.each([
    ["code:101", { code: 101, message: "bad request" }],
    ["code:0 且 success_count:0", { code: 0, data: { success_count: 0 } }],
  ])("解析触发 %s：rejected 且文档被删，第二份照常入库", async (_name, answer) => {
    const world = await open();
    world.write("a.md", "a");
    world.write("b.md", "b");
    world.fake.answer(PARSE, answer);
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(pathsOf(body)).toEqual(["b.md"]);
    expect(reasonsOf(body)).toEqual([["a.md", "rejected"]]);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(1);
    expect(world.fake.documents(world.datasetId).map(({ name }) => name)).toEqual(["b.md"]);
  });

  it("解析触发 code:404（数据集没了）：unavailable，补偿删除的不存在视为已删，不写 leak", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.fake.answer(PARSE, { code: 404, message: "Resource not found" });
    world.fake.answer(DELETE_DOCUMENT, { code: 404, message: "Resource not found" });
    const body = (await world.ingest(["a.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([["a.md", "unavailable"]]);
    expect(world.logged).toEqual([]);
  });

  it("补偿删除失败：恰一行 kb_document_leak，该条结果不变", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.write("b.md", "b");
    world.fake.answer(PARSE, { code: 0, data: { success_count: 0 } });
    world.fake.fault(DELETE_DOCUMENT, { kind: "status", status: 503 });
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([["a.md", "rejected"]]);
    expect(pathsOf(body)).toEqual(["b.md"]);
    const [leaked] = world.fake.documents(world.datasetId);
    expect(world.logged).toEqual([{ event: "kb_document_leak", documentId: leaked?.id }]);
  });

  it("补偿删除到期仍 deleted:0：同样 leak，恰一次停止", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.fake.answer(PARSE, { code: 101, message: "bad request" });
    world.fake.answer(
      DELETE_DOCUMENT,
      { code: 0, data: { deleted: 0 } },
      { times: Number.MAX_SAFE_INTEGER },
    );
    world.fake.answer(STOP, { code: 0, data: { success_count: 1 } });
    const body = (await world.ingest(["a.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([["a.md", "rejected"]]);
    expect(world.countOf(STOP)).toBe(1);
    expect(world.logged).toHaveLength(1);
    expect(world.logged[0]).toMatchObject({ event: "kb_document_leak" });
  });
});

describe("写入失败不留审计", () => {
  it.each([
    [
      "插行失败",
      "CREATE TRIGGER refuse BEFORE INSERT ON kb_documents BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
    [
      "审计失败",
      "CREATE TRIGGER refuse BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.ingest' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ],
  ])("%s：500，没有 kb.ingest，没有行，假 RAGFlow 收到删除", async (_name, trigger) => {
    const world = await open();
    world.write("a.md", "a");
    world.fw.world.db.exec(trigger);
    const response = await world.ingest(["a.md"]);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(GENERIC_500);
    expect(world.audits("kb.ingest")).toEqual([]);
    expect(world.rows()).toEqual([]);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(1);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
  });
});

describe("读取期间文件变化", () => {
  it("fstat 之后被追加：changed，出站被中止，没有行，不发删除，下一份照常", async () => {
    const world = await open({
      kb: {
        onSourceStat(absPath) {
          if (absPath.endsWith("a.md")) appendFileSync(absPath, " appended");
        },
      },
    });
    world.write("a.md", "abc");
    world.write("b.md", "b");
    const response = await world.ingest(["a.md", "b.md"]);
    expect(response.statusCode).toBe(201);
    const body = response.json<Ingested>();
    expect(reasonsOf(body)).toEqual([["a.md", "changed"]]);
    expect(body.rejected[0]?.message).toBe("读取期间文件发生了变化");
    expect(pathsOf(body)).toEqual(["b.md"]);
    expect(world.fake.documents(world.datasetId).map(({ name }) => name)).toEqual(["b.md"]);
    expect(world.rows().map(({ sourcePath }) => sourcePath)).toEqual(["b.md"]);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
    expect(world.audits("kb.ingest_reject")[0]?.detail.reason).toBe("changed");
  });

  it("fstat 之后被截短：同样 changed，不是 unavailable，后面的条目不受牵连", async () => {
    const world = await open({
      kb: {
        onSourceStat(absPath) {
          if (absPath.endsWith("a.md")) truncateSync(absPath, 1);
        },
      },
    });
    world.write("a.md", "abc");
    world.write("b.md", "b");
    const body = (await world.ingest(["a.md", "b.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([["a.md", "changed"]]);
    expect(pathsOf(body)).toEqual(["b.md"]);
    expect(world.fake.documents(world.datasetId).map(({ name }) => name)).toEqual(["b.md"]);
    expect(world.countOf(DELETE_DOCUMENT)).toBe(0);
  });

  it("出站已经开始时被中止：假 RAGFlow 记下中断的上传，不留文档", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const world = await open({
      online: [{ name: "docs" }],
      overrides: { mountFs: seam.impl },
      kb: {
        onSourceStat(absPath) {
          appendFileSync(absPath, " appended");
        },
      },
    });
    const file = join(world.fw.point("docs"), "a.pdf");
    put(world.fw.point("docs"), "a.pdf", "abc");
    const release = seam.hold(file, ["read"]);
    const pending = world.ingest(["docs/a.pdf"]);
    await expect.poll(() => world.uploads()).toHaveLength(1);
    release();
    expect(reasonsOf((await pending).json<Ingested>())).toEqual([["docs/a.pdf", "changed"]]);
    await expect.poll(() => world.uploads()[0]?.aborted).toBe(true);
    expect(world.uploads()[0]?.multipart).toBeNull();
    expect(world.fake.documents(world.datasetId)).toEqual([]);
  });

  it("挂载内同样按读到的字节判定：文件增长与 fstat 过期的短读都是 changed", {
    timeout: CASE_MS,
  }, async () => {
    const seam = createSeam();
    const world = await open({
      online: [{ name: "docs" }],
      overrides: { mountFs: seam.impl },
      kb: {
        onSourceStat(absPath) {
          if (absPath.endsWith("grown.pdf")) appendFileSync(absPath, " appended");
        },
      },
    });
    const point = world.fw.point("docs");
    put(point, "grown.pdf", "abc");
    put(point, "short.pdf", "abc");
    seam.staleSize(join(point, "short.pdf"), 10);
    const body = (await world.ingest(["docs/grown.pdf", "docs/short.pdf"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([
      ["docs/grown.pdf", "changed"],
      ["docs/short.pdf", "changed"],
    ]);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
    await expect.poll(() => handles(seam, point)).toEqual({ opened: 2, closed: 2 });
  });
});

describe("挂载离线", () => {
  it("离线挂载内的路径：offline，没有上传，不碰挂载点", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({ offline: ["docs"], overrides: { mountFs: seam.impl } });
    world.write("a.md", "a");
    const path = `docs/${SENTINEL}`;
    const body = (await world.ingest([path, "a.md"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([[path, "offline"]]);
    expect(body.rejected[0]?.message).toBe("挂载已离线");
    expect(pathsOf(body)).toEqual(["a.md"]);
    expect(world.countOf(UPLOAD)).toBe(1);
    expect(seam.under(world.fw.point("docs"))).toEqual([]);
  });

  it("离线挂载内不支持的后缀：后缀判定在打开之前", { timeout: CASE_MS }, async () => {
    const world = await open({ offline: ["docs"] });
    const body = (await world.ingest(["docs/a.exe"])).json<Ingested>();
    expect(reasonsOf(body)).toEqual([["docs/a.exe", "unsupported_type"]]);
  });

  it("读到一半挂载到期：offline，出站被中止，不是 unavailable", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({
      online: [{ name: "docs" }],
      overrides: { mountFs: seam.impl },
    });
    const file = join(world.fw.point("docs"), "a.pdf");
    put(world.fw.point("docs"), "a.pdf", "abc");
    seam.hang(file, ["read"]);
    const pending = world.ingest(["docs/a.pdf"]);
    await waitFor(() => seam.under(file).some(({ op }) => op === "read"));
    await expect.poll(() => world.uploads()).toHaveLength(1);
    world.fw.world.clock.advance(10_000);
    const body = (await pending).json<Ingested>();
    expect(reasonsOf(body)).toEqual([["docs/a.pdf", "offline"]]);
    await expect.poll(() => world.uploads()[0]?.aborted).toBe(true);
    expect(world.fake.documents(world.datasetId)).toEqual([]);
  });
});

describe("同一知识库的写操作串行", () => {
  it("同一路径并发入库：一个入库，另一个 duplicate，恰一次上传", async () => {
    const world = await open();
    world.write("a.md", "a");
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const first = world.ingest(["a.md"]);
    await gate.reached;
    const second = world.ingest(["a.md"]);
    await expect.poll(() => world.locks.writeWaiters(world.baseId)).toBe(1);
    gate.release();
    const bodies = (await Promise.all([first, second])).map((response) =>
      response.json<Ingested>(),
    );
    expect(pathsOf(bodies[0] as Ingested)).toEqual(["a.md"]);
    expect(reasonsOf(bodies[1] as Ingested)).toEqual([["a.md", "duplicate"]]);
    expect(world.countOf(UPLOAD)).toBe(1);
  });

  it("入库中删库：删除等入库结束，204，库与文档行都不在，删数据集在上传之后", async () => {
    const world = await open();
    world.write("a.md", "a");
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const ingest = world.ingest(["a.md"]);
    await gate.reached;
    const removal = send(world.fw.rest, "member", "DELETE", `/api/kb/bases/${world.baseId}`);
    await expect.poll(() => world.locks.writeWaiters(world.baseId)).toBe(1);
    expect(world.lines().filter((line) => line.startsWith("DELETE"))).toEqual([]);
    gate.release();
    expect((await ingest).statusCode).toBe(201);
    expect((await removal).statusCode).toBe(204);
    expect(world.store.getBase(world.baseId)).toBeUndefined();
    expect(world.rows()).toEqual([]);
    const lines = world.lines();
    expect(lines.indexOf("DELETE /api/v1/datasets")).toBeGreaterThan(
      lines.findIndex((line) => line.endsWith("/parse")),
    );
  });

  it("排队期间库转入重建：取锁后重判，409，不发上传", async () => {
    const world = await open();
    world.write("a.md", "a");
    world.write("b.md", "b");
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const first = world.ingest(["a.md"]);
    await gate.reached;
    const second = world.ingest(["b.md"]);
    await expect.poll(() => world.locks.writeWaiters(world.baseId)).toBe(1);
    world.setState("rebuilding");
    gate.release();
    expect((await first).statusCode).toBe(201);
    const refused = await second;
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual(REBUILDING);
    expect(world.countOf(UPLOAD)).toBe(1);
  });

  it("排队期间库被删：取锁后重判，404，不发上传", async () => {
    const world = await open();
    world.write("a.md", "a");
    const gate = world.fake.fault("DELETE /api/v1/datasets", { kind: "hold" });
    const removal = send(world.fw.rest, "member", "DELETE", `/api/kb/bases/${world.baseId}`);
    await gate.reached;
    const ingest = world.ingest(["a.md"]);
    await expect.poll(() => world.locks.writeWaiters(world.baseId)).toBe(1);
    gate.release();
    expect((await removal).statusCode).toBe(204);
    const response = await ingest;
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(NOT_FOUND);
    expect(world.countOf(UPLOAD)).toBe(0);
  });

  it("批内计数：上限在锁内逐条算，一批跨过上限时只进到第 500 份", async () => {
    const world = await open({ kb: { uploadMaxBytes: UPLOAD_MAX_BYTES } });
    for (let index = 0; index < 498; index += 1) {
      world.store.addDocument({
        kbId: world.baseId,
        ragflowDocumentId: `seed-${String(index)}`,
        name: `seed-${String(index)}.md`,
        size: 1,
        source: "upload",
      });
    }
    for (const name of ["a.md", "b.md", "c.md"]) world.write(name, name);
    const body = (await world.ingest(["a.md", "b.md", "c.md"])).json<Ingested>();
    expect(pathsOf(body)).toEqual(["a.md", "b.md"]);
    expect(reasonsOf(body)).toEqual([["c.md", "limit"]]);
    expect(world.rows()).toHaveLength(500);
  });
});
