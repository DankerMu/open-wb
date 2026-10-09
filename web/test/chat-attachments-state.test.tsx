// `useAttachmentsState`（hook 层 + 假 `uploadFile`）：串行队列、移除、限制、清空与迟到结果、恢复。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAttachmentsState } from "../src/features/chat/attachments-state.js";
import type { ApiClient } from "../src/lib/api.js";
import { ApiError, REQUEST_FAILED_MESSAGE } from "../src/lib/api.js";
import { deferred } from "./chat-stream-support.js";

type Props = Parameters<typeof useAttachmentsState>[0];
type Uploaded = Awaited<ReturnType<ApiClient["uploadFile"]>>;
type Call = {
  workspaceId: string;
  name: string;
  signal: AbortSignal;
  onProgress(percent: number): void;
  flight: ReturnType<typeof deferred<Uploaded>>;
};

const W = "1".repeat(32);
const LIMITS = { maxBytes: 1000, maxFiles: 3 };
const TOO_BIG = "文件超过大小上限";
const ITEM = { scopeKey: "A", status: "uploaded", percent: 100, message: null };
const PENDING = { scopeKey: null, status: "pending", percent: 0, path: null, message: null };

function file(name: string, size = 10) {
  return new File([new Uint8Array(size)], name);
}

function fakeClient() {
  const calls: Call[] = [];
  const uploadFile = vi.fn<ApiClient["uploadFile"]>((workspaceId, sent, options) => {
    const flight = deferred<Uploaded>();
    calls.push({
      workspaceId,
      name: sent.name,
      signal: options?.signal as AbortSignal,
      onProgress: options?.onProgress as Call["onProgress"],
      flight,
    });
    return flight.promise;
  });
  return { calls, client: { uploadFile } };
}

function mount(overrides: Partial<Props> = {}) {
  const { calls, client } = fakeClient();
  const initialProps: Props = {
    client,
    scopeKey: "A",
    workspaceId: W,
    upload: LIMITS,
    ...overrides,
  };
  let props = initialProps;
  const hook = renderHook((current: Props) => useAttachmentsState(current), { initialProps });
  const { result } = hook;
  return {
    calls,
    hook,
    accept: (...files: File[]) => act(() => result.current.accept(files)),
    remove: (name: string) =>
      act(() => {
        const item = result.current.items.find((candidate) => candidate.name === name);
        if (!item) throw new Error(`没有标签 ${name}`);
        result.current.remove(item.id);
      }),
    restore: (...args: Parameters<typeof result.current.restore>) =>
      act(() => result.current.restore(...args)),
    rerender(next: Partial<Props>) {
      props = { ...props, ...next };
      hook.rerender(props);
    },
    sent: () => calls.map((call) => call.name),
    shown: () => result.current.items.map((item) => `${item.name} ${item.status} ${item.percent}`),
    notice: () => result.current.notice,
    items: () => result.current.items,
  };
}

function settle(call: Call | undefined, outcome: Uploaded | Error) {
  if (!call) throw new Error("没有这次上传请求");
  return act(async () => {
    if (outcome instanceof Error) call.flight.reject(outcome);
    else call.flight.resolve(outcome);
    await call.flight.promise.catch(() => undefined);
    await Promise.resolve();
  });
}

const done = (name: string, size = 10): Uploaded => ({ path: `uploads/${name}`, name, size });
// 中止的拒绝与网络失败是同一个错误（`api-upload.ts`）。
const aborted = () => new ApiError(0, "request_failed", REQUEST_FAILED_MESSAGE);

/** a 已传完、b 在途、c 排队。 */
async function midQueue(overrides: Partial<Props> = {}) {
  const page = mount(overrides);
  page.accept(file("a.bin"), file("b.bin"), file("c.bin"));
  await settle(page.calls[0], done("a.bin"));
  act(() => page.calls[1]?.onProgress(40));
  expect(page.shown()).toEqual(["a.bin uploaded 100", "b.bin uploading 40", "c.bin uploading 0"]);
  return page;
}

