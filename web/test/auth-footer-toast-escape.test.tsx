import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_NARROW_QUERY } from "../src/lib/viewport.js";
import { createAppRouter } from "../src/routes/index.js";
import { ToastProvider, useToast } from "../src/ui/index.js";
import { FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import { createMediaQuery, installMatchMedia, uninstallMatchMedia } from "./media-query-support.js";
import {
  authenticatedPrincipal,
  composerOptionsRoute,
  createFetchMock,
  type FetchMock,
  jsonResponse,
  serviceInfo,
  setBrowserPath,
} from "./support.js";
import { waitMs, yieldMacrotask } from "./ui-support.js";

/*
 * 退出确认框的 Escape 兜底（#643 的同一层栈问题，落在 features/auth/footer.tsx 的接线上）：Toast 的每条
 * Root 是一个 DismissableLayer，后入栈的 Toast 占住 document 上唯一的 Escape 监听，确认框的 Radix 层收不到
 * Escape；由 AlertDialogContent 上的 `useEscapeFallback`（ref / onEscapeKeyDown / onKeyDown）关闭。
 * 顺序固定为「确认框先开、Toast 后出」——反过来时 act 会冲刷掉层交接，Radix 自己就能关，测不到兜底。
 */

const HERO = "WorkBuddy，我帮你";
const TOAST = "已停止生成";

type Show = ReturnType<typeof useToast>["show"];

let show: Show | undefined;
let disposeRouter: (() => void) | undefined;

afterEach(async () => {
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  show = undefined;
  uninstallMatchMedia();
  // 确认框与覆盖层的 FocusScope 在卸载后的宏任务里归还焦点，先让出一轮再清 DOM。
  await yieldMacrotask();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.replaceChildren();
});

function Probe() {
  show = useToast().show;
  return null;
}

/** 与 ui-toast-drawer-escape 的 mountNarrowShell 同构；`narrow` 决定外壳断点查询是否匹配。 */
async function mountShell(narrow: boolean): Promise<FetchMock> {
  const shell = createMediaQuery(narrow);
  const other = createMediaQuery(false);
  installMatchMedia((query) => (query === SHELL_NARROW_QUERY ? shell : other));
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  setBrowserPath("/");
  const fetchMock = createFetchMock({
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/info": () => jsonResponse(serviceInfo),
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    ...composerOptionsRoute(),
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createAppRouter();
  render(
    <ToastProvider>
      <Probe />
      <RouterProvider router={router} />
    </ToastProvider>,
  );
  disposeRouter = () => router.dispose();
  await screen.findByRole("heading", { level: 1, name: HERO });
  return fetchMock;
}

function showToast() {
  if (!show) throw new Error("Probe 未就绪");
  const toastApi = show;
  act(() => toastApi({ type: "info", message: TOAST }));
}

const toastPresent = () => document.querySelector(".ui-toast") !== null;

function logoutCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([path]) => path === "/api/auth/logout");
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

/** Toast 后入栈，再在确认框内的活动元素上按一次 Escape。 */
async function showToastThenEscapeInside(confirm: HTMLElement) {
  showToast();
  await yieldMacrotask();
  expect(toastPresent(), "Toast 应已出现").toBe(true);
  expect(confirm.contains(document.activeElement), "Escape 前焦点应在确认框内").toBe(true);
  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  await waitMs(100);
}

describe("退出确认框：Toast 在场时的 Escape 兜底", () => {
  it("宽屏：Escape 关闭确认框，Toast 仍在，不发起退出，焦点回到 用户菜单", async () => {
    const fetchMock = await mountShell(false);
    const { confirm, trigger } = await openConfirm(
      screen.getByRole("complementary", { name: "侧栏" }),
    );

    await showToastThenEscapeInside(confirm);

    expect(screen.queryByRole("alertdialog"), "确认框未被 Escape 关闭").toBeNull();
    expect(toastPresent(), "Toast 被 Escape 关闭").toBe(true);
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

    await showToastThenEscapeInside(confirm);

    expect(screen.queryByRole("alertdialog"), "确认框未被 Escape 关闭").toBeNull();
    expect(overlay.isConnected, "Escape 连带关闭了 dialog 导航").toBe(true);
    expect(overlay.getAttribute("data-state")).toBe("open");
    expect(toastPresent(), "Toast 被 Escape 关闭").toBe(true);
    expect(logoutCalls(fetchMock)).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(overlay.contains(trigger)).toBe(true);
  });
});
