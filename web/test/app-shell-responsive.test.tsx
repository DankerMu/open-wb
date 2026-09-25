import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { chatSnapshot, FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import {
  createMediaQuery,
  type FakeMediaQuery,
  installMatchMedia,
  uninstallMatchMedia,
} from "./media-query-support.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  deferredResponse,
  type FetchMock,
  jsonResponse,
} from "./support.js";
import { blockBody, readRepoFile, stripComments, yieldMacrotask } from "./ui-support.js";
import "./radix-platform.js";

const HERO = "WorkBuddy，我帮你";
const SIDEBAR_KEY = "workbuddy-sidebar";
const LABELS = ["会话", "工作空间", "中心", "设置"];
const SESSION = "cccccccccccccccccccccccccccccccc";

type Routes = Parameters<typeof createFetchMock>[0];

let disposeRouter: (() => void) | undefined;

// 覆盖层/确认框的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 mock 与 DOM。
afterEach(async () => {
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  uninstallMatchMedia();
  await yieldMacrotask();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.replaceChildren();
});

/** 外壳断点查询交给 `narrow`，其它查询（主题的配色偏好）恒不匹配。 */
function installViewport(matches: boolean): FakeMediaQuery {
  const narrow = createMediaQuery(matches);
  const other = createMediaQuery(false);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? narrow : other));
  return narrow;
}

/** 挂载完整已认证应用；matchMedia 由调用方先行安装（或不安装，即 jsdom 默认）。 */
function mountShell(path: string, routes: Routes = {}) {
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  const fetchMock = createFetchMock({
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/info": () =>
      jsonResponse({
        name: "workbuddy-app-server",
        version: "0.0.0",
        auth: { provider: "dev-stub" },
      }),
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    "/api/auth/logout": () => new Response(null, { status: 204 }),
    ...routes,
  });
  const mounted = mountAuthenticatedApp(path, fetchMock);
  disposeRouter = () => mounted.router.dispose();
  return mounted;
}

function navButton() {
  return screen.getByRole("button", { name: "打开导航" });
}

/** 先把焦点放到打开者上（jsdom 的 click 不移焦点），再点击打开覆盖层。 */
async function openNav() {
  const button = navButton();
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "导航" });
  return { button, dialog };
}

function overlayLinks(dialog: HTMLElement) {
  return within(within(dialog).getByRole("navigation", { name: "主导航" })).getAllByRole("link");
}

async function expectNavClosed(container: HTMLElement, button: HTMLElement) {
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
  await waitFor(() => expect(container.hasAttribute("aria-hidden")).toBe(false));
  await waitFor(() => expect(document.activeElement).toBe(button));
}

