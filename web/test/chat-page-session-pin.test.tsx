import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  A,
  B,
  C,
  chooseEntryAction,
  cleanupSessionMeta,
  crumb,
  entryTitles,
  envelope,
  findList,
  messagesPath,
  mountSessions,
  openEntryMenu,
  openRename,
  openTopbarRename,
  PIN,
  PINNED_AT,
  PINNED_TOAST,
  partition,
  partitionTitles,
  patchOf,
  patchPath,
  patchRequests,
  RENAMED_TOAST,
  REQUEST_FAILED,
  renameDialog,
  type SessionView,
  saveTitle,
  toasts,
  UNPIN,
  view,
} from "./chat-page-session-meta-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const FIRST = "任务一";
const MIDDLE = "任务二";
const LAST = "任务三";
const NEW = "周报整理";
const PINNED_GROUP = "置顶任务";
const CREATED = "f".repeat(32);

/** `任务` 分区里的三条会话，服务端顺序 A、B、C；被操作的是中间的 B。 */
const TASKS = [view(A, FIRST), view(B, MIDDLE), view(C, LAST)];
const PINNED_B = view(B, MIDDLE, { pinnedAt: PINNED_AT });

afterEach(cleanupSessionMeta);

function mountTasks(extra: Parameters<typeof mountSessions>[2], path = "/", strict = false) {
  return mountSessions(path, TASKS, extra, strict);
}

function expectUnpinned(nav: HTMLElement) {
  expect(partition(nav, PINNED_GROUP)).toBeNull();
  expect(partitionTitles(nav, "任务 (3)")).toEqual([FIRST, MIDDLE, LAST]);
}

function expectMiddlePinned(nav: HTMLElement, title = MIDDLE) {
  expect(partitionTitles(nav, PINNED_GROUP)).toEqual([title]);
  expect(partitionTitles(nav, "任务 (2)")).toEqual([FIRST, LAST]);
  expect(entryTitles(nav)).toEqual([title, FIRST, LAST]);
}

