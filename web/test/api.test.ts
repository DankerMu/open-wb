import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/lib/api.js";

const principal = {
  id: "user-1",
  account: "zhangsan",
  role: "member",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureApiError(request: Promise<unknown>): Promise<ApiError> {
  return request.then(
    () => {
      throw new Error("expected the API request to reject");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    },
  );
}

function expectRequestFailure(error: ApiError, status: number) {
  expect(error).toMatchObject({
    status,
    code: "request_failed",
    message: "请求失败，请稍后重试",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client request contract", () => {
  it("uses the session endpoint and same-origin credentials for me", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(principal));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().getMe({ signal: controller.signal })).resolves.toEqual(
      principal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", {
      method: "GET",
      credentials: "same-origin",
      signal: controller.signal,
    });
  });

  it("posts the exact login JSON with same-origin credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(principal));
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().login(
        { account: "  ZhangSan ", password: "demo" },
        { signal: controller.signal },
      ),
    ).resolves.toEqual(principal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: '{"account":"  ZhangSan ","password":"demo"}',
      signal: controller.signal,
    });
  });
});

describe("API client Principal contract", () => {
  it("accepts the exact direct Principal response for me and login", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(principal))
      .mockResolvedValueOnce(jsonResponse(principal));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();

    await expect(client.getMe()).resolves.toEqual(principal);
    await expect(client.login({ account: "zhangsan", password: "demo" })).resolves.toEqual(
      principal,
    );
  });

  it.each([
    ["missing role", { id: "user-1", account: "zhangsan" }],
    ["extra field", { ...principal, displayName: "张三" }],
    ["non-string role", { ...principal, role: 7 }],
    ["null field", { ...principal, role: null }],
    ["array field", { ...principal, role: ["member"] }],
    ["null response", null],
    ["array response", [principal]],
  ])("rejects a $0 Principal response with the stable fallback", async (_label, body) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getMe());

    expectRequestFailure(error, 200);
  });

  it.each([
    ["a missing field", { id: "user-1", account: "zhangsan" }],
    ["an extra field", { ...principal, displayName: "张三" }],
    ["a non-string field", { ...principal, role: 7 }],
  ])("rejects login with $0 using the stable fallback", async (_label, body) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(
      createApiClient().login({ account: "zhangsan", password: "demo" }),
    );

    expectRequestFailure(error, 200);
  });
});

describe("API client error envelope contract", () => {
  it("preserves a valid non-success envelope in ApiError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "account_disabled",
            message: "该账号已停用，请联系管理员",
          },
        },
        403,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(
      createApiClient().login({ account: "wangwu", password: "demo" }),
    );

    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(403);
    expect(error.code).toBe("account_disabled");
    expect(error.message).toBe("该账号已停用，请联系管理员");
  });

  it.each([
    ["a null envelope", jsonResponse(null, 403), 403],
    [
      "an array envelope",
      jsonResponse([{ error: { code: "forbidden", message: "private" } }], 403),
      403,
    ],
    ["a missing error member", jsonResponse({}, 403), 403],
    ["a null nested error", jsonResponse({ error: null }, 403), 403],
    ["an array nested error", jsonResponse({ error: [] }, 403), 403],
    ["a missing code", jsonResponse({ error: { message: "private server message" } }, 403), 403],
    ["a missing message", jsonResponse({ error: { code: "account_disabled" } }, 403), 403],
    [
      "a non-string code",
      jsonResponse({ error: { code: 403, message: "private server message" } }, 403),
      403,
    ],
    [
      "a non-string message",
      jsonResponse({ error: { code: "account_disabled", message: null } }, 403),
      403,
    ],
    [
      "an envelope with an extra outer field",
      jsonResponse(
        {
          error: { code: "account_disabled", message: "private server message" },
          trace: "leaked outer trace",
        },
        403,
      ),
      403,
    ],
    [
      "an envelope with an extra nested field",
      jsonResponse(
        {
          error: {
            code: "account_disabled",
            message: "private server message",
            trace: "leaked nested trace",
          },
        },
        403,
      ),
      403,
    ],
    ["a non-JSON error response", new Response("leaked response body", { status: 500 }), 500],
    ["a malformed successful payload", jsonResponse({ account: "zhangsan" }), 200],
  ])("maps $0 to a stable error without response text", async (_label, response, status) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getMe());

    expectRequestFailure(error, status);
    expect(error.message).not.toContain("leaked");
    expect(error.stack).not.toContain("leaked");
  });

  it("maps a fetch rejection to the stable error without transport details", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("transport secret"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().getMe());

    expect(error.status).toBe(0);
    expect(error.code).toBe("request_failed");
    expect(error.message).toBe("请求失败，请稍后重试");
    expect(error.message).not.toContain("transport secret");
  });
});

describe("API client unauthorized callback", () => {
  it("calls the one callback once for each 401, including a malformed body", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
      )
      .mockResolvedValueOnce(new Response("not JSON", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient({ onUnauthorized });

    const validError = await captureApiError(client.getMe());
    const malformedError = await captureApiError(client.getMe());

    expect(validError).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
    expect(malformedError).toMatchObject({
      status: 401,
      code: "request_failed",
      message: "请求失败，请稍后重试",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("does not call the unauthorized callback for a non-401 response", async () => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
          403,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await captureApiError(createApiClient({ onUnauthorized }).getMe());

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
