/**
 * Issue 1022 (parent task 13.2) `getComposerOptions()` over an injected fetch: the options part of
 * the chat-web scenario 「新输入与两个新方法」 of openspec/changes/s1g-composer-capabilities and the
 * extras of the task's implementation notes. Seam: the real `createApiClient` over a stubbed
 * `fetch`. Oracles: the request and the four invalid responses spelled out by that scenario, the
 * key sets of chat-web 「API 客户端扩展」, and the bodies of session-composer-settings
 * 「输入框选项端点」 (「缺省配置」 and 「封顶、白名单与账号各自的缺省」).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import {
  captureApiError,
  createFetchMock,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

const OPTIONS = "/api/composer/options";
const UNSAFE_INTEGER = 9_007_199_254_740_992;
/** The only model of the default body. */
const MODEL = DEFAULT_COMPOSER_OPTIONS
  .models[0] as (typeof DEFAULT_COMPOSER_OPTIONS.models)[number];
const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The capped three-model body: `m2` cannot reason, `m3` offers a subset of the efforts. */
const CAPPED_OPTIONS = {
  approvalModes: ["always-ask", "write"],
  models: [
    {
      id: "m1",
      name: "通用",
      reasoning: true,
      vision: false,
      efforts: ALL_EFFORTS,
      defaultEffort: "high",
    },
    { id: "m2", name: "m2", reasoning: false, vision: false, efforts: [], defaultEffort: null },
    {
      id: "m3",
      name: "深度",
      reasoning: true,
      vision: true,
      efforts: ["off", "low", "high"],
      defaultEffort: "high",
    },
  ],
  defaults: { approvalMode: "write", modelId: "m3", reasoningEffort: "low" },
  upload: { maxBytes: 1_048_576, maxFiles: 3 },
};