describe("串行上传队列", () => {
  it("三个文件逐个发出：进度写入在途项，落定后才发下一个，响应的名字与路径生效", async () => {
    const { accept, calls, items, sent, shown } = mount();
    accept(file("a.pdf", 10), file("b.png", 20), file("c.zip", 30));
    expect(sent()).toEqual(["a.pdf"]);
    expect(calls[0]?.workspaceId).toBe(W);
    expect(shown()).toEqual(["a.pdf uploading 0", "b.png uploading 0", "c.zip uploading 0"]);

    act(() => calls[0]?.onProgress(50));
    expect(shown()).toEqual(["a.pdf uploading 50", "b.png uploading 0", "c.zip uploading 0"]);
    expect(sent()).toEqual(["a.pdf"]);

    await settle(calls[0], done("a.pdf", 10));
    expect(sent()).toEqual(["a.pdf", "b.png"]);
    await settle(calls[1], { path: "uploads/b (1).png", name: "b (1).png", size: 21 });
    expect(sent()).toEqual(["a.pdf", "b.png", "c.zip"]);
    await settle(calls[2], done("c.zip", 30));

    expect(sent()).toHaveLength(3);
    expect(items()).toEqual([
      { ...ITEM, id: 1, name: "a.pdf", size: 10, path: "uploads/a.pdf" },
      { ...ITEM, id: 2, name: "b (1).png", size: 21, path: "uploads/b (1).png" },
      { ...ITEM, id: 3, name: "c.zip", size: 30, path: "uploads/c.zip" },
    ]);
  });

  it("失败项记下信封文案，队列继续，提示槽不变", async () => {
    const { accept, calls, items, notice, sent } = mount();
    accept(file("a.pdf"), file("b.png"));
    await settle(calls[0], new ApiError(413, "payload_too_large", TOO_BIG));
    expect(items()[0]).toEqual({
      id: 1,
      scopeKey: "A",
      name: "a.pdf",
      size: 10,
      status: "failed",
      percent: 0,
      path: null,
      message: TOO_BIG,
    });
    expect(sent()).toEqual(["a.pdf", "b.png"]);
    expect(notice()).toBeNull();

    await settle(calls[1], new Error("boom"));
    expect(items()[1]).toMatchObject({ status: "failed", message: REQUEST_FAILED_MESSAGE });
  });

  it("三个函数的引用在重渲染与状态变化后不变", async () => {
    const { accept, calls, hook, rerender } = mount();
    const { accept: first, remove, restore } = hook.result.current;
    accept(file("a.pdf"));
    await settle(calls[0], done("a.pdf"));
    rerender({ scopeKey: "B", upload: { maxBytes: 1, maxFiles: 1 } });
    expect(hook.result.current.accept).toBe(first);
    expect(hook.result.current.remove).toBe(remove);
    expect(hook.result.current.restore).toBe(restore);
  });
});

describe("移除", () => {
  it("在途项：signal 被中止，下一个排队项开始，中止的拒绝不产生失败标签", async () => {
    const { accept, calls, remove, sent, shown } = mount();
    accept(file("a.pdf"), file("b.png"));
    remove("a.pdf");
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(sent()).toEqual(["a.pdf", "b.png"]);
    expect(calls[1]?.signal.aborted).toBe(false);
    expect(shown()).toEqual(["b.png uploading 0"]);

    await settle(calls[0], aborted());
    expect(shown()).toEqual(["b.png uploading 0"]);
    expect(sent()).toHaveLength(2);
  });

  it("排队项：该文件从未被发出，在途项不受影响", async () => {
    const { accept, calls, remove, sent, shown } = mount();
    accept(file("a.pdf"), file("b.png"), file("c.zip"));
    remove("b.png");
    expect(calls[0]?.signal.aborted).toBe(false);
    await settle(calls[0], done("a.pdf"));
    expect(sent()).toEqual(["a.pdf", "c.zip"]);
    expect(shown()).toEqual(["a.pdf uploaded 100", "c.zip uploading 0"]);
  });

  it("已上传项：不发任何请求，其它标签不变", async () => {
    const { accept, calls, remove, sent, shown } = mount();
    accept(file("a.pdf"), file("b.png"));
    await settle(calls[0], done("a.pdf"));
    await settle(calls[1], done("b.png"));
    remove("a.pdf");
    expect(sent()).toHaveLength(2);
    expect(calls.map((call) => call.signal.aborted)).toEqual([false, false]);
    expect(shown()).toEqual(["b.png uploaded 100"]);
  });
});

