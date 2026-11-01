/**
 * s2a-kb-ragflow tasks 5.2（#1840）：RAGFlow 客户端的结果映射（ragflow-backend「RAGFlow 出站请求」，design D4）。
 * 全部打假 RAGFlow，期望值取自实测记录（§ 号）与 spec 的路由专属组合表。不从 `src/` 取期望值。
 * 传输层的期限、上传与下载在 `kb-ragflow-client-transfer.test.ts`。
 */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { closedPort, holdServer } from "./models-probe-helpers.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1840-ragflow-key";
const UPSTREAM_KEY = "wb-issue1840-upstream-key";
const SENTINEL = "wb-issue1840-message-sentinel";
const ABSENT = "0123456789abcdef0123456789abcdef";
const AUTH_FAILED = { event: "kb_upstream_auth_failed" };
const UNAVAILABLE = { kind: "kb_unavailable" };
const REJECTED = { kind: "kb_rejected" };
const NOT_FOUND = { kind: "not_found" };
const DATASET = {
  name: "owb-1-g0",
  parserId: "general",
  embeddingModel: "bge-m3@owb-embed@OpenAI-API-Compatible",
};
const INSTANCE = {
  instanceName: "owb-chat",
  apiKey: UPSTREAM_KEY,
  baseUrl: "http://upstream.test/v1",
  modelInfo: [{ model_name: "m", model_type: ["chat"], max_tokens: 8192 }],
};
/** §8.3 的列表行：只留客户端要读的键。 */
const LISTED = { id: ABSENT, ingestion_status: "COMPLETED", chunk_count: 2, name: "a.txt" };

type Client = ReturnType<typeof createRagflowClient>;

let fake: FakeRagflowServer;
let client: Client;
let logged: unknown[];
let clock: number;
let stderr: MockInstance<typeof process.stderr.write>;

function clientOf(baseUrl: string, deadlines: Record<string, number> = {}): Client {
  return createRagflowClient({
    baseUrl,
    key: { read: () => KEY },
    log: (record) => {
      logged.push(record);
    },
    now: () => clock,
    deadlines,
  });
}

function multipart(name: string, content: string) {
  const head = `--b\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`;
  const text = `${head}${content}\r\n--b--\r\n`;
  return {
    body: Readable.from([Buffer.from(text)]),
    contentType: "multipart/form-data; boundary=b",
    contentLength: Buffer.byteLength(text),
  };
}

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
  logged = [];
  clock = 1_000_000;
  stderr = vi.spyOn(process.stderr, "write");
  client = clientOf(fake.baseUrl);
});

afterEach(async () => {
  stderr.mockRestore();
  await fake.close();
});

