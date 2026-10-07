import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
  renewAccount,
  settleDeferredResponse,
} from "./chat-page-lifecycle-support.js";
import { typeAndSend } from "./chat-page-ownership-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { settle } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { listRepoFiles, readRepoFile, stripComments, yieldMacrotask } from "./ui-support.js";

const HERO = "WorkBuddy，我帮你";
const SEARCH = "搜索任务";
const PINNED = "置顶任务";
const TEMPORARY = "临时空间";
const GROUPING_KEY = "workbuddy-session-grouping";
const EMPTY = "没有匹配的任务";
const UNKNOWN = "未知空间";

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
  cleanupChatLifecycle();
  uninstallMatchMedia();
  await yieldMacrotask();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function listed(
  id: string,
  title: string | null,
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

/** 首次发送可用的路由：POST 返回 CREATED 并把它排到列表首位，其历史与 prompt 挂起。 */
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
    [`/api/sessions/${CREATED}/prompt`]: () => deferredResponse().promise,
  });
}

const STATUS_FIXTURE = [
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

/** 选择按钮的标题，按文档顺序（只认 `data-slot="session-select"`）。 */
function titles(scope: HTMLElement) {
  return Array.from(scope.querySelectorAll('[data-slot="session-select"]')).map((button) =>
    button.getAttribute("aria-label"),
  );
}

/** `scope` 内全部 group 的标签按钮文本，按文档顺序。 */
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

function searchBox(scope: HTMLElement) {
  return within(scope).getByRole<HTMLInputElement>("searchbox", { name: SEARCH });
}

function search(scope: HTMLElement, query: string) {
  fireEvent.change(searchBox(scope), { target: { value: query } });
}

/** 分组的标签按钮：组内与组同名的那个按钮。 */
function header(scope: HTMLElement, name: string) {
  return within(group(scope, name)).getByRole("button", { name });
}

function workspaceRequests(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"]) {
  return calls(fetchMock, "/api/workspaces").length;
}

describe("分组侧栏 (S1)", () => {
  it.each([
    ["默认渲染", false],
    ["StrictMode", true],
  ] as const)(
    "S1 分组 DOM（%s）：置顶任务 → 空间列表顺序的各空间 → 临时空间，分组不嵌套，每个会话恰一个条目",
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

      expect(groupLabels(nav)).toEqual([PINNED, "W2", "W1", TEMPORARY]);
      const groups = within(nav).getAllByRole("group");
      expect(groups).toHaveLength(4);
      for (const [index, item] of groups.slice(1).entries()) {
        expect(follows(groups[index] as Element, item)).toBe(true);
        expect(groups[index]?.contains(item)).toBe(false);
      }
      expect(titles(group(nav, PINNED))).toEqual(["会话A"]);
      expect(titles(group(nav, "W2"))).toEqual(["会话C"]);
      expect(titles(group(nav, "W1"))).toEqual(["会话B"]);
      expect(titles(group(nav, TEMPORARY))).toEqual(["会话E", "会话D"]);

      expect(titles(nav)).toEqual(["会话A", "会话C", "会话B", "会话E", "会话D"]);
      for (const title of ["会话A", "会话B", "会话C", "会话D", "会话E"]) {
        expect(within(nav).getAllByRole("button", { name: title })).toHaveLength(1);
      }
      expect(nav.textContent).not.toContain("助理任务");
      // 前端不渲染空间根路径：夹具里两个空间的 root 都不在列表区文本里。
      for (const id of [W1, W2]) expect(nav.textContent).not.toContain(workspace(id, "").root);
      expect(screen.getAllByRole("navigation", { name: "会话列表" })).toHaveLength(1);
    },
  );
});