describe("数量与大小限制", () => {
  it("已有两个再选两个、上限三个：整批不接受，提示逐字，没有新请求", async () => {
    const { accept, calls, notice, sent, shown } = mount();
    accept(file("a.pdf"), file("b.png"));
    await settle(calls[0], new ApiError(413, "payload_too_large", TOO_BIG));
    await settle(calls[1], done("b.png"));
    expect(sent()).toHaveLength(2);

    // 一个超限也不改变判定次序：个数先判，不出大小提示。
    accept(file("c.zip"), file("big.bin", 1001));
    expect(shown()).toEqual(["a.pdf failed 0", "b.png uploaded 100"]);
    expect(sent()).toHaveLength(2);
    expect(notice()).toBe("每条消息最多 3 个附件");

    // 恰好到上限的一批被接受，提示清掉。
    accept(file("c.zip"));
    expect(shown()).toHaveLength(3);
    expect(notice()).toBeNull();
  });

  it("超过单个大小上限的不接受、其余照常，恰等于上限的被接受", () => {
    const { accept, notice, sent, shown } = mount();
    accept(file("ok.txt", 10), file("big.bin", 1001), file("huge.bin", 2000));
    expect(shown()).toEqual(["ok.txt uploading 0"]);
    expect(sent()).toEqual(["ok.txt"]);
    expect(notice()).toBe("「big.bin」超过大小上限");

    accept(file("edge.bin", 1000));
    expect(shown()).toEqual(["ok.txt uploading 0", "edge.bin uploading 0"]);
    expect(notice()).toBeNull();
  });
});

describe("没有上传目标", () => {
  it("选项未取得、会话的工作空间未知：不接受，提示不变", () => {
    const { accept, notice, rerender, sent, shown } = mount({ upload: null });
    accept(file("a.pdf"));
    rerender({ upload: undefined });
    accept(file("a.pdf"));
    expect([shown(), sent(), notice()]).toEqual([[], [], null]);

    rerender({ upload: LIMITS });
    accept(file("big.bin", 1001));
    expect(notice()).toBe("「big.bin」超过大小上限");
    rerender({ upload: null });
    accept(file("a.pdf"));
    rerender({ upload: LIMITS, workspaceId: undefined });
    accept(file("a.pdf"));
    expect([shown(), sent(), notice()]).toEqual([[], [], "「big.bin」超过大小上限"]);
  });

  it("已选会话没有工作空间：不接受，给出原因", () => {
    const { accept, notice, sent, shown } = mount({ workspaceId: null });
    accept(file("a.pdf"));
    expect([shown(), sent()]).toEqual([[], []]);
    expect(notice()).toBe("此会话没有工作空间，无法上传文件");
  });

  it.each([W, null])("欢迎态（工作空间 %s）：标签为待上传，不发请求", (workspaceId) => {
    const { accept, items, notice, sent } = mount({ scopeKey: null, workspaceId });
    accept(file("a.pdf"), file("b.png", 20));
    expect(sent()).toEqual([]);
    expect(notice()).toBeNull();
    expect(items()).toEqual([
      { ...PENDING, id: 1, name: "a.pdf", size: 10 },
      { ...PENDING, id: 2, name: "b.png", size: 20 },
    ]);
  });
});

