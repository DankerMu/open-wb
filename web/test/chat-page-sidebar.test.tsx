import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { cleanupChatPage, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, settle } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { listRepoFiles, pressPointer, readRepoFile, yieldMacrotask } from "./ui-support.js";

const HERO = "WorkBuddy，我帮你";
const FILTER = "筛选任务";
const EMPTY = "没有匹配的任务";
const UNKNOWN = "未知空间";
const ANSWER = "这是回答正文";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const E = "e".repeat(32);
const CREATED = "f".repeat(32);
const W1 = "1".repeat(32);
const W2 = "2".repeat(32);

// 只伪造 Date：Radix 的焦点/外点处理依赖真实计时器。时间戳用本地时间构造器生成，与时区无关。
const NOW = new Date(2026, 4, 20, 12, 0, 0);
const TODAY = new Date(2026, 4, 20, 9, 0, 0).getTime();
const YESTERDAY = new Date(2026, 4, 19, 18, 0, 0).getTime();

type Listed = ReturnType<typeof listed>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

// 弹层/覆盖层的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 mock 与 DOM。
afterEach(async () => {
  cleanupChatPage();
  uninstallMatchMedia();
  await yieldMacrotask();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function listed(
  id: string,
  title: string,
  overrides: {
    pinnedAt?: number | null;
    status?: "idle" | "running" | "done" | "failed" | "stopped";
    updatedAt?: number;
    workspaceId?: string | null;
  } = {},
) {
  return {
    id,
    title,
    status: "done" as const,
    createdAt: YESTERDAY,
    updatedAt: TODAY,
    ...NULL_SESSION_META,
    ...overrides,
  };
}

function workspace(id: string, name: string) {
  return { id, name, dir: name, root: `/srv/${id}`, createdAt: YESTERDAY };
}

function workspaceList(...workspaces: ReturnType<typeof workspace>[]) {
  return jsonResponse({ workspaces });
}

function messagesPath(sessionId: string) {
  return `/api/sessions/${sessionId}/messages`;
}

/** 已完成会话的历史：助手正文为 ANSWER（主区内容不变的断言用）。 */
function answeredHistory(sessionId: string): FetchRoutes {
  return {
    [messagesPath(sessionId)]: () =>
      jsonResponse(
        chatSnapshot({ assistantStatus: "done", content: ANSWER, sessionId, status: "done" }),
      ),
  };
}

/** 会话列表 + 工作空间列表；`extra` 覆盖或追加（历史、POST 等）。 */
function sidebarRoutes(
  sessions: readonly Listed[],
  workspaces: FetchRoutes[string] = () => workspaceList(),
  extra: FetchRoutes = {},
): FetchRoutes {
  return {
    "/api/sessions": () => jsonResponse({ sessions }),
    "/api/workspaces": workspaces,
    ...extra,
  };
}

/** `新建会话` 可用的路由：POST 返回 CREATED 并把它排到列表首位，其历史挂起。 */
function creatableRoutes(sessions: readonly Listed[], workspaces: FetchRoutes[string]) {
  let current = sessions;
  const created = listed(CREATED, "新建的", { status: "idle" });
  return sidebarRoutes(sessions, workspaces, {
    "/api/sessions": (_path, options) => {
      if (options?.method === "POST") {
        current = [created, ...sessions];
        return jsonResponse(created, 201);
      }
      return jsonResponse({ sessions: current });
    },
    [messagesPath(CREATED)]: () => deferredResponse().promise,
  });
}

const FILTER_FIXTURE = [
  listed(A, "进行中的", { status: "running" }),
  listed(B, "完成的", { status: "done" }),
  listed(C, "未开始的", { status: "idle" }),
  listed(D, "失败的", { status: "failed", updatedAt: YESTERDAY }),
  listed(E, "停止的", { status: "stopped", updatedAt: YESTERDAY }),
];

/** 外壳断点查询交给 `narrow`，其它查询（主题的配色偏好）恒不匹配。 */
function installViewport(matches: boolean) {
  const narrow = createMediaQuery(matches);
  const other = createMediaQuery(false);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? narrow : other));
}

/** 先把焦点放到打开者上（jsdom 的 click 不移焦点），再点击打开覆盖层。 */
async function openNav() {
  const button = screen.getByRole("button", { name: "打开导航" });
  button.focus();
  fireEvent.click(button);
  return screen.findByRole("dialog", { name: "导航" });
}

