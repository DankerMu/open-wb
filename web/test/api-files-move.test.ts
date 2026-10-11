// files-web「API 客户端扩展」里 `moveEntry` 的部分：「方法与错误码」中它的一行（`POST …/move` 加 JSON
// `{from,to}`、错误信封与 401 回调），与「地址函数与严格解析」中响应为 `{}` 的残缺响应。
// 只从公共入口 `lib/api.js` 取——`api-files.ts` 的导出只供 `api.ts` 使用（见 chat-module-layout.test.ts）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("moveEntry", () => {
  it("发一次 POST …/move，id 编码成单个路径段，body 恰为 {from,to}，返回 {path}", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ path: "out/b.md" }));
    vi.stubGlobal("fetch", fetchMock);
    const { signal } = new AbortController();

    const moved = await createApiClient().moveEntry(
      "ws/%#?+ 中",
      { from: "a.md", to: "out/b.md" },
      { signal },
    );

    // 逐键严格相等：`toHaveBeenCalledWith` 会放过多出来的 `undefined` 键。
    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/move",
        {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: '{"from":"a.md","to":"out/b.md"}',
          signal,
        },
      ],
    ]);
    expect(moved).toStrictEqual({ path: "out/b.md" });
  });

  it("路径是数据：不裁剪、不规范化，多带的键不发出；不给 signal 时请求里也没有这个键", async () => {
    // 返回的 path 故意与 to 不同：客户端不比对，原样交回服务端的值。
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ path: "服务端说的" }));
    vi.stubGlobal("fetch", fetchMock);
    // 前导 `/`、中间的 `..` 段、尾部空格都原样发出；é 两种写法并排：已合成的 `\u00e9`（NFD 会拆开它）
    // 与未合成的 `e\u0301`（NFC 会并掉它），所以两个方向的 `normalize` 都看得出。
    const input = { from: "/x/../a 报告/\u00e9e\u0301 ", to: "/b/../\u00e9e\u0301 ", extra: 1 };

    const moved = await createApiClient().moveEntry("workspace-1", input);

    expect(fetchMock.mock.calls).toStrictEqual([
      [
        "/api/workspaces/workspace-1/move",
        {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: '{"from":"/x/../a 报告/\u00e9e\u0301 ","to":"/b/../\u00e9e\u0301 "}',
        },
      ],
    ]);
    expect(moved).toStrictEqual({ path: "服务端说的" });
  });

  it.each([
    ["{}", {}],
    ["path 不是字符串", { path: 1 }],
    ["多一键", { path: "x", extra: 1 }],
    ["正文为 null", null],
  ])("残缺响应按失败处理：%s", async (_name, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

    const error = await captureApiError(
      createApiClient().moveEntry("workspace-1", { from: "a", to: "b" }),
    );

    expectRequestFailure(error, 200);
  });

  it("成功码只认 200：形状正确的 201 也按失败处理", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ path: "b" }, 201)));

    const error = await captureApiError(
      createApiClient().moveEntry("workspace-1", { from: "a", to: "b" }),
    );

    expectRequestFailure(error, 201);
  });

  it.each([
    [409, "conflict", "目标已存在"],
    [403, "sandbox_denied", "路径不在工作空间内"],
    [400, "bad_request", "请求无效"],
    [404, "not_found", "工作空间不存在"],
  ])("%i 的错误信封原样保留 status / code / message", async (status, code, message) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code, message } }, status)),
    );

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).moveEntry("workspace-1", { from: "a", to: "b" }),
    );

    expect(error).toMatchObject({ status, code, message });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(unauthorizedResponseCases())("%s 401 恰好通知一次", async (_name, response) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { signal } = new AbortController();

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).moveEntry(
        "workspace-1",
        { from: "a", to: "b" },
        { signal },
      ),
    );

    expect(error.status).toBe(401);
    expect(onUnauthorized.mock.calls).toEqual([[signal]]);
  });
});
