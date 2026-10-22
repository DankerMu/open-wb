/**
 * s1d-model-registry 任务 10.2 / 10.3：`web/src/lib/api-models.ts` 的六个方法（model-registry「模型 tab」的
 * API 客户端句）。接缝：真实的 `createApiClient` 加替身 `fetch`。期望值来自规格：路径与 `?id=` 的百分号编码
 *（字面量）、各端点的状态码（「模型管理端点」：list 200、create 201、update / default / probe 200、delete 204）、
 * `ModelView` 恰十键与各键的取值域（服务端 `server/src/models/rest.ts` 的视图）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type ModelView } from "../src/lib/api.js";
import { captureApiError, createFetchMock, expectRequestFailure, jsonResponse } from "./support.js";

const SEED: ModelView = {
  id: "deepseek-v4.1-flash",
  name: "deepseek-v4.1-flash",
  reasoning: true,
  vision: true,
  maxTokens: 32768,
  efforts: null,
  upstream: null,
  isDefault: true,
  probe: { status: "never", at: null, message: null },
  updatedAt: 1_760_000_000_000,
};

const M2: ModelView = {
  id: "Qwen/Qwen2.5-72B-Instruct",
  name: "千问",
  reasoning: true,
  vision: false,
  maxTokens: 8192,
  efforts: ["low", "high"],
  upstream: { baseUrl: "https://gw.example/v1", hasApiKey: true },
  isDefault: false,
  probe: { status: "failed", at: 1_760_000_000_500, message: "HTTP 401：bad key" },
  updatedAt: 1_760_000_000_400,
};

const ENCODED = "/api/models?id=Qwen%2FQwen2.5-72B-Instruct";
const GET = { method: "GET", credentials: "same-origin", cache: "no-store" };
const BODYLESS_POST = { method: "POST", credentials: "same-origin" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(routes: Parameters<typeof createFetchMock>[0]) {
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("六个方法的请求与成功应答", () => {
  it("listModels GETs /api/models without a body and returns the views in order", async () => {
    const fetchMock = stub({ "/api/models": () => jsonResponse({ models: [SEED, M2] }) });

    await expect(createApiClient().listModels()).resolves.toEqual([SEED, M2]);
    expect(fetchMock.mock.calls).toEqual([["/api/models", GET]]);
  });

  it("createModel POSTs exactly the given input as JSON and expects 201", async () => {
    const fetchMock = stub({ "/api/models": () => jsonResponse(M2, 201) });
    const input = {
      id: "m2",
      reasoning: true,
      efforts: ["low" as const, "high" as const],
      upstream: { baseUrl: "https://gw.example/v1", apiKey: "wb-issue1651-api-key" },
    };

    await expect(createApiClient().createModel(input)).resolves.toEqual(M2);
    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/models",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ],
    ]);
  });

  it("updateModel PUTs to ?id=<encodeURIComponent(id)> with the JSON body and expects 200", async () => {
    const fetchMock = stub({ [ENCODED]: () => jsonResponse(M2) });
    const input = {
      name: "千问",
      reasoning: true,
      vision: false,
      maxTokens: 8192,
      upstream: { baseUrl: "https://gw.example/v1" },
    };

    await expect(createApiClient().updateModel(M2.id, input)).resolves.toEqual(M2);
    expect(fetchMock.mock.calls).toEqual([
      [
        ENCODED,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ],
    ]);
  });

  it("deleteModel sends DELETE without a body and resolves on 204", async () => {
    const path = "/api/models?id=a%20b%2Fc%3F%26%23";
    const fetchMock = stub({ [path]: () => new Response(null, { status: 204 }) });

    await expect(createApiClient().deleteModel("a b/c?&#")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toEqual([
      [path, { method: "DELETE", credentials: "same-origin" }],
    ]);
  });

  it.each([
    ["setDefaultModel", "/api/models/default"],
    ["probeModel", "/api/models/probe"],
  ] as const)(
    "%s POSTs to %s?id= without a body or Content-Type and expects 200",
    async (method, base) => {
      const path = `${base}?id=Qwen%2FQwen2.5-72B-Instruct`;
      const fetchMock = stub({ [path]: () => jsonResponse(M2) });

      await expect(createApiClient()[method](M2.id)).resolves.toEqual(M2);
      expect(fetchMock.mock.calls).toEqual([[path, BODYLESS_POST]]);
    },
  );
});

describe("期望状态码", () => {
  it.each([
    ["listModels 201", () => createApiClient().listModels(), "/api/models", 201],
    ["createModel 200", () => createApiClient().createModel({ id: "m2" }), "/api/models", 200],
    [
      "updateModel 201",
      () =>
        createApiClient().updateModel(M2.id, {
          name: "x",
          reasoning: false,
          vision: false,
          maxTokens: 1,
          upstream: null,
        }),
      ENCODED,
      201,
    ],
    [
      "setDefaultModel 201",
      () => createApiClient().setDefaultModel("m2"),
      "/api/models/default?id=m2",
      201,
    ],
    ["probeModel 202", () => createApiClient().probeModel("m2"), "/api/models/probe?id=m2", 202],
  ] as const)("%s with a valid view is request_failed", async (_label, call, path, status) => {
    const body = path === "/api/models" && status === 201 ? { models: [M2] } : M2;
    stub({ [path]: () => jsonResponse(body, status) });

    expectRequestFailure(await captureApiError(call()), status);
  });

  it("deleteModel answered 200 is request_failed without reading the body", async () => {
    stub({ "/api/models?id=m2": () => jsonResponse({}, 200) });

    expectRequestFailure(await captureApiError(createApiClient().deleteModel("m2")), 200);
  });

  it("an envelope keeps status, code and message; a non-envelope 500 is request_failed 500", async () => {
    const inUse = { code: "model_in_use", message: "该模型是缺省模型，先把缺省换成别的模型" };
    stub({
      "/api/models?id=m1": () => jsonResponse({ error: inUse }, 409),
      "/api/models": () => jsonResponse({ error: { message: "服务器内部错误" } }, 500),
    });

    expect(await captureApiError(createApiClient().deleteModel("m1"))).toMatchObject({
      status: 409,
      ...inUse,
    });
    const failed = await captureApiError(createApiClient().createModel({ id: "c" }));
    expectRequestFailure(failed, 500);
  });
});

describe("ModelView 严格解析", () => {
  const { updatedAt: _dropped, ...nineKeys } = M2;
  it.each([
    ["a missing key", nineKeys],
    ["an extra key", { ...M2, createdAt: 1 }],
    ["an apiKey key", { ...M2, apiKey: "wb-issue1651-api-key" }],
    ["an upstream apiKey", { ...M2, upstream: { ...M2.upstream, apiKey: "wb-issue1651-api-key" } }],
    [
      "hasApiKey false",
      { ...M2, upstream: { baseUrl: "https://gw.example/v1", hasApiKey: false } },
    ],
    ["an empty baseUrl", { ...M2, upstream: { baseUrl: "", hasApiKey: true } }],
    ["an empty id", { ...M2, id: "" }],
    ["a non-string name", { ...M2, name: 1 }],
    ["a string reasoning", { ...M2, reasoning: "true" }],
    ["maxTokens 0", { ...M2, maxTokens: 0 }],
    ["maxTokens 128001", { ...M2, maxTokens: 128001 }],
    ["a fractional maxTokens", { ...M2, maxTokens: 1.5 }],
    ["an empty efforts array", { ...M2, efforts: [] }],
    ["efforts out of order", { ...M2, efforts: ["high", "low"] }],
    ["a repeated effort", { ...M2, efforts: ["low", "low"] }],
    ["the composer-only effort off", { ...M2, efforts: ["off", "low"] }],
    ["an unknown probe status", { ...M2, probe: { ...M2.probe, status: "pending" } }],
    ["a negative probe time", { ...M2, probe: { ...M2.probe, at: -1 } }],
    ["a probe with an extra key", { ...M2, probe: { ...M2.probe, detail: "x" } }],
    ["a numeric probe message", { ...M2, probe: { ...M2.probe, message: 1 } }],
    ["a fractional updatedAt", { ...M2, updatedAt: 1.5 }],
    ["a string isDefault", { ...M2, isDefault: "false" }],
  ])("a view with %s is request_failed on every method that returns one", async (_label, view) => {
    stub({
      "/api/models": [jsonResponse({ models: [SEED, view] }), jsonResponse(view, 201)],
      [ENCODED]: () => jsonResponse(view),
      "/api/models/probe?id=m2": () => jsonResponse(view),
    });
    const client = createApiClient();

    expectRequestFailure(await captureApiError(client.listModels()), 200);
    expectRequestFailure(await captureApiError(client.createModel({ id: "m2" })), 201);
    const put = { name: "x", reasoning: false, vision: false, maxTokens: 1, upstream: null };
    expectRequestFailure(await captureApiError(client.updateModel(M2.id, put)), 200);
    expectRequestFailure(await captureApiError(client.probeModel("m2")), 200);
  });

  it.each([
    ["an extra key", { models: [SEED], total: 1 }],
    ["no models key", { items: [SEED] }],
    ["a non-array models", { models: SEED }],
  ])("a list body with %s is request_failed", async (_label, body) => {
    stub({ "/api/models": () => jsonResponse(body) });

    expectRequestFailure(await captureApiError(createApiClient().listModels()), 200);
  });

  it("accepts every effort in ascending order and a probe with a zero time", async () => {
    const full: ModelView = {
      ...M2,
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      probe: { status: "ok", at: 0, message: null },
    };
    stub({ "/api/models": () => jsonResponse({ models: [full] }) });

    await expect(createApiClient().listModels()).resolves.toEqual([full]);
  });
});