/** 列表区 nav；`title` 给出时等到该会话条目出现。 */
async function findList(title?: string) {
  const nav = await screen.findByRole("navigation", { name: "会话列表" });
  if (title !== undefined) await within(nav).findByRole("button", { name: title });
  return nav;
}

/** 选择按钮的标题，按文档顺序（只认 `button.chat-session-button`）。 */
function titles(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll("button.chat-session-button")).map((button) =>
    button.getAttribute("aria-label"),
  );
}

/** `scope` 内全部 group 的可见标签文本，按文档顺序。 */
function groupLabels(scope: HTMLElement) {
  return within(scope)
    .queryAllByRole("group")
    .map((group) => {
      const labelId = group.getAttribute("aria-labelledby");
      return labelId === null ? null : (document.getElementById(labelId)?.textContent ?? null);
    });
}

function group(scope: HTMLElement, name: string) {
  return within(scope).getByRole("group", { name });
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function filterPopover() {
  return screen.queryByRole("dialog", { name: FILTER });
}

/** 点击 `筛选任务` 并等弹层把焦点接进去（之后的 Escape 从弹层内发出）。 */
async function openFilter(scope: HTMLElement) {
  const trigger = within(scope).getByRole("button", { name: FILTER });
  fireEvent.click(trigger);
  const popover = await screen.findByRole("dialog", { name: FILTER });
  await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true));
  return { popover, trigger };
}

function radio(name: string) {
  return screen.getByRole("radio", { name });
}

function choose(name: string) {
  fireEvent.click(radio(name));
}

function checked(name: string) {
  return radio(name).getAttribute("aria-checked");
}

async function escapeFilter() {
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  await waitFor(() => expect(filterPopover()).toBeNull());
}

function workspaceRequests(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"]) {
  return calls(fetchMock, "/api/workspaces").length;
}

describe("三分区侧栏 (S1)", () => {
  it.each([
    ["默认渲染", false],
    ["StrictMode", true],
  ] as const)(
    "S1 三分区 DOM（%s）：置顶任务 → 任务 (2) → 空间 (2)，子组按空间列表顺序，每个会话恰一个条目",
    async (_mode, strict) => {
      renderChatPage(
        "/",
        sidebarRoutes(
          [
            listed(E, "会话E"),
            listed(D, "会话D"),
            listed(C, "会话C", { workspaceId: W2 }),
            listed(B, "会话B", { workspaceId: W1 }),
            listed(A, "会话A", { pinnedAt: TODAY, workspaceId: W1 }),
          ],
          () => workspaceList(workspace(W2, "W2"), workspace(W1, "W1")),
        ),
        strict,
      );
      const nav = await findList("会话A");
      await within(nav).findByRole("group", { name: "W2" });

      expect(groupLabels(nav)).toEqual(["置顶任务", "任务 (2)", "空间 (2)", "W2", "W1"]);
      const pinned = group(nav, "置顶任务");
      const tasks = group(nav, "任务 (2)");
      const spaces = group(nav, "空间 (2)");
      expect(follows(pinned, tasks)).toBe(true);
      expect(follows(tasks, spaces)).toBe(true);
      expect(titles(pinned)).toEqual(["会话A"]);
      expect(titles(tasks)).toEqual(["会话E", "会话D"]);
      expect(titles(spaces)).toEqual(["会话C", "会话B"]);
      expect(titles(group(spaces, "W2"))).toEqual(["会话C"]);
      expect(titles(group(spaces, "W1"))).toEqual(["会话B"]);
      expect(within(nav).getAllByRole("group")).toHaveLength(5);

      expect(titles(nav)).toEqual(["会话A", "会话E", "会话D", "会话C", "会话B"]);
      for (const title of ["会话A", "会话B", "会话C", "会话D", "会话E"]) {
        expect(within(nav).getAllByRole("button", { name: title })).toHaveLength(1);
      }
      expect(nav.textContent).not.toContain("助理任务");
      expect(screen.getAllByRole("navigation", { name: "会话列表" })).toHaveLength(1);
    },
  );
});

