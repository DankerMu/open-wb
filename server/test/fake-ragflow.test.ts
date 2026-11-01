/**
 * s2a-kb-ragflow tasks 5.2（#1840）：假 RAGFlow 夹具自测。协议应答的期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` 的字面量（用例名或注释标了小节号），不从夹具导入。
 * 这里用 `fetch` 与裸 socket 直接打夹具，不经客户端：夹具是客户端用例的判据，不能反过来靠它证明。
 */
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1840-fixture-key";
const ABSENT = "0123456789abcdef0123456789abcdef";
const ABSENT_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const NOT_HEX = "not-hex";
const ALL_ZERO = "0".repeat(32);
const THREE_PART = "bge-m3@owb-embed@OpenAI-API-Compatible";
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

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  options: { json?: unknown; form?: FormData; key?: string | null } = {},
): Promise<Answer> {
  const { json, form, key = KEY } = options;
  const response = await fetch(`${fake.baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(form === undefined ? {} : { body: form }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 非 JSON 应答：`text` 才是判据。
  }
  return { status: response.status, headers: response.headers, text, body };
}

function formOf(name: string, content: string, field = "file"): FormData {
  const form = new FormData();
  form.append(field, new Blob([content]), name);
  return form;
}

describe("版本接口（§3）", () => {
  it("不要密钥，版本串在 data", async () => {
    const answer = await call("GET", "/api/v1/system/version", { key: null });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('{"code":0,"data":"v1.0.0-rc2","message":"success"}');
    expect(fake.requests()[0]).toMatchObject({ bearer: "missing", unknown: false });
  });
});

describe("鉴权（§12）", () => {
  it("无 Authorization：HTTP 401 + code:401", async () => {
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [] }, key: null });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 401, message: "Missing Authorization header" });
    expect(fake.requests()[0]?.bearer).toBe("missing");
  });

  it("错误密钥：HTTP 401 + code:401", async () => {
    const answer = await call("DELETE", "/api/v1/datasets", { json: {}, key: "wrong" });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 401, message: "Invalid access token" });
    expect(fake.requests()[0]?.bearer).toBe("other");
  });

  it("记录只说 Bearer 对不对，不留密钥本身", async () => {
    await call("DELETE", "/api/v1/datasets", { json: {} });
    expect(fake.requests()[0]?.bearer).toBe("ok");
    expect(JSON.stringify(fake.requests())).not.toContain(KEY);
  });
});

describe("建数据集（§4）", () => {
  const create = (json: unknown) => call("POST", "/api/v1/datasets", { json });

  it("内置模板：code:0，message 为 null，data 含 id 与三段式嵌入模型", async () => {
    const answer = await create({
      name: "owb-general",
      parser_id: "general",
      parse_type: 1,
      embedding_model: THREE_PART,
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 0,
      message: null,
      data: {
        chunk_count: 0,
        embedding_model: THREE_PART,
        name: "owb-general",
        parser_id: "general",
      },
    });
    const { id } = answer.body.data as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(fake.datasets()).toEqual([
      { id, name: "owb-general", parserId: "general", embeddingModel: THREE_PART },
    ]);
  });

  it("naive 规范化为 general（§4.3）", async () => {
    const answer = await create({ name: "n", parser_id: "naive", parse_type: 1 });
    expect(answer.body).toMatchObject({ code: 0, data: { parser_id: "general" } });
  });

  it("不传 embedding_model 也成功（§4.4）", async () => {
    const answer = await create({ name: "n", parser_id: "book", parse_type: 1 });
    expect(answer.body).toMatchObject({ code: 0, data: { embedding_model: "" } });
  });

  it.each([
    [
      "chunk_method",
      { name: "n", chunk_method: "naive" },
      101,
      "Extra inputs are not permitted: chunk_method",
    ],
    ["无 parse_type", { name: "n", parser_id: "naive" }, 102, "parse_type is required"],
    ["只有 name", { name: "n" }, 102, "parse_type is required"],
    ["无 parser_id", { parse_type: 1 }, 102, "parser_id is required when parse_type is BuiltIn"],
    [
      "无 pipeline_id",
      { parse_type: 2 },
      102,
      "pipeline_id is required when parse_type is Pipeline",
    ],
    ["parse_type 0", { parse_type: 0 }, 102, "invalid parse_type: 0 (must be 1 or 2)"],
    ["parse_type 3", { parse_type: 3 }, 102, "invalid parse_type: 3 (must be 1 or 2)"],
    [
      "内置带 pipeline_id",
      { parse_type: 1, parser_id: "general", pipeline_id: "x" },
      102,
      "pipeline_id must not be set when parse_type is BuiltIn",
    ],
    ["不存在的画布", { parse_type: 2, pipeline_id: ABSENT }, 102, "canvas is not accessible"],
    [
      "tag",
      { name: "n", parser_id: "tag", parse_type: 1 },
      102,
      "input should be 'general', 'qa', 'manual', 'table', 'paper', 'book', 'laws', 'presentation', 'picture', 'one', 'audio' or 'email'",
    ],
    [
      "只有模型名的 embedding_model",
      { name: "n", parser_id: "general", parse_type: 1, embedding_model: "bge-m3" },
      102,
      "embedding model identifier must follow <model_name>@<provider> format",
    ],
    [
      "空串 embedding_model",
      { name: "n", parser_id: "general", parse_type: 1, embedding_model: "" },
      102,
      "embedding model identifier must follow <model_name>@<provider> format",
    ],
    [
      "两段式 embedding_model",
      {
        name: "n",
        parser_id: "general",
        parse_type: 1,
        embedding_model: "bge-m3@OpenAI-API-Compatible",
      },
      102,
      'model configuration unavailable: instance "default" lookup failed: record not found',
    ],
  ])("%s", async (_label, json, code, message) => {
    const answer = await create(json);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code, message });
    expect(fake.datasets()).toEqual([]);
  });

  it("畸形 JSON 与非 JSON 类型都回 101（§4.5）", async () => {
    const malformed = await fetch(`${fake.baseUrl}/api/v1/datasets`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: "{",
    });
    expect(await malformed.json()).toMatchObject({ code: 101 });
    const wrongType = await fetch(`${fake.baseUrl}/api/v1/datasets`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect(await wrongType.json()).toMatchObject({ code: 101 });
  });
});

describe("删数据集（§4.6、§10）", () => {
  it("成功：success_count", async () => {
    const id = fake.addDataset();
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [id] } });
    expect(answer.text).toBe('{"code":0,"data":{"errors":[],"success_count":1},"message":null}');
    expect(fake.datasets()).toEqual([]);
  });

  it.each([[{ ids: [] }], [{}], [{ ids: null }]])("%j 什么也不删", async (json) => {
    fake.addDataset();
    const answer = await call("DELETE", "/api/v1/datasets", { json });
    expect(answer.text).toBe('{"code":0,"data":{"deleted":[]},"message":null}');
    expect(fake.datasets()).toHaveLength(1);
  });

  it.each([[ABSENT], [ABSENT_UUID]])("不存在的 id %s：code:403", async (id) => {
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [id] } });
    expect(answer.body).toMatchObject({ code: 403, message: "Permission denied" });
  });

  it("已删除的 id 与从未存在的应答相同", async () => {
    const id = fake.addDataset();
    await call("DELETE", "/api/v1/datasets", { json: { ids: [id] } });
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [id] } });
    expect(answer.body).toMatchObject({ code: 403 });
  });

  it("混合批次回 403，全部不删（§10）", async () => {
    const id = fake.addDataset();
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [id, ABSENT] } });
    expect(answer.body).toMatchObject({ code: 403 });
    expect(fake.datasets()).toHaveLength(1);
  });

  it.each([[NOT_HEX], [ALL_ZERO], ["a".repeat(40)]])("非法 id %s：code:101", async (id) => {
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [id] } });
    expect(answer.body).toMatchObject({ code: 101, message: "Invalid UUID format" });
  });

  it("多余字段回 101", async () => {
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [], foo: 1 } });
    expect(answer.body).toMatchObject({
      code: 101,
      message: "Extra inputs are not permitted: foo",
    });
  });
});

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

describe("表 B：不存在的组合", () => {
  it.each([
    ["GET", `/api/v1/datasets/${ABSENT}`, undefined, 404],
    ["PUT", `/api/v1/datasets/${ABSENT}`, { name: "n" }, 404],
    ["PUT", `/api/v1/datasets/${NOT_HEX}`, { name: "n" }, 101],
    ["GET", `/api/v1/datasets/${ABSENT}/documents`, undefined, 404],
    ["POST", `/api/v1/datasets/${ABSENT}/documents/parse`, { document_ids: [ABSENT] }, 404],
    ["POST", `/api/v1/datasets/${ABSENT}/documents/stop`, { document_ids: [ABSENT] }, 404],
    ["DELETE", `/api/v1/datasets/${ABSENT}/documents`, { ids: [ABSENT] }, 404],
    ["GET", `/api/v1/datasets/${ABSENT}/compilation/status`, undefined, 404],
  ])("%s %s：HTTP 200 + code", async (method, path, json, code) => {
    const answer = await call(method, path, json === undefined ? {} : { json });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code });
    expect(fake.unknownRoutes()).toEqual([]);
  });

  it("上传到不存在的数据集：102 加固定前缀", async () => {
    const answer = await call("POST", `/api/v1/datasets/${ABSENT}/documents`, {
      form: formOf("a.txt", "x"),
    });
    expect(answer.body).toMatchObject({
      code: 102,
      message: `Can't find the dataset with ID ${ABSENT}!`,
    });
  });

  it("文档 id：删除 102、停止 100、解析 0、下载 404、过滤 102", async () => {
    const id = fake.addDataset();
    const base = `/api/v1/datasets/${id}/documents`;
    expect((await call("DELETE", base, { json: { ids: [ABSENT] } })).body).toMatchObject({
      code: 102,
      message: `These documents do not belong to dataset ${id} or Document not found: ${ABSENT}`,
    });
    const stopped = await call("POST", `${base}/stop`, { json: { document_ids: [ABSENT] } });
    expect(stopped.body).toMatchObject({
      code: 100,
      message: `Documents not found: ['${ABSENT}']`,
    });
    const parsed = await call("POST", `${base}/parse`, { json: { document_ids: [ABSENT] } });
    expect(parsed.body).toMatchObject({ code: 0, data: { success_count: 0 } });
    expect((await call("GET", `${base}/${ABSENT}`)).body).toMatchObject({ code: 404 });
    expect((await call("GET", `${base}?id=${ABSENT}`)).body).toMatchObject({
      code: 102,
      message: `you don't own the document ${ABSENT}`,
      data: { docs: [], total: 0 },
    });
    expect(fake.unknownRoutes()).toEqual([]);
  });

  it("画布与模板组", async () => {
    expect((await call("GET", `/api/v1/agents/${ABSENT}`)).body).toMatchObject({
      code: 103,
      message: "Make sure you have permission to access the agent.",
    });
    expect((await call("DELETE", `/api/v1/agents/${ABSENT}`)).body).toMatchObject({
      code: 103,
      message: "Only the owner of the agent is authorized for this operation.",
    });
    const group = `/api/v1/compilation-template-groups/${ABSENT}`;
    for (const method of ["GET", "DELETE"]) {
      expect((await call(method, group)).body).toMatchObject({
        code: 404,
        message: `Cannot find compilation template group ${ABSENT}.`,
      });
    }
  });
});

