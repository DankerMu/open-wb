// 会话列表区整页测试：session-sidebar「分组侧栏」八个场景、「标题搜索」的「过滤与恢复」「不影响主区」、
// spa-shell「列表区承载重建后的会话列表」。`已归档` 入口归任务 16.1，这里不断言它。
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { cleanupChatLifecycle, settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { typeAndSend } from "./chat-page-ownership-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, settle } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const EMPTY = "没有匹配的任务";
const PINNED = "置顶任务";
const TEMPORARY = "临时空间";
const UNKNOWN = "未知空间";
const SEARCH = "搜索任务";
const GROUPING = "分组方式";
const BY_WORKSPACE = "按工作空间";
const BY_TIME = "按时间";
const GROUPING_KEY = "workbuddy-session-grouping";
const COLLAPSED_KEY = "workbuddy-session-collapsed";
const ANSWER = "这是回答正文";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const E = "e".repeat(32);
const F = "f".repeat(32);
const G = "9".repeat(32);
const W1 = "1".repeat(32);
const W2 = "2".repeat(32);
const TEMP_SPACE = "3".repeat(32);

// 只伪造 Date：Radix 的焦点与外点处理依赖真实计时器。时间戳用本地时间构造器生成，与时区无关。
const NOW = new Date(2026, 4, 20, 12, 0, 0);
const daysAgo = (days: number) => new Date(2026, 4, 20 - days, 9, 0, 0).getTime();
const PINNED_AT = daysAgo(1);

type Meta = {
  archivedAt?: number | null;
  pinnedAt?: number | null;
  temporaryWorkspace?: boolean;
  updatedAt?: number;
  workspaceId?: string | null;
};
type Listed = ReturnType<typeof listed>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

// 菜单与覆盖层的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 mock 与 DOM。
afterEach(async () => {
  cleanupChatLifecycle();
  uninstallMatchMedia();
  await yieldMacrotask();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function listed(id: string, title: string | null, meta: Meta = {}) {
  return {
    id,
    title,
    status: "done" as const,
    createdAt: daysAgo(40),
    updatedAt: daysAgo(0),
    ...NULL_SESSION_META,
    ...meta,
  };
}

function workspace(id: string, name: string) {
  return { id, name, dir: name, root: `/srv/${id}`, createdAt: daysAgo(40) };
}

function workspaceList(...workspaces: ReturnType<typeof workspace>[]) {
  return jsonResponse({ workspaces });
}

const TWO_SPACES = () => workspaceList(workspace(W2, "W2"), workspace(W1, "W1"));

function routes(
  sessions: readonly Listed[],
  workspaces: FetchRoutes[string] = TWO_SPACES,
  extra: FetchRoutes = {},
): FetchRoutes {
  return {
    "/api/sessions": () => jsonResponse({ sessions }),
    "/api/workspaces": workspaces,
    ...extra,
  };
}

/** 「按工作空间分组」的夹具：服务端顺序 F、E、D、C、B、A。 */
const SPEC_LIST = [
  listed(F, "会话F", { archivedAt: daysAgo(2), workspaceId: W1 }),
  listed(E, "会话E"),
  listed(D, "会话D", { temporaryWorkspace: true, workspaceId: TEMP_SPACE }),
  listed(C, "会话C", { workspaceId: W2 }),
  listed(B, "会话B", { workspaceId: W1 }),
  listed(A, "会话A", { pinnedAt: PINNED_AT, workspaceId: W1 }),
];

/** 列表区 nav；`title` 给出时等到该会话条目出现。 */
async function findList(title?: string) {
  const nav = await screen.findByRole("navigation", { name: "会话列表" });
  if (title !== undefined) await within(nav).findByRole("button", { name: title });
  return nav;
}

/** 选择按钮的标题，按文档顺序。 */
function titles(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll('[data-slot="session-select"]'), (button) =>
    button.getAttribute("aria-label"),
  );
}

function group(nav: HTMLElement, name: string) {
  return within(nav).getByRole("group", { name });
}

/** 全部分组的 accessible name（`aria-labelledby` 指向的标签按钮文本），按文档顺序。 */
function groupNames(nav: HTMLElement) {
  return within(nav)
    .queryAllByRole("group")
    .map(
      (item) => document.getElementById(item.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
}

/** 分组的标签按钮：组内与组同名的那个按钮。 */
function header(nav: HTMLElement, name: string) {
  return within(group(nav, name)).getByRole("button", { name });
}

function expanded(nav: HTMLElement, name: string) {
  return header(nav, name).getAttribute("aria-expanded");
}

function searchBox(nav: HTMLElement) {
  return within(nav).getByRole<HTMLInputElement>("searchbox", { name: SEARCH });
}

function search(nav: HTMLElement, query: string) {
  fireEvent.change(searchBox(nav), { target: { value: query } });
}

function groupingTrigger(nav: HTMLElement) {
  return within(nav).getByRole("button", { name: GROUPING });
}

/** 左键 pointerdown 打开 `分组方式` 菜单（Radix DropdownMenu 不认 click）。 */
async function openGrouping(nav: HTMLElement) {
  fireEvent.pointerDown(groupingTrigger(nav), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  return { items: within(menu).getAllByRole("menuitemradio"), menu };
}

async function chooseGrouping(nav: HTMLElement, name: string) {
  const { menu } = await openGrouping(nav);
  fireEvent.click(within(menu).getByRole("menuitemradio", { name }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

function storedCollapsed(): unknown {
  return JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "null");
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** 「刷新」：卸载整页再挂载，`localStorage` 原样保留。 */
function reload(path: string, next: FetchRoutes) {
  cleanupChatLifecycle();
  return renderChatPage(path, next);
}

describe("分组侧栏 (session-sidebar)", () => {
  it("按工作空间分组：置顶任务 → 空间列表顺序 → 临时空间，置顶不重复、已归档不出现、没有 筛选任务", async () => {
    renderChatPage("/", routes(SPEC_LIST));
    const nav = await findList("会话A");
    await within(nav).findByRole("group", { name: "W2" });

    expect(groupNames(nav)).toEqual([PINNED, "W2", "W1", TEMPORARY]);
    expect(titles(group(nav, PINNED))).toEqual(["会话A"]);
    expect(titles(group(nav, "W2"))).toEqual(["会话C"]);
    expect(titles(group(nav, "W1"))).toEqual(["会话B"]);
    expect(titles(group(nav, TEMPORARY))).toEqual(["会话E", "会话D"]);
    expect(titles(nav)).toEqual(["会话A", "会话C", "会话B", "会话E", "会话D"]);
    for (const title of ["会话A", "会话B", "会话C", "会话D", "会话E"]) {
      expect(within(nav).getAllByRole("button", { name: title })).toHaveLength(1);
    }
    expect(within(nav).queryByRole("button", { name: "会话F" })).toBeNull();
    expect(nav.textContent).not.toContain("会话F");
    for (const name of [PINNED, "W2", "W1", TEMPORARY]) expect(expanded(nav, name)).toBe("true");
    expect(screen.queryByRole("button", { name: "筛选任务" })).toBeNull();
    expect(document.body.textContent).not.toContain("筛选任务");
    // 工作空间名只取自列表：根路径与临时空间的 id 都不渲染。
    for (const id of [W1, W2, TEMP_SPACE]) expect(nav.textContent).not.toContain(id);
  });

  it("折叠与记忆：点击标签按钮折叠并写入存储，刷新后仍折叠，再点击展开并从存储移除，全程不发请求", async () => {
    const { fetchMock } = renderChatPage("/", routes(SPEC_LIST));
    const nav = await findList("会话B");
    await within(nav).findByRole("group", { name: "W1" });
    await act(settle);
    const requests = fetchMock.mock.calls.length;

    fireEvent.click(header(nav, "W1"));
    expect(expanded(nav, "W1")).toBe("false");
    expect(within(nav).queryByRole("button", { name: "会话B" })).toBeNull();
    expect(titles(group(nav, "W1"))).toEqual([]);
    expect(groupNames(nav)).toEqual([PINNED, "W2", "W1", TEMPORARY]);
    for (const name of [PINNED, "W2", TEMPORARY]) expect(expanded(nav, name)).toBe("true");
    expect(titles(nav)).toEqual(["会话A", "会话C", "会话E", "会话D"]);
    expect(storedCollapsed()).toEqual([W1]);
    await act(settle);
    expect(fetchMock.mock.calls.length).toBe(requests);

    const reloaded = reload("/", routes(SPEC_LIST));
    const restored = await findList("会话A");
    await within(restored).findByRole("group", { name: "W1" });
    expect(expanded(restored, "W1")).toBe("false");
    expect(titles(restored)).toEqual(["会话A", "会话C", "会话E", "会话D"]);
    await act(settle);
    const afterReload = reloaded.fetchMock.mock.calls.length;

    fireEvent.click(header(restored, "W1"));
    expect(expanded(restored, "W1")).toBe("true");
    expect(titles(group(restored, "W1"))).toEqual(["会话B"]);
    expect(storedCollapsed()).toEqual([]);
    await act(settle);
    expect(reloaded.fetchMock.mock.calls.length).toBe(afterReload);
  });

  it("切换为按时间：置顶任务 → 今天 → 近 7 天 → 更早，当前项 aria-checked，写入存储，焦点回 分组方式，刷新后保持", async () => {
    const sessions = [
      listed(A, "今天的"),
      listed(B, "三天前的", { updatedAt: daysAgo(3), workspaceId: W1 }),
      listed(C, "三十天前的", { updatedAt: daysAgo(30) }),
      listed(D, "置顶的", { pinnedAt: PINNED_AT, updatedAt: daysAgo(30) }),
    ];
    const { fetchMock } = renderChatPage("/", routes(sessions));
    const nav = await findList("今天的");
    await within(nav).findByRole("group", { name: "W1" });
    expect(groupNames(nav)).toEqual([PINNED, "W1", TEMPORARY]);
    await act(settle);
    const requests = fetchMock.mock.calls.length;

    const { items, menu } = await openGrouping(nav);
    expect(items.map((item) => item.textContent)).toEqual([BY_WORKSPACE, BY_TIME]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: BY_TIME }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(groupingTrigger(nav)));

    expect(groupNames(nav)).toEqual([PINNED, "今天", "近 7 天", "更早"]);
    expect(titles(group(nav, PINNED))).toEqual(["置顶的"]);
    expect(titles(group(nav, "今天"))).toEqual(["今天的"]);
    expect(titles(group(nav, "近 7 天"))).toEqual(["三天前的"]);
    expect(titles(group(nav, "更早"))).toEqual(["三十天前的"]);
    expect(window.localStorage.getItem(GROUPING_KEY)).toBe("time");
    await act(settle);
    expect(fetchMock.mock.calls.length).toBe(requests);
    const reopened = await openGrouping(nav);
    expect(reopened.items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
    ]);
    fireEvent.keyDown(reopened.menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    reload("/", routes(sessions));
    const restored = await findList("今天的");
    expect(groupNames(restored)).toEqual([PINNED, "今天", "近 7 天", "更早"]);
  });

  it("未知空间与读取失败：空间读取失败归 未知空间 且列表区无错误提示；重新读取未返回时沿用上一次成功的列表", async () => {
    const bound = [listed(B, "绑定会话", { workspaceId: W1 })];
    renderChatPage(
      "/",
      routes(bound, () =>
        jsonResponse({ error: { code: "internal", message: "空间不可用" } }, 500),
      ),
    );
    const failed = await findList("绑定会话");
    await act(settle);
    expect(groupNames(failed)).toEqual([UNKNOWN]);
    expect(titles(group(failed, UNKNOWN))).toEqual(["绑定会话"]);
    expect(within(failed).queryByRole("alert")).toBeNull();
    expect(failed.textContent).not.toContain("空间不可用");

    // 第二例：首次读取成功，欢迎态首次发送触发列表与空间的重新读取，第二次空间响应挂起。
    const second = deferredResponse();
    const created = listed(C, "新建的", { workspaceId: W1 });
    let current: readonly Listed[] = bound;
    const { fetchMock } = reload(
      "/",
      routes(bound, [workspaceList(workspace(W1, "研发空间")), second.promise], {
        "/api/sessions": (_path, options) => {
          if (options?.method !== "POST") return jsonResponse({ sessions: current });
          current = [created, ...bound];
          return jsonResponse(created, 201);
        },
        [`/api/sessions/${C}/messages`]: () => deferredResponse().promise,
        [`/api/sessions/${C}/prompt`]: () => deferredResponse().promise,
      }),
    );
    const nav = await findList("绑定会话");
    await within(nav).findByRole("group", { name: "研发空间" });
    await typeAndSend("你好");
    await within(nav).findByRole("button", { name: "新建的" });
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/workspaces")).toHaveLength(2);
    expect(groupNames(nav)).toEqual(["研发空间"]);
    expect(titles(group(nav, "研发空间"))).toEqual(["新建的", "绑定会话"]);

    await settleDeferredResponse(
      second,
      jsonResponse({ error: { code: "x", message: "坏了" } }, 500),
    );
    expect(groupNames(nav)).toEqual([UNKNOWN]);
    expect(within(nav).queryByRole("alert")).toBeNull();
  });

  it.each([
    ["账号没有会话", []],
    ["会话全部已归档", [listed(A, "归档甲", { archivedAt: daysAgo(1), pinnedAt: PINNED_AT })]],
  ] as const)("空状态（%s）：只显示 没有匹配的任务，没有分组", async (_case, sessions) => {
    renderChatPage("/", routes(sessions));
    const nav = await findList();

    expect(await within(nav).findByText(EMPTY, { exact: true })).toBeTruthy();
    expect(within(nav).queryAllByRole("group")).toEqual([]);
    expect(titles(nav)).toEqual([]);
    expect(nav.textContent).not.toContain("归档甲");
  });

  it("本地存储不可用：读写都抛错时页面照常，折叠与分组方式在本次页面生命周期内生效", async () => {
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
    const errors = vi.spyOn(console, "error");
    renderChatPage("/", routes(SPEC_LIST));
    const nav = await findList("会话A");
    await within(nav).findByRole("group", { name: "W1" });
    expect(groupNames(nav)).toEqual([PINNED, "W2", "W1", TEMPORARY]);

    fireEvent.click(header(nav, PINNED));
    expect(expanded(nav, PINNED)).toBe("false");
    expect(titles(group(nav, PINNED))).toEqual([]);
    await chooseGrouping(nav, BY_TIME);
    expect(groupNames(nav)).toEqual([PINNED, "今天"]);
    expect(expanded(nav, PINNED)).toBe("false");
    expect(titles(nav)).toEqual(["会话E", "会话D", "会话C", "会话B"]);
    expect(setItem).toHaveBeenCalled();

    // 列表节点卸载再挂载（折叠再展开侧栏）：内存状态仍在。
    const aside = screen.getByRole("complementary", { name: "侧栏" });
    fireEvent.click(within(aside).getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();
    fireEvent.click(within(aside).getByRole("button", { name: "展开侧栏" }));
    const restored = within(aside).getByRole("navigation", { name: "会话列表" });
    expect(groupNames(restored)).toEqual([PINNED, "今天"]);
    expect(expanded(restored, PINNED)).toBe("false");
    expect(errors).not.toHaveBeenCalled();
  });

  it("覆盖层内操作不关闭覆盖层：折叠分组、切换分组方式、搜索都不关 导航；选择会话后关闭", async () => {
    const narrow = createMediaQuery(true);
    const other = createMediaQuery(false);
    installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? narrow : other));
    renderChatPage(
      "/",
      routes(SPEC_LIST, TWO_SPACES, {
        [`/api/sessions/${C}/messages`]: () => deferredResponse().promise,
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" });
    const open = screen.getByRole("button", { name: "打开导航" });
    open.focus();
    fireEvent.click(open);
    const overlay = await screen.findByRole("dialog", { name: "导航" });
    const nav = within(overlay).getByRole("navigation", { name: "会话列表" });
    await within(nav).findByRole("group", { name: "W1" });
    const stillOpen = async () => {
      await yieldMacrotask();
      expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    };

    // 完整指针序列：覆盖层的外点判定监听 document 的 pointerdown，挂载后的 setTimeout(0) 里才注册。
    await yieldMacrotask();
    pressPointer(header(nav, "W1"));
    expect(expanded(nav, "W1")).toBe("false");
    await stillOpen();

    // 菜单项在 portal 里（覆盖层 DOM 之外）。
    const { menu } = await openGrouping(nav);
    await yieldMacrotask();
    pressPointer(within(menu).getByRole("menuitemradio", { name: BY_TIME }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(groupNames(nav)).toEqual([PINNED, "今天"]);
    await stillOpen();

    pressPointer(searchBox(nav));
    search(nav, "会话C");
    expect(titles(nav)).toEqual(["会话C"]);
    await stillOpen();

    fireEvent.click(within(nav).getByRole("button", { name: "会话C" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
    expect(currentLocation()).toBe(`/?session=${C}`);
  });

  it("置顶与取消置顶后的移动：置顶后只在 置顶任务，取消后回到所属分组的服务端顺序位置；按时间 下同理", async () => {
    const g = listed(G, "会话G", { workspaceId: W1 });
    const b = listed(B, "会话B", { updatedAt: daysAgo(3), workspaceId: W1 });
    const pinned = jsonResponse({ ...b, pinnedAt: PINNED_AT });
    renderChatPage(
      "/",
      routes([g, b], TWO_SPACES, {
        [`/api/sessions/${B}`]: [pinned, jsonResponse(b), pinned.clone(), jsonResponse(b)],
      }),
    );
    const nav = await findList("会话B");
    await within(nav).findByRole("group", { name: "W1" });
    const toggle = async (action: string) => {
      const more = within(nav).getByRole("button", { name: "更多操作：会话B" });
      fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(await screen.findByRole("menuitem", { name: action }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    };
    expect(groupNames(nav)).toEqual(["W1"]);
    expect(titles(group(nav, "W1"))).toEqual(["会话G", "会话B"]);

    await toggle("置顶任务");
    await waitFor(() => expect(groupNames(nav)).toEqual([PINNED, "W1"]));
    expect(titles(group(nav, PINNED))).toEqual(["会话B"]);
    expect(titles(group(nav, "W1"))).toEqual(["会话G"]);
    await toggle("取消置顶");
    await waitFor(() => expect(groupNames(nav)).toEqual(["W1"]));
    expect(titles(group(nav, "W1"))).toEqual(["会话G", "会话B"]);

    await chooseGrouping(nav, BY_TIME);
    expect(groupNames(nav)).toEqual(["今天", "近 7 天"]);
    await toggle("置顶任务");
    await waitFor(() => expect(groupNames(nav)).toEqual([PINNED, "今天"]));
    expect(titles(group(nav, PINNED))).toEqual(["会话B"]);
    expect(titles(group(nav, "今天"))).toEqual(["会话G"]);
    await toggle("取消置顶");
    await waitFor(() => expect(groupNames(nav)).toEqual(["今天", "近 7 天"]));
    expect(titles(group(nav, "近 7 天"))).toEqual(["会话B"]);
  });
});

describe("标题搜索 (session-sidebar)", () => {
  const SEARCH_LIST = [
    listed(A, "周报整理", { workspaceId: W1 }),
    listed(B, "Weekly Sync", { workspaceId: W2 }),
    listed(C, null),
    listed(D, "周报存档", { archivedAt: daysAgo(1), workspaceId: W1 }),
  ];

  it("过滤与恢复：子串、去空白且不分大小写、title 为 null 按 新会话、无匹配、清空后恢复折叠；不含已归档，不发请求", async () => {
    const { fetchMock } = renderChatPage("/", routes(SEARCH_LIST));
    const nav = await findList("周报整理");
    await within(nav).findByRole("group", { name: "W1" });
    expect(searchBox(nav).placeholder).toBe(SEARCH);
    fireEvent.click(header(nav, "W1"));
    expect(titles(nav)).toEqual(["Weekly Sync", "新会话"]);
    await act(settle);
    const requests = fetchMock.mock.calls.length;
    const archivedHidden = () => expect(nav.textContent).not.toContain("周报存档");

    search(nav, "周报");
    expect(titles(nav)).toEqual(["周报整理"]);
    expect(groupNames(nav)).toEqual(["W1"]);
    expect(expanded(nav, "W1")).toBe("true");
    expect(storedCollapsed()).toEqual([W1]);
    archivedHidden();
    // 搜索期间折叠被忽略：点标签按钮既不折叠也不改写存储值。
    fireEvent.click(header(nav, "W1"));
    expect(expanded(nav, "W1")).toBe("true");
    expect(titles(nav)).toEqual(["周报整理"]);
    expect(storedCollapsed()).toEqual([W1]);

    search(nav, " WEEK ");
    expect(titles(nav)).toEqual(["Weekly Sync"]);
    expect(groupNames(nav)).toEqual(["W2"]);
    archivedHidden();

    search(nav, "新会");
    expect(titles(nav)).toEqual(["新会话"]);
    expect(groupNames(nav)).toEqual([TEMPORARY]);

    search(nav, "不存在");
    expect(within(nav).getByText(EMPTY, { exact: true })).toBeTruthy();
    expect(within(nav).queryAllByRole("group")).toEqual([]);
    expect(titles(nav)).toEqual([]);
    archivedHidden();

    search(nav, "");
    expect(within(nav).queryByText(EMPTY, { exact: true })).toBeNull();
    expect(groupNames(nav)).toEqual(["W2", "W1", TEMPORARY]);
    expect(expanded(nav, "W1")).toBe("false");
    expect(titles(nav)).toEqual(["Weekly Sync", "新会话"]);
    expect(storedCollapsed()).toEqual([W1]);
    archivedHidden();
    await act(settle);
    expect(fetchMock.mock.calls.length).toBe(requests);
  });

  it("不影响主区：当前会话被搜索滤掉后侧栏不显示它，主区仍是它的线程，顶栏标题与 URL 不变", async () => {
    const path = `/?session=${B}`;
    renderChatPage(
      path,
      routes(SEARCH_LIST, TWO_SPACES, {
        [`/api/sessions/${B}/messages`]: () =>
          jsonResponse(
            chatSnapshot({
              assistantStatus: "done",
              content: ANSWER,
              sessionId: B,
              status: "done",
            }),
          ),
      }),
    );
    const nav = await findList("Weekly Sync");
    const main = screen.getByRole("main");
    await within(main).findByText(ANSWER, { exact: true });
    const heading = screen.getByRole("heading", { level: 1, name: "我的工作 / Weekly Sync" });

    search(nav, "周报");
    expect(titles(nav)).toEqual(["周报整理"]);
    expect(within(nav).queryByRole("button", { name: "Weekly Sync" })).toBeNull();
    expect(within(main).getByText(ANSWER, { exact: true })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "我的工作 / Weekly Sync" })).toBe(heading);
    expect(currentLocation()).toBe(path);

    search(nav, "");
    expect(
      within(nav).getByRole("button", { name: "Weekly Sync" }).getAttribute("aria-current"),
    ).toBe("true");
  });
});

describe("列表区承载重建后的会话列表 (spa-shell)", () => {
  it("≥761px 的 / ：新建会话 → 搜索任务 → 分组方式 → 置顶任务、项目A 两个分组，没有 筛选任务，用户区在其后；到 /files 后列表区不在 DOM", async () => {
    renderChatPage(
      "/",
      routes(
        [listed(B, "绑定的", { workspaceId: W1 }), listed(A, "置顶的", { pinnedAt: PINNED_AT })],
        () => workspaceList(workspace(W1, "项目A")),
      ),
    );
    const nav = await findList("置顶的");
    await within(nav).findByRole("group", { name: "项目A" });
    const aside = screen.getByRole("complementary", { name: "侧栏" });
    const footer = aside.querySelector("footer");
    if (!footer) throw new Error("侧栏缺用户区");

    expect(aside.contains(nav)).toBe(true);
    const ordered = [
      within(nav).getByRole("button", { name: "新建会话" }),
      searchBox(nav),
      groupingTrigger(nav),
      group(nav, PINNED),
      group(nav, "项目A"),
      footer,
    ];
    for (const [index, element] of ordered.slice(1).entries()) {
      expect(follows(ordered[index] as Element, element), `次序 ${index}`).toBe(true);
    }
    expect(groupNames(nav)).toEqual([PINNED, "项目A"]);
    expect(within(aside).queryByRole("button", { name: "筛选任务" })).toBeNull();
    expect(aside.textContent).not.toContain("筛选任务");

    fireEvent.click(within(aside).getByRole("link", { name: /^工作空间/ }));
    await screen.findByRole("heading", { level: 1, name: "工作空间" });
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建会话" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: SEARCH })).toBeNull();
  });
});
