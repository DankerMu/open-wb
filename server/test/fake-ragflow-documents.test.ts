/**
 * s2a-kb-ragflow tasks 5.2（#1840）：假 RAGFlow 文档路由的自测：上传、删除、解析、停止与下载。期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` 的字面量（用例名或注释标了小节号），不从夹具导入。
 * 这里用 `fetch` 与裸 socket 直接打夹具，不经客户端：夹具是客户端用例的判据，不能反过来靠它证明。
 */
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import {
  callFake,
  expectUnknownRoute,
  type FakeCallOptions,
  formOf,
} from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1840-fixture-key";
const ABSENT = "0123456789abcdef0123456789abcdef";
const NOT_FOUND_DOCUMENT = '{"code":404,"message":"Resource not found"}';
const NOT_FOUND_DATASET = '{"code":404,"data":null,"message":"Resource not found"}';
const EMPTY_FILE = '{"code":500,"message":"Failed to download document"}';

let fake: FakeRagflowServer;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
});

afterEach(async () => {
  await fake.close();
});

const call = (method: string, path: string, options?: FakeCallOptions) =>
  callFake(fake.baseUrl, KEY, method, path, options);

describe("上传（§7）", () => {
  const upload = (id: string, form: FormData) =>
    call("POST", `/api/v1/datasets/${id}/documents`, { form });

  it("字段 file：回文档行，记录字段名、字节数与 Content-Length", async () => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf("a.txt", "0123456789abcdef"));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 0,
      message: null,
      data: [
        {
          chunk_count: 0,
          dataset_id: id,
          ingestion_status: "UNSTART",
          location: "a.txt",
          name: "a.txt",
          size: 16,
          suffix: "txt",
        },
      ],
    });
    const record = fake.requests()[0];
    expect(record?.multipart).toEqual([{ field: "file", filename: "a.txt", bytes: 16 }]);
    expect(record?.contentLength).toBeGreaterThan(16);
    expect(fake.documents(id)).toMatchObject([
      { name: "a.txt", size: 16, ingestionStatus: "UNSTART" },
    ]);
  });

  it("字段可重复，一次两个文件回两条", async () => {
    const id = fake.addDataset();
    const form = formOf("a.txt", "a");
    form.append("file", new Blob(["bb"]), "b.txt");
    const answer = await upload(id, form);
    expect(answer.body.data).toHaveLength(2);
    expect(fake.requests()[0]?.multipart).toEqual([
      { field: "file", filename: "a.txt", bytes: 1 },
      { field: "file", filename: "b.txt", bytes: 2 },
    ]);
  });

  it("同名改名 a(1).txt、a(2).txt", async () => {
    const id = fake.addDataset();
    const names: unknown[] = [];
    for (let round = 0; round < 3; round += 1) {
      const answer = await upload(id, formOf("a.txt", "x"));
      names.push((answer.body.data as { name: string }[])[0]?.name);
    }
    expect(names).toEqual(["a.txt", "a(1).txt", "a(2).txt"]);
  });

  it.each([["bin.exe"], ["thing.zzz"], ["noext"]])(
    "不支持的 %s：HTTP 200 + code:500，不留文档",
    async (name) => {
      const id = fake.addDataset();
      const answer = await upload(id, formOf(name, "x"));
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        code: 500,
        message: `${name}: This type of file has not been supported yet!`,
      });
      expect(fake.documents(id)).toEqual([]);
    },
  );

  it("大写后缀照常接受（§7.4）", async () => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf("B.PDF", "x"));
    expect(answer.body).toMatchObject({ code: 0, data: [{ suffix: "PDF" }] });
  });

  it("§9 上传过的 .json 被接受", async () => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf("nf.json", "{}"));
    expect(answer.body).toMatchObject({ code: 0, data: [{ name: "nf.json", suffix: "json" }] });
  });

  it.each([
    ["a.txt", "txt", "doc"],
    ["C.TXT", "TXT", "doc"],
    ["a.pdf", "pdf", "pdf"],
    ["B.PDF", "PDF", "pdf"],
    ["h.Pdf", "Pdf", "pdf"],
  ])("%s：suffix 保留大小写，type 小写（§7.4）", async (name, suffix, type) => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf(name, "x"));
    expect(answer.body).toMatchObject({ code: 0, data: [{ suffix, type }] });
  });

  it("文件名 255 字节：成功（§7.1）", async () => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf(`${"n".repeat(251)}.txt`, "x"));
    expect(answer.body).toMatchObject({ code: 0 });
  });

  it.each([
    ["256 个 ASCII 字符", `${"n".repeat(252)}.txt`],
    ["按字节算，不按字符算", `${"中".repeat(84)}.txt`],
  ])("文件名 256 字节回 101（§7.1）：%s", async (_label, name) => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf(name, "x"));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 101,
      message: "File name must be 255 bytes or less.",
    });
    expect(fake.documents(id)).toEqual([]);
  });

  it("?type=nope 回 101（§7.1）", async () => {
    const id = fake.addDataset();
    const answer = await call("POST", `/api/v1/datasets/${id}/documents?type=nope`, {
      form: formOf("a.txt", "x"),
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 101,
      message: '"type" must be one of "local", "web", or "empty".',
    });
    expect(fake.documents(id)).toEqual([]);
  });

  it.each([["local"], ["web"], ["empty"]])("?type=%s 的行为没有测过：未知路由", async (type) => {
    const id = fake.addDataset();
    const path = `/api/v1/datasets/${id}/documents`;
    const answer = await call("POST", `${path}?type=${type}`, { form: formOf("a.txt", "x") });
    expectUnknownRoute(fake, answer, path);
    expect(fake.documents(id)).toEqual([]);
  });

  it("一次多个文件里有不支持的：没有记录，未知路由，不留文档", async () => {
    const id = fake.addDataset();
    const form = formOf("a.txt", "a");
    form.append("file", new Blob(["b"]), "bin.exe");
    const answer = await upload(id, form);
    expectUnknownRoute(fake, answer, `/api/v1/datasets/${id}/documents`);
    expect(fake.documents(id)).toEqual([]);
  });

  it.each([
    ["缺结束边界", 'name="file"; filename="a.txt"\r\n\r\nx\r\n--b\r\n'],
    ["正文里没有下一个边界", 'name="file"; filename="a.txt"\r\n\r\nx'],
  ])("multipart %s：没有记录，未知路由，不留文档", async (_label, tail) => {
    const id = fake.addDataset();
    const path = `/api/v1/datasets/${id}/documents`;
    const response = await fetch(`${fake.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "multipart/form-data; boundary=b",
      },
      body: `--b\r\nContent-Disposition: form-data; ${tail}`,
    });
    expectUnknownRoute(fake, response, path);
    expect(fake.documents(id)).toEqual([]);
  });

  it("裸的 octet-stream 请求体：同样 101 No file part!", async () => {
    const id = fake.addDataset();
    const response = await fetch(`${fake.baseUrl}/api/v1/datasets/${id}/documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/octet-stream" },
      body: "x",
    });
    expect(await response.json()).toMatchObject({ code: 101, message: "No file part!" });
  });

  it("字段名不是 file：101 No file part!", async () => {
    const id = fake.addDataset();
    const answer = await upload(id, formOf("a.txt", "x", "upload"));
    expect(answer.body).toMatchObject({ code: 101, message: "No file part!" });
    expect(fake.documents(id)).toEqual([]);
  });

  it("中断的上传不留文档（§7.2），记录标明中断", async () => {
    const id = fake.addDataset();
    const socket = connect(fake.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /api/v1/datasets/${id}/documents HTTP/1.1\r\nHost: h\r\n` +
        `Authorization: Bearer ${KEY}\r\nContent-Type: multipart/form-data; boundary=b\r\n` +
        `Content-Length: 1000\r\n\r\n--b\r\nContent-Disposition: form-data; name="file"; ` +
        `filename="a.txt"\r\n\r\npartial`,
    );
    await expect.poll(() => fake.requests().length).toBe(1);
    socket.destroy();
    await expect.poll(() => fake.requests()[0]?.aborted).toBe(true);
    expect(fake.documents(id)).toEqual([]);
    expect(fake.requests()[0]?.contentLength).toBe(1000);
  });
});

describe("删文档（§8.5）", () => {
  const remove = (dataset: string, ids: unknown) =>
    call("DELETE", `/api/v1/datasets/${dataset}/documents`, { json: { ids } });

  it.each([["UNSTART"], ["SCHEDULED"], ["CREATED"], ["COMPLETED"], ["FAILED"], ["STOPPED"]])(
    "%s：deleted:1",
    async (ingestionStatus) => {
      const id = fake.addDataset();
      const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
      const answer = await remove(id, [doc]);
      expect(answer.text).toBe('{"code":0,"data":{"deleted":1},"message":"success"}');
      expect(fake.documents(id)).toEqual([]);
    },
  );

  it.each([["RUNNING"], ["STOPPING"]])(
    "%s：code:0 且 deleted:0，行仍在",
    async (ingestionStatus) => {
      const id = fake.addDataset();
      const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
      const answer = await remove(id, [doc]);
      expect(answer.text).toBe('{"code":0,"data":{"deleted":0},"message":"success"}');
      expect(fake.documents(id)).toHaveLength(1);
    },
  );

  it("运行结束后再删回 deleted:1", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus: "RUNNING" });
    fake.setDocumentStatus(id, doc, "COMPLETED");
    expect((await remove(id, [doc])).body).toMatchObject({ data: { deleted: 1 } });
  });

  it("空 ids 回 102", async () => {
    const id = fake.addDataset();
    expect((await remove(id, [])).body).toMatchObject({
      code: 102,
      message: "should either provide doc ids or set delete_all(true)",
    });
  });

  it("ids 类型错回 102", async () => {
    const id = fake.addDataset();
    expect((await remove(id, "x")).body).toMatchObject({ code: 102 });
  });

  it("ids 含重复回 101，什么也不删", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x" });
    const answer = await remove(id, [doc, doc]);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 101 });
    expect(fake.documents(id)).toHaveLength(1);
  });

  it("含一真一假回 102，全部不删（§10）", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x" });
    expect((await remove(id, [doc, ABSENT])).body).toMatchObject({ code: 102 });
    expect(fake.documents(id)).toHaveLength(1);
  });

  it("批量删除只有上面的混合批次有记录：别的批次未知路由，什么也不删", async () => {
    const id = fake.addDataset();
    const running = { name: "a.txt", content: "x", ingestionStatus: "RUNNING" };
    const docs = [running, { name: "b.txt", content: "y" }].map((seed) =>
      fake.addDocument(id, seed),
    );
    expectUnknownRoute(fake, await remove(id, docs), `/api/v1/datasets/${id}/documents`);
    expect(fake.documents(id)).toHaveLength(2);
  });
});

describe("解析触发（§8.1）", () => {
  const parse = (dataset: string, ids: unknown) =>
    call("POST", `/api/v1/datasets/${dataset}/documents/parse`, { json: { document_ids: ids } });

  it.each([
    ["UNSTART", 1],
    ["FAILED", 1],
    ["STOPPED", 1],
    ["RUNNING", 0],
    ["COMPLETED", 0],
  ])("%s：success_count %i，状态不自动迁移", async (ingestionStatus, count) => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
    const answer = await parse(id, [doc]);
    expect(answer.text).toBe(`{"code":0,"data":{"success_count":${count}},"message":"success"}`);
    expect(fake.documents(id)[0]?.ingestionStatus).toBe(ingestionStatus);
  });

  it("不存在的文档：success_count:0；混合批次只算真的那份", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x" });
    expect((await parse(id, [ABSENT])).body).toMatchObject({ code: 0, data: { success_count: 0 } });
    expect((await parse(id, [doc, ABSENT])).body).toMatchObject({ data: { success_count: 1 } });
  });

  it.each([["CREATED"], ["SCHEDULED"], ["STOPPING"]])(
    "%s 不在 §8.1 的表里：未知路由",
    async (ingestionStatus) => {
      const id = fake.addDataset();
      const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
      const answer = await parse(id, [doc]);
      expectUnknownRoute(fake, answer, `/api/v1/datasets/${id}/documents/parse`);
    },
  );

  it("document_ids 为空：102", async () => {
    const id = fake.addDataset();
    expect((await parse(id, [])).body).toMatchObject({
      code: 102,
      message: "`document_ids` is required",
    });
  });
});

describe("停止解析（§8.2）", () => {
  const stop = (dataset: string, ids: unknown) =>
    call("POST", `/api/v1/datasets/${dataset}/documents/stop`, { json: { document_ids: ids } });

  it.each([["RUNNING"], ["SCHEDULED"], ["STOPPED"], ["STOPPING"]])(
    "%s：success_count:1",
    async (ingestionStatus) => {
      const id = fake.addDataset();
      const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
      const answer = await stop(id, [doc]);
      expect(answer.text).toBe('{"code":0,"data":{"success_count":1},"message":"success"}');
    },
  );

  it.each([["UNSTART"], ["COMPLETED"]])(
    "%s：success_count:0 带 errors",
    async (ingestionStatus) => {
      const id = fake.addDataset();
      const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
      expect((await stop(id, [doc])).body).toMatchObject({
        code: 0,
        data: {
          errors: ["Can't stop parsing document that has not started or already completed"],
          success_count: 0,
        },
      });
    },
  );

  it.each([["CREATED"], ["FAILED"]])("%s 不在 §8.2 的表里：未知路由", async (ingestionStatus) => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
    const answer = await stop(id, [doc]);
    expectUnknownRoute(fake, answer, `/api/v1/datasets/${id}/documents/stop`);
  });

  it("批量与空 document_ids 没有记录：未知路由", async () => {
    const id = fake.addDataset();
    const path = `/api/v1/datasets/${id}/documents/stop`;
    const seed = { content: "x", ingestionStatus: "RUNNING" };
    const docs = ["a.txt", "b.txt"].map((name) => fake.addDocument(id, { ...seed, name }));
    expectUnknownRoute(fake, await stop(id, docs), path);
    expect((await stop(id, [])).status).toBe(404);
  });
});

describe("下载（§9、§9.1）", () => {
  const download = (dataset: string, doc: string) =>
    call("GET", `/api/v1/datasets/${dataset}/documents/${doc}`);

  it("成功：带 Content-Disposition 与 Content-Length，octet-stream", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "0123456789abcdef" });
    const answer = await download(id, doc);
    expect(answer.status).toBe(200);
    expect(answer.text).toBe("0123456789abcdef");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="a.txt"');
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-length")).toBe("16");
    expect(answer.headers.get("transfer-encoding")).toBeNull();
  });

  it("内容恰为 not-found 正文的文件：43 字节，仍带头", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "nf.json", content: NOT_FOUND_DOCUMENT });
    const answer = await download(id, doc);
    expect(answer.text).toBe(NOT_FOUND_DOCUMENT);
    expect(answer.headers.get("content-length")).toBe("43");
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="nf.json"');
  });

  it("真实上传 nf.json 再下载：字节不变，带头（§9.1）", async () => {
    const id = fake.addDataset();
    const uploaded = await call("POST", `/api/v1/datasets/${id}/documents`, {
      form: formOf("nf.json", NOT_FOUND_DOCUMENT),
    });
    const [row] = uploaded.body.data as { id: string }[];
    const answer = await download(id, row?.id ?? "");
    expect(answer.text).toBe(NOT_FOUND_DOCUMENT);
    expect(answer.headers.get("content-disposition")).toBe('attachment; filename="nf.json"');
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-length")).toBe("43");
  });

  it("文档不存在：HTTP 200，无 Content-Disposition，JSON 类型", async () => {
    const id = fake.addDataset();
    const answer = await download(id, ABSENT);
    expect(answer.status).toBe(200);
    expect(answer.text).toBe(NOT_FOUND_DOCUMENT);
    expect(answer.headers.get("content-disposition")).toBeNull();
    expect(answer.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(answer.headers.get("content-length")).toBe("43");
  });

  it("数据集不存在：正文多一个 data 键，55 字节", async () => {
    const answer = await download(ABSENT, ABSENT);
    expect(answer.status).toBe(200);
    expect(answer.text).toBe(NOT_FOUND_DATASET);
    expect(answer.headers.get("content-disposition")).toBeNull();
    expect(answer.headers.get("content-length")).toBe("55");
  });

  it("0 字节文件：code:500，52 字节，无 Content-Disposition", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "empty.txt", content: "" });
    const answer = await download(id, doc);
    expect(answer.status).toBe(200);
    expect(answer.text).toBe(EMPTY_FILE);
    expect(answer.headers.get("content-disposition")).toBeNull();
    expect(answer.headers.get("content-length")).toBe("52");
  });
});