describe("未知路由（§12）", () => {
  it.each([
    ["GET", "/api/v1/nope"],
    ["DELETE", "/api/v1/providers/OpenAI-API-Compatible"],
    ["GET", "/api/v1/providers/OpenAI-API-Compatible/instances/owb-embed"],
    ["PATCH", "/api/v1/models/default"],
  ])("%s %s：HTTP 404 + code:404，并记录", async (method, path) => {
    const answer = await call(method, path);
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: 404, message: `Not Found: ${path}` });
    expect(fake.unknownRoutes()).toMatchObject([{ method, path, unknown: true }]);
  });

  it("本组没有实现的路由也是未知路由：已存在数据集的文档列表归组 11", async () => {
    const id = fake.addDataset();
    await call("GET", `/api/v1/datasets/${id}/documents?page=1&page_size=100`);
    expect(fake.unknownRoutes()).toMatchObject([
      { path: `/api/v1/datasets/${id}/documents`, query: "page=1&page_size=100" },
    ]);
  });
});

describe("脚本化应答", () => {
  it("按路由应答一次，之后恢复；* 匹配一段路径", async () => {
    const id = fake.addDataset();
    fake.answer("POST /api/v1/datasets/*/documents/parse", { code: 500, message: "boom" });
    const path = `/api/v1/datasets/${id}/documents/parse`;
    expect((await call("POST", path, { json: { document_ids: [] } })).body).toMatchObject({
      code: 500,
    });
    expect((await call("POST", path, { json: { document_ids: [] } })).body).toMatchObject({
      code: 102,
    });
  });

  it("times 控制次数，先脚本化的先生效", async () => {
    fake.answer("GET /api/v1/system/version", { code: 100 }, { times: 2 });
    fake.answer("GET /api/v1/system/version", { code: 101 });
    const codes: unknown[] = [];
    for (let round = 0; round < 4; round += 1) {
      codes.push((await call("GET", "/api/v1/system/version")).body.code);
    }
    expect(codes).toEqual([100, 100, 101, 0]);
  });

  it("HTTP 状态可设：§12 的 404 与 401", async () => {
    fake.answer("GET /api/v1/system/version", { status: 401, code: 401, message: "x" });
    expect((await call("GET", "/api/v1/system/version")).status).toBe(401);
  });

  it.each([[108], [109], [999]])("code:%i 不在实测记录里，拒绝脚本化", (code) => {
    expect(() => {
      fake.answer("GET /api/v1/system/version", { code });
    }).toThrow(/record/u);
  });

  it("脚本化的路由不算未知路由", async () => {
    fake.answer("POST /api/v1/providers/*/instances", { code: 0, data: null, message: "success" });
    await call("POST", "/api/v1/providers/x/instances", { json: {} });
    expect(fake.unknownRoutes()).toEqual([]);
    expect(fake.requests()[0]?.unknown).toBe(false);
  });
});

