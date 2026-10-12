// file-previewers「隔离来源的嵌入与令牌」里 hook 一级的部分：场景「共用与续期」与「签发失败」，以及
// 第四参数 `attempt`（宿主在刷新或再点同一行时让它变化）下的重新签发判据（T11）。
// 整页的「两个 html 加一个 pdf 合计恰一次签发」、iframe 是否重载、界面可见文本归 frame 的测试。
// 假定时器先于 `renderHook` 装好；一律用 `advance` 推进后同步断言，不用 `waitFor` / `findBy`。
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewToken } from "../src/features/files/use-preview-token.js";
import { ApiError, createApiClient, REQUEST_FAILED_MESSAGE } from "../src/lib/api.js";
import { deferredResponse, jsonResponse } from "./support.js";

type Client = Parameters<typeof usePreviewToken>[0];
type Issued = Awaited<ReturnType<Client["issuePreviewToken"]>>;
type Props = { client: Client; workspaceId: string | null; needed: boolean; attempt: number };

const MINUTE = 60_000;
/** 夹具令牌：长度与真实令牌相同，但不是十六进制。 */
const TOKEN = "t".repeat(64);
const READY = {
  status: "ready",
  base: `https://preview.example.test/w/${TOKEN}/`,
  officeBase: `https://preview.example.test/o/${TOKEN}/`,
  documentMaxBytes: 1_000,
  officeAvailable: true,
};
/** 签发端点的六键响应；`expiresAt` 任意，hook 不读它。 */
const issued = (patch: Partial<Issued> = {}): Issued => ({
  token: TOKEN,
  base: READY.base,
  officeBase: READY.officeBase,
  expiresAt: 7,
  documentMaxBytes: READY.documentMaxBytes,
  officeAvailable: READY.officeAvailable,
  ...patch,
});
const LOADING = { status: "loading" };
const CALL = ["ws-1", { signal: expect.any(AbortSignal) }];

function stubClient() {
  return { issuePreviewToken: vi.fn<Client["issuePreviewToken"]>() };
}

