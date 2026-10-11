// files-web「API 客户端扩展」里 `issuePreviewToken` 的部分：「方法与错误码」中它的一行（无 body 的
// `POST …/preview-token`、错误信封与 401 回调），与「地址函数与严格解析」中残缺的令牌响应。
// 只从公共入口 `lib/api.js` 取——`api-files.ts` 的导出只供 `api.ts` 使用（见 chat-module-layout.test.ts）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import {
  captureApiError,
  expectRequestFailure,
  jsonResponse,
  unauthorizedResponseCases,
} from "./support.js";

/** 夹具令牌：长度与真实令牌相同，但不是十六进制（客户端不校验形态）。 */
const TOKEN = "t".repeat(64);
const ISSUED = {
  token: TOKEN,
  base: `https://preview.example.test/w/${TOKEN}/`,
  officeBase: `https://preview.example.test/o/${TOKEN}/`,
  expiresAt: 1_790_000_000_000,
  documentMaxBytes: 52_428_800,
  officeAvailable: false,
};
/** 六键各自的值换成 `patch` 里的；值为 `undefined` 的键在 JSON 里消失。 */
const issuedWith = (patch: Record<string, unknown>) => ({ ...ISSUED, ...patch });

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("issuePreviewToken", () => {
  it("发一次无 body 的 POST，id 编码成单个路径段，返回规格的六键", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ISSUED));
    vi.stubGlobal("fetch", fetchMock);
    const { signal } = new AbortController();

    const issued = await createApiClient().issuePreviewToken("ws/%#?+ 中", { signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws%2F%25%23%3F%2B%20%E4%B8%AD/preview-token",
      { method: "POST", credentials: "same-origin", signal },
    );
    expect(issued).toEqual(ISSUED);
  });

  it("不给 signal 时请求里也没有这个键", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(issuedWith({ officeAvailable: true })));
    vi.stubGlobal("fetch", fetchMock);

    const issued = await createApiClient().issuePreviewToken("workspace-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace-1/preview-token", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(issued.officeAvailable).toBe(true);
  });

  it.each([
    ["缺 base", issuedWith({ base: undefined }), 200],
    ["缺 token", issuedWith({ token: undefined }), 200],
    ["多一键", issuedWith({ extra: 1 }), 200],
    ["token 不是字符串", issuedWith({ token: ["t"] }), 200],
    ["token 为空串", issuedWith({ token: "" }), 200],
    ["base 为空串", issuedWith({ base: "" }), 200],
    ["officeBase 为空串", issuedWith({ officeBase: "" }), 200],
    ["expiresAt 为字符串", issuedWith({ expiresAt: "1790000000000" }), 200],
    ["expiresAt 为小数", issuedWith({ expiresAt: 1.5 }), 200],
    ["documentMaxBytes 为 -1", issuedWith({ documentMaxBytes: -1 }), 200],
    ["officeAvailable 为 0", issuedWith({ officeAvailable: 0 }), 200],
    ["正文为 null", null, 200],
    ["六键齐全但状态是 201", ISSUED, 201],
  ])("残缺响应按失败处理：%s", async (_name, body, status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, status)));

    const error = await captureApiError(createApiClient().issuePreviewToken("workspace-1"));

    expectRequestFailure(error, status);
  });

  it.each([
    [404, "not_found", "工作空间不存在"],
    [400, "bad_request", "请求无效"],
  ])("%i 的错误信封原样保留 status / code / message", async (status, code, message) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code, message } }, status)),
    );

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).issuePreviewToken("workspace-1"),
    );

    expect(error).toMatchObject({ status, code, message });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(unauthorizedResponseCases())("%s 401 恰好通知一次", async (_name, response) => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { signal } = new AbortController();

    const error = await captureApiError(
      createApiClient({ onUnauthorized }).issuePreviewToken("workspace-1", { signal }),
    );

    expect(error.status).toBe(401);
    expect(onUnauthorized.mock.calls).toEqual([[signal]]);
  });

  it("令牌只在返回值里：不写存储，不动地址", async () => {
    // 先换到本用例独有的地址：前面的用例若已把地址改成同一个值，「前后相等」就看不出这一次的改写。
    window.history.replaceState(null, "", "/files?probe=preview-token");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const hrefBefore = window.location.href;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(ISSUED)));

    const issued = await createApiClient().issuePreviewToken("workspace-1");

    expect(issued.token).toBe(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
  });
});