describe("状态与时间筛选 (S2–S4, S9, S10)", () => {
  it("S2 筛选任务 打开弹层：两个 radiogroup，选择即生效、弹层保持打开、不发请求", async () => {
    const { fetchMock } = renderChatPage("/", sidebarRoutes(FILTER_FIXTURE));
    const nav = await findList("进行中的");
    const requests = fetchMock.mock.calls.length;

    const { popover } = await openFilter(nav);
    const status = within(popover).getByRole("radiogroup", { name: "状态" });
    const time = within(popover).getByRole("radiogroup", { name: "时间" });
    expect(
      within(status)
        .getAllByRole("radio")
        .map((item) => item.textContent),
    ).toEqual(["全部", "进行中", "已完成"]);
    expect(
      within(time)
        .getAllByRole("radio")
        .map((item) => item.textContent),
    ).toEqual(["全部时间", "今天", "更早"]);
    expect(within(popover).getByText("状态", { exact: true })).toBeTruthy();
    expect(within(popover).getByText("时间", { exact: true })).toBeTruthy();
    expect(checked("全部")).toBe("true");
    expect(checked("全部时间")).toBe("true");
    expect(titles(nav)).toEqual(["进行中的", "完成的", "未开始的", "失败的", "停止的"]);
    expect(groupLabels(nav)).toEqual(["任务 (5)"]);

    choose("进行中");
    expect(titles(nav)).toEqual(["进行中的"]);
    expect(groupLabels(nav)).toEqual(["任务 (1)"]);
    expect(checked("进行中")).toBe("true");
    expect(checked("全部")).toBe("false");
    expect(filterPopover()).toBe(popover);

    choose("已完成");
    expect(titles(nav)).toEqual(["完成的", "失败的", "停止的"]);
    expect(groupLabels(nav)).toEqual(["任务 (3)"]);
    expect(filterPopover()).toBe(popover);

    choose("今天");
    expect(titles(nav)).toEqual(["完成的"]);
    expect(groupLabels(nav)).toEqual(["任务 (1)"]);
    expect(checked("今天")).toBe("true");
    expect(checked("已完成")).toBe("true");
    expect(filterPopover()).toBe(popover);

    choose("全部");
    choose("更早");
    expect(titles(nav)).toEqual(["失败的", "停止的"]);
    expect(groupLabels(nav)).toEqual(["任务 (2)"]);
    expect(filterPopover()).toBe(popover);

    choose("今天");
    expect(titles(nav)).toEqual(["进行中的", "完成的", "未开始的"]);
    await act(settle);
    expect(fetchMock.mock.calls.length).toBe(requests);
  });

  it("S3 空态：账号无会话 → 只有 没有匹配的任务，没有任何 group", async () => {
    renderChatPage("/", sidebarRoutes([]));
    const nav = await findList();

    expect(await within(nav).findByText(EMPTY, { exact: true })).toBeTruthy();
    expect(within(nav).queryAllByRole("group")).toEqual([]);
    expect(titles(nav)).toEqual([]);
  });

  it("S3 空态：进行中 无匹配 → 只有该文本；Escape 关弹层并把焦点还给 筛选任务，URL 与主区不变", async () => {
    const path = `/?session=${B}`;
    renderChatPage(
      path,
      sidebarRoutes(
        [listed(B, "完成的"), listed(D, "失败的", { status: "failed" })],
        undefined,
        answeredHistory(B),
      ),
    );
    const nav = await findList("完成的");
    const main = screen.getByRole("main");
    await within(main).findByText(ANSWER, { exact: true });

    const { trigger } = await openFilter(nav);
    choose("进行中");
    expect(within(nav).getByText(EMPTY, { exact: true })).toBeTruthy();
    expect(within(nav).queryAllByRole("group")).toEqual([]);
    expect(titles(nav)).toEqual([]);

    await escapeFilter();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(currentLocation()).toBe(path);
    expect(within(main).getByText(ANSWER, { exact: true })).toBeTruthy();
    expect(within(nav).getByText(EMPTY, { exact: true })).toBeTruthy();
  });

  it("S4 外点关闭：弹层消失、焦点不回 筛选任务，筛选值保持", async () => {
    renderChatPage("/", sidebarRoutes(FILTER_FIXTURE));
    const nav = await findList("进行中的");
    const { trigger } = await openFilter(nav);
    choose("已完成");
    expect(titles(nav)).toEqual(["完成的", "失败的", "停止的"]);

    // DismissableLayer 的 document pointerdown 监听在挂载后的 setTimeout(0) 里才注册。
    await yieldMacrotask();
    pressPointer(screen.getByRole("main"));
    await waitFor(() => expect(filterPopover()).toBeNull());
    await yieldMacrotask();
    expect(document.activeElement).not.toBe(trigger);
    expect(titles(nav)).toEqual(["完成的", "失败的", "停止的"]);

    await openFilter(nav);
    expect(checked("已完成")).toBe("true");
    expect(checked("全部时间")).toBe("true");
  });

  it("S9 筛选不动主区：当前会话被筛掉后主区、顶栏标题与 ?session= 不变；选另一会话后筛选值保留", async () => {
    const path = `/?session=${B}`;
    renderChatPage(
      path,
      sidebarRoutes(
        [listed(B, "当前会话"), listed(A, "另一个", { status: "running" })],
        undefined,
        {
          ...answeredHistory(B),
          [messagesPath(A)]: () => jsonResponse(chatSnapshot({ sessionId: A })),
        },
      ),
    );
    const nav = await findList("当前会话");
    const main = screen.getByRole("main");
    await within(main).findByText(ANSWER, { exact: true });
    const heading = screen.getByRole("heading", { level: 1, name: "我的工作 / 当前会话" });

    await openFilter(nav);
    choose("进行中");
    expect(titles(nav)).toEqual(["另一个"]);
    expect(within(main).getByText(ANSWER, { exact: true })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "我的工作 / 当前会话" })).toBe(heading);
    expect(currentLocation()).toBe(path);
    await escapeFilter();

    fireEvent.click(within(nav).getByRole("button", { name: "另一个" }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${A}`));
    await screen.findByRole("heading", { level: 1, name: "我的工作 / 另一个" });
    expect(titles(nav)).toEqual(["另一个"]);
    expect(within(nav).getByRole("button", { name: "另一个" }).getAttribute("aria-current")).toBe(
      "true",
    );
    await openFilter(nav);
    expect(checked("进行中")).toBe("true");
  });

  it("S10 不写 storage：筛选操作期间 Storage.prototype.setItem 未被调用", async () => {
    renderChatPage("/", sidebarRoutes(FILTER_FIXTURE));
    const nav = await findList("进行中的");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    await openFilter(nav);
    choose("已完成");
    choose("今天");
    expect(titles(nav)).toEqual(["完成的"]);
    await escapeFilter();
    await openFilter(nav);
    choose("全部");
    choose("全部时间");
    expect(titles(nav)).toHaveLength(5);
    await escapeFilter();

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("工作空间读取与归组 (S5–S7)", () => {
  const BOUND = [listed(B, "绑定会话", { workspaceId: W1 }), listed(D, "普通任务")];

  it("S5 工作空间读取 500：会话照常渲染，绑定会话在 空间 (1) > 未知空间，列表区没有 alert", async () => {
    const { fetchMock } = renderChatPage(
      "/",
      sidebarRoutes(BOUND, () =>
        jsonResponse({ error: { code: "internal", message: "工作空间不可用" } }, 500),
      ),
    );
    const nav = await findList("绑定会话");
    await waitFor(() => expect(workspaceRequests(fetchMock)).toBe(1));
    await act(settle);

    expect(groupLabels(nav)).toEqual(["任务 (1)", "空间 (1)", UNKNOWN]);
    expect(titles(group(group(nav, "空间 (1)"), UNKNOWN))).toEqual(["绑定会话"]);
    expect(titles(group(nav, "任务 (1)"))).toEqual(["普通任务"]);
    expect(within(nav).queryByRole("alert")).toBeNull();
    expect(nav.textContent).not.toContain("工作空间不可用");
    expect(calls(fetchMock, "/api/sessions")).toHaveLength(1);
  });

  /**
   * 两次工作空间响应都由用例控制：返回时首次响应仍挂起而会话条目已渲染。`refreshByCreate` 经
   * `新建会话` 触发一次 refreshList，等列表刷新（新会话出现）且第二次工作空间请求已发出。
   */
  async function mountWithDeferredWorkspaces() {
    const first = deferredResponse();
    const second = deferredResponse();
    const { fetchMock } = renderChatPage(
      "/",
      creatableRoutes(BOUND, [first.promise, second.promise]),
    );
    const nav = await findList("绑定会话");
    expect(workspaceRequests(fetchMock)).toBe(1);
    const refreshByCreate = async () => {
      fireEvent.click(within(nav).getByRole("button", { name: "新建会话" }));
      await within(nav).findByRole("button", { name: "新建的" });
      expect(workspaceRequests(fetchMock)).toBe(2);
    };
    return { first, nav, refreshByCreate, second };
  }

  it("S6 互不等待与沿用：首读挂起归 未知空间；到达后归空间名；重读挂起沿用；重读失败回 未知空间", async () => {
    const { first, nav, refreshByCreate, second } = await mountWithDeferredWorkspaces();
    expect(groupLabels(nav)).toEqual(["任务 (1)", "空间 (1)", UNKNOWN]);
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话"]);

    await settleDeferredResponse(first, workspaceList(workspace(W1, "研发空间")));
    expect(groupLabels(nav)).toEqual(["任务 (1)", "空间 (1)", "研发空间"]);
    expect(titles(group(nav, "研发空间"))).toEqual(["绑定会话"]);

    // 第二次工作空间响应仍挂起：沿用上一次成功结果。
    await refreshByCreate();
    expect(groupLabels(nav)).toEqual(["任务 (2)", "空间 (1)", "研发空间"]);
    expect(titles(group(nav, "研发空间"))).toEqual(["绑定会话"]);

    await settleDeferredResponse(
      second,
      jsonResponse({ error: { code: "internal", message: "工作空间不可用" } }, 500),
    );
    expect(groupLabels(nav)).toEqual(["任务 (2)", "空间 (1)", UNKNOWN]);
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话"]);
    expect(within(nav).queryByRole("alert")).toBeNull();
    expect(titles(nav)).toEqual(["新建的", "普通任务", "绑定会话"]);
  });

  it("S7 迟到响应：第一次工作空间响应晚于第二次到达 → 子组名以第二次为准", async () => {
    const { first, nav, refreshByCreate, second } = await mountWithDeferredWorkspaces();
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话"]);

    await refreshByCreate();

    await settleDeferredResponse(second, workspaceList(workspace(W1, "第二次的名字")));
    expect(titles(group(nav, "第二次的名字"))).toEqual(["绑定会话"]);

    await settleDeferredResponse(first, workspaceList(workspace(W1, "第一次的名字")));
    expect(groupLabels(nav)).toEqual(["任务 (2)", "空间 (1)", "第二次的名字"]);
    expect(nav.textContent).not.toContain("第一次的名字");
  });
});

describe("筛选状态跨槽位节点卸载保留 (S8)", () => {
  const OVERLAY_FIXTURE = [
    listed(B, "完成的"),
    listed(A, "进行中的", { status: "running" }),
    listed(D, "失败的", { status: "failed" }),
  ];

  it("S8 ≤760px 覆盖层：筛选与 Escape 不关 导航；选会话后重开覆盖层筛选值仍在", async () => {
    installViewport(true);
    renderChatPage(
      "/",
      sidebarRoutes(OVERLAY_FIXTURE, undefined, {
        [messagesPath(D)]: () => deferredResponse().promise,
      }),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();

    const overlay = await openNav();
    const nav = within(overlay).getByRole("navigation", { name: "会话列表" });
    await within(nav).findByRole("button", { name: "进行中的" });
    const { trigger } = await openFilter(nav);
    // 完整指针序列：单选项在 portal 里（覆盖层 DOM 之外），覆盖层的外点判定要真的跑到。
    // DismissableLayer 的 document pointerdown 监听在挂载后的 setTimeout(0) 里才注册。
    await yieldMacrotask();
    pressPointer(radio("已完成"));
    await yieldMacrotask();
    expect(checked("已完成")).toBe("true");
    expect(titles(nav)).toEqual(["完成的", "失败的"]);
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    expect(filterPopover()).not.toBeNull();

    await escapeFilter();
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await yieldMacrotask();
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);

    fireEvent.click(within(nav).getByRole("button", { name: "失败的" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
    expect(currentLocation()).toBe(`/?session=${D}`);
    expect(screen.queryByRole("navigation", { name: "会话列表", hidden: true })).toBeNull();

    const reopened = await openNav();
    const list = within(reopened).getByRole("navigation", { name: "会话列表" });
    expect(titles(list)).toEqual(["完成的", "失败的"]);
    await openFilter(list);
    expect(checked("已完成")).toBe("true");
    expect(checked("全部")).toBe("false");
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(reopened);
  });

  it("S8 宽屏：折叠再展开侧栏后筛选值保留", async () => {
    renderChatPage("/", sidebarRoutes(OVERLAY_FIXTURE));
    const nav = await findList("进行中的");
    await openFilter(nav);
    choose("已完成");
    await escapeFilter();
    expect(titles(nav)).toEqual(["完成的", "失败的"]);

    const aside = screen.getByRole("complementary", { name: "侧栏" });
    fireEvent.click(within(aside).getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();
    fireEvent.click(within(aside).getByRole("button", { name: "展开侧栏" }));

    const restored = within(aside).getByRole("navigation", { name: "会话列表" });
    expect(titles(restored)).toEqual(["完成的", "失败的"]);
    await openFilter(restored);
    expect(checked("已完成")).toBe("true");
  });
});

describe("既有 DOM 钩子保持 (S11)", () => {
  it("S11 nav 唯一且在侧栏 主导航 之后、用户区之前；新建会话 类名不变；条目按钮与 aria-current、状态元素不变", async () => {
    renderChatPage(
      `/?session=${B}`,
      sidebarRoutes(
        [listed(B, "选中的"), listed(A, "运行中的", { status: "running" })],
        undefined,
        { [messagesPath(B)]: () => deferredResponse().promise },
      ),
    );
    const nav = await findList("选中的");

    const aside = screen.getByRole("complementary", { name: "侧栏" });
    const mainNav = within(aside).getByRole("navigation", { name: "主导航" });
    const footer = aside.querySelector("footer");
    if (!footer) throw new Error("侧栏缺用户区");
    expect(screen.getAllByRole("navigation", { name: "会话列表" })).toEqual([nav]);
    expect(aside.contains(nav)).toBe(true);
    expect(follows(mainNav, nav)).toBe(true);
    expect(follows(nav, footer)).toBe(true);
    expect(nav.classList.contains("chat-session-nav")).toBe(true);
    const main = screen.getByRole("main");
    expect(within(main).queryByRole("navigation", { name: "会话列表" })).toBeNull();
    expect(within(main).queryByRole("button", { name: "新建会话" })).toBeNull();

    expect(within(nav).getByRole("button", { name: "新建会话" }).className).toBe(
      "ui-btn ui-btn--primary ui-btn--md chat-new-session",
    );
    expect(titles(nav)).toEqual(["选中的", "运行中的"]);
    const selected = within(nav).getByRole("button", { name: "选中的" });
    const other = within(nav).getByRole("button", { name: "运行中的" });
    expect(selected.classList.contains("chat-session-button")).toBe(true);
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(other.hasAttribute("aria-current")).toBe(false);
    expect(selected.closest("li")?.className).toBe("chat-session-item");
    expect(within(nav).getByRole("status", { name: "选中的 已完成" })).toBeTruthy();
    const running = within(nav).getByRole("status", { name: "运行中的 运行中" });
    expect(running.querySelector(".chat-session-dot")?.classList.contains("ui-pulse")).toBe(true);
  });

  it("S11 读取中显示 正在读取会话；读取失败显示 alert，两种情况都没有 没有匹配的任务", async () => {
    const pending = deferredResponse();
    renderChatPage("/", sidebarRoutes([], undefined, { "/api/sessions": () => pending.promise }));
    const loadingNav = await findList();
    const loading = within(loadingNav).getByText("正在读取会话", { exact: true });
    expect(loading.getAttribute("role")).toBe("status");
    expect(within(loadingNav).queryByText(EMPTY, { exact: true })).toBeNull();
    cleanupChatPage();

    renderChatPage(
      "/",
      sidebarRoutes([], undefined, {
        "/api/sessions": () =>
          jsonResponse({ error: { code: "unavailable", message: "会话列表不可用" } }, 503),
      }),
    );
    const failedNav = await findList();
    expect((await within(failedNav).findByRole("alert")).textContent).toBe("会话列表不可用");
    expect(within(failedNav).queryByText("正在读取会话", { exact: true })).toBeNull();
    expect(within(failedNav).queryByText(EMPTY, { exact: true })).toBeNull();
    expect(titles(failedNav)).toEqual([]);
  });
});

describe("旧列表组件已移除 (S12)", () => {
  it("S12 session-nav.tsx 不存在；web/src 没有 session-nav.js 导入与 SessionNav 标识符，类名 chat-session-nav 保留", () => {
    const sources = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path));
    expect(sources).not.toContain("web/src/features/chat/session-nav.tsx");
    expect(
      sources.filter((path) => /session-nav\.js|\bSessionNav\b/.test(readRepoFile(path))),
    ).toEqual([]);
    expect(readRepoFile("web/src/features/chat/session-sidebar.tsx")).toContain(
      'className="chat-session-nav"',
    );
  });
});
