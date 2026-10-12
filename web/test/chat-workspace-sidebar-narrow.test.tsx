/**
 * Issue #1105 工作空间侧边栏外壳（tasks 23.4）：workspace-sidebar「布局与开合」的场景「窄屏覆盖」里
 * jsdom 证得了的部分。接缝：真实外壳里的整页，外壳断点的媒体查询由桩给出「匹配」。期望值是规格里的
 * 字面量。
 *
 * jsdom 没有布局也没有 Tab 的焦点移动：盖满视口与「Tab 不离开该层」只在 `make ui-walk` 里证明。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../src/routes/index.js";
import { ToastProvider, useToast } from "../src/ui/index.js";
import {
  cleanupSessionMeta,
  crumb,
  focusOn,
  installNarrowViewport,
} from "./chat-page-session-meta-support.js";
import {
  BOUND,
  bannerButtons,
  CLOSE,
  mountSidebarPage,
  NAME,
  sidebarButton,
} from "./chat-workspace-sidebar-support.js";
import { waitMs, yieldMacrotask } from "./ui-support.js";

let disposeRouter: (() => void) | undefined;

afterEach(async () => {
  disposeRouter?.();
  disposeRouter = undefined;
  await cleanupSessionMeta();
});

/** 窄屏下点顶栏按钮，等模态层的初始焦点落定；返回该层、触发按钮与它的 `focus` 探针。 */
async function openLayer() {
  const trigger = sidebarButton();
  trigger.focus();
  const focus = vi.spyOn(trigger, "focus");
  fireEvent.click(trigger);
  const layer = await screen.findByRole("dialog", { name: NAME });
  await within(layer).findByRole("button", { name: "readme.md" });
  await yieldMacrotask();
  return { focus, layer, trigger };
}

/** 该层已关、焦点回到触发按钮，且归还时只带 `preventScroll`（不滚动消息线程）。 */
async function expectClosed({ focus, trigger }: Awaited<ReturnType<typeof openLayer>>) {
  await waitFor(() => expect(screen.queryByRole("dialog", { name: NAME })).toBeNull());
  await focusOn(trigger);
  expect(focus.mock.calls).toStrictEqual([[{ preventScroll: true }]]);
  expect(sidebarButton()).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
}

describe("窄屏覆盖", () => {
  it("N1 顶栏按钮打开名为 工作空间侧边栏 的模态 dialog，焦点在它唯一的关闭按钮上，没有分隔线；Escape 关闭后焦点回顶栏按钮", async () => {
    installNarrowViewport();
    await mountSidebarPage(BOUND);
    expect(bannerButtons()).toEqual(["打开导航", "重命名", "对话内搜索", NAME]);

    const opened = await openLayer();
    const { layer, trigger } = opened;

    expect(layer.getAttribute("aria-modal")).toBe("true");
    expect(layer.getAttribute("data-slot")).toBe("sheet-content");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // 层外的内容此时都被 aria-hidden，按角色查不到：并排的那一块与分隔线直接在 DOM 里找。
    expect(document.querySelector(`aside[aria-label="${NAME}"]`)).toBeNull();
    expect(document.querySelector('[role="separator"]')).toBeNull();
    const close = within(layer).getByRole("button", { name: CLOSE });
    expect(within(layer).getAllByRole("button", { name: /关闭/ })).toEqual([close]);
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await expectClosed(opened);
  });

  it("N2 层内的 关闭工作空间侧边栏 关闭它，焦点同样归还", async () => {
    installNarrowViewport();
    await mountSidebarPage(BOUND);
    const opened = await openLayer();

    fireEvent.click(within(opened.layer).getByRole("button", { name: CLOSE }));

    await expectClosed(opened);
  });
});

describe("屏上有 Toast 时的 Escape", () => {
  let show: ReturnType<typeof useToast>["show"] | undefined;

  function Probe() {
    show = useToast().show;
    return null;
  }

  /*
   * Toast 的每条 Root 也是一层 DismissableLayer：它后入栈时占住 document 上唯一的 Escape 监听，
   * 模态层的 Radix 收不到 Escape，由 SheetContent 上的 `useEscapeFallback` 关闭。会话页自己今天不出
   * Toast，所以这里在应用旁边挂一个探针来出；顺序固定为「层先开、Toast 后出」（同
   * auth-footer-toast-escape.test.tsx）。
   */
  it("N3 模态层打开后出现 Toast，层内按 Escape 仍关闭该层，Toast 还在", async () => {
    installNarrowViewport();
    const page = await mountSidebarPage(BOUND);
    page.view.unmount();
    const router = createAppRouter();
    disposeRouter = () => router.dispose();
    render(
      <ToastProvider>
        <Probe />
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    await crumb(BOUND.title);
    const opened = await openLayer();

    act(() => show?.({ type: "info", message: "已停止生成" }));
    await yieldMacrotask();
    expect(document.querySelector(".ui-toast")).not.toBeNull();
    expect(opened.layer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitMs(100);

    await expectClosed(opened);
    expect(document.querySelector(".ui-toast")).not.toBeNull();
  });
});