describe("空态、搜索与按时间分组 (S2, S3, S8, S10)", () => {
  it("S3 空态：账号无会话 → 只有 没有匹配的任务，没有任何 group", async () => {
    renderChatPage("/", sidebarRoutes([]));
    const nav = await findList();

    expect(await within(nav).findByText(EMPTY, { exact: true })).toBeTruthy();
    expect(within(nav).queryAllByRole("group")).toEqual([]);
    expect(titles(nav)).toEqual([]);
  });

  it("S10 不写 storage：搜索期间 Storage.prototype.setItem 未被调用", async () => {
    renderChatPage("/", sidebarRoutes(STATUS_FIXTURE));
    const nav = await findList("进行中的");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    search(nav, "的");
    expect(titles(nav)).toHaveLength(5);
    search(nav, "完成");
    expect(titles(nav)).toEqual(["完成的"]);
    search(nav, "");
    expect(titles(nav)).toHaveLength(5);

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("S2 今天 的当前时间取渲染时刻：时钟跨到次日后重新渲染，今天 分组不再有任何会话", async () => {
    window.localStorage.setItem(GROUPING_KEY, "time");
    renderChatPage("/", sidebarRoutes(STATUS_FIXTURE));
    const nav = await findList("进行中的");
    expect(groupLabels(nav)).toEqual(["今天", "近 7 天"]);
    expect(titles(group(nav, "今天"))).toEqual(["进行中的", "完成的", "未开始的"]);
    expect(titles(group(nav, "近 7 天"))).toEqual(["失败的", "停止的"]);

    // 不设定时器：时钟前进本身不触发渲染，经一次真实交互（输入再清空搜索词）才重新取当前时间。
    vi.setSystemTime(new Date(2026, 4, 21, 0, 0, 1));
    expect(groupLabels(nav)).toEqual(["今天", "近 7 天"]);
    search(nav, "的");
    search(nav, "");
    expect(groupLabels(nav)).toEqual(["近 7 天"]);
    expect(titles(nav)).toEqual(["进行中的", "完成的", "未开始的", "失败的", "停止的"]);
  });

  it("S8 对照 离开会话页复位：经主导航去 /files 再回 / 后搜索词清空、列表完整；分组方式与折叠来自存储，保持", async () => {
    window.localStorage.setItem(GROUPING_KEY, "time");
    renderChatPage("/", sidebarRoutes(STATUS_FIXTURE));
    const nav = await findList("进行中的");
    fireEvent.click(header(nav, "近 7 天"));
    search(nav, "完成");
    expect(titles(nav)).toEqual(["完成的"]);

    const aside = screen.getByRole("complementary", { name: "侧栏" });
    fireEvent.click(within(aside).getByRole("link", { name: /^工作空间/ }));
    await screen.findByRole("heading", { level: 1, name: "工作空间" });
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();
    fireEvent.click(within(aside).getByRole("link", { name: "会话" }));

    const restored = await findList("进行中的");
    expect(searchBox(restored).value).toBe("");
    expect(groupLabels(restored)).toEqual(["今天", "近 7 天"]);
    expect(titles(restored)).toEqual(["进行中的", "完成的", "未开始的"]);
    expect(header(restored, "近 7 天").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("工作空间读取与归组 (S5–S7)", () => {
  const BOUND = [listed(B, "绑定会话", { workspaceId: W1 }), listed(D, "普通任务")];

  it("S5 工作空间读取 500：会话照常渲染，同一空间的两个绑定会话在末位的 未知空间，列表区没有 alert", async () => {
    const sessions = [...BOUND, listed(E, "另一个绑定会话", { workspaceId: W1 })];
    const { fetchMock } = renderChatPage(
      "/",
      sidebarRoutes(sessions, () =>
        jsonResponse({ error: { code: "internal", message: "工作空间不可用" } }, 500),
      ),
    );
    const nav = await findList("绑定会话");
    await waitFor(() => expect(workspaceRequests(fetchMock)).toBe(1));
    await act(settle);

    expect(groupLabels(nav)).toEqual([TEMPORARY, UNKNOWN]);
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话", "另一个绑定会话"]);
    expect(titles(group(nav, TEMPORARY))).toEqual(["普通任务"]);
    expect(within(nav).queryByRole("alert")).toBeNull();
    expect(nav.textContent).not.toContain("工作空间不可用");
    expect(calls(fetchMock, "/api/sessions")).toHaveLength(1);
  });

  // 两次工作空间响应都由用例控制：返回时首次响应仍挂起而会话条目已渲染。`refreshByCreate` 经
  // 欢迎态首次发送触发一次 refreshList，等列表刷新（新会话出现）且第二次工作空间请求已发出。
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
      await typeAndSend("你好");
      await within(nav).findByRole("button", { name: "新建的" });
      expect(workspaceRequests(fetchMock)).toBe(2);
    };
    return { first, nav, refreshByCreate, second };
  }

  it("S6 互不等待与沿用：首读挂起归 未知空间；到达后归空间名；重读挂起沿用；重读失败回 未知空间", async () => {
    const { first, nav, refreshByCreate, second } = await mountWithDeferredWorkspaces();
    expect(groupLabels(nav)).toEqual([TEMPORARY, UNKNOWN]);
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话"]);

    await settleDeferredResponse(first, workspaceList(workspace(W1, "研发空间")));
    expect(groupLabels(nav)).toEqual(["研发空间", TEMPORARY]);
    expect(titles(group(nav, "研发空间"))).toEqual(["绑定会话"]);

    // 第二次工作空间响应仍挂起：沿用上一次成功结果。
    await refreshByCreate();
    expect(groupLabels(nav)).toEqual(["研发空间", TEMPORARY]);
    expect(titles(group(nav, "研发空间"))).toEqual(["绑定会话"]);
    expect(titles(group(nav, TEMPORARY))).toEqual(["新建的", "普通任务"]);

    await settleDeferredResponse(
      second,
      jsonResponse({ error: { code: "internal", message: "工作空间不可用" } }, 500),
    );
    expect(groupLabels(nav)).toEqual([TEMPORARY, UNKNOWN]);
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话"]);
    expect(within(nav).queryByRole("alert")).toBeNull();
    expect(titles(nav)).toEqual(["新建的", "普通任务", "绑定会话"]);
  });

  it("S7 迟到响应：第一次工作空间响应晚于第二次到达 → 分组名以第二次为准", async () => {
    const { first, nav, refreshByCreate, second } = await mountWithDeferredWorkspaces();
    expect(titles(group(nav, UNKNOWN))).toEqual(["绑定会话"]);

    await refreshByCreate();

    await settleDeferredResponse(second, workspaceList(workspace(W1, "第二次的名字")));
    expect(titles(group(nav, "第二次的名字"))).toEqual(["绑定会话"]);

    await settleDeferredResponse(first, workspaceList(workspace(W1, "第一次的名字")));
    expect(groupLabels(nav)).toEqual(["第二次的名字", TEMPORARY]);
    expect(nav.textContent).not.toContain("第一次的名字");
  });
});

describe("换账号后不沿用上一账号的工作空间列表 (D3)", () => {
  it("S7 对照 换账号：新账号的工作空间响应挂起时绑定会话归 未知空间、不露出上一账号的空间名；到达后按新名归组", async () => {
    const pending = deferredResponse();
    let renewed = false;
    const { getProbe } = renderChatPageWithAuthProbe("/", {
      "/api/sessions": () =>
        jsonResponse({
          sessions: [
            renewed
              ? listed(D, "乙的会话", { workspaceId: W1 })
              : listed(B, "甲的会话", { workspaceId: W1 }),
          ],
        }),
      "/api/workspaces": () =>
        renewed ? pending.promise : workspaceList(workspace(W1, "甲的空间")),
    });
    const nav = await findList("甲的会话");
    await within(nav).findByRole("group", { name: "甲的空间" });

    // 同一工作空间 id：若沿用上一账号的列表，乙的会话会落进「甲的空间」。
    renewed = true;
    await renewAccount(getProbe);
    const list = await findList("乙的会话");
    expect(groupLabels(list)).toEqual([UNKNOWN]);
    expect(titles(group(list, UNKNOWN))).toEqual(["乙的会话"]);
    expect(list.textContent).not.toContain("甲的空间");
    expect(list.textContent).not.toContain("甲的会话");

    await settleDeferredResponse(pending, workspaceList(workspace(W1, "乙的空间")));
    expect(groupLabels(list)).toEqual(["乙的空间"]);
    expect(titles(group(list, "乙的空间"))).toEqual(["乙的会话"]);
  });
});

describe("视图状态跨槽位节点卸载保留 (S8)", () => {
  const OVERLAY_FIXTURE = [
    listed(B, "完成的", { workspaceId: W1 }),
    listed(A, "进行中的", { status: "running" }),
    listed(D, "失败的", { status: "failed" }),
  ];
  const oneSpace = () => workspaceList(workspace(W1, "W1"));

  it("S8 ≤760px 覆盖层：搜索不关 导航；选会话后重开覆盖层搜索词仍在", async () => {
    installViewport(true);
    renderChatPage(
      "/",
      sidebarRoutes(OVERLAY_FIXTURE, oneSpace, {
        [messagesPath(D)]: () => deferredResponse().promise,
      }),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();

    const overlay = await openNav();
    const nav = within(overlay).getByRole("navigation", { name: "会话列表" });
    await within(nav).findByRole("button", { name: "进行中的" });
    search(nav, "失败");
    expect(titles(nav)).toEqual(["失败的"]);
    await yieldMacrotask();
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);

    fireEvent.click(within(nav).getByRole("button", { name: "失败的" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
    expect(currentLocation()).toBe(`/?session=${D}`);
    expect(screen.queryByRole("navigation", { name: "会话列表", hidden: true })).toBeNull();

    const reopened = await openNav();
    const list = within(reopened).getByRole("navigation", { name: "会话列表" });
    expect(searchBox(list).value).toBe("失败");
    expect(titles(list)).toEqual(["失败的"]);
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(reopened);
  });

  it("S8 宽屏：折叠再展开侧栏后搜索词、分组的折叠状态都保留", async () => {
    renderChatPage("/", sidebarRoutes(OVERLAY_FIXTURE, oneSpace));
    const nav = await findList("进行中的");
    await within(nav).findByRole("group", { name: "W1" });
    fireEvent.click(header(nav, "W1"));
    expect(titles(nav)).toEqual(["进行中的", "失败的"]);
    search(nav, "的");
    expect(titles(nav)).toEqual(["完成的", "进行中的", "失败的"]);

    const aside = screen.getByRole("complementary", { name: "侧栏" });
    fireEvent.click(within(aside).getByRole("button", { name: "折叠侧栏" }));
    expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();
    fireEvent.click(within(aside).getByRole("button", { name: "展开侧栏" }));

    const restored = within(aside).getByRole("navigation", { name: "会话列表" });
    expect(searchBox(restored).value).toBe("的");
    expect(titles(restored)).toEqual(["完成的", "进行中的", "失败的"]);
    search(restored, "");
    expect(header(restored, "W1").getAttribute("aria-expanded")).toBe("false");
    expect(titles(restored)).toEqual(["进行中的", "失败的"]);
  });
});

describe("既有 DOM 钩子保持 (S11)", () => {
  it("S11 nav 唯一且在侧栏 主导航 之后、用户区之前；新建会话 是拷入层的主按钮；条目按钮与 aria-current、状态元素不变", async () => {
    renderChatPage(
      `/?session=${B}`,
      sidebarRoutes(
        [
          listed(B, "选中的"),
          listed(A, "运行中的", { status: "running" }),
          listed(C, null, { status: "idle" }),
        ],
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
    const main = screen.getByRole("main");
    expect(within(main).queryByRole("navigation", { name: "会话列表" })).toBeNull();
    expect(within(main).queryByRole("button", { name: "新建会话" })).toBeNull();

    const create = within(nav).getByRole("button", { name: "新建会话" });
    expect(create.getAttribute("data-slot")).toBe("button");
    expect(create.getAttribute("data-variant")).toBe("default");
    // 无标题会话回退为 新会话：选择按钮与状态元素的名称都用回退标题。
    expect(titles(nav)).toEqual(["选中的", "运行中的", "新会话"]);
    expect(within(nav).getByRole("status", { name: "新会话 未开始" }).textContent).toBe("未开始");
    const selected = within(nav).getByRole("button", { name: "选中的" });
    const other = within(nav).getByRole("button", { name: "运行中的" });
    expect(selected.getAttribute("data-slot")).toBe("session-select");
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(other.hasAttribute("aria-current")).toBe(false);
    expect(selected.closest("li")?.children).toHaveLength(2);
    expect(within(nav).getByRole("status", { name: "选中的 已完成" })).toBeTruthy();
    const running = within(nav).getByRole("status", { name: "运行中的 运行中" });
    const mark = running.querySelector('[data-status-mark="running"]');
    expect(mark?.classList.contains("animate-spin")).toBe(true);
    expect(mark?.classList.contains("motion-reduce:animate-none")).toBe(true);
  });

  it("S11 读取中显示 正在读取会话；读取失败显示 alert，两种情况都没有 没有匹配的任务", async () => {
    const pending = deferredResponse();
    renderChatPage("/", sidebarRoutes([], undefined, { "/api/sessions": () => pending.promise }));
    const loadingNav = await findList();
    const loading = within(loadingNav).getByText("正在读取会话", { exact: true });
    expect(loading.getAttribute("role")).toBe("status");
    expect(within(loadingNav).queryByText(EMPTY, { exact: true })).toBeNull();
    cleanupChatLifecycle();

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
  it("S12 session-nav.tsx 与 session-filter.tsx 不存在；web/src 没有 session-nav.js 导入与 SessionNav 标识符，也没有筛选的函数、类型与文案", () => {
    const sources = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path));
    expect(sources).not.toContain("web/src/features/chat/session-nav.tsx");
    expect(
      sources.filter((path) => /session-nav\.js|\bSessionNav\b/.test(readRepoFile(path))),
    ).toEqual([]);
    expect(sources).not.toContain("web/src/features/chat/session-filter.tsx");
    const removed =
      /SessionFilter|DEFAULT_SESSION_FILTER|filterSessions|\bgroupSessions\b|筛选任务/;
    expect(sources.filter((path) => removed.test(readRepoFile(path)))).toEqual([]);
    expect(readRepoFile("web/src/features/chat/session-sidebar.tsx")).toContain(
      'aria-label="会话列表"',
    );
  });

  it("S12 滚动：分组容器是唯一滚动容器，覆盖层内不滚动，列表与 nav 自身无 overflow；chat.css 不再有侧栏规则", async () => {
    renderChatPage("/", sidebarRoutes([listed(A, "会话A")]));
    const nav = await findList("会话A");
    const scroller = nav.querySelector('[data-slot="session-groups"]');
    if (!scroller) throw new Error("缺分组滚动容器");
    for (const token of ["overflow-y-auto", "min-h-0", "in-data-[variant=overlay]:flex-none"]) {
      expect(scroller.classList.contains(token), token).toBe(true);
    }
    expect(scroller.contains(group(nav, TEMPORARY))).toBe(true);
    const overflowing = Array.from(nav.querySelectorAll("*")).filter((element) =>
      /(^|\s)overflow-(y|x)?-?(auto|scroll)/.test(element.getAttribute("class") ?? ""),
    );
    expect(overflowing).toEqual([scroller]);
    expect(nav.className).not.toContain("overflow");
    const css = stripComments(readRepoFile("web/src/features/chat/chat.css"));
    for (const gone of ["chat-session-groups", "chat-session-nav", "chat-session-list"]) {
      expect(css).not.toContain(gone);
    }
  });
});
