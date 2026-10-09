import "./radix-platform.js";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { chatSnapshot, FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  composerOptionsRoute,
  createFetchMock,
  jsonResponse,
  serviceInfo,
} from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * 窄屏 导航 覆盖层的初始焦点：打开后焦点落在覆盖层自己的 `关闭` 按钮上（与重写前的 Drawer 一致），
 * 不随路由落到会话列表区的按钮或 用户菜单；关闭后焦点仍还给 打开导航。
 */

let disposeRouter: (() => void) | undefined;

// 覆盖层的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 mock 与 DOM。
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

async function mountNarrow(path: string, heading: string, sessions: unknown[] = []) {
  const narrow = createMediaQuery(true);
  const other = createMediaQuery(false);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? narrow : other));
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  const mounted = mountAuthenticatedApp(
    path,
    createFetchMock({
      "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
      "/api/info": () => jsonResponse(serviceInfo),
      "/api/sessions": () => jsonResponse({ sessions }),
      "/api/workspaces": () => jsonResponse({ workspaces: [] }),
      ...composerOptionsRoute(),
    }),
  );
  disposeRouter = () => mounted.router.dispose();
  await screen.findByRole("heading", { level: 1, name: heading });
}

describe("导航 覆盖层初始焦点", () => {
  it.each([
    ["/", "WorkBuddy，我帮你"],
    ["/settings", "设置"],
  ])(
    "%s：打开后活动元素是覆盖层内的 关闭；Escape 关闭后焦点回到 打开导航",
    async (path, heading) => {
      await mountNarrow(path, heading);
      const opener = screen.getByRole("button", { name: "打开导航" });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "导航" });
      // FocusScope 的初始聚焦在挂载后的宏任务里才落定；让出一轮后焦点仍须在 关闭 上。
      await yieldMacrotask();

      const close = within(dialog).getByRole("button", { name: "关闭" });
      expect(document.activeElement).toBe(close);

      fireEvent.keyDown(close, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
    },
  );

  it("会话标题恰为 关闭 时，初始焦点仍在 Sheet 自己的关闭控件上（按标记而非名称定位）", async () => {
    const titled = { ...chatSnapshot().session, status: "done" as const, title: "关闭" };
    await mountNarrow("/", "WorkBuddy，我帮你", [titled]);
    const opener = screen.getByRole("button", { name: "打开导航" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "导航" });
    // 会话项与 Sheet 关闭控件的可访问名都是 关闭，会话项在 DOM 顺序上靠前。
    await waitFor(() =>
      expect(within(dialog).getAllByRole("button", { name: "关闭" })).toHaveLength(2),
    );
    await yieldMacrotask();

    const [sessionItem, sheetClose] = within(dialog).getAllByRole("button", { name: "关闭" });
    expect(sessionItem?.getAttribute("data-slot")).not.toBe("sheet-close");
    expect(sheetClose?.getAttribute("data-slot")).toBe("sheet-close");
    expect(document.activeElement).toBe(sheetClose);
  });
});