function pending() {
  let resolve!: (value: Issued) => void;
  const promise = new Promise<Issued>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** `frames` 记下每一次渲染的返回值：换空间那一次渲染本身给出什么，只有这里看得见。 */
function mount(client: Client, workspaceId: string | null = "ws-1", needed = true) {
  const frames: unknown[] = [];
  const hook = renderHook(
    (props: Props) => {
      const value = usePreviewToken(props.client, props.workspaceId, props.needed, props.attempt);
      frames.push(value);
      return value;
    },
    { initialProps: { client, workspaceId, needed, attempt: 0 } },
  );
  return { ...hook, frames };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const signalOf = (client: ReturnType<typeof stubClient>, call: number) =>
  client.issuePreviewToken.mock.calls[call]?.[1]?.signal;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("usePreviewToken", () => {
  it("T1 共用与续期：合计恰一次签发，需要期间每 5 分钟续期一次，不需要时不续期", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(issued());
    const { result, rerender } = mount(client, "ws-1", false);
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([]);
    expect(result.current).toStrictEqual({ status: "idle" });

    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL]);
    expect(result.current).toStrictEqual(READY);

    // 同一工作空间里换一个需要令牌的预览：宿主只是重渲染。
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL]);

    await advance(299_999);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL]);
    await advance(1);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL, CALL]);
    // 第 11 分钟：停留期间恰两次续期。
    await advance(MINUTE);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL, CALL]);

    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    await advance(6 * MINUTE);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL, CALL]);
  });

  it("T2 复用与过期：5 分钟内再需要时不发请求、续期点不后移，过了 5 分钟立即重新签发", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(issued());
    const { frames, result, rerender } = mount(client);
    await advance(11 * MINUTE);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
    const ready = result.current;
    expect(ready).toStrictEqual(READY);

    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    await advance(MINUTE);
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
    expect(result.current).toBe(ready);
    // 上一次签发在第 10 分钟：下一次在第 15 分钟，不是从再需要时起再数 5 分钟。
    await advance(3 * MINUTE - 1);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
    await advance(1);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(4);

    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    await advance(6 * MINUTE);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(4);
    // 同键、同 client 下缓存已过期：再需要的那一次渲染起就是 loading，上一份 ready 一帧也不交出。
    const from = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    expect(client.issuePreviewToken.mock.calls).toHaveLength(5);
    const waiting = frames.length - from;
    expect(waiting).toBeGreaterThan(0);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => LOADING));
    expect(result.current).toStrictEqual(LOADING);
    await advance(0);
    expect(frames.slice(from + waiting)).toStrictEqual([READY]);
    expect(result.current).toStrictEqual(READY);
  });

  it("T2 本地时钟被拨回：不按负的间隔推迟续期，立即重新签发", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(issued());
    const { frames, result, rerender } = mount(client);
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(1);

    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    vi.setSystemTime(Date.now() - 60 * MINUTE);
    const from = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
    // 再需要的那一次渲染起就是 loading：签发时刻落在「未来」的那一份不交出。
    expect(frames.length).toBeGreaterThan(from);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => LOADING));
    expect(result.current).toStrictEqual(LOADING);
  });

  it("T2 时钟拨回后的签发失败：作废的签发时刻不再用来复用，时钟追上后再需要时立即签发", async () => {
    const client = stubClient();
    client.issuePreviewToken
      .mockResolvedValueOnce(issued())
      .mockRejectedValueOnce(new ApiError(500, "internal", "服务器内部错误"))
      .mockResolvedValueOnce(issued());
    const { result, rerender } = mount(client);
    await advance(0);
    const issuedAt = Date.now();
    expect(result.current).toStrictEqual(READY);

    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    vi.setSystemTime(issuedAt - 60 * MINUTE);
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
    expect(result.current).toStrictEqual({ status: "error", message: "服务器内部错误" });

    // 时钟追到「第一次签发 + 1 分钟」：按那一次算还在 5 分钟内，但它在拨回时已作废。
    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    vi.setSystemTime(issuedAt + MINUTE);
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
    expect(result.current).toStrictEqual(LOADING);
    await advance(0);
    expect(result.current).toStrictEqual(READY);
  });

  it("T3 引用稳定：续期返回相同四字段时是同一个对象，base 变了才换新对象", async () => {
    const client = stubClient();
    const moved = `https://preview.example.test/w/${"u".repeat(64)}/`;
    client.issuePreviewToken
      .mockResolvedValueOnce(issued())
      .mockResolvedValueOnce(issued({ expiresAt: 8 }))
      .mockResolvedValueOnce(issued({ base: moved }));
    const { result } = mount(client);
    await advance(0);
    const first = result.current;
    expect(first).toStrictEqual(READY);

    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
    expect(result.current).toBe(first);

    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
    expect(result.current).not.toBe(first);
    expect(result.current).toStrictEqual({ ...READY, base: moved });
  });

  it.each([
    ["base", { base: `https://preview.example.test/w/${"u".repeat(64)}/` }],
    ["officeBase", { officeBase: `https://preview.example.test/o/${"u".repeat(64)}/` }],
    ["documentMaxBytes", { documentMaxBytes: 2_000 }],
    ["officeAvailable", { officeAvailable: false }],
  ] satisfies [string, Partial<Issued>][])(
    "T3 四字段逐一：续期只有 %s 变了，就是带新值的新对象",
    async (_field, patch) => {
      const client = stubClient();
      client.issuePreviewToken.mockResolvedValueOnce(issued()).mockResolvedValueOnce(issued(patch));
      const { result } = mount(client);
      await advance(0);
      const first = result.current;
      expect(first).toStrictEqual(READY);

      await advance(300_000);
      expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
      expect(result.current).not.toBe(first);
      expect(result.current).toStrictEqual({ ...READY, ...patch });
    },
  );

  it("T4 ready 的值恰五键，不带 token 与 expiresAt", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(
      issued({ documentMaxBytes: 52_428_800, officeAvailable: false }),
    );
    const { result } = mount(client);
    expect(result.current).toStrictEqual(LOADING);
    await advance(0);

    expect(result.current).toStrictEqual({
      status: "ready",
      base: `https://preview.example.test/w/${TOKEN}/`,
      officeBase: `https://preview.example.test/o/${TOKEN}/`,
      documentMaxBytes: 52_428_800,
      officeAvailable: false,
    });
  });

  it("T5 卸载：在途的签发被中止，迟到的结果不落地、不再排续期", async () => {
    const client = stubClient();
    const first = pending();
    client.issuePreviewToken.mockReturnValue(first.promise);
    const { result, unmount } = mount(client);
    const signal = signalOf(client, 0);
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
    first.resolve(issued());
    await advance(0);
    expect(result.current).toStrictEqual(LOADING);
    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(1);
  });

  it("T5 卸载：已排好的续期被取消", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(issued());
    const { result, unmount } = mount(client);
    await advance(0);
    expect(result.current).toStrictEqual(READY);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(1);

    unmount();
    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(1);
  });

  it("T6 换空间与换 client：切换的那一次渲染就是 loading，旧请求被中止，旧结果迟到不显示", async () => {
    const client = stubClient();
    const second = pending();
    const third = pending();
    client.issuePreviewToken
      .mockResolvedValueOnce(issued())
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { frames, result, rerender } = mount(client);
    await advance(0);
    expect(result.current).toStrictEqual(READY);

    // 换空间：这次渲染及其后的每一帧都不是 ws-1 的值；缓存不跨空间，立即签发。
    let from = frames.length;
    rerender({ client, workspaceId: "ws-2", needed: true, attempt: 0 });
    expect(frames.length).toBeGreaterThan(from);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => LOADING));
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([
      CALL,
      ["ws-2", { signal: expect.any(AbortSignal) }],
    ]);
    const stale = signalOf(client, 1);
    expect(stale?.aborted).toBe(false);

    rerender({ client, workspaceId: "ws-3", needed: true, attempt: 0 });
    expect(stale?.aborted).toBe(true);
    second.resolve(issued({ base: "https://preview.example.test/w/ws-2/" }));
    await advance(0);
    expect(result.current).toStrictEqual(LOADING);
    third.resolve(issued({ base: "https://preview.example.test/w/ws-3/" }));
    await advance(0);
    expect(result.current).toStrictEqual({
      ...READY,
      base: "https://preview.example.test/w/ws-3/",
    });

    // 换 client（登录纪元变了，工作空间 id 相同）。
    const next = stubClient();
    const fourth = pending();
    next.issuePreviewToken.mockReturnValue(fourth.promise);
    from = frames.length;
    rerender({ client: next, workspaceId: "ws-3", needed: true, attempt: 0 });
    expect(frames.length).toBeGreaterThan(from);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => LOADING));
    expect(next.issuePreviewToken.mock.calls).toStrictEqual([
      ["ws-3", { signal: expect.any(AbortSignal) }],
    ]);
    fourth.resolve(issued({ base: "https://preview.example.test/w/next/" }));
    await advance(0);
    expect(result.current).toStrictEqual({
      ...READY,
      base: "https://preview.example.test/w/next/",
    });
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
  });

  it("T6 换到不需要令牌的空间：切换的那一次渲染就是 idle，不发请求", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(issued());
    const { frames, result, rerender } = mount(client);
    await advance(0);
    expect(result.current).toStrictEqual(READY);

    const from = frames.length;
    rerender({ client, workspaceId: "ws-2", needed: false, attempt: 0 });
    expect(frames.length).toBeGreaterThan(from);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => ({ status: "idle" })));
    rerender({ client, workspaceId: null, needed: true, attempt: 0 });
    expect(result.current).toStrictEqual({ status: "idle" });
    await advance(MINUTE);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(1);

    // 一分钟后回到 ws-1：离开时它的值已丢，回来的那一次渲染不是旧的 ready，且立即重新签发。
    const back = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    expect(frames.length).toBeGreaterThan(back);
    expect(frames.slice(back)).toStrictEqual(frames.slice(back).map(() => LOADING));
    expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
  });

  it("T7 签发失败：信封 message 或安全文案，没有未处理的拒绝，下一拍成功后可用", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const client = stubClient();
      client.issuePreviewToken
        .mockRejectedValueOnce(new ApiError(404, "not_found", "预览未启用"))
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 内部细节"))
        .mockResolvedValueOnce(issued());
      const { result } = mount(client);
      expect(result.current).toStrictEqual(LOADING);
      await advance(0);
      expect(result.current).toStrictEqual({ status: "error", message: "预览未启用" });

      await advance(300_000);
      expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
      expect(result.current).toStrictEqual({ status: "error", message: REQUEST_FAILED_MESSAGE });

      await advance(300_000);
      expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
      expect(result.current).toStrictEqual(READY);

      // Node 在一轮真实的宏任务之后才报未处理的拒绝。
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled.mock.calls).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("T8 401 不显示成失败：保持 loading", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockRejectedValue(new ApiError(401, "unauthorized", "登录已失效"));
    const { frames, result } = mount(client);
    await advance(0);

    expect(client.issuePreviewToken.mock.calls).toHaveLength(1);
    await expect(client.issuePreviewToken.mock.results[0]?.value).rejects.toBeInstanceOf(ApiError);
    expect(result.current).toStrictEqual(LOADING);

    // 节拍不为 401 另开分支：5 分钟后照常再调。
    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
    expect(frames).toStrictEqual(frames.map(() => LOADING));
  });

  it("T9 续期失败：保留上一份 ready 对象，下一拍再调", async () => {
    const client = stubClient();
    client.issuePreviewToken
      .mockResolvedValueOnce(issued())
      .mockRejectedValueOnce(new ApiError(500, "internal", "服务器内部错误"))
      .mockResolvedValueOnce(issued());
    const { result } = mount(client);
    await advance(0);
    const ready = result.current;
    expect(ready).toStrictEqual(READY);

    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(2);
    expect(result.current).toBe(ready);

    await advance(300_000);
    expect(client.issuePreviewToken.mock.calls).toHaveLength(3);
    expect(result.current).toBe(ready);
  });

  it("T11 失败态下 attempt 加一：立即第二次签发并转 ready，不等下一拍", async () => {
    const client = stubClient();
    client.issuePreviewToken
      .mockRejectedValueOnce(new ApiError(500, "internal", "服务器内部错误"))
      .mockResolvedValueOnce(issued());
    const { frames, result, rerender } = mount(client);
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL]);
    expect(result.current).toStrictEqual({ status: "error", message: "服务器内部错误" });

    const from = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 1 });
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
    expect(frames.length).toBeGreaterThan(from);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => LOADING));
    await advance(0);
    expect(result.current).toStrictEqual(READY);
  });

  it("T11 第 2 分钟 attempt 加一：不发请求、仍是同一个 ready，第 5 分钟整才续期", async () => {
    const client = stubClient();
    client.issuePreviewToken.mockResolvedValue(issued());
    const { frames, result, rerender } = mount(client);
    await advance(0);
    const ready = result.current;
    expect(ready).toStrictEqual(READY);

    await advance(2 * MINUTE);
    const from = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 1 });
    await advance(0);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL]);
    expect(frames.length).toBeGreaterThan(from);
    for (const frame of frames.slice(from)) {
      expect(frame).toBe(ready);
    }

    // 续期时刻仍按第 0 分钟那一次签发算，不从 attempt 变化时起再数 5 分钟。
    await advance(3 * MINUTE - 1);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL]);
    await advance(1);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
    await advance(2 * MINUTE);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
  });

  it("T11 续期失败后 attempt 加一：那一帧即 loading 并立即签发，不再交出保留的旧 ready", async () => {
    const client = stubClient();
    const moved = `https://preview.example.test/w/${"u".repeat(64)}/`;
    client.issuePreviewToken
      .mockResolvedValueOnce(issued())
      .mockRejectedValueOnce(new ApiError(500, "internal", "服务器内部错误"))
      .mockResolvedValueOnce(issued({ base: moved }));
    const { frames, result, rerender } = mount(client);
    await advance(0);
    const ready = result.current;
    await advance(5 * MINUTE);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
    expect(result.current).toBe(ready);

    // 第 7 分钟：上一次成功签发在第 0 分钟，已满 5 分钟。
    await advance(2 * MINUTE);
    const from = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 1 });
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL, CALL]);
    expect(frames.length).toBeGreaterThan(from);
    expect(frames.slice(from)).toStrictEqual(frames.slice(from).map(() => LOADING));
    await advance(0);
    expect(result.current).toStrictEqual({ ...READY, base: moved });
  });

  it("T11 在途首签时 attempt 加一：旧 signal 中止，恰两次调用，迟到的第一次结果不落地", async () => {
    const client = stubClient();
    const first = pending();
    const stale = `https://preview.example.test/w/${"s".repeat(64)}/`;
    client.issuePreviewToken.mockReturnValueOnce(first.promise).mockResolvedValueOnce(issued());
    const { result, rerender } = mount(client);
    const signal = signalOf(client, 0);
    expect(signal?.aborted).toBe(false);

    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 1 });
    expect(signal?.aborted).toBe(true);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
    expect(signalOf(client, 1)?.aborted).toBe(false);

    first.resolve(issued({ base: stale }));
    await advance(0);
    expect(result.current).toStrictEqual(READY);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
  });

  it("T11 在途续期期间宿主重渲染：仍是同一个 ready，不另发请求", async () => {
    const client = stubClient();
    const renewal = pending();
    client.issuePreviewToken.mockResolvedValueOnce(issued()).mockReturnValueOnce(renewal.promise);
    const { frames, result, rerender } = mount(client);
    await advance(0);
    const ready = result.current;
    expect(ready).toStrictEqual(READY);
    await advance(5 * MINUTE);
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);

    const from = frames.length;
    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    expect(frames.length).toBeGreaterThan(from);
    for (const frame of frames.slice(from)) {
      expect(frame).toBe(ready);
    }
    expect(client.issuePreviewToken.mock.calls).toStrictEqual([CALL, CALL]);
    expect(signalOf(client, 1)?.aborted).toBe(false);
  });

  it("T10 真实 client：被中止的请求不显示成失败，地址不变，不写存储、地址栏与日志", async () => {
    const first = deferredResponse();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(() => Promise.resolve(jsonResponse(issued())));
    vi.stubGlobal("fetch", fetchMock);
    const spies = [
      vi.spyOn(Storage.prototype, "setItem"),
      vi.spyOn(window.history, "pushState"),
      vi.spyOn(window.history, "replaceState"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "debug"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const href = window.location.href;
    const client = createApiClient();

    const { frames, result, rerender } = mount(client);
    expect(fetchMock.mock.calls).toHaveLength(1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    rerender({ client, workspaceId: "ws-1", needed: false, attempt: 0 });
    expect(signal?.aborted).toBe(true);
    first.reject(new DOMException("The operation was aborted.", "AbortError"));
    await advance(300_000);
    expect(fetchMock.mock.calls).toHaveLength(1);

    rerender({ client, workspaceId: "ws-1", needed: true, attempt: 0 });
    await advance(0);
    expect(result.current).toStrictEqual(READY);
    await advance(300_000);
    expect(result.current).toStrictEqual(READY);

    expect(fetchMock.mock.calls.map(([address]) => address)).toStrictEqual([
      "/api/workspaces/ws-1/preview-token",
      "/api/workspaces/ws-1/preview-token",
      "/api/workspaces/ws-1/preview-token",
    ]);
    expect(
      frames.filter((frame) => (frame as { status: string }).status === "error"),
    ).toStrictEqual([]);
    expect(spies.map((spy) => spy.mock.calls)).toStrictEqual(spies.map(() => []));
    expect(window.location.href).toBe(href);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });
});
