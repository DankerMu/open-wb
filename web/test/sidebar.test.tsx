import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "./radix-platform.js";
import { routeManifest } from "../src/routes/manifest.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  deferredResponse,
  type FetchMock,
  jsonResponse,
} from "./support.js";
import {
  readRepoFile,
  ruleBody,
  stripComments,
  topLevelBlocks,
  yieldMacrotask,
} from "./ui-support.js";

const STORAGE_KEY = "workbuddy-sidebar";
const LABELS = ["会话", "工作空间", "中心", "设置"];

let disposeRouter: (() => void) | undefined;

function mountFiles(
  logout: () => Promise<Response> | Response = () => new Response(null, { status: 204 }),
): FetchMock {
  const fetchMock = createFetchMock({
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    "/api/auth/logout": logout,
  });
  const mounted = mountAuthenticatedApp("/files", fetchMock);
  disposeRouter = () => mounted.router.dispose();
  return fetchMock;
}

async function findSidebar() {
  expect(await screen.findByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
  return screen.getByRole("complementary", { name: "侧栏" });
}

function navLinks(aside: HTMLElement) {
  return within(within(aside).getByRole("navigation", { name: "主导航" })).getAllByRole("link");
}

/** 点击折叠/展开按钮并断言 data-collapsed 随之翻转。 */
function toggleSidebar(aside: HTMLElement, name: "折叠侧栏" | "展开侧栏") {
  fireEvent.click(within(aside).getByRole("button", { name }));
  expect(aside.getAttribute("data-collapsed")).toBe(name === "折叠侧栏" ? "true" : "false");
}

function userMenuTrigger() {
  const aside = screen.getByRole("complementary", { name: "侧栏", hidden: true });
  return within(aside).getByRole("button", { name: "用户菜单", hidden: true });
}

function openUserMenu() {
  fireEvent.pointerDown(userMenuTrigger(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.findByRole("menu");
}

async function selectLogout() {
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  return screen.getByRole("alertdialog");
}

function logoutCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout");
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  await yieldMacrotask();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe("侧栏展开态 (S1)", () => {
  it("默认展开：四项图标 + 标签、/files 副标签、字标与折叠按钮", async () => {
    mountFiles();
    const aside = await findSidebar();

    expect(aside.getAttribute("data-collapsed")).toBe("false");
    const links = navLinks(aside);
    expect(links).toHaveLength(4);
    links.forEach((link, index) => {
      expect(link.hasAttribute("aria-label")).toBe(false);
      expect(within(link).getByText(LABELS[index] as string, { exact: true })).toBeTruthy();
      expect(link.querySelector("svg.ui-icon")).not.toBeNull();
    });
    expect(within(links[1] as HTMLElement).getByText("文件·预览", { exact: true })).toBeTruthy();
    expect(within(aside).getByText("WorkBuddy", { exact: true })).toBeTruthy();
    expect(within(aside).getByRole("button", { name: "折叠侧栏" })).toBeTruthy();
  });
});

const LIST_SESSION = {
  id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  title: "周报",
  status: "done",
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_100,
} as const;

function mountChat(path = "/", strict = false) {
  const fetchMock = createFetchMock({
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    "/api/sessions": () => jsonResponse({ sessions: [LIST_SESSION] }),
    "/api/info": () =>
      jsonResponse({
        name: "workbuddy-app-server",
        version: "0.0.0",
        auth: { provider: "dev-stub" },
      }),
  });
  const mounted = mountAuthenticatedApp(path, fetchMock, strict);
  disposeRouter = () => mounted.router.dispose();
}

async function findChatSidebar() {
  expect(await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" })).toBeTruthy();
  const aside = screen.getByRole("complementary", { name: "侧栏" });
  await within(aside).findByRole("button", { name: LIST_SESSION.title });
  return aside;
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function expectNoSessionList() {
  expect(screen.queryByRole("navigation", { name: "会话列表" })).toBeNull();
  expect(screen.queryByRole("button", { name: "新建会话" })).toBeNull();
}

describe("侧栏会话列表区 (S11)", () => {
  it("/ 展开态：新建会话 与 会话列表 在侧栏 主导航 之后、用户区之前，main 内没有", async () => {
    mountChat();
    const aside = await findChatSidebar();

    const mainNav = within(aside).getByRole("navigation", { name: "主导航" });
    const list = within(aside).getByRole("navigation", { name: "会话列表" });
    const create = within(list).getByRole("button", { name: "新建会话" });
    const footer = aside.querySelector("footer");
    if (!footer) throw new Error("侧栏缺用户区");
    expect(follows(mainNav, list)).toBe(true);
    expect(follows(list, footer)).toBe(true);
    expect(list.closest(".sidebar-main")?.parentElement).toBe(aside);
    expect(create.className).toContain("chat-new-session");
    const main = screen.getByRole("main");
    expect(within(main).queryByRole("navigation", { name: "会话列表" })).toBeNull();
    expect(within(main).queryByRole("button", { name: "新建会话" })).toBeNull();
    expect(screen.getAllByRole("navigation", { name: "会话列表" })).toHaveLength(1);
  });

  it("折叠态不渲染列表区；展开后恢复", async () => {
    mountChat();
    const aside = await findChatSidebar();

    toggleSidebar(aside, "折叠侧栏");
    expectNoSessionList();
    expect(aside.querySelector(".sidebar-main")).toBeNull();

    toggleSidebar(aside, "展开侧栏");
    expect(within(aside).getByRole("navigation", { name: "会话列表" })).toBeTruthy();
    expect(within(aside).getByRole("button", { name: LIST_SESSION.title })).toBeTruthy();
  });

  it("离开 / 后清空列表区；/files、/settings 直挂也无列表", async () => {
    mountChat();
    const aside = await findChatSidebar();

    fireEvent.click(within(aside).getByRole("link", { name: /^工作空间/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expectNoSessionList();
    expect(aside.querySelector(".sidebar-main")?.childElementCount).toBe(0);
    cleanup();
    disposeRouter?.();

    mountChat("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "设置" })).toBeTruthy();
    expectNoSessionList();
  });

  it("StrictMode 双挂载后只有一份列表", async () => {
    mountChat("/", true);
    await findChatSidebar();

    expect(screen.getAllByRole("navigation", { name: "会话列表" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "新建会话" })).toHaveLength(1);
  });

  it("sidebar.css 的主导航规则不再匹配列表区的 nav；列表区不另设滚动层", () => {
    const css = stripComments(readRepoFile("web/src/routes/shell/sidebar.css"));
    const preludes = topLevelBlocks(css).map((block) => block.prelude);
    expect(preludes.filter((prelude) => /(^|[\s>+~])nav\b/.test(prelude))).toEqual([]);
    expect(preludes).toContain(".sidebar-nav");
    const area = ruleBody(css, ".sidebar-main");
    expect(area).toContain("flex: 1;");
    expect(area).toContain("min-height: 0;");
    expect(area).not.toContain("overflow");
  });
});

describe("侧栏折叠与持久化 (S2–S5)", () => {
  it("折叠往返：只剩图标 + aria-label，storage 写 collapsed/expanded (S2)", async () => {
    mountFiles();
    const aside = await findSidebar();

    toggleSidebar(aside, "折叠侧栏");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("collapsed");
    navLinks(aside).forEach((link, index) => {
      const label = LABELS[index] as string;
      expect(link.getAttribute("aria-label")).toBe(label);
      expect(within(link).queryByText(label)).toBeNull();
      expect(within(link).queryByText("文件·预览")).toBeNull();
    });
    expect(within(aside).queryByText("WorkBuddy")).toBeNull();

    toggleSidebar(aside, "展开侧栏");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("expanded");
    expect(within(aside).getByRole("button", { name: "折叠侧栏" })).toBeTruthy();
  });

  it.each([
    ["collapsed", "true"],
    ["garbage", "false"],
    ["expanded", "false"],
  ])("初始读取 storage=%s → data-collapsed=%s (S3)", async (stored, expected) => {
    window.localStorage.setItem(STORAGE_KEY, stored);
    mountFiles();

    expect((await findSidebar()).getAttribute("data-collapsed")).toBe(expected);
  });

  it("读失败按展开且不报错 (S4)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mountFiles();

    expect((await findSidebar()).getAttribute("data-collapsed")).toBe("false");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("写失败静默并保留内存状态 (S5)", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // React 把事件回调里的异常交给 window 的 error 事件（reportError），不会从 fireEvent 抛出。
    const uncaught: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      uncaught.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    onTestFinished(() => window.removeEventListener("error", onError));
    mountFiles();
    const aside = await findSidebar();

    toggleSidebar(aside, "折叠侧栏");
    expect(setItem).toHaveBeenLastCalledWith(STORAGE_KEY, "collapsed");

    toggleSidebar(aside, "展开侧栏");
    expect(setItem).toHaveBeenLastCalledWith(STORAGE_KEY, "expanded");
    expect(uncaught).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("折叠态 Tooltip (S6)", () => {
  it("折叠态聚焦链接显示标签 tooltip，blur 消失；展开态不出现", async () => {
    mountFiles();
    const aside = await findSidebar();

    fireEvent.focus(navLinks(aside)[2] as HTMLElement);
    await yieldMacrotask();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.blur(navLinks(aside)[2] as HTMLElement);

    toggleSidebar(aside, "折叠侧栏");
    const link = navLinks(aside)[1] as HTMLElement;
    fireEvent.focus(link);
    expect((await screen.findByRole("tooltip")).textContent).toBe("工作空间");

    fireEvent.blur(link);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});

describe("用户菜单 (S7–S9)", () => {
  it("菜单只含 退出登录，Escape 关闭并回焦触发器 (S7)", async () => {
    mountFiles();
    await findSidebar();

    const menu = await openUserMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["退出登录"]);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(userMenuTrigger()));
  });

  it("选择 退出登录 → 确认框聚焦 取消（同步且一个宏任务后），退出恰一次 (S8)", async () => {
    const fetchMock = mountFiles();
    await findSidebar();

    await openUserMenu();
    const dialog = await selectLogout();
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
    await yieldMacrotask();
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(logoutCalls(fetchMock)).toHaveLength(1);
  });

  it("确认框 取消 → 不发请求、侧栏仍在、回焦触发器 (S9)", async () => {
    const fetchMock = mountFiles();
    await findSidebar();

    await openUserMenu();
    const dialog = await selectLogout();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(logoutCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByRole("complementary", { name: "侧栏" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(userMenuTrigger()));
  });
});

describe("manifest 与静态契约 (S10)", () => {
  it("routeManifest 带 icon，定义迁出 router.tsx，sidebar 不直连 Radix，旧样式已删", () => {
    expect(routeManifest.map((route) => [route.path, route.icon])).toEqual([
      ["/", "message-square"],
      ["/files", "folder"],
      ["/center", "layout-grid"],
      ["/settings", "settings"],
    ]);
    expect(readRepoFile("web/src/routes/router.tsx")).not.toContain("export const routeManifest");
    expect(readRepoFile("web/src/routes/shell/sidebar.tsx")).not.toContain("@radix-ui");
    const styles = readRepoFile("web/src/styles.css");
    expect(styles).not.toContain(".account-footer");
    expect(styles).not.toContain(".sidebar-link");
    expect(styles).toContain("routes/shell/sidebar.css");
  });
});

describe("折叠态退出反馈与样式契约", () => {
  const sidebarCss = () => stripComments(readRepoFile("web/src/routes/shell/sidebar.css"));
  const COLLAPSED_NOTE = '.sidebar[data-collapsed="true"] .sidebar-footer-note';

  /** 折叠侧栏后经用户菜单确认 退出；返回侧栏。 */
  async function collapseAndConfirmLogout() {
    const aside = await findSidebar();
    toggleSidebar(aside, "折叠侧栏");
    await openUserMenu();
    const dialog = await selectLogout();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));
    return aside;
  }

  it("折叠态退出失败：错误提示以浮出 note 呈现，确认框关闭、侧栏仍折叠", async () => {
    const message = "无法退出当前会话";
    mountFiles(() => jsonResponse({ error: { code: "forbidden", message } }, 403));
    const aside = await collapseAndConfirmLogout();

    const alert = await within(aside).findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.classList.contains("sidebar-footer-note")).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(aside.getAttribute("data-collapsed")).toBe("true");
  });

  it("折叠态退出进行中：状态提示以浮出 note 呈现", async () => {
    const pendingLogout = deferredResponse();
    mountFiles(() => pendingLogout.promise);
    const aside = await collapseAndConfirmLogout();

    const status = await within(aside).findByRole("status", { hidden: true });
    expect(status.textContent).toBe("正在退出登录，可继续浏览或刷新确认登录状态。");
    expect(status.classList.contains("sidebar-footer-note")).toBe(true);
    expect(aside.getAttribute("data-collapsed")).toBe("true");
  });

  /** 退出失败后等确认框关闭、焦点回 用户菜单，返回浮出的 alert。 */
  async function awaitLogoutFailure(aside: HTMLElement) {
    const alert = await within(aside).findByRole("alert");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(userMenuTrigger()));
    return alert;
  }

  /** 先把焦点移到 关闭提示 上（jsdom 的 click 不移焦点），再点击。 */
  function dismissLogoutNote(alert: HTMLElement) {
    const dismiss = within(alert).getByRole("button", { name: "关闭提示" });
    dismiss.focus();
    fireEvent.click(dismiss);
  }

  it("折叠态关闭退出失败提示：提示消失、焦点回 用户菜单、仍折叠且不发请求", async () => {
    const message = "无法退出当前会话";
    const fetchMock = mountFiles(() =>
      jsonResponse({ error: { code: "forbidden", message } }, 403),
    );
    const aside = await collapseAndConfirmLogout();
    const alert = await awaitLogoutFailure(aside);

    dismissLogoutNote(alert);

    expect(within(aside).queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(userMenuTrigger());
    expect(aside.getAttribute("data-collapsed")).toBe("true");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("collapsed");
    expect(logoutCalls(fetchMock)).toHaveLength(1);
  });

  it("关闭提示后再次以相同 message 退出失败：提示重新出现", async () => {
    const message = "无法退出当前会话";
    const fetchMock = mountFiles(() =>
      jsonResponse({ error: { code: "forbidden", message } }, 403),
    );
    const aside = await collapseAndConfirmLogout();
    dismissLogoutNote(await awaitLogoutFailure(aside));
    expect(within(aside).queryByRole("alert")).toBeNull();

    await openUserMenu();
    const dialog = await selectLogout();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));

    const alert = await awaitLogoutFailure(aside);
    expect(alert.textContent).toBe(message);
    expect(logoutCalls(fetchMock)).toHaveLength(2);
  });

  it("折叠态退出进行中：状态提示无 关闭提示 按钮", async () => {
    const pendingLogout = deferredResponse();
    mountFiles(() => pendingLogout.promise);
    const aside = await collapseAndConfirmLogout();

    // 确认框仍开着，hideOthers 把侧栏设为 aria-hidden，故带 hidden 查询以免空过。
    expect(await within(aside).findByRole("status", { hidden: true })).toBeTruthy();
    expect(within(aside).queryByRole("button", { name: "关闭提示", hidden: true })).toBeNull();
  });

  it("折叠态 note 以 fixed 浮出 overflow 裁剪", () => {
    const floating = ruleBody(sidebarCss(), COLLAPSED_NOTE);
    expect(floating).toContain("position: fixed;");
    expect(floating).toContain("width: 240px;");
    // 半透明的 alert 底浮在主内容上需垫不透明底色。
    expect(ruleBody(sidebarCss(), `${COLLAPSED_NOTE}.ui-alert`)).toContain("var(--wb-bg-primary)");
  });

  it("导航链接聚焦时重申 8px 圆角（压过全局 :focus-visible）", () => {
    expect(ruleBody(sidebarCss(), ".sidebar-link:focus-visible")).toContain("border-radius: 8px;");
  });
});