describe("清空", () => {
  const leave: [string, (page: Awaited<ReturnType<typeof midQueue>>) => void][] = [
    ["切到另一个会话", (page) => page.rerender({ scopeKey: "B" })],
    ["回到欢迎态", (page) => page.rerender({ scopeKey: null })],
    ["换账号", (page) => page.rerender({ client: fakeClient().client })],
  ];
  const late: [string, () => Uploaded | Error][] = [
    ["成功", () => done("b.bin")],
    ["中止", aborted],
  ];

  describe.each(leave)("%s", (_, go) => {
    it.each(late)(
      "在途的被中止、排队的不发出、标签与提示清空；迟到的%s不改界面",
      async (_n, outcome) => {
        const page = await midQueue();
        page.accept(file("d.bin"));
        expect(page.notice()).toBe("每条消息最多 3 个附件");

        go(page);
        expect(page.calls[1]?.signal.aborted).toBe(true);
        expect(page.calls[0]?.signal.aborted).toBe(false);
        expect(page.sent()).toEqual(["a.bin", "b.bin"]);
        expect(page.items()).toEqual([]);
        expect(page.notice()).toBeNull();

        await settle(page.calls[1], outcome());
        expect(page.sent()).toEqual(["a.bin", "b.bin"]);
        expect(page.items()).toEqual([]);
        expect(page.notice()).toBeNull();
      },
    );
  });

  it.each(late)("卸载：在途的被中止、排队的不发出；迟到的%s不再发请求", async (_n, outcome) => {
    const page = await midQueue();
    page.hook.unmount();
    expect(page.calls[1]?.signal.aborted).toBe(true);
    expect(page.sent()).toEqual(["a.bin", "b.bin"]);
    await settle(page.calls[1], outcome());
    expect(page.sent()).toEqual(["a.bin", "b.bin"]);
  });

  it("切走再切回来：两边都没有标签", async () => {
    const page = await midQueue();
    page.rerender({ scopeKey: "B" });
    expect(page.items()).toEqual([]);
    page.rerender({ scopeKey: "A" });
    expect(page.items()).toEqual([]);
    expect(page.sent()).toEqual(["a.bin", "b.bin"]);
  });

  it("旧请求的落定不释放新会话的在途闩", async () => {
    const page = await midQueue();
    page.rerender({ scopeKey: "B" });
    page.accept(file("d.bin"), file("e.bin"));
    expect(page.sent()).toEqual(["a.bin", "b.bin", "d.bin"]);

    await settle(page.calls[1], aborted());
    expect(page.sent()).toEqual(["a.bin", "b.bin", "d.bin"]);
    expect(page.shown()).toEqual(["d.bin uploading 0", "e.bin uploading 0"]);

    await settle(page.calls[2], done("d.bin"));
    expect(page.sent()).toEqual(["a.bin", "b.bin", "d.bin", "e.bin"]);
  });
});

describe("从 fork / undo 响应恢复", () => {
  it("恢复到尚未选中的会话：当前会话看不到，切过去后恰为已上传的那一项，不发请求", () => {
    const { items, rerender, restore, sent } = mount();
    restore("B", [{ path: "uploads/x/a.pdf", size: 3 }]);
    expect(items()).toEqual([]);

    rerender({ scopeKey: "B" });
    expect(items()).toEqual([
      {
        id: 1,
        scopeKey: "B",
        name: "a.pdf",
        size: 3,
        status: "uploaded",
        percent: 100,
        path: "uploads/x/a.pdf",
        message: null,
      },
    ]);
    expect(sent()).toEqual([]);
  });

  it("该会话已有标签：被覆盖，在途的被中止、排队的不发出，提示清掉", async () => {
    const page = await midQueue();
    page.accept(file("d.bin"));
    expect(page.notice()).not.toBeNull();

    page.restore("A", [
      { path: "top.txt", size: 1 },
      { path: "uploads/z.png", size: 2 },
    ]);
    expect(page.calls[1]?.signal.aborted).toBe(true);
    expect(page.shown()).toEqual(["top.txt uploaded 100", "z.png uploaded 100"]);
    expect(page.notice()).toBeNull();

    await settle(page.calls[1], aborted());
    expect(page.sent()).toEqual(["a.bin", "b.bin"]);
    expect(page.shown()).toEqual(["top.txt uploaded 100", "z.png uploaded 100"]);
  });

  it("恢复别的会话不动当前会话的标签与在途上传", async () => {
    const page = await midQueue();
    page.restore("B", [{ path: "uploads/a.pdf", size: 3 }]);
    expect(page.calls[1]?.signal.aborted).toBe(false);
    expect(page.shown()).toEqual(["a.bin uploaded 100", "b.bin uploading 40", "c.bin uploading 0"]);
  });
});