describe("结果映射的五条", () => {
  it("第 1 条：路由专属组合先于通用行，DELETE /datasets 的 code:403 不是权限错误", async () => {
    await expect(client.deleteDataset(ABSENT)).resolves.toEqual(NOT_FOUND);
    expect(logged).toEqual([]);
  });

  it("第 2 条：HTTP 2xx 且 code 为 0 是成功，读出调用点要的字段", async () => {
    const created = await client.createDataset(DATASET);
    const [dataset] = fake.datasets();
    expect(created).toEqual({ kind: "ok", value: { id: dataset?.id } });
    expect(dataset).toMatchObject({ parserId: "general", embeddingModel: DATASET.embeddingModel });
    expect(fake.requests()[0]?.json).toEqual({
      name: "owb-1-g0",
      parser_id: "general",
      parse_type: 1,
      embedding_model: DATASET.embeddingModel,
    });
  });

  it.each([[101], [102]])("第 3 条：code %i 是 kb_rejected", async (code) => {
    fake.answer("POST /api/v1/datasets", { code, message: SENTINEL });
    await expect(client.createDataset(DATASET)).resolves.toEqual(REJECTED);
    expect(logged).toEqual([]);
  });

  it("第 3 条看 body code，不看 HTTP 状态", async () => {
    fake.answer("POST /api/v1/datasets", { status: 400, code: 102, message: SENTINEL });
    await expect(client.createDataset(DATASET)).resolves.toEqual(REJECTED);
  });

  it("第 4 条：HTTP 401 是 kb_unavailable，并写一行", async () => {
    fake.answer("POST /api/v1/datasets", { status: 401, code: 401, message: SENTINEL });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([AUTH_FAILED]);
  });

  it.each([
    ["其它非零 code", () => fake.answer("POST /api/v1/datasets", { code: 100 })],
    ["code:500", () => fake.answer("POST /api/v1/datasets", { code: 500 })],
    ["HTTP 500", () => fake.fault("POST /api/v1/datasets", { kind: "status", status: 500 })],
    [
      "HTTP 500 的 code:0",
      () => fake.answer("POST /api/v1/datasets", { status: 500, code: 0, data: { id: "x" } }),
    ],
    ["3xx", () => fake.fault("POST /api/v1/datasets", { kind: "redirect", location: "/" })],
    ["非 JSON", () => fake.fault("POST /api/v1/datasets", { kind: "not_json" })],
    ["连接重置", () => fake.fault("POST /api/v1/datasets", { kind: "reset" })],
    ["中途断开", () => fake.fault("POST /api/v1/datasets", { kind: "cut", body: '{"code":0' })],
    ["缺少调用点要读的字段", () => fake.answer("POST /api/v1/datasets", { code: 0, data: {} })],
    ["data 为 null", () => fake.answer("POST /api/v1/datasets", { code: 0, data: null })],
  ])("第 5 条：%s 是 kb_unavailable，不写认证行，不重试", async (_label, arrange) => {
    arrange();
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([]);
    expect(fake.requests()).toHaveLength(1);
  });

  it("第 5 条：连接失败", async () => {
    const closed = clientOf(`http://127.0.0.1:${String(await closedPort())}`);
    await expect(closed.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
  });

  it("第 5 条：地址解析不出来的请求建不起来，不外抛", async () => {
    await expect(clientOf("http://h:port").createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    const upload = multipart("a.txt", "x");
    await expect(clientOf("http://h:port").uploadDocument("a", upload)).resolves.toEqual(
      UNAVAILABLE,
    );
    expect(upload.body.destroyed).toBe(true);
  });

  it("第 5 条：挂起超过总期限（期限注入缩短）", async () => {
    const held = await holdServer();
    const slow = clientOf(`http://127.0.0.1:${String(held.port)}`, { totalMs: 30 });
    await expect(slow.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
  });

  it("第 5 条：响应体 1 MiB + 1 字节失败，恰 1 MiB 成功", async () => {
    const envelope = { code: 0, data: "v1.0.0-rc2" };
    const route = "GET /api/v1/system/version";
    fake.fault(route, { kind: "oversize", bytes: 1_048_577, envelope });
    await expect(client.version()).resolves.toEqual(UNAVAILABLE);
    fake.fault(route, { kind: "oversize", bytes: 1_048_576, envelope });
    await expect(client.version()).resolves.toEqual({ kind: "ok", value: "v1.0.0-rc2" });
  });

  it("body code 不是数字、顶层不是对象，都不算成功", async () => {
    fake.answer("POST /api/v1/datasets", { code: 0, data: { id: "" } });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    const route = "POST /api/v1/datasets";
    fake.fault(route, { kind: "not_json", body: '{"code":"0","data":{"id":"x"}}' });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    fake.fault(route, { kind: "not_json", body: "[0]" });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
  });
});

describe("路由专属组合表（表 B、§7.1、§8）", () => {
  const parser = (dataset: string, id: string) => client.parseDocument(dataset, id);

  it("GET /datasets/<id>/documents 的 code:404：not_found", async () => {
    await expect(client.listDocuments(ABSENT, 1)).resolves.toEqual(NOT_FOUND);
    expect(fake.requests()[0]?.query).toBe("page=1&page_size=100&orderby=create_time&desc=false");
  });

  it("POST /datasets/<id>/documents 的 102 加前缀：not_found", async () => {
    await expect(client.uploadDocument(ABSENT, multipart("a.txt", "x"))).resolves.toEqual(
      NOT_FOUND,
    );
  });

  it("POST /datasets/<id>/documents 的 500 含固定文字：unsupported_file", async () => {
    const id = fake.addDataset();
    await expect(client.uploadDocument(id, multipart("bin.exe", "x"))).resolves.toEqual({
      kind: "unsupported_file",
    });
  });

  it("POST …/documents/parse 的 code:404：not_found", async () => {
    await expect(parser(ABSENT, ABSENT)).resolves.toEqual(NOT_FOUND);
  });

  it("POST …/documents/parse 的 code:0 且 success_count 0：parse_not_started", async () => {
    const id = fake.addDataset();
    await expect(parser(id, ABSENT)).resolves.toEqual({ kind: "parse_not_started" });
    const running = fake.addDocument(id, {
      name: "a.txt",
      content: "x",
      ingestionStatus: "RUNNING",
    });
    await expect(parser(id, running)).resolves.toEqual({ kind: "parse_not_started" });
  });

  it("POST …/documents/stop 的 code:404 与 code:100 加前缀：not_found", async () => {
    await expect(client.stopDocument(ABSENT, ABSENT)).resolves.toEqual(NOT_FOUND);
    const id = fake.addDataset();
    await expect(client.stopDocument(id, ABSENT)).resolves.toEqual(NOT_FOUND);
  });

  it("DELETE …/documents 的 code:404 与 code:102 加前缀：not_found", async () => {
    await expect(client.deleteDocument(ABSENT, ABSENT)).resolves.toEqual(NOT_FOUND);
    const id = fake.addDataset();
    await expect(client.deleteDocument(id, ABSENT)).resolves.toEqual(NOT_FOUND);
  });

  it.each([["RUNNING"], ["STOPPING"]])(
    "DELETE …/documents 的 code:0 且 deleted 0（%s）：not_deleted",
    async (ingestionStatus) => {
      const id = fake.addDataset();
      const doc = fake.addDocument(id, { name: "a.txt", content: "x", ingestionStatus });
      await expect(client.deleteDocument(id, doc)).resolves.toEqual({ kind: "not_deleted" });
      expect(fake.documents(id)).toHaveLength(1);
    },
  );

  it("DELETE /datasets 的 code:403：not_found", async () => {
    await expect(client.deleteDataset(ABSENT)).resolves.toEqual(NOT_FOUND);
  });

  it("DELETE /agents/<id> 的 code:103：not_found", async () => {
    await expect(client.deleteCanvas(ABSENT)).resolves.toEqual(NOT_FOUND);
    expect(fake.requests()[0]).toMatchObject({
      method: "DELETE",
      path: `/api/v1/agents/${ABSENT}`,
    });
  });

  it("DELETE /compilation-template-groups/<id> 的 code:404：not_found", async () => {
    await expect(client.deleteTemplateGroup(ABSENT)).resolves.toEqual(NOT_FOUND);
    expect(fake.requests()[0]?.path).toBe(`/api/v1/compilation-template-groups/${ABSENT}`);
  });

  it("这些路由都落在夹具已知的路由上", async () => {
    await client.deleteDataset(ABSENT);
    await client.deleteCanvas(ABSENT);
    await client.deleteTemplateGroup(ABSENT);
    await client.listDocuments(ABSENT, 1);
    expect(fake.unknownRoutes()).toEqual([]);
  });
});

describe("成功路径", () => {
  it("每个调用的成功值", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x" });
    await expect(client.parseDocument(id, doc)).resolves.toEqual({ kind: "ok", value: null });
    fake.setDocumentStatus(id, doc, "RUNNING");
    await expect(client.stopDocument(id, doc)).resolves.toEqual({
      kind: "ok",
      value: { successCount: 1 },
    });
    fake.setDocumentStatus(id, doc, "COMPLETED");
    await expect(client.stopDocument(id, doc)).resolves.toEqual({
      kind: "ok",
      value: { successCount: 0 },
    });
    await expect(client.deleteDocument(id, doc)).resolves.toEqual({ kind: "ok", value: null });
    await expect(client.deleteDataset(id)).resolves.toEqual({ kind: "ok", value: null });
    expect(fake.requests().map((request) => request.json)).toEqual([
      { document_ids: [doc] },
      { document_ids: [doc] },
      { document_ids: [doc] },
      { ids: [doc] },
      { ids: [id] },
    ]);
  });

  it("文档列表读 §8.3 的字段，运行状态是 ingestion_status，不是 status", async () => {
    const data = {
      docs: [{ ...LISTED, status: "1" }],
      has_active_tasks: false,
      total: 16,
    };
    fake.answer("GET /api/v1/datasets/*/documents", { code: 0, data, message: "success" });
    await expect(client.listDocuments(ABSENT, 2)).resolves.toEqual({
      kind: "ok",
      value: {
        documents: [{ id: ABSENT, ingestionStatus: "COMPLETED", chunkCount: 2 }],
        total: 16,
      },
    });
    expect(fake.requests()[0]?.query).toBe("page=2&page_size=100&orderby=create_time&desc=false");
  });

  it.each([
    ["缺 docs", { total: 1 }],
    ["缺 total", { docs: [] }],
    ["行缺 ingestion_status", { docs: [{ ...LISTED, ingestion_status: undefined }], total: 1 }],
    ["行缺 chunk_count", { docs: [{ ...LISTED, chunk_count: undefined }], total: 1 }],
    ["行缺 id", { docs: [{ ...LISTED, id: undefined }], total: 1 }],
  ])("文档列表%s：kb_unavailable", async (_label, data) => {
    fake.answer("GET /api/v1/datasets/*/documents", { code: 0, data });
    await expect(client.listDocuments(ABSENT, 1)).resolves.toEqual(UNAVAILABLE);
  });

  it("删画布与删模板组：data 为 true（§5.1 (7)）", async () => {
    const reply = { code: 0, data: true, message: "success" };
    fake.answer("DELETE /api/v1/agents/*", reply);
    fake.answer("DELETE /api/v1/compilation-template-groups/*", reply);
    await expect(client.deleteCanvas(ABSENT)).resolves.toEqual({ kind: "ok", value: null });
    await expect(client.deleteTemplateGroup(ABSENT)).resolves.toEqual({ kind: "ok", value: null });
  });

  it("建与改模型实例：四个键恰在 body 里（§11.1、§11.4）", async () => {
    const reply = { code: 0, data: null, message: "success" };
    fake.answer("POST /api/v1/providers/*/instances", reply);
    fake.answer("PUT /api/v1/providers/*/instances/*", reply);
    await expect(client.createModelInstance(INSTANCE)).resolves.toEqual({
      kind: "ok",
      value: null,
    });
    await expect(client.updateModelInstance(INSTANCE)).resolves.toEqual({
      kind: "ok",
      value: null,
    });
    const body = {
      instance_name: "owb-chat",
      api_key: UPSTREAM_KEY,
      base_url: "http://upstream.test/v1",
      model_info: INSTANCE.modelInfo,
    };
    expect(fake.requests()).toMatchObject([
      {
        method: "POST",
        path: "/api/v1/providers/OpenAI-API-Compatible/instances",
        json: body,
        bearer: "ok",
      },
      {
        method: "PUT",
        path: "/api/v1/providers/OpenAI-API-Compatible/instances/owb-chat",
        json: body,
        bearer: "ok",
      },
    ]);
  });
});

describe("同路由别的 code 不被误判", () => {
  const dataset = "POST /api/v1/datasets/*/documents";

  it("上传的 102 没有前缀：kb_rejected；500 没有固定文字：kb_unavailable", async () => {
    fake.answer(dataset, { code: 102, message: `x Can't find the dataset with ID ${ABSENT}` });
    await expect(client.uploadDocument(ABSENT, multipart("a.txt", "x"))).resolves.toEqual(REJECTED);
    fake.answer(dataset, { code: 500, message: "fail to store" });
    await expect(client.uploadDocument(ABSENT, multipart("a.txt", "x"))).resolves.toEqual(
      UNAVAILABLE,
    );
  });

  it("上传的固定前缀不跨 code：100 加同样前缀不是 not_found", async () => {
    fake.fault(dataset, {
      kind: "combo",
      code: 100,
      message: `Can't find the dataset with ID ${ABSENT}!`,
    });
    await expect(client.uploadDocument(ABSENT, multipart("a.txt", "x"))).resolves.toEqual(
      UNAVAILABLE,
    );
  });

  it("停止的 100 没有前缀：kb_unavailable；102：kb_rejected", async () => {
    const route = "POST /api/v1/datasets/*/documents/stop";
    fake.fault(route, { kind: "combo", code: 100, message: "model missing isn't available" });
    await expect(client.stopDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
    fake.fault(route, { kind: "combo", code: 102, message: "Documents not found: []" });
    await expect(client.stopDocument(ABSENT, ABSENT)).resolves.toEqual(REJECTED);
  });

  it("删文档的 102 没有前缀（§8.5 的参数错）：kb_rejected", async () => {
    fake.answer("DELETE /api/v1/datasets/*/documents", {
      code: 102,
      message: "should either provide doc ids or set delete_all(true)",
    });
    await expect(client.deleteDocument(ABSENT, ABSENT)).resolves.toEqual(REJECTED);
  });

  it("删数据集的非法 id 是 code:101（§12）：kb_rejected，不是 not_found", async () => {
    await expect(client.deleteDataset("not-hex")).resolves.toEqual(REJECTED);
  });

  it("message 不是字符串时前缀判定不成立", async () => {
    fake.fault("DELETE /api/v1/datasets/*/documents", { kind: "combo", code: 102 });
    await expect(client.deleteDocument(ABSENT, ABSENT)).resolves.toEqual(REJECTED);
  });

  it("not_found 组合要 HTTP 200：未知路由的 HTTP 404 + code:404（§12）不算已删", async () => {
    fake.answer("DELETE /api/v1/datasets/*/documents", { status: 404, code: 404 });
    await expect(client.deleteDocument(ABSENT, ABSENT)).resolves.toEqual(UNAVAILABLE);
    fake.answer("GET /api/v1/datasets/*/documents", { status: 404, code: 404 });
    await expect(client.listDocuments(ABSENT, 1)).resolves.toEqual(UNAVAILABLE);
  });

  it("模型实例不认前缀：重复 POST 的 code:500（§11.4）是 kb_unavailable", async () => {
    fake.answer("POST /api/v1/providers/*/instances", {
      code: 500,
      message: "fail to create model instance: instance owb-chat already exists",
    });
    await expect(client.createModelInstance(INSTANCE)).resolves.toEqual(UNAVAILABLE);
  });
});

describe("成功码下的失败", () => {
  it("DELETE /datasets 的 {code:0, data:{deleted:[]}}：kb_unavailable", async () => {
    fake.fault("DELETE /api/v1/datasets", { kind: "combo", deletedList: true });
    await expect(client.deleteDataset(ABSENT)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([]);
  });

  it("DELETE /datasets 的 success_count 不是 1：kb_unavailable", async () => {
    fake.answer("DELETE /api/v1/datasets", {
      code: 0,
      data: { errors: [], success_count: 0 },
    });
    await expect(client.deleteDataset(ABSENT)).resolves.toEqual(UNAVAILABLE);
  });

  it.each([
    ["parse", "POST /api/v1/datasets/*/documents/parse", (c: Client) => c.parseDocument("a", "b")],
    ["stop", "POST /api/v1/datasets/*/documents/stop", (c: Client) => c.stopDocument("a", "b")],
    ["delete", "DELETE /api/v1/datasets/*/documents", (c: Client) => c.deleteDocument("a", "b")],
    [
      "upload",
      "POST /api/v1/datasets/*/documents",
      (c: Client) => c.uploadDocument("a", multipart("a.txt", "x")),
    ],
  ])("%s 的 code:0 缺字段：kb_unavailable", async (_label, route, invoke) => {
    fake.answer(route, { code: 0, data: {} });
    await expect(invoke(client)).resolves.toEqual(UNAVAILABLE);
  });

  it("上传回两行：不是这一个请求的应答，kb_unavailable", async () => {
    fake.answer("POST /api/v1/datasets/*/documents", {
      code: 0,
      data: [{ id: "a" }, { id: "b" }],
    });
    await expect(client.uploadDocument("a", multipart("a.txt", "x"))).resolves.toEqual(UNAVAILABLE);
  });
});

describe("权限错误的防御性映射", () => {
  it("文档列表的 HTTP 200 + code:403：kb_unavailable，写一行", async () => {
    const route = "GET /api/v1/datasets/*/documents";
    fake.fault(route, { kind: "combo", code: 403, message: "Permission denied" });
    await expect(client.listDocuments(ABSENT, 1)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([AUTH_FAILED]);
  });

  it("body code:401 同样写一行；HTTP 401 不看 body", async () => {
    fake.answer("POST /api/v1/datasets", { code: 401 });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([AUTH_FAILED]);
    clock += 60_000;
    fake.fault("POST /api/v1/datasets", { kind: "not_json", status: 401 });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([AUTH_FAILED, AUTH_FAILED]);
  });

  it("DELETE /datasets 的 code:403 不写", async () => {
    await client.deleteDataset(ABSENT);
    expect(logged).toEqual([]);
  });

  it("60 秒内至多一行，满 60 秒再写", async () => {
    fake.answer("POST /api/v1/datasets", { status: 401, code: 401 }, { times: 4 });
    await client.createDataset(DATASET);
    await client.createDataset(DATASET);
    clock += 59_999;
    await client.createDataset(DATASET);
    expect(logged).toEqual([AUTH_FAILED]);
    clock += 1;
    await client.createDataset(DATASET);
    expect(logged).toEqual([AUTH_FAILED, AUTH_FAILED]);
  });

  it("错误密钥的真实组合（§12）走同一行", async () => {
    const wrong = createRagflowClient({
      baseUrl: fake.baseUrl,
      key: { read: () => "wrong" },
      log: (record) => {
        logged.push(record);
      },
    });
    await expect(wrong.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    expect(logged).toEqual([AUTH_FAILED]);
  });
});

describe("3xx 不跟随", () => {
  it("发出恰一个请求，Location 指向的服务收不到请求", async () => {
    const other = await start({ apiKey: KEY });
    fake.fault("POST /api/v1/datasets", {
      kind: "redirect",
      location: `${other.baseUrl}/api/v1/datasets`,
    });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toHaveLength(1);
    expect(other.requests()).toEqual([]);
    await other.close();
  });

  it("3xx 带 code:102 的正文也不算 kb_rejected", async () => {
    fake.fault("POST /api/v1/datasets", {
      kind: "redirect",
      location: "/",
      body: '{"code":102,"message":"x"}',
    });
    await expect(client.createDataset(DATASET)).resolves.toEqual(UNAVAILABLE);
  });
});

describe("key 只走请求头", () => {
  it("版本请求不带 key，其余都带", async () => {
    const id = fake.addDataset();
    const doc = fake.addDocument(id, { name: "a.txt", content: "x" });
    await client.version();
    await client.createDataset(DATASET);
    await client.deleteDataset(ABSENT);
    await client.uploadDocument(id, multipart("a.txt", "x"));
    await client.parseDocument(id, doc);
    await client.stopDocument(id, doc);
    await client.listDocuments(ABSENT, 1);
    const download = await client.downloadDocument(id, doc);
    if (download.kind === "ok") {
      download.value.body.destroy();
    }
    await client.deleteDocument(id, doc);
    await client.deleteCanvas(ABSENT);
    await client.deleteTemplateGroup(ABSENT);
    expect(fake.requests().map((request) => request.bearer)).toEqual([
      "missing",
      ...Array.from({ length: 10 }, () => "ok"),
    ]);
    expect(JSON.stringify(fake.requests())).not.toContain(KEY);
  });

  it("结果对象不含 key 与上游密钥", async () => {
    fake.answer("POST /api/v1/providers/*/instances", { code: 500, message: UPSTREAM_KEY });
    const result = await client.createModelInstance(INSTANCE);
    expect(JSON.stringify(result)).not.toContain(UPSTREAM_KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("不发出的请求", () => {
  it.each([
    ["deleteDataset", () => client.deleteDataset("")],
    ["deleteDocument 的文档", () => client.deleteDocument(ABSENT, "")],
    ["deleteDocument 的数据集", () => client.deleteDocument("", ABSENT)],
    ["parseDocument", () => client.parseDocument(ABSENT, "")],
    ["stopDocument", () => client.stopDocument(ABSENT, "")],
    ["listDocuments", () => client.listDocuments("", 1)],
    ["uploadDocument", () => client.uploadDocument("", multipart("a.txt", "x"))],
    ["downloadDocument", () => client.downloadDocument(ABSENT, "")],
    ["deleteCanvas", () => client.deleteCanvas("")],
    ["deleteTemplateGroup", () => client.deleteTemplateGroup("")],
  ])("空 id 的 %s 不发出：kb_unavailable，绝不当成 not_found", async (_label, invoke) => {
    await expect(invoke()).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toEqual([]);
  });

  it.each([["."], [".."]])("id %s 走不出自己的路径段：不发出", async (id) => {
    await expect(client.deleteCanvas(id)).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toEqual([]);
  });

  it("空 api_key 的建实例与改实例不发出（§11.4：空串清空实例密钥）", async () => {
    const empty = { ...INSTANCE, apiKey: "" };
    await expect(client.createModelInstance(empty)).resolves.toEqual(UNAVAILABLE);
    await expect(client.updateModelInstance(empty)).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toEqual([]);
  });

  it("空实例名的改实例不发出", async () => {
    await expect(client.updateModelInstance({ ...INSTANCE, instanceName: "" })).resolves.toEqual(
      UNAVAILABLE,
    );
    expect(fake.requests()).toEqual([]);
  });

  it("空 id 上传时释放请求体", async () => {
    const upload = multipart("a.txt", "x");
    await client.uploadDocument("", upload);
    expect(upload.body.destroyed).toBe(true);
  });
});

describe("路径的 id 按段编码", () => {
  it("/ 与 ? 留在路径段里", async () => {
    await client.deleteCanvas("a/b?c");
    expect(fake.requests()[0]).toMatchObject({ path: "/api/v1/agents/a%2Fb%3Fc", query: "" });
  });
});

describe("客户端的调用面（design D4、D7）", () => {
  it("恰为这些调用：没有读单实例、清空缺省与 /providers 下的删除", () => {
    expect(Object.keys(client).sort()).toEqual([
      "createDataset",
      "createModelInstance",
      "deleteCanvas",
      "deleteDataset",
      "deleteDocument",
      "deleteTemplateGroup",
      "downloadDocument",
      "listDocuments",
      "parseDocument",
      "stopDocument",
      "updateModelInstance",
      "uploadDocument",
      "version",
    ]);
  });
});

describe("RAGFlow 的 message 不外泄", () => {
  const rows: [string, () => void, () => Promise<unknown>][] = [
    [
      "kb_rejected",
      () => fake.answer("POST /api/v1/datasets", { code: 101, message: SENTINEL }),
      () => client.createDataset(DATASET),
    ],
    [
      "kb_unavailable 的 500",
      () => fake.answer("POST /api/v1/datasets", { code: 500, message: SENTINEL }),
      () => client.createDataset(DATASET),
    ],
    [
      "HTTP 401",
      () => fake.answer("POST /api/v1/datasets", { status: 401, code: 401, message: SENTINEL }),
      () => client.createDataset(DATASET),
    ],
    [
      "not_found",
      () => {
        fake.answer("DELETE /api/v1/datasets", { code: 403, message: SENTINEL });
      },
      () => client.deleteDataset(ABSENT),
    ],
    [
      "unsupported_file",
      () =>
        fake.answer("POST /api/v1/datasets/*/documents", {
          code: 500,
          message: `${SENTINEL} This type of file has not been supported yet!`,
        }),
      () => client.uploadDocument(ABSENT, multipart("a.txt", "x")),
    ],
    [
      "not_deleted",
      () =>
        fake.answer("DELETE /api/v1/datasets/*/documents", {
          code: 0,
          data: { deleted: 0 },
          message: SENTINEL,
        }),
      () => client.deleteDocument(ABSENT, ABSENT),
    ],
    [
      "parse_not_started",
      () =>
        fake.answer("POST /api/v1/datasets/*/documents/parse", {
          code: 0,
          data: { success_count: 0 },
          message: SENTINEL,
        }),
      () => client.parseDocument(ABSENT, ABSENT),
    ],
    [
      "非 JSON 正文",
      () => fake.fault("POST /api/v1/datasets", { kind: "not_json", body: SENTINEL }),
      () => client.createDataset(DATASET),
    ],
    [
      "5xx 正文",
      () => fake.fault("POST /api/v1/datasets", { kind: "status", status: 502, body: SENTINEL }),
      () => client.createDataset(DATASET),
    ],
    [
      "成功值",
      () =>
        fake.answer("POST /api/v1/datasets", {
          code: 0,
          data: { id: "x", name: SENTINEL },
          message: SENTINEL,
        }),
      () => client.createDataset(DATASET),
    ],
  ];

  it.each(rows)("%s：结果对象、日志与 stderr 都没有哨兵", async (_label, arrange, invoke) => {
    arrange();
    const result = await invoke();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(logged)).not.toContain(SENTINEL);
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).not.toContain(SENTINEL);
  });

  it("结果只有 kind，失败不带原始 code 与 message", async () => {
    fake.answer("POST /api/v1/datasets", { code: 102, message: SENTINEL });
    expect(Object.keys(await client.createDataset(DATASET))).toEqual(["kind"]);
  });
});
