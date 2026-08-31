import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { captureApiError, expectRequestFailure, jsonResponse, serviceInfo } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ServiceInfo API contract", () => {
  it("gets service information with the exact no-store same-origin request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(serviceInfo));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().getInfo({ signal: controller.signal })).resolves.toEqual(
      serviceInfo,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/info", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it.each([
    ["a missing name", { version: "0.0.0" }],
    ["a missing version", { name: "workbuddy-app-server" }],
    ["an extra field", { ...serviceInfo, source: "private" }],
    ["a non-string name", { ...serviceInfo, name: 3 }],
    ["an empty name", { ...serviceInfo, name: "" }],
    ["a non-string version", { ...serviceInfo, version: 3 }],
    ["a null response", null],
    ["an array response", [serviceInfo]],
    ["a missing patch", { ...serviceInfo, version: "1.2" }],
    ["a v-prefixed version", { ...serviceInfo, version: "v1.2.3" }],
    ["a build-metadata version", { ...serviceInfo, version: "1.2.3+build" }],
    ["an underscore prerelease", { ...serviceInfo, version: "1.2.3-rc_1" }],
  ])("rejects $0 with the stable fallback", async (_label, body) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getInfo());

    expectRequestFailure(error, 200);
  });

  it.each(["0.0.0", "1.2.3", "10.20.30-alpha.1", "1.2.3-A-z.9-"])(
    "accepts the server semver %s",
    async (version) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ...serviceInfo, version }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(createApiClient().getInfo()).resolves.toEqual({ ...serviceInfo, version });
    },
  );

  it.each([201, 204, 205])("rejects the non-info success status %i", async (status) => {
    const response = {
      json: vi.fn().mockResolvedValue(serviceInfo),
      status,
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getInfo());

    expectRequestFailure(error, status);
  });

  it("preserves a legal non-401 envelope message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: "maintenance", message: "服务信息暂不可用" } }, 503),
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getInfo());

    expect(error).toMatchObject({ status: 503, code: "maintenance", message: "服务信息暂不可用" });
  });

  it.each([
    ["a 200 non-JSON response", new Response("private response body", { status: 200 }), 200],
    ["a malformed envelope", jsonResponse({ error: { code: "private" } }, 500), 500],
    ["a non-JSON response", new Response("private response body", { status: 500 }), 500],
    ["a network rejection", new Error("private transport detail"), 0],
  ])("does not leak $0", async (_label, result, status) => {
    const fetchMock = vi.fn().mockImplementation(() => {
      if (result instanceof Error) {
        return Promise.reject(result);
      }

      return Promise.resolve(result);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getInfo());

    expectRequestFailure(error, status);
    expect(error.message).not.toContain("private");
    expect(error.stack).not.toContain("private");
  });
});

describe("logout API contract", () => {
  it("posts logout with no body or content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().logout({ signal: controller.signal })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    });
  });

  it("accepts 204 before attempting to read a forbidden response body", async () => {
    const json = vi.fn(() => {
      throw new Error("204 body must not be read");
    });
    const text = vi.fn(() => {
      throw new Error("204 body must not be read");
    });
    const response = { status: 204, json, text } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(createApiClient().logout()).resolves.toBeUndefined();

    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each([200, 205])("rejects the non-logout success status %i", async (status) => {
    const json = vi.fn().mockResolvedValue({ ignored: true });
    const response = { ok: true, status, json } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await captureApiError(createApiClient().logout());

    expectRequestFailure(error, status);
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a legal non-401 envelope",
      jsonResponse({ error: { code: "forbidden", message: "无权退出" } }, 403),
      403,
    ],
    ["a malformed error", jsonResponse({ error: { code: "private" } }, 500), 500],
    ["a non-JSON error", new Response("private response body", { status: 500 }), 500],
    ["a network rejection", new Error("private transport detail"), 0],
  ])("uses the shared error core for $0", async (_label, response, expectedStatus) => {
    const fetchMock = vi.fn().mockImplementation(() => {
      if (response instanceof Error) {
        return Promise.reject(response);
      }

      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().logout());

    if (expectedStatus === 403) {
      expect(error).toMatchObject({ code: "forbidden", message: "无权退出" });
      return;
    }

    expectRequestFailure(error, expectedStatus);
    expect(error.message).not.toContain("private");
  });
});

describe("info and logout unauthorized callbacks", () => {
  it.each([
    [
      "info",
      (client: ReturnType<typeof createApiClient>, signal: AbortSignal) =>
        client.getInfo({ signal }),
    ],
    [
      "logout",
      (client: ReturnType<typeof createApiClient>, signal: AbortSignal) =>
        client.logout({ signal }),
    ],
  ])("calls the callback exactly once for every %s 401 body class", async (_name, request) => {
    const onUnauthorized = vi.fn();
    const validController = new AbortController();
    const malformedController = new AbortController();
    const nonJsonController = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { code: "unauthorized" } }, 401))
      .mockResolvedValueOnce(new Response("not JSON", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient({ onUnauthorized });

    const validError = await captureApiError(request(client, validController.signal));
    const malformedError = await captureApiError(request(client, malformedController.signal));
    const nonJsonError = await captureApiError(request(client, nonJsonController.signal));

    expect(validError).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
    expectRequestFailure(malformedError, 401);
    expectRequestFailure(nonJsonError, 401);
    expect(onUnauthorized).toHaveBeenCalledTimes(3);
    expect(onUnauthorized).toHaveBeenNthCalledWith(1, validController.signal);
    expect(onUnauthorized).toHaveBeenNthCalledWith(2, malformedController.signal);
    expect(onUnauthorized).toHaveBeenNthCalledWith(3, nonJsonController.signal);
  });
});