describe("置顶与取消置顶 (M8, M9)", () => {
  it.each([
    ["默认渲染", false],
    ["StrictMode", true],
  ] as const)(
    "M8 置顶往返（%s）：PATCH {pinned:true} 后只在 置顶任务、任务 (2)；取消置顶 后回到 任务 (3) 的原位",
    async (_mode, strict) => {
      const { fetchMock } = mountTasks(
        { [patchPath(B)]: [jsonResponse(PINNED_B), jsonResponse(view(B, MIDDLE))] },
        "/",
        strict,
      );
      const nav = await findList(MIDDLE);
      expectUnpinned(nav);
      const lists = calls(fetchMock, "/api/sessions").length;

      await chooseEntryAction(nav, MIDDLE, PIN);
      await waitFor(() => expect(toasts()).toEqual([PINNED_TOAST]));
      expect(patchRequests(fetchMock, B)).toEqual([patchOf('{"pinned":true}')]);
      expectMiddlePinned(nav);
      expect(within(nav).getAllByRole("button", { name: MIDDLE })).toHaveLength(1);

      const { items, menu } = await openEntryMenu(nav, MIDDLE);
      expect(items.map((item) => item.textContent)).toEqual(["重命名", UNPIN]);
      fireEvent.click(within(menu).getByRole("menuitem", { name: UNPIN }));
      await waitFor(() => expect(toasts()).toEqual([PINNED_TOAST, PINNED_TOAST]));
      expect(patchRequests(fetchMock, B)).toEqual([
        patchOf('{"pinned":true}'),
        patchOf('{"pinned":false}'),
      ]);
      expectUnpinned(nav);
      expect(entryTitles(nav)).toEqual([FIRST, MIDDLE, LAST]);
      expect(calls(fetchMock, "/api/sessions")).toHaveLength(lists);
    },
  );

  it("M9 置顶失败：409 信封以 Toast 显示 message，非信封失败为 请求失败，请稍后重试；分区与顺序不变", async () => {
    const { fetchMock } = mountTasks({
      [patchPath(B)]: [envelope(409, "会话状态冲突"), new Response("bad gateway", { status: 502 })],
    });
    const nav = await findList(MIDDLE);

    await chooseEntryAction(nav, MIDDLE, PIN);
    await waitFor(() => expect(toasts()).toEqual(["会话状态冲突"]));
    expectUnpinned(nav);
    expect((await openEntryMenu(nav, MIDDLE)).items.map((item) => item.textContent)).toEqual([
      "重命名",
      PIN,
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: PIN }));
    await waitFor(() => expect(toasts()).toEqual(["会话状态冲突", REQUEST_FAILED]));
    expectUnpinned(nav);
    expect(patchRequests(fetchMock, B)).toEqual([
      patchOf('{"pinned":true}'),
      patchOf('{"pinned":true}'),
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("只信响应 (M10)", () => {
  it("M10 重命名：响应前条目与顶栏不变；响应的 title 与输入不同时显示响应的标题", async () => {
    const patch = deferredResponse();
    mountTasks({ [patchPath(B)]: () => patch.promise }, `/?session=${B}`);
    const nav = await findList(MIDDLE);
    await crumb(MIDDLE);

    saveTitle(await openRename(nav, MIDDLE), "我键入的名字");
    expect(entryTitles(nav)).toEqual([FIRST, MIDDLE, LAST]);
    expect(await crumb(MIDDLE)).toBeTruthy();
    expect(toasts()).toEqual([]);

    await settleDeferredResponse(patch, jsonResponse(view(B, "服务端改写的名字")));
    await waitFor(() => expect(renameDialog()).toBeNull());
    expect(entryTitles(nav)).toEqual([FIRST, "服务端改写的名字", LAST]);
    expect(await crumb("服务端改写的名字")).toBeTruthy();
    expect(nav.textContent).not.toContain("我键入的名字");
    expect(toasts()).toEqual([RENAMED_TOAST]);
  });

  it("M10 置顶：响应前条目不动；响应的 pinnedAt 为 null 时条目留在 任务", async () => {
    const patch = deferredResponse();
    const { fetchMock } = mountTasks({ [patchPath(B)]: () => patch.promise });
    const nav = await findList(MIDDLE);

    await chooseEntryAction(nav, MIDDLE, PIN);
    expect(patchRequests(fetchMock, B)).toEqual([patchOf('{"pinned":true}')]);
    expectUnpinned(nav);
    expect(toasts()).toEqual([]);

    await settleDeferredResponse(patch, jsonResponse(view(B, MIDDLE)));
    expect(toasts()).toEqual([PINNED_TOAST]);
    expectUnpinned(nav);
  });
});

describe("迟到与乱序的元数据响应 (M11, M12)", () => {
  it("M11 running 会话置顶请求挂起时列表被重读为 done：迟到的响应（status 仍为 running）只带来置顶，状态仍为 已完成", async () => {
    const patch = deferredResponse();
    const running = view(B, MIDDLE, { status: "running" });
    const created = view(CREATED, "新建的", { status: "idle" });
    let sessions: SessionView[] = [view(A, FIRST), running, view(C, LAST)];
    mountTasks({
      // `新建会话` 触发一次列表重读（page.tsx 的 createAndSelect）；重读时 B 已完成。
      "/api/sessions": (_path, options) => {
        if (options?.method !== "POST") return jsonResponse({ sessions });
        sessions = [created, view(A, FIRST), view(B, MIDDLE), view(C, LAST)];
        return jsonResponse(created, 201);
      },
      [messagesPath(CREATED)]: () => deferredResponse().promise,
      [patchPath(B)]: () => patch.promise,
    });
    const nav = await findList(MIDDLE);
    expect(within(nav).getByRole("status", { name: `${MIDDLE} 运行中` })).toBeTruthy();

    await chooseEntryAction(nav, MIDDLE, PIN);
    fireEvent.click(within(nav).getByRole("button", { name: "新建会话" }));
    await within(nav).findByRole("button", { name: "新建的" });
    expect(within(nav).getByRole("status", { name: `${MIDDLE} 已完成` })).toBeTruthy();
    expect(partition(nav, PINNED_GROUP)).toBeNull();

    await settleDeferredResponse(patch, jsonResponse({ ...running, pinnedAt: PINNED_AT }));
    expect(toasts()).toEqual([PINNED_TOAST]);
    expect(partitionTitles(nav, PINNED_GROUP)).toEqual([MIDDLE]);
    expect(partitionTitles(nav, "任务 (3)")).toEqual(["新建的", FIRST, LAST]);
    expect(within(nav).getByRole("status", { name: `${MIDDLE} 已完成` })).toBeTruthy();
    expect(within(nav).queryByRole("status", { name: `${MIDDLE} 运行中` })).toBeNull();
  });

  it("M12 同类乱序：两次 置顶任务，后发的响应先到并生效；先发的响应（pinnedAt:null）后到被丢弃，只提示一次", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const { fetchMock } = mountTasks({ [patchPath(B)]: [first.promise, second.promise] });
    const nav = await findList(MIDDLE);

    await chooseEntryAction(nav, MIDDLE, PIN);
    // 不乐观更新：第一次响应返回前菜单项仍是 置顶任务。
    await chooseEntryAction(nav, MIDDLE, PIN);
    expect(patchRequests(fetchMock, B)).toEqual([
      patchOf('{"pinned":true}'),
      patchOf('{"pinned":true}'),
    ]);
    expectUnpinned(nav);

    await settleDeferredResponse(second, jsonResponse(PINNED_B));
    expectMiddlePinned(nav);
    expect(toasts()).toEqual([PINNED_TOAST]);

    await settleDeferredResponse(first, jsonResponse(view(B, MIDDLE)));
    await yieldMacrotask();
    expectMiddlePinned(nav);
    expect(toasts()).toEqual([PINNED_TOAST]);
  });

  it("M12 跨类：重命名请求中关闭 Dialog 后置顶；置顶响应先到，重命名响应（pinnedAt:null）后到只改标题", async () => {
    const rename = deferredResponse();
    const pin = deferredResponse();
    const { fetchMock } = mountTasks({ [patchPath(B)]: [rename.promise, pin.promise] });
    const nav = await findList(MIDDLE);

    const controls = await openRename(nav, MIDDLE);
    saveTitle(controls, NEW);
    fireEvent.click(controls.cancel);
    await waitFor(() => expect(renameDialog()).toBeNull());
    await chooseEntryAction(nav, MIDDLE, PIN);
    expect(patchRequests(fetchMock, B)).toEqual([
      patchOf(`{"title":"${NEW}"}`),
      patchOf('{"pinned":true}'),
    ]);

    await settleDeferredResponse(pin, jsonResponse(PINNED_B));
    expectMiddlePinned(nav);
    expect(toasts()).toEqual([PINNED_TOAST]);

    await settleDeferredResponse(rename, jsonResponse(view(B, NEW)));
    expectMiddlePinned(nav, NEW);
    expect(toasts()).toEqual([PINNED_TOAST, RENAMED_TOAST]);
  });

  it("M12 镜像：置顶请求挂起时顶栏重命名成功；迟到的置顶响应（title 为旧标题）只带来置顶，标题仍为新值", async () => {
    const pin = deferredResponse();
    const { fetchMock } = mountTasks(
      { [patchPath(B)]: [pin.promise, jsonResponse(view(B, NEW))] },
      `/?session=${B}`,
    );
    const nav = await findList(MIDDLE);
    await crumb(MIDDLE);

    await chooseEntryAction(nav, MIDDLE, PIN);
    saveTitle(await openTopbarRename(), NEW);
    await waitFor(() => expect(renameDialog()).toBeNull());
    expect(entryTitles(nav)).toEqual([FIRST, NEW, LAST]);
    expect(await crumb(NEW)).toBeTruthy();
    expect(toasts()).toEqual([RENAMED_TOAST]);
    expect(patchRequests(fetchMock, B)).toEqual([
      patchOf('{"pinned":true}'),
      patchOf(`{"title":"${NEW}"}`),
    ]);

    await settleDeferredResponse(pin, jsonResponse(PINNED_B));
    expectMiddlePinned(nav, NEW);
    expect(await crumb(NEW)).toBeTruthy();
    expect(toasts()).toEqual([RENAMED_TOAST, PINNED_TOAST]);
  });
});

describe("401 交给既有的登录失效处理 (D2)", () => {
  const unauthorized = () =>
    jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401);

  it("D2 置顶收到 401：进入登录页，不以 Toast 显示该失败", async () => {
    mountTasks({ [patchPath(B)]: unauthorized });
    const nav = await findList(MIDDLE);

    await chooseEntryAction(nav, MIDDLE, PIN);
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await yieldMacrotask();
    expect(toasts()).toEqual([]);
  });

  it("D2 重命名请求中关闭 Dialog 后收到 401：进入登录页，不以 Toast 显示该失败", async () => {
    const patch = deferredResponse();
    mountTasks({ [patchPath(B)]: () => patch.promise });
    const nav = await findList(MIDDLE);
    const controls = await openRename(nav, MIDDLE);
    saveTitle(controls, NEW);
    fireEvent.click(controls.cancel);
    await waitFor(() => expect(renameDialog()).toBeNull());

    await settleDeferredResponse(patch, unauthorized());
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await yieldMacrotask();
    expect(toasts()).toEqual([]);
  });
});

// M15 放在本文件而不是 rename-pin 文件：`topbar-actions.js` 在实现前不存在，而 Vite 在转换期解析
// import() 的字面量说明符，解析失败会让所在文件整体无法收集。M16 的保持项（实现前即绿）在另一个
// 文件里，不受影响。
describe("CHAT_TOPBAR_ACTIONS (M15)", () => {
  it("M15 槽位次序、标签、图标固定；builder 按常量次序产出，expanded 透传，未给的槽位不出现", async () => {
    const { CHAT_TOPBAR_ACTIONS, chatTopbarActions } = await import(
      "../src/features/chat/topbar-actions.js"
    );
    expect(CHAT_TOPBAR_ACTIONS).toEqual([
      { icon: "pencil", key: "rename", label: "重命名" },
      { icon: "search", key: "search", label: "对话内搜索" },
      { icon: "package", key: "artifacts", label: "产物面板" },
    ]);

    const rename = vi.fn();
    const artifacts = vi.fn();
    // 入参键序与常量次序相反：产出次序必须跟常量走。
    const built = chatTopbarActions({
      artifacts: { expanded: true, onSelect: artifacts },
      rename: { onSelect: rename },
    });
    expect(built.map(({ expanded, icon, key, label }) => ({ expanded, icon, key, label }))).toEqual(
      [
        { expanded: undefined, icon: "pencil", key: "rename", label: "重命名" },
        { expanded: true, icon: "package", key: "artifacts", label: "产物面板" },
      ],
    );
    const trigger = document.createElement("button");
    built[0]?.onSelect(trigger);
    expect(rename.mock.calls).toEqual([[trigger]]);
    expect(artifacts).not.toHaveBeenCalled();
    built[1]?.onSelect(trigger);
    expect(artifacts.mock.calls).toEqual([[trigger]]);

    expect(chatTopbarActions({})).toEqual([]);
    const search = chatTopbarActions({ search: { expanded: false, onSelect: vi.fn() } });
    expect(search.map(({ expanded, key }) => [key, expanded])).toEqual([["search", false]]);
  });
});
