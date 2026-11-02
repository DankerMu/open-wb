/**
 * s2a-kb-ragflow tasks 8.2、8.3（#1844）：RAGFlow 客户端的模型下发调用，打假 RAGFlow（ragflow-backend「知识库模型设置」
 * 的下发序列，design D4、D7）。期望值是实测记录 §11 的字面量。上面的序列在 `kb-settings.test.ts` 经 HTTP 验证，这里钉住
 * 每个调用的路径、body、读出的字段与拒绝发出的取值。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1844-client-key";
const PROVIDER = "OpenAI-API-Compatible";
const UNAVAILABLE = { kind: "kb_unavailable" };
const REJECTED = { kind: "kb_rejected" };
const OK = { kind: "ok", value: null };
const LIST_MODELS = "GET /api/v1/models";
const PATCH_DEFAULT = "PATCH /api/v1/models/default";
const INSTANCE_MODELS = "GET /api/v1/providers/*/instances/*/models";

let fake: FakeRagflowServer;
let client: ReturnType<typeof createRagflowClient>;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
  client = createRagflowClient({
    baseUrl: fake.baseUrl,
    key: { read: () => KEY },
    log: () => undefined,
  });
});

afterEach(async () => {
  try {
    expect(fake.unknownRoutes()).toEqual([]);
  } finally {
    await fake.close();
  }
});

const sent = () =>
  fake.requests().map(({ method, path, query, json, bearer }) => ({
    method,
    path,
    query,
    json,
    bearer,
  }));

describe("ensureProvider（§11.1）", () => {
  it("PUT /providers，body 恰为 provider_name", async () => {
    await expect(client.ensureProvider()).resolves.toEqual(OK);
    expect(sent()).toEqual([
      {
        method: "PUT",
        path: "/api/v1/providers",
        query: "",
        json: { provider_name: PROVIDER },
        bearer: "ok",
      },
    ]);
  });
});

describe("listModelInstances（§11.1）", () => {
  it("账号没有模型：空列表", async () => {
    await expect(client.listModelInstances()).resolves.toEqual({ kind: "ok", value: [] });
  });

  it("按 provider_name 取 instance_name，一个实例有多个模型时只算一次", async () => {
    fake.answer(LIST_MODELS, {
      code: 0,
      message: "success",
      data: [
        { instance_name: "owb-embed", name: "bge-m3", provider_name: PROVIDER },
        { instance_name: "owb-embed", name: "bge-large", provider_name: PROVIDER },
        { instance_name: "owb-chat", name: "m2", provider_name: PROVIDER },
        { instance_name: "other", name: "x", provider_name: "Other" },
      ],
    });
    await expect(client.listModelInstances()).resolves.toEqual({
      kind: "ok",
      value: ["owb-embed", "owb-chat"],
    });
  });

  it.each([
    ["data 不是数组", {}],
    ["行缺 instance_name", [{ provider_name: PROVIDER }]],
    ["行缺 provider_name", [{ instance_name: "owb-embed" }]],
    ["行不是对象", ["owb-embed"]],
  ])("成功应答缺字段（%s）：kb_unavailable", async (_label, data) => {
    fake.fault(LIST_MODELS, { kind: "combo", code: 0, data });
    await expect(client.listModelInstances()).resolves.toEqual(UNAVAILABLE);
  });
});

describe("listInstanceModels（§11.1）", () => {
  it("读出 model_info 的项：name 改名为 model_name，其余字段丢弃", async () => {
    fake.addModel("owb-embed", "bge-m3", "embedding");
    await expect(client.listInstanceModels("owb-embed")).resolves.toEqual({
      kind: "ok",
      value: [{ model_name: "bge-m3", model_type: ["embedding"], max_tokens: 8192 }],
    });
    expect(sent()).toMatchObject([
      {
        method: "GET",
        path: `/api/v1/providers/${PROVIDER}/instances/owb-embed/models`,
        bearer: "ok",
      },
    ]);
  });

  it.each([
    ["data 不是数组", {}],
    ["行缺 name", [{ model_type: ["chat"], max_tokens: 1 }]],
    ["行缺 model_type", [{ name: "m", max_tokens: 1 }]],
    ["行缺 max_tokens", [{ name: "m", model_type: ["chat"] }]],
  ])("成功应答缺字段（%s）：kb_unavailable", async (_label, data) => {
    fake.fault(INSTANCE_MODELS, { kind: "combo", code: 0, data });
    await expect(client.listInstanceModels("owb-chat")).resolves.toEqual(UNAVAILABLE);
  });

  it.each(["", ".", ".."])("实例名 %j 不发出：kb_unavailable", async (name) => {
    await expect(client.listInstanceModels(name)).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toEqual([]);
  });
});

describe("setDefaultModel（§11.2、§13）", () => {
  const CHAT = { instanceName: "owb-chat", modelName: "m2", modelType: "chat" } as const;

  it("PATCH /models/default，body 恰为四个键", async () => {
    fake.addModel("owb-chat", "m2", "chat");
    await expect(client.setDefaultModel(CHAT)).resolves.toEqual(OK);
    expect(sent()).toEqual([
      {
        method: "PATCH",
        path: "/api/v1/models/default",
        query: "",
        json: {
          model_provider: PROVIDER,
          model_instance: "owb-chat",
          model_name: "m2",
          model_type: "chat",
        },
        bearer: "ok",
      },
    ]);
    expect(fake.defaultModels()).toEqual([{ modelType: "chat", instance: "owb-chat", name: "m2" }]);
  });

  it.each([
    ["模型名为空", { ...CHAT, modelName: "" }],
    ["实例名为空", { ...CHAT, instanceName: "" }],
  ])("%s：这是清空缺省的写法（§11.2），不发出，kb_unavailable", async (_label, target) => {
    await expect(client.setDefaultModel(target)).resolves.toEqual(UNAVAILABLE);
    expect(fake.requests()).toEqual([]);
  });

  it("code:100（模型不存在）：kb_unavailable", async () => {
    await expect(client.setDefaultModel(CHAT)).resolves.toEqual(UNAVAILABLE);
  });

  it("code:102：kb_rejected", async () => {
    fake.fault(PATCH_DEFAULT, { kind: "combo", code: 102, message: "nope" });
    await expect(client.setDefaultModel(CHAT)).resolves.toEqual(REJECTED);
  });
});

describe("下发路由走同一套结果映射", () => {
  it("重复 POST 同名实例的 code:500：kb_unavailable（§11.4）", async () => {
    fake.addModel("owb-chat", "m2", "chat");
    const instance = {
      instanceName: "owb-chat",
      apiKey: "upstream",
      baseUrl: "http://upstream.test/v1",
      modelInfo: [{ model_name: "m2", model_type: ["chat"], max_tokens: 8192 }],
    };
    await expect(client.createModelInstance(instance)).resolves.toEqual(UNAVAILABLE);
  });

  it.each([
    ["空格", "   "],
    ["只有 U+0085", "\u0085"],
    ["空白夹 U+0085", " \u0085\t"],
  ])(
    "api_key 为%s：建实例与改实例不发出，RAGFlow 按 TrimSpace 后的值写入，等于清空实例密钥",
    async (_label, apiKey) => {
      const blank = {
        instanceName: "owb-chat",
        apiKey,
        baseUrl: "http://upstream.test/v1",
        modelInfo: [{ model_name: "m2", model_type: ["chat"], max_tokens: 8192 }],
      };
      await expect(client.createModelInstance(blank)).resolves.toEqual(UNAVAILABLE);
      await expect(client.updateModelInstance(blank)).resolves.toEqual(UNAVAILABLE);
      expect(fake.requests()).toEqual([]);
    },
  );

  it("HTTP 401：kb_unavailable", async () => {
    const wrong = createRagflowClient({
      baseUrl: fake.baseUrl,
      key: { read: () => "wrong-key" },
      log: () => undefined,
    });
    await expect(wrong.ensureProvider()).resolves.toEqual(UNAVAILABLE);
  });
});
