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

    // path 是数据：首尾各一个空格、中间的 `..` 段都原样发出；é 两种写法并排：已合成的 `\u00e9`
    // （NFD 会拆开它）与未合成的 `e\u0301`（NFC 会并掉它），所以两个方向的 `normalize` 都看得出。
    const path = " /x/../报告 2026/\u00e9e\u0301 b#1&x.md ";

    await expect(
      createApiClient().deleteEntry("ws/%#?+ 中", path, { signal }),
    ).resolves.toBeUndefined();

    // 逐键严格相等：`toHaveBeenCalledWith` 会放过多出来的 `undefined` 键。没有 body、headers、cache。
    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/entries?path=%20%2Fx%2F..%2F%E6%8A%A5%E5%91%8A%202026%2F%C3%A9e%CC%81%20b%231%26x.md%20",
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

  it("前导 / 不剥掉，原样编码发出", async () => {
    const fetchMock = vi.fn().mockResolvedValue(unreadableResponse(204));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApiClient().deleteEntry("workspace-1", "/x/../a.md"),
    ).resolves.toBeUndefined();

    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/workspace-1/entries?path=%2Fx%2F..%2Fa.md",
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
  ])("%i 的错误信封原样保留 status / code / message，不重发", async (status, code, message) => {
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code, message } }, status));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).deleteEntry("workspace-1", "a.md"),
    );

    expect(error).toMatchObject({ status, code, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("网络失败映射为 status 0 的 request_failed，不重发", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await captureApiError(createApiClient().deleteEntry("workspace-1", "a.md"));

    expectRequestFailure(error, 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