describe("故障注入", () => {
  const VERSION = "GET /api/v1/system/version";
  const version = () => call("GET", "/api/v1/system/version");

  it("hang：不应答；close 仍能结束", async () => {
    fake.fault(VERSION, { kind: "hang" });
    const pending = version().catch(() => "failed");
    await expect.poll(() => fake.requests().length).toBe(1);
    await fake.close();
    await expect(pending).resolves.toBe("failed");
    fake = await start({ apiKey: KEY });
  });

  it("hold：挂起后放行，照常处理", async () => {
    const gate = fake.fault(VERSION, { kind: "hold" });
    const pending = version();
    await gate.reached;
    gate.release();
    expect((await pending).body).toMatchObject({ code: 0, data: "v1.0.0-rc2" });
  });

  it("reset：不发应答头就断开", async () => {
    fake.fault(VERSION, { kind: "reset" });
    await expect(version()).rejects.toThrow();
  });

  it("cut：发出部分正文后断开", async () => {
    fake.fault(VERSION, { kind: "cut", body: '{"code":0' });
    await expect(version()).rejects.toThrow();
  });

  it("stall：发出部分正文后不再有字节", async () => {
    fake.fault(VERSION, { kind: "stall", body: "partial" });
    const response = await fetch(`${fake.baseUrl}/api/v1/system/version`);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toBe("partial");
    await reader?.cancel();
  });

  it("redirect：3xx 带 Location 与任意正文", async () => {
    fake.fault(VERSION, { kind: "redirect", location: "http://elsewhere.test/", body: "{}" });
    const answer = await version();
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe("http://elsewhere.test/");
  });

  it("status：5xx", async () => {
    fake.fault(VERSION, { kind: "status", status: 503, body: "upstream down" });
    const answer = await version();
    expect(answer.status).toBe(503);
    expect(answer.text).toBe("upstream down");
  });

  it("not_json：HTTP 200 的非 JSON", async () => {
    fake.fault(VERSION, { kind: "not_json" });
    const answer = await version();
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({});
  });

  it("oversize：恰为给定字节数，仍是合法 JSON", async () => {
    fake.fault(VERSION, { kind: "oversize", bytes: 1_048_577, envelope: { code: 0, data: "v" } });
    const answer = await version();
    expect(Buffer.byteLength(answer.text)).toBe(1_048_577);
    expect(answer.body).toEqual({ code: 0, data: "v" });
  });

  it("version：不符的版本串", async () => {
    fake.fault(VERSION, { kind: "version", value: "v1.0.0-rc1" });
    expect((await version()).body).toMatchObject({ code: 0, data: "v1.0.0-rc1" });
  });

  it("combo：防御性组合", async () => {
    fake.fault("DELETE /api/v1/datasets", { kind: "combo", deletedList: true });
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [ABSENT] } });
    expect(answer.text).toBe('{"code":0,"data":{"deleted":[]},"message":null}');
    fake.fault(VERSION, { kind: "combo", code: 403, message: "Permission denied" });
    expect((await version()).body).toMatchObject({ code: 403 });
  });

  it("combo 只接受 100、101、102、403", () => {
    expect(() => {
      fake.fault(VERSION, { kind: "combo", code: 500 });
    }).toThrow(/combo/u);
  });

  it("没有分块下载这一种故障，未知种类直接抛", () => {
    expect(() => {
      fake.fault(VERSION, { kind: "chunked" } as never);
    }).toThrow(/fault/u);
  });

  it("脚本不改请求记录：挂起的请求也有查询串与 key 状态", async () => {
    fake.fault("GET /api/v1/datasets/*/documents", { kind: "reset" });
    await call("GET", `/api/v1/datasets/${ABSENT}/documents?page=2`).catch(() => undefined);
    expect(fake.requests()[0]).toMatchObject({ query: "page=2", bearer: "ok" });
  });
});
