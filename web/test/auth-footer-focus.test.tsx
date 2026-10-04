import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./radix-platform.js";
import {
  authenticatedRoutes,
  expectAuthenticatedShell,
  getFooter,
  openLogoutDialog,
  renderApp,
  resetSettingsTestState,
} from "./settings-support.js";
import { createFetchMock, deferredResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * 退出确认框的焦点契约（ui-primitives「退出确认框忙碌期焦点」）：确认框由拷入层的 alert-dialog 渲染，
 * 忙碌期焦点救回与关闭后的焦点归还都在应用层（features/auth/footer.tsx）实现。
 */

// 确认框的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 DOM。
afterEach(async () => {
  await yieldMacrotask();
  resetSettingsTestState();
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
