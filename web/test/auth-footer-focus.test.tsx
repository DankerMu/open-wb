import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./radix-platform.js";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import {
  authenticatedRoutes,
  createAuthenticatedFetch,
  expectAuthenticatedShell,
  getFooter,
  openLogoutDialog,
  renderApp,
  resetSettingsTestState,
} from "./settings-support.js";
import { createFetchMock, deferredResponse } from "./support.js";
import { waitMs, yieldMacrotask } from "./ui-support.js";

/*
 * 退出确认框的焦点契约（ui-primitives「退出确认框忙碌期焦点」）：确认框由拷入层的 alert-dialog 渲染，
 * 忙碌期焦点救回与关闭后的焦点归还都在应用层（features/auth/footer.tsx）实现。
 */

// 确认框的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 DOM。
afterEach(async () => {
  await yieldMacrotask();
  resetSettingsTestState();
  uninstallMatchMedia();
});

function logoutCalls(fetchMock: ReturnType<typeof createFetchMock>) {
  return fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout");
}

/** 挂载 /files（logout 挂起）并打开退出确认框。 */
async function openPendingConfirm() {
  const pendingLogout = deferredResponse();
  const fetchMock = createFetchMock(
    authenticatedRoutes({ "/api/auth/logout": pendingLogout.promise }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderApp("/files");
  await expectAuthenticatedShell("/files");
  const trigger = within(getFooter()).getByRole("button", { name: "用户菜单" });
  const dialog = await openLogoutDialog();
  return { dialog, fetchMock, trigger };
}

/** 在活动元素上按 Tab / Shift+Tab：返回事件是否未被拦截（false 即焦点循环接管了这次按键）。 */
function pressTab(shiftKey: boolean) {
  return fireEvent.keyDown(document.activeElement as Element, { key: "Tab", shiftKey });
}

describe("退出确认框忙碌期焦点", () => {
  it("pending 上升沿：聚焦中的 退出 被禁用后活动元素为 关闭，Tab 与 Shift+Tab 不出确认框", async () => {
    const { dialog, fetchMock } = await openPendingConfirm();
    const confirm = within(dialog).getByRole("button", { name: "退出" }) as HTMLButtonElement;
    confirm.focus();
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(confirm);

    expect(confirm.disabled).toBe(true);
    const close = within(dialog).getByRole("button", { name: "关闭" });
    expect(document.activeElement).toBe(close);
    expect(within(dialog).queryByRole("button", { name: "取消" })).toBeNull();

    for (const shiftKey of [false, true, false]) {
      // 确认框内只剩 关闭 可聚焦：按键被焦点循环拦下，焦点留在原处。
      expect(pressTab(shiftKey)).toBe(false);
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(close);
    }
    expect(logoutCalls(fetchMock)).toHaveLength(1);
  });

  it("pending 上升沿：焦点已落到 body（浏览器对禁用控件的 focus fixup）时同样移到 关闭", async () => {
    const { dialog } = await openPendingConfirm();
    const confirm = within(dialog).getByRole("button", { name: "退出" });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(confirm);

    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "关闭" }));
  });

  it("pending 保持为 true 的后续渲染不再移动焦点：重开的确认框初始焦点仍在 关闭", async () => {
    const { dialog, fetchMock, trigger } = await openPendingConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    const reopened = await openLogoutDialog();

    const close = within(reopened).getByRole("button", { name: "关闭" });
    expect(document.activeElement).toBe(close);
    await yieldMacrotask();
    expect(document.activeElement).toBe(close);
    expect(logoutCalls(fetchMock)).toHaveLength(1);
  });
});

describe("退出确认框关闭后的焦点归还", () => {
  it("触发按钮可用：Escape 关闭后焦点回到 用户菜单", async () => {
    const { trigger } = await openPendingConfirm();

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("触发按钮被禁用：焦点改还给侧栏里当前路由的导航链接", async () => {
    const { trigger } = await openPendingConfirm();
    (trigger as HTMLButtonElement).disabled = true;

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const current = within(getFooter()).getByRole("link", { name: /^工作空间/ });
    expect(current.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(document.activeElement).toBe(current));
  });
});

/** 挂载 `/`（logout 不在路由表里）；`narrow` 决定外壳断点查询是否匹配。 */
async function mountShell(narrow: boolean) {
  const shell = createMediaQuery(narrow);
  const other = createMediaQuery(false);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? shell : other));
  const fetchMock = createAuthenticatedFetch();
  vi.stubGlobal("fetch", fetchMock);
  renderApp("/");
  await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" });
  return fetchMock;
}

/** `scope` 内经 用户菜单 → 退出登录 打开确认框，等它的初始焦点落定；返回触发按钮与确认框。 */
async function openConfirm(scope: HTMLElement) {
  const trigger = within(scope).getByRole("button", { name: "用户菜单" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  const confirm = await screen.findByRole("alertdialog");
  await yieldMacrotask();
  return { confirm, trigger };
}

/** 在确认框内的活动元素上按一次 Escape。 */
async function escapeInside(confirm: HTMLElement) {
  expect(confirm.contains(document.activeElement), "Escape 前焦点应在确认框内").toBe(true);
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  await waitMs(100);
}

// ui-primitives「覆盖层的 Escape 关闭」：Escape 即取消；嵌套层只关最内一层。
describe("退出确认框的 Escape", () => {
  it("宽屏：Escape 关闭确认框，不发起退出，焦点回到 用户菜单", async () => {
    const fetchMock = await mountShell(false);
    const { confirm, trigger } = await openConfirm(
      screen.getByRole("complementary", { name: "侧栏" }),
    );

    await escapeInside(confirm);

    expect(screen.queryByRole("alertdialog"), "确认框未被 Escape 关闭").toBeNull();
    expect(logoutCalls(fetchMock)).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("窄屏：导航 覆盖层内打开的确认框，一次 Escape 只关确认框，覆盖层保持打开", async () => {
    const fetchMock = await mountShell(true);
    const navButton = screen.getByRole("button", { name: "打开导航" });
    navButton.focus();
    fireEvent.click(navButton);
    // 确认框打开后覆盖层被 aria-hidden，之后一律用这里取到的元素断言。
    const overlay = await screen.findByRole("dialog", { name: "导航" });
    await yieldMacrotask();
    const { confirm, trigger } = await openConfirm(overlay);

    await escapeInside(confirm);

    expect(screen.queryByRole("alertdialog"), "确认框未被 Escape 关闭").toBeNull();
    expect(overlay.isConnected, "Escape 连带关闭了 dialog 导航").toBe(true);
    expect(overlay.getAttribute("data-state")).toBe("open");
    expect(logoutCalls(fetchMock)).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(overlay.contains(trigger)).toBe(true);
  });
});
