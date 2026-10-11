// files-web「API 客户端扩展」里 `deleteEntry` 的部分：「方法与错误码」中它的一行（`DELETE …/entries?path=`、
// 无 body、204 为成功、错误信封与 401 回调）。
// 只从公共入口 `lib/api.js` 取——`api-files.ts` 的导出只供 `api.ts` 使用（见 chat-module-layout.test.ts）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

/** 一个读正文就抛错的响应：204 没有正文，客户端不该去读。 */
function unreadableResponse(status: number) {
  const unreadable = () => {
    throw new Error("response body must not be read");
  };
  return { status, json: vi.fn(unreadable), text: vi.fn(unreadable) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deleteEntry", () => {
  it("发一次无 body 的 DELETE …/entries?path=，id 与 path 都编码，204 不读正文即成功", async () => {
    const response = unreadableResponse(204);
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { signal } = new AbortController();

    await expect(
      createApiClient().deleteEntry("ws/%#?+ 中", "报告 2026/a b#1&x.md", { signal }),
    ).resolves.toBeUndefined();

    // 逐键严格相等：`toHaveBeenCalledWith` 会放过多出来的 `undefined` 键。没有 body、headers、cache。
    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/entries?path=%E6%8A%A5%E5%91%8A%202026%2Fa%20b%231%26x.md",
        { method: "DELETE", credentials: "same-origin", signal },
      ],
    ]);
    expect(response.json).not.toHaveBeenCalled();
    expect(response.text).not.toHaveBeenCalled();
  });

  it("空串 path 不预检，原样发出 …?path=；不给 signal 时请求里也没有这个键", async () => {
    const fetchMock = vi.fn().mockResolvedValue(unreadableResponse(204));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().deleteEntry("workspace-1", "")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/workspace-1/entries?path=",
        { method: "DELETE", credentials: "same-origin" },
      ],
    ]);
  });

  it("成功码只认 204：200 按失败处理", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 200)));

    const error = await captureApiError(createApiClient().deleteEntry("workspace-1", "a.md"));

    expectRequestFailure(error, 200);
  });

  it.each([
    [403, "sandbox_denied", "路径不在工作空间内"],
    [404, "not_found", "工作空间不存在"],
    [400, "bad_request", "请求无效"],
    [500, "internal_error", "服务器内部错误"],
  ])("%i 的错误信封原样保留 status / code / message", async (status, code, message) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code, message } }, status)),
    );

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).deleteEntry("workspace-1", "a.md"),
    );

    expect(error).toMatchObject({ status, code, message });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(unauthorizedResponseCases())("%s 401 恰好通知一次", async (kind, response) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { signal } = new AbortController();

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).deleteEntry("workspace-1", "a.md", { signal }),
    );

    if (kind === "a legal") {
      expect(error).toMatchObject({ status: 401, code: "unauthorized", message: "登录已失效" });
    } else {
      expectRequestFailure(error, 401);
    }
    expect(onUnauthorized.mock.calls).toEqual([[signal]]);
  });

  it("网络失败映射为 status 0 的 request_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const error = await captureApiError(createApiClient().deleteEntry("workspace-1", "a.md"));

    expectRequestFailure(error, 0);
  });
});