/** Answers every options request with `response`; any other path fails the case. */
function stubOptions(response: Response) {
  const fetchMock = createFetchMock({ [OPTIONS]: () => response });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The default body with its only model, its defaults or its upload limits partly replaced. */
function withModel(patch: object) {
  return { ...DEFAULT_COMPOSER_OPTIONS, models: [{ ...MODEL, ...patch }] };
}

function withDefaults(patch: object) {
  return {
    ...DEFAULT_COMPOSER_OPTIONS,
    defaults: { ...DEFAULT_COMPOSER_OPTIONS.defaults, ...patch },
  };
}

function withUpload(patch: object) {
  return { ...DEFAULT_COMPOSER_OPTIONS, upload: { ...DEFAULT_COMPOSER_OPTIONS.upload, ...patch } };
}

/** `source` without one of its keys. */
function without<T extends object>(source: T, omitted: keyof T) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== omitted));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getComposerOptions request and valid responses", () => {
  it("GETs /api/composer/options without a cache or a body and returns the default body value by value", async () => {
    const controller = new AbortController();
    const fetchMock = stubOptions(jsonResponse(DEFAULT_COMPOSER_OPTIONS));

    const options = await createApiClient().getComposerOptions({ signal: controller.signal });

    expect(options).toEqual({
      approvalModes: ["always-ask", "write", "yolo"],
      models: [
        {
          id: "deepseek-v4.1-flash",
          name: "deepseek-v4.1-flash",
          reasoning: true,
          vision: false,
          efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          defaultEffort: "high",
        },
      ],
      defaults: { approvalMode: "write", modelId: "deepseek-v4.1-flash", reasoningEffort: "high" },
      upload: { maxBytes: 524_288_000, maxFiles: 10 },
    });
    expect(fetchMock.mock.calls).toEqual([
      [
        OPTIONS,
        { method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal },
      ],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("sends no signal key when none is given", async () => {
    const fetchMock = stubOptions(jsonResponse(DEFAULT_COMPOSER_OPTIONS));

    await createApiClient().getComposerOptions();

    expect(fetchMock.mock.calls).toEqual([
      [OPTIONS, { method: "GET", credentials: "same-origin", cache: "no-store" }],
    ]);
  });

  it("returns the capped three-model body: a model without efforts and a null default effort", async () => {
    stubOptions(jsonResponse(CAPPED_OPTIONS));

    const options = await createApiClient().getComposerOptions();

    expect(options).toEqual(CAPPED_OPTIONS);
    expect(options.approvalModes).toEqual(["always-ask", "write"]);
    expect(options.models.map((model) => model.id)).toEqual(["m1", "m2", "m3"]);
    expect(options.models[1]).toEqual({
      id: "m2",
      name: "m2",
      reasoning: false,
      vision: false,
      efforts: [],
      defaultEffort: null,
    });
    expect(options.models[2]?.efforts).toEqual(["off", "low", "high"]);
    expect(options.upload).toEqual({ maxBytes: 1_048_576, maxFiles: 3 });
  });

  it("accepts a default effort outside the default model's efforts (m3 with xhigh)", async () => {
    const body = {
      ...CAPPED_OPTIONS,
      defaults: { approvalMode: "write", modelId: "m3", reasoningEffort: "xhigh" },
    };
    stubOptions(jsonResponse(body));

    const options = await createApiClient().getComposerOptions();

    expect(options).toEqual(body);
    expect(options.defaults).toEqual({
      approvalMode: "write",
      modelId: "m3",
      reasoningEffort: "xhigh",
    });
  });

  it("accepts a null default effort and a single approval mode", async () => {
    const body = {
      ...CAPPED_OPTIONS,
      approvalModes: ["yolo"],
      defaults: { approvalMode: "yolo", modelId: "m2", reasoningEffort: null },
    };
    stubOptions(jsonResponse(body));

    expect(await createApiClient().getComposerOptions()).toEqual(body);
  });
});

describe("getComposerOptions invalid responses", () => {
  it.each<[string, unknown]>([
    // The four of the chat-web scenario.
    ["an empty approvalModes", { ...DEFAULT_COMPOSER_OPTIONS, approvalModes: [] }],
    [
      "a model without defaultEffort",
      { ...DEFAULT_COMPOSER_OPTIONS, models: [without(MODEL, "defaultEffort")] },
    ],
    ["a model whose efforts contain auto", withModel({ efforts: ["off", "auto"] })],
    ["upload.maxFiles 0", withUpload({ maxFiles: 0 })],
    // Top level: exactly four keys.
    ["an extra top-level key", { ...DEFAULT_COMPOSER_OPTIONS, upstream: "private" }],
    ["a missing top-level key", without(DEFAULT_COMPOSER_OPTIONS, "upload")],
    ["a top-level array", [DEFAULT_COMPOSER_OPTIONS]],
    ["a null body", null],
    // approvalModes.
    [
      "a repeated approval mode",
      { ...DEFAULT_COMPOSER_OPTIONS, approvalModes: ["write", "write"] },
    ],
    ["an unknown approval mode", { ...DEFAULT_COMPOSER_OPTIONS, approvalModes: ["write", "auto"] }],
    ["approvalModes that is not an array", { ...DEFAULT_COMPOSER_OPTIONS, approvalModes: "write" }],
    // models.
    ["an empty models", { ...DEFAULT_COMPOSER_OPTIONS, models: [] }],
    ["models that is not an array", { ...DEFAULT_COMPOSER_OPTIONS, models: MODEL }],
    ["a model with an extra key", withModel({ baseUrl: "private" })],
    ["a model with an empty id", withModel({ id: "" })],
    ["a model with an empty name", withModel({ name: "" })],
    ["a model with a non-string name", withModel({ name: 1 })],
    ["a model with a non-boolean reasoning", withModel({ reasoning: "true" })],
    ["a model with a non-boolean vision", withModel({ vision: 0 })],
    ["a model whose efforts is not an array", withModel({ efforts: "high" })],
    ["a model whose efforts contain an unknown name", withModel({ efforts: ["off", "ultra"] })],
    ["a model with defaultEffort auto", withModel({ defaultEffort: "auto" })],
    ["a model without a usable defaultEffort value", withModel({ defaultEffort: 3 })],
    // defaults: exactly three keys.
    ["defaults.reasoningEffort auto", withDefaults({ reasoningEffort: "auto" })],
    ["an unknown defaults.approvalMode", withDefaults({ approvalMode: "auto" })],
    ["an empty defaults.modelId", withDefaults({ modelId: "" })],
    ["a null defaults.modelId", withDefaults({ modelId: null })],
    ["defaults with an extra key", withDefaults({ scene: null })],
    [
      "defaults without a key",
      {
        ...DEFAULT_COMPOSER_OPTIONS,
        defaults: without(DEFAULT_COMPOSER_OPTIONS.defaults, "reasoningEffort"),
      },
    ],
    // upload: exactly two keys, positive safe integers.
    ["upload.maxBytes 0", withUpload({ maxBytes: 0 })],
    ["a negative upload.maxBytes", withUpload({ maxBytes: -1 })],
    ["an unsafe upload.maxBytes", withUpload({ maxBytes: UNSAFE_INTEGER })],
    ["a fractional upload.maxBytes", withUpload({ maxBytes: 1.5 })],
    ["a string upload.maxBytes", withUpload({ maxBytes: "524288000" })],
    ["a negative upload.maxFiles", withUpload({ maxFiles: -1 })],
    ["upload with an extra key", withUpload({ dir: "uploads" })],
    [
      "upload without a key",
      { ...DEFAULT_COMPOSER_OPTIONS, upload: without(DEFAULT_COMPOSER_OPTIONS.upload, "maxFiles") },
    ],
  ])("rejects %s as request_failed without leaking the body", async (_name, body) => {
    stubOptions(jsonResponse(body));

    const error = await captureApiError(createApiClient().getComposerOptions());

    expectRequestFailure(error, 200);
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it("rejects a 201 carrying a valid body", async () => {
    stubOptions(jsonResponse(DEFAULT_COMPOSER_OPTIONS, 201));

    expectRequestFailure(await captureApiError(createApiClient().getComposerOptions()), 201);
  });

  it("rejects a non-JSON 200 without leaking it", async () => {
    stubOptions(new Response("private response body", { status: 200 }));

    const error = await captureApiError(createApiClient().getComposerOptions());

    expectRequestFailure(error, 200);
    expect(error.message).not.toContain("private");
  });
});

describe("getComposerOptions error envelopes", () => {
  it.each(unauthorizedResponseCases())(
    "notifies exactly once for %s 401 response",
    async (kind, response) => {
      const onUnauthorized = vi.fn();
      const { signal } = new AbortController();
      stubOptions(response);

      const error = await captureApiError(
        createApiClient({ onUnauthorized }).getComposerOptions({ signal }),
      );

      expect(error.status).toBe(401);
      expect(error.code).toBe(kind === "a legal" ? "unauthorized" : "request_failed");
      expect(error.message).not.toContain("private");
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledWith(signal);
    },
  );

  it("keeps a non-401 error envelope as its ApiError and does not notify", async () => {
    const onUnauthorized = vi.fn();
    stubOptions(jsonResponse({ error: { code: "internal_error", message: "服务异常" } }, 500));

    const error = await captureApiError(createApiClient({ onUnauthorized }).getComposerOptions());

    expect(error).toMatchObject({ status: 500, code: "internal_error", message: "服务异常" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
