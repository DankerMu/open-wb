/**
 * s2a-kb-ragflow tasks 5.2（#1840）：假 RAGFlow 夹具自测。协议应答的期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` 的字面量（用例名或注释标了小节号），不从夹具导入。
 * 这里用 `fetch` 直接打夹具，不经客户端：夹具是客户端用例的判据，不能反过来靠它证明。文档路由的自测在
 * `fake-ragflow-documents.test.ts`，脚本层的在 `fake-ragflow-script.test.ts`。
 */
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
const ABSENT_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const NOT_HEX = "not-hex";
const ALL_ZERO = "0".repeat(32);
const THREE_PART = "bge-m3@owb-embed@OpenAI-API-Compatible";

let fake: FakeRagflowServer;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
});

afterEach(async () => {
  await fake.close();
});

const call = (method: string, path: string, options?: FakeCallOptions) =>
  callFake(fake.baseUrl, KEY, method, path, options);

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

  it.each([
    ["小写 bearer", `bearer ${KEY}`],
    ["裸密钥", KEY],
  ])("%s 被接受", async (_label, authorization) => {
    const answer = await call("DELETE", "/api/v1/datasets", { json: {}, authorization });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 0 });
  });

  it("大写 BEARER 不放行：记录只有 Bearer 与小写", async () => {
    const authorization = `BEARER ${KEY}`;
    const answer = await call("DELETE", "/api/v1/datasets", { json: {}, authorization });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 401, message: "Invalid access token" });
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

  const named = (name: string) => create({ name, parser_id: "general", parse_type: 1 });

  it("名字恰 128 字符：成功；129 字符：102（§4.5）", async () => {
    const fits = await named("n".repeat(128));
    expect(fits.body).toMatchObject({ code: 0, data: { name: "n".repeat(128) } });
    const answer = await named("n".repeat(129));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 102,
      message: "Dataset name length is 129 which is large than 128",
    });
    expect(fake.datasets()).toHaveLength(1);
  });

  it("全空白的名字：102（§4.5）", async () => {
    const answer = await named("   ");
    expect(answer.body).toMatchObject({ code: 102, message: "dataset name can't be empty" });
    expect(fake.datasets()).toEqual([]);
  });

  it("缺名字：102（§12 的缺字段）", async () => {
    const answer = await create({ parser_id: "general", parse_type: 1 });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 102 });
    expect(fake.datasets()).toEqual([]);
  });

  it("同名改名，不区分大小写（§4.5）", async () => {
    const names: unknown[] = [];
    for (const name of ["owb-dup", "owb-dup", "OWB-DUP"]) {
      names.push(((await named(name)).body.data as { name: string }).name);
    }
    expect(names).toEqual(["owb-dup", "owb-dup(1)", "OWB-DUP(2)"]);
    expect(fake.datasets().map((dataset) => dataset.name)).toEqual(names);
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

  it.each([[{ ids: "x" }], [{ ids: 1 }], [{ ids: {} }]])(
    "%j 不在 §4.6 的表里：未知路由，什么也不删",
    async (json) => {
      fake.addDataset();
      const answer = await call("DELETE", "/api/v1/datasets", { json });
      expectUnknownRoute(fake, answer, "/api/v1/datasets");
      expect(fake.datasets()).toHaveLength(1);
    },
  );

  it("重复的 id 没有记录：未知路由，什么也不删", async () => {
    const id = fake.addDataset();
    const answer = await call("DELETE", "/api/v1/datasets", { json: { ids: [id, id] } });
    expectUnknownRoute(fake, answer, "/api/v1/datasets");
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