/** 在 `scope`（覆盖层或文档流侧栏）内经 用户菜单 → 退出登录 打开确认框。 */
async function openLogoutConfirm(scope: HTMLElement) {
  const trigger = within(scope).getByRole("button", { name: "用户菜单" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  const confirm = await screen.findByRole("alertdialog", { name: "退出登录？" });
  return { confirm, trigger };
}

function logoutRequests(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout").length;
}

/** 窄屏、logout 挂起：覆盖层内确认退出（请求恰发 1 次），确认框仍开。 */
async function beginPendingLogout() {
  const narrow = installViewport(true);
  const pendingLogout = deferredResponse();
  const { fetchMock, view } = mountShell("/", {
    "/api/auth/logout": () => pendingLogout.promise,
  });
  await screen.findByRole("heading", { level: 1, name: HERO });
  const first = await openNav();
  const { confirm, trigger } = await openLogoutConfirm(first.dialog);
  fireEvent.click(within(confirm).getByRole("button", { name: "退出" }));
  expect(logoutRequests(fetchMock)).toBe(1);
  return { fetchMock, first, narrow, pendingLogout, trigger, view };
}

type PendingLogout = Awaited<ReturnType<typeof beginPendingLogout>>;

/** Escape 依次关确认框与覆盖层（发起退出的用户区随之卸载），再重开覆盖层与确认框。 */
async function reopenOverlayConfirm({ first, trigger, view }: PendingLogout) {
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  await expectNavClosed(view.container, first.button);

  const second = await openNav();
  const { confirm } = await openLogoutConfirm(second.dialog);
  return { confirm, dialog: second.dialog };
}

/** 锁定态确认框：退出 忙碌禁用、取消 换成 关闭、用户区有在途提示、请求仍只 1 次。 */
function expectPendingConfirm(confirm: HTMLElement, scope: HTMLElement, fetchMock: FetchMock) {
  const confirmButton = within(confirm).getByRole("button", { name: "退出" });
  expect(confirmButton.hasAttribute("disabled")).toBe(true);
  expect(confirmButton.getAttribute("aria-busy")).toBe("true");
  expect(within(confirm).getByRole("button", { name: "关闭" })).toBeTruthy();
  // 确认框的 hideOthers 把用户区所在树设为 aria-hidden，故带 hidden 查询。
  const note = within(scope).getByRole("status", { hidden: true });
  expect(note.textContent).toMatch(/^正在退出登录/);
  expect(logoutRequests(fetchMock)).toBe(1);
}

/** 挂起的 logout 以 204 落定：回到登录页，全程只发过 1 次请求。 */
async function finishLogout({ fetchMock, pendingLogout }: PendingLogout) {
  await act(async () => pendingLogout.resolve(new Response(null, { status: 204 })));
  expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
  expect(logoutRequests(fetchMock)).toBe(1);
}

/** 再次进入窄屏：覆盖层为关闭态，顶栏提供 打开导航。 */
function reenterNarrow(narrow: FakeMediaQuery) {
  act(() => narrow.emit(true));
  expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  expect(navButton()).toBeTruthy();
}

function expectWideShell() {
  expect(screen.getByRole("complementary", { name: "侧栏" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("banner")).toBeNull();
}

describe("窄屏顶栏与覆盖层入口 (R1/R4/R4b/R5)", () => {
  it("R1 欢迎态：顶栏只含 打开导航，hero 是唯一 h1，无文档流侧栏与对话框", async () => {
    installViewport(true);
    mountShell("/");

    const hero = await screen.findByRole("heading", { level: 1, name: HERO });
    const banner = screen.getByRole("banner");
    expect(banner.classList.contains("topbar")).toBe(true);
    const button = within(banner).getByRole("button", { name: "打开导航" });
    expect(banner.firstElementChild).toBe(button);
    expect(within(banner).queryAllByRole("heading")).toHaveLength(0);
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([hero]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
    expect(screen.queryByRole("button", { name: "折叠侧栏" })).toBeNull();
    expect(screen.queryByRole("button", { name: "展开侧栏" })).toBeNull();
  });

  it("R4 已选会话：顶栏含 打开导航 与唯一 h1 面包屑", async () => {
    installViewport(true);
    const item = { ...chatSnapshot().session, id: SESSION, status: "done" as const, title: "周报" };
    mountShell(`/?session=${SESSION}`, {
      "/api/sessions": () => jsonResponse({ sessions: [item] }),
      [`/api/sessions/${SESSION}/messages`]: () => deferredResponse().promise,
    });

    const banner = await screen.findByRole("banner");
    const crumb = await within(banner).findByRole("heading", {
      level: 1,
      name: "我的工作 / 周报",
    });
    expect(banner.firstElementChild).toBe(within(banner).getByRole("button", { name: "打开导航" }));
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([crumb]);
  });

  it("R4b 标题未知窗口：顶栏只含 打开导航，无 heading、无 hero", async () => {
    installViewport(true);
    mountShell(`/?session=${SESSION}`, {
      "/api/sessions": () => deferredResponse().promise,
      [`/api/sessions/${SESSION}/messages`]: () => deferredResponse().promise,
    });

    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("button", { name: "打开导航" })).toBeTruthy();
    expect(within(banner).queryAllByRole("heading")).toHaveLength(0);
    expect(screen.queryByText(HERO)).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("R5 /settings 直挂：顶栏含 打开导航 与 h1 设置", async () => {
    installViewport(true);
    mountShell("/settings");

    const banner = await screen.findByRole("banner");
    expect(await within(banner).findByRole("heading", { level: 1, name: "设置" })).toBeTruthy();
    expect(banner.firstElementChild).toBe(within(banner).getByRole("button", { name: "打开导航" }));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("宽屏与 matchMedia 兜底 (R2/R2b/R2c)", () => {
  it("R2 不匹配：文档流侧栏、无 打开导航、无对话框、欢迎态无顶栏", async () => {
    installViewport(false);
    mountShell("/");

    await screen.findByRole("heading", { level: 1, name: HERO });
    expectWideShell();
  });

  it("R2b 无 matchMedia（jsdom 默认）按宽屏", async () => {
    mountShell("/");

    await screen.findByRole("heading", { level: 1, name: HERO });
    expectWideShell();
  });

  it("R2c matchMedia 抛错按宽屏且不报错", async () => {
    const consoleError = vi.spyOn(console, "error");
    installMatchMedia(() => {
      throw new Error("boom");
    });
    mountShell("/");

    await screen.findByRole("heading", { level: 1, name: HERO });
    expectWideShell();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("覆盖层开合 (R3/R6)", () => {
  it("R3 打开 → 展开态主导航；选路由即关闭、焦点归还、不写 storage", async () => {
    installViewport(true);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { view } = mountShell("/");
    await screen.findByRole("heading", { level: 1, name: HERO });

    const { button, dialog } = await openNav();
    expect(dialog.getAttribute("data-side")).toBe("left");
    expect(dialog.classList.contains("ui-drawer--w288")).toBe(true);
    const links = overlayLinks(dialog);
    expect(links).toHaveLength(4);
    links.forEach((link, index) => {
      expect(within(link).getByText(LABELS[index] as string, { exact: true })).toBeTruthy();
    });
    expect(within(links[1] as HTMLElement).getByText("文件·预览", { exact: true })).toBeTruthy();
    expect(
      dialog.querySelector('aside[data-collapsed="false"][data-variant="overlay"]'),
    ).not.toBeNull();
    expect(within(dialog).queryByRole("button", { name: "折叠侧栏" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "展开侧栏" })).toBeNull();
    expect(within(dialog).queryByText("WorkBuddy", { exact: true })).toBeNull();
    expect(view.container.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(within(dialog).getByRole("link", { name: /^工作空间/ }));
    await expectNavClosed(view.container, button);
    expect(document.querySelector(".topbar h1")?.textContent).toBe("工作空间");
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
  });

  it("R6 Escape 关闭并归还焦点；关闭 按钮亦关闭", async () => {
    installViewport(true);
    const { view } = mountShell("/");
    await screen.findByRole("heading", { level: 1, name: HERO });

    const first = await openNav();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await expectNavClosed(view.container, first.button);

    const second = await openNav();
    fireEvent.click(within(second.dialog).getByRole("button", { name: "关闭" }));
    await expectNavClosed(view.container, second.button);
  });
});

describe("视口切换与折叠偏好 (R7/R8)", () => {
  it("R7 宽→窄→开→宽→窄：覆盖层不复活，应用根 aria-hidden 复位", async () => {
    const narrow = installViewport(false);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { view } = mountShell("/");
    await screen.findByRole("heading", { level: 1, name: HERO });

    act(() => narrow.emit(true));
    expect(screen.queryByRole("complementary", { name: "侧栏" })).toBeNull();
    await openNav();
    expect(view.container.getAttribute("aria-hidden")).toBe("true");

    act(() => narrow.emit(false));
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    await waitFor(() => expect(view.container.hasAttribute("aria-hidden")).toBe(false));
    const aside = screen.getByRole("complementary", { name: "侧栏" });
    expect(aside.getAttribute("data-collapsed")).toBe("false");
    expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();

    reenterNarrow(narrow);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("R8 预置 collapsed：覆盖层仍展开、storage 不被触碰；切回宽屏为折叠态", async () => {
    window.localStorage.setItem(SIDEBAR_KEY, "collapsed");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const narrow = installViewport(true);
    const { view } = mountShell("/");
    await screen.findByRole("heading", { level: 1, name: HERO });

    const { button, dialog } = await openNav();
    expect(dialog.querySelector('aside[data-collapsed="false"]')).not.toBeNull();
    overlayLinks(dialog).forEach((link, index) => {
      expect(within(link).getByText(LABELS[index] as string, { exact: true })).toBeTruthy();
    });
    fireEvent.click(within(dialog).getByRole("link", { name: /^设置/ }));
    await expectNavClosed(view.container, button);

    act(() => narrow.emit(false));
    const aside = screen.getByRole("complementary", { name: "侧栏" });
    expect(aside.getAttribute("data-collapsed")).toBe("true");
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");

    reenterNarrow(narrow);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("覆盖层内用户区 (R9/R9b/R9c/R9d)", () => {
  it("R9 菜单与确认框叠在覆盖层上，取消后覆盖层仍开、焦点回 用户菜单", async () => {
    installViewport(true);
    const { fetchMock } = mountShell("/");
    await screen.findByRole("heading", { level: 1, name: HERO });

    const { dialog } = await openNav();
    const { confirm, trigger } = await openLogoutConfirm(dialog);
    // 确认框打开期间覆盖层被 aria-hidden（可访问名随之为空），按元素身份断言它仍打开。
    expect(screen.getAllByRole("dialog", { hidden: true })).toContain(dialog);
    expect(dialog.getAttribute("data-state")).toBe("open");

    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(dialog);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(logoutRequests(fetchMock)).toBe(0);
  });

  it("R9b 退出挂起时关闭确认框与覆盖层再重开，锁定态仍在且不再发请求", async () => {
    const flow = await beginPendingLogout();
    const reopened = await reopenOverlayConfirm(flow);
    expectPendingConfirm(reopened.confirm, reopened.dialog, flow.fetchMock);

    await finishLogout(flow);
  });

  it("R9b' 重开后的确认框在挂起的退出失败时关闭，错误提示可见", async () => {
    const flow = await beginPendingLogout();
    const reopened = await reopenOverlayConfirm(flow);
    expectPendingConfirm(reopened.confirm, reopened.dialog, flow.fetchMock);

    const failure = { error: { code: "forbidden", message: "无法退出当前会话" } };
    await act(async () => flow.pendingLogout.resolve(jsonResponse(failure, 403)));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull());
    // 不带 hidden：错误提示所在的覆盖层已解除遮蔽，读屏可达。
    await waitFor(() =>
      expect(within(reopened.dialog).getByRole("alert").textContent).toBe("无法退出当前会话"),
    );
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(reopened.dialog);
    expect(within(reopened.dialog).queryByRole("status", { hidden: true })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
    expect(logoutRequests(flow.fetchMock)).toBe(1);
  });

  it("R9d 覆盖层内关闭退出失败提示，关闭覆盖层再重开不复现", async () => {
    installViewport(true);
    const failure = { error: { code: "forbidden", message: "无法退出当前会话" } };
    const { fetchMock, view } = mountShell("/", {
      "/api/auth/logout": () => jsonResponse(failure, 403),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });

    const first = await openNav();
    const { confirm, trigger } = await openLogoutConfirm(first.dialog);
    fireEvent.click(within(confirm).getByRole("button", { name: "退出" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    const alert = within(first.dialog).getByRole("alert");
    const dismiss = within(alert).getByRole("button", { name: "关闭提示" });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(within(first.dialog).queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await expectNavClosed(view.container, first.button);

    const second = await openNav();
    expect(within(second.dialog).getByRole("button", { name: "用户菜单" })).toBeTruthy();
    expect(within(second.dialog).queryByRole("alert", { hidden: true })).toBeNull();
    expect(logoutRequests(fetchMock)).toBe(1);
  });

  it("R9c 确认框开着时视口跨越 760：锁定态随文档流用户区保留，不再发请求", async () => {
    const flow = await beginPendingLogout();
    const consoleError = vi.spyOn(console, "error");
    const windowErrors: unknown[] = [];
    const onError = (event: ErrorEvent) => windowErrors.push(event.error);
    window.addEventListener("error", onError);

    act(() => flow.narrow.emit(false));
    expect(screen.queryByRole("alertdialog", { hidden: true })).toBeNull();
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    await waitFor(() => expect(flow.view.container.hasAttribute("aria-hidden")).toBe(false));
    const aside = screen.getByRole("complementary", { name: "侧栏" });

    const { confirm } = await openLogoutConfirm(aside);
    expectPendingConfirm(confirm, aside, flow.fetchMock);
    fireEvent.click(within(confirm).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    window.removeEventListener("error", onError);
    expect(windowErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();

    reenterNarrow(flow.narrow);

    await finishLogout(flow);
  });
});

describe("静态契约 (R10)", () => {
  it("横条 CSS 已删、覆盖层规则存在、外壳经 ui 出口取 Drawer、Drawer API 未扩", () => {
    const sidebarCss = stripComments(readRepoFile("web/src/routes/shell/sidebar.css"));
    expect(sidebarCss).not.toContain("max-width: 760px");
    expect(sidebarCss).toContain('.sidebar[data-variant="overlay"]');

    const styles = stripComments(readRepoFile("web/src/styles.css"));
    const narrowBlock = blockBody(styles, /@media\s*\(max-width:\s*760px\)\s*\{/);
    expect(narrowBlock).not.toContain("flex-direction: column");
    expect(narrowBlock).toContain("min-height: 100dvh;");

    const shell = readRepoFile("web/src/routes/shell/app-shell.tsx");
    expect(shell).toContain("useMediaQuery(SHELL_NARROW_QUERY)");
    expect(shell).toMatch(/import \{[^}]*\bDrawer\b[^}]*\} from "\.\.\/\.\.\/ui\/index\.js"/);

    const topbar = readRepoFile("web/src/routes/shell/topbar.tsx");
    expect(topbar).toContain("打开导航");
    expect(topbar).not.toContain("@radix-ui");

    const viewport = readRepoFile("web/src/lib/viewport.ts");
    expect(viewport).toContain("useSyncExternalStore");
    expect(viewport).toContain('"(max-width: 760px)"');

    const drawer = readRepoFile("web/src/ui/drawer.tsx");
    const props = blockBody(drawer, /type DrawerProps = \{/);
    const keys = [...props.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]);
    expect(keys).toEqual(["open", "onOpenChange", "side", "width", "title", "footer", "children"]);
  });
});
