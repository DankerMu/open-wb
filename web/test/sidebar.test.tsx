import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "./radix-platform.js";
import { routeManifest } from "../src/routes/manifest.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  type FetchMock,
  jsonResponse,
} from "./support.js";
import { readRepoFile, yieldMacrotask } from "./ui-support.js";

const STORAGE_KEY = "workbuddy-sidebar";
const LABELS = ["会话", "工作空间", "中心", "设置"];

let disposeRouter: (() => void) | undefined;

function mountFiles(): FetchMock {
  const fetchMock = createFetchMock({
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    "/api/auth/logout": () => new Response(null, { status: 204 }),
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
