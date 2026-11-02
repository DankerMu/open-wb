/**
 * s2a-kb-ragflow tasks 8.2（#1844）：假 RAGFlow 模型路由的自测。期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` §4.4、§11 的字面量，不从夹具导入；用 `fetch` 直接打夹具，不经客户端：
 * 夹具是下发用例的判据，不能反过来靠它证明。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { callFake, expectUnknownRoute, type FakeCallOptions } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1844-fixture-key";
const PROVIDERS = "/api/v1/providers";
const PROVIDER = "OpenAI-API-Compatible";
const INSTANCES = `${PROVIDERS}/${PROVIDER}/instances`;
const DEFAULTS = "/api/v1/models/default";
const UPSTREAM = "http://upstream.test/v1";
const BGE = { model_name: "bge-m3", model_type: ["embedding"], max_tokens: 8192 };
const CHAT = { model_name: "deepseek-v4.1-flash", model_type: ["chat"], max_tokens: 8192 };
const SMALL = { model_name: "text-embedding-3-small", model_type: ["embedding"], max_tokens: 8192 };
const INSTANCE_BODY = {
  instance_name: "owb-embed",
  api_key: "upstream-key",
  base_url: UPSTREAM,
  model_info: [BGE],
};
const THREE_PART = `bge-m3@owb-embed@${PROVIDER}`;
const SET_EMBEDDING = {
  model_provider: PROVIDER,
  model_instance: "owb-embed",
  model_name: "bge-m3",
  model_type: "embedding",
};

let fake: FakeRagflowServer;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
});

afterEach(async () => {
  await fake.close();
});

const call = (method: string, path: string, options?: FakeCallOptions) =>
  callFake(fake.baseUrl, KEY, method, path, options);

const putProvider = () => call("PUT", PROVIDERS, { json: { provider_name: PROVIDER } });
const postInstance = (json: unknown) => call("POST", INSTANCES, { json });
const putInstance = (json: unknown) => call("PUT", `${INSTANCES}/owb-embed`, { json });

async function provisioned() {
  expect((await putProvider()).body).toMatchObject({ code: 0 });
  expect((await postInstance(INSTANCE_BODY)).body).toMatchObject({ code: 0 });
}

describe("提供方与实例（§11.1）", () => {
  it("PUT /providers 幂等，data 为 null", async () => {
    expect((await putProvider()).text).toBe('{"code":0,"data":null,"message":"success"}');
    expect((await putProvider()).body).toMatchObject({ code: 0 });
  });

  it("PUT /providers 的未知名字回 code:0，但之后建实例是 code:404（§11.4）", async () => {
    const answer = await call("PUT", PROVIDERS, { json: { provider_name: "Nope" } });
    expect(answer.body).toMatchObject({ code: 0 });
    const created = await call("POST", `${PROVIDERS}/Nope/instances`, { json: INSTANCE_BODY });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ code: 404, message: "provider 'Nope' does not exist" });
  });

  it("没有 PUT /providers 就建实例是 code:404：夹具不比下发序列宽松", async () => {
    const answer = await postInstance(INSTANCE_BODY);
    expect(answer.body).toMatchObject({ code: 404 });
    expect(fake.instances()).toEqual([]);
  });

  it("建实例：code:0，模型进 GET /models 与实例的模型列表", async () => {
    await putProvider();
    expect((await postInstance(INSTANCE_BODY)).text).toBe(
      '{"code":0,"data":null,"message":"success"}',
    );
    const listed = await call("GET", "/api/v1/models");
    expect(listed.body).toMatchObject({
      code: 0,
      data: [
        {
          instance_name: "owb-embed",
          model_type: ["embedding"],
          name: "bge-m3",
          provider_name: PROVIDER,
          rank: 500,
        },
      ],
    });
    const models = await call("GET", `${INSTANCES}/owb-embed/models`);
    expect(models.body).toMatchObject({
      code: 0,
      data: [
        {
          extra: { max_tokens: 8192 },
          features: [],
          max_tokens: 8192,
          model_type: ["embedding"],
          name: "bge-m3",
          status: "active",
          verify: "unknown",
        },
      ],
    });
  });

  it("账号没有模型时 GET /models 回空列表（§16 只记了为空，信封外推自 §11.1）", async () => {
    expect((await call("GET", "/api/v1/models")).text).toBe(
      '{"code":0,"data":[],"message":"success"}',
    );
  });

  it("重复 POST 同名实例：HTTP 200 + code:500（§11.4）", async () => {
    await provisioned();
    const answer = await postInstance(INSTANCE_BODY);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      code: 500,
      message: "fail to create model instance: instance owb-embed already exists",
    });
  });

  it.each([
    ["空 body", {}],
    ["实例名含空格", { ...INSTANCE_BODY, instance_name: "owb embed" }],
  ])("%s：HTTP 200 + code:400（§11.4）", async (_label, json) => {
    await putProvider();
    const answer = await postInstance(json);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 400 });
    expect(fake.instances()).toEqual([]);
  });
});

describe("改实例（§11.4）", () => {
  it("带四个键：新地址与密钥生效，model_info 增一项", async () => {
    await provisioned();
    const answer = await putInstance({
      ...INSTANCE_BODY,
      api_key: "rotated",
      base_url: "http://other.test/v1",
      model_info: [BGE, SMALL],
    });
    expect(answer.body).toMatchObject({ code: 0 });
    expect(fake.instances()).toEqual([
      {
        name: "owb-embed",
        apiKey: "rotated",
        baseUrl: "http://other.test/v1",
        models: [
          { name: "bge-m3", modelType: ["embedding"], maxTokens: 8192 },
          { name: "text-embedding-3-small", modelType: ["embedding"], maxTokens: 8192 },
        ],
      },
    ]);
  });

  it("不带 model_info：HTTP 400 + code:400，实例不变", async () => {
    await provisioned();
    const { model_info: _dropped, ...withoutInfo } = INSTANCE_BODY;
    const answer = await putInstance({ ...withoutInfo, api_key: "rotated" });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: 400 });
    expect(fake.instances()[0]?.apiKey).toBe("upstream-key");
  });

  it("api_key 为空串：code:0，密钥被清空，不是保留", async () => {
    await provisioned();
    expect((await putInstance({ ...INSTANCE_BODY, api_key: "" })).body).toMatchObject({ code: 0 });
    expect(fake.instances()[0]?.apiKey).toBe("");
  });

  it("不存在的实例：code:404", async () => {
    await putProvider();
    const answer = await putInstance(INSTANCE_BODY);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ code: 404 });
    expect(fake.unknownRoutes()).toEqual([]);
  });

  it("model_info 里缺了已有模型：效果没有测过，落到未知路由", async () => {
    await provisioned();
    const answer = await putInstance({ ...INSTANCE_BODY, model_info: [SMALL] });
    expectUnknownRoute(fake, answer, `${INSTANCES}/owb-embed`);
  });
});

describe("账号缺省模型（§11.2、§11.4）", () => {
  it("PATCH 的 data.models 恒为空数组，读取要另发 GET", async () => {
    await provisioned();
    const set = await call("PATCH", DEFAULTS, { json: SET_EMBEDDING });
    expect(set.text).toBe('{"code":0,"data":{"models":[]},"message":"success"}');
    expect((await call("GET", DEFAULTS)).body).toMatchObject({
      code: 0,
      data: {
        models: [
          {
            model_provider: PROVIDER,
            model_instance: "owb-embed",
            model_name: "bge-m3",
            model_type: "embedding",
            enable: true,
          },
        ],
      },
    });
  });

  it("两种缺省都设了：GET 回两项", async () => {
    await putProvider();
    await postInstance({ ...INSTANCE_BODY, model_info: [BGE, CHAT] });
    await call("PATCH", DEFAULTS, { json: SET_EMBEDDING });
    await call("PATCH", DEFAULTS, {
      json: { ...SET_EMBEDDING, model_name: CHAT.model_name, model_type: "chat" },
    });
    expect(fake.defaultModels()).toEqual([
      { modelType: "embedding", instance: "owb-embed", name: "bge-m3" },
      { modelType: "chat", instance: "owb-embed", name: "deepseek-v4.1-flash" },
    ]);
    const rows = (await call("GET", DEFAULTS)).body.data as { models: { model_type: string }[] };
    expect(rows.models.map(({ model_type }) => model_type)).toEqual(["chat", "embedding"]);
  });

  it("账号没有缺省时 GET 的 models 为空", async () => {
    expect((await call("GET", DEFAULTS)).body).toMatchObject({ code: 0, data: { models: [] } });
  });

  it("模型不存在：code:100", async () => {
    await provisioned();
    const answer = await call("PATCH", DEFAULTS, {
      json: { ...SET_EMBEDDING, model_name: "missing" },
    });
    expect(answer.body).toMatchObject({ code: 100, message: "model missing isn't available" });
  });

  it("类型不符：code:100", async () => {
    await provisioned();
    const answer = await call("PATCH", DEFAULTS, {
      json: { ...SET_EMBEDDING, model_type: "chat" },
    });
    expect(answer.body).toMatchObject({ code: 100, message: "model bge-m3 isn't a chat model" });
    expect(fake.defaultModels()).toEqual([]);
  });

  it("不带 model_type：HTTP 400 + code:400", async () => {
    await provisioned();
    const { model_type: _dropped, ...json } = SET_EMBEDDING;
    const answer = await call("PATCH", DEFAULTS, { json });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: 400 });
  });

  it.each([
    ["只带 model_type", { model_type: "chat" }],
    [
      "三个名字都为空串",
      { model_provider: "", model_instance: "", model_name: "", model_type: "chat" },
    ],
    ["名字为空串", { ...SET_EMBEDDING, model_name: "" }],
  ])("清空缺省没有路由（D7、D17）：%s 落到未知路由", async (_label, json) => {
    await provisioned();
    await call("PATCH", DEFAULTS, { json: SET_EMBEDDING });
    expectUnknownRoute(fake, await call("PATCH", DEFAULTS, { json }), DEFAULTS);
    expect(fake.defaultModels()).toEqual([
      { modelType: "embedding", instance: "owb-embed", name: "bge-m3" },
    ]);
  });

  it("GET 的 data.models 可脚本化为空（§11.4）或缺一种（防御性组合）", async () => {
    fake.answer(`GET ${DEFAULTS}`, { code: 0, data: { models: [] }, message: "success" });
    expect((await call("GET", DEFAULTS)).body).toMatchObject({ data: { models: [] } });
    const only = { model_name: "bge-m3", model_type: "embedding" };
    fake.fault(`GET ${DEFAULTS}`, { kind: "combo", code: 0, data: { models: [only] } });
    expect((await call("GET", DEFAULTS)).body).toMatchObject({ data: { models: [only] } });
  });
});

describe("夹具没有的模型配置路由", () => {
  it.each([
    ["GET", `${INSTANCES}/owb-embed`],
    ["DELETE", `${PROVIDERS}/${PROVIDER}`],
    ["DELETE", INSTANCES],
    ["DELETE", `${INSTANCES}/owb-embed/models`],
    ["PATCH", "/api/v1/users/me/models"],
  ])("%s %s：未知路由", async (method, path) => {
    await provisioned();
    const answer = await call(method, path, method === "GET" ? {} : { json: {} });
    expectUnknownRoute(fake, answer, path);
    expect(fake.instances()).toHaveLength(1);
  });
});

describe("模型路由要密钥（§12）", () => {
  it.each([
    ["PUT", PROVIDERS],
    ["GET", "/api/v1/models"],
    ["POST", INSTANCES],
    ["PATCH", DEFAULTS],
  ])("%s %s：错误密钥 HTTP 401", async (method, path) => {
    const answer = await call(method, path, {
      ...(method === "GET" ? {} : { json: {} }),
      key: "wrong",
    });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ code: 401, message: "Invalid access token" });
  });
});

describe("embedding_model 的引用（§4.4）", () => {
  const create = (embeddingModel: string) =>
    call("POST", "/api/v1/datasets", {
      json: {
        name: "owb-ref",
        parser_id: "general",
        parse_type: 1,
        embedding_model: embeddingModel,
      },
    });

  it("引用已下发的模型：成功，保留三段式", async () => {
    await provisioned();
    expect((await create(THREE_PART)).body).toMatchObject({
      code: 0,
      data: { embedding_model: THREE_PART },
    });
  });

  it("账号没有下发过任何模型：三段式也是 102", async () => {
    expect((await create(THREE_PART)).body).toMatchObject({ code: 102 });
    expect(fake.datasets()).toEqual([]);
  });

  it("不存在的模型：102", async () => {
    await provisioned();
    const answer = await create(`missing@owb-embed@${PROVIDER}`);
    expect(answer.body).toMatchObject({
      code: 102,
      message: "model configuration unavailable: model config not found: missing",
    });
    expect(fake.datasets()).toEqual([]);
  });

  it("提供方名错：102", async () => {
    await provisioned();
    const answer = await create("bge-m3@owb-embed@Nope");
    expect(answer.body).toMatchObject({
      code: 102,
      message: 'provider "Nope" lookup failed: record not found',
    });
  });

  it("把对话模型当嵌入模型：102", async () => {
    await putProvider();
    await postInstance({ ...INSTANCE_BODY, model_info: [CHAT] });
    const answer = await create(`${CHAT.model_name}@owb-embed@${PROVIDER}`);
    expect(answer.body).toMatchObject({ code: 102 });
    expect(answer.body.message).toContain("cannot be used as embedding model");
  });

  it("两段式：账号有名为 default 的实例时成功，应答保留两段式", async () => {
    fake.addModel("default", "bge-m3", "embedding");
    const model = `bge-m3@${PROVIDER}`;
    expect((await create(model)).body).toMatchObject({ code: 0, data: { embedding_model: model } });
  });
});
