import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Dialog, Drawer, ToastProvider, useToast } from "../src/ui/index.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * #643：Escape 分派不受 Toast 层栈影响（ui-primitives）。Toast 在覆盖层之后出现即成为 DismissableLayer
 * 层栈的最高层、独占 document 上的 Escape 监听；覆盖层须经 Content 的 onKeyDown 兜底关闭自己，且 Toast
 * 不因焦点外的 Escape 关闭。Escape 一律派发在覆盖层内的焦点元素上（派发在 document 上走不到兜底）。
 */

type Show = ReturnType<typeof useToast>["show"];

let show: Show | undefined;

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  show = undefined;
  await yieldMacrotask();
  vi.restoreAllMocks();
});

function Probe() {
  show = useToast().show;
  return null;
}

function renderWithToasts(ui: ReactNode) {
  render(
    <ToastProvider>
      <Probe />
      {ui}
    </ToastProvider>,
  );
}

function showToast(message = "已停止生成") {
  const toastApi = show;
  if (!toastApi) throw new Error("Probe 未就绪");
  act(() => toastApi({ type: "info", message }));
}

const toastPresent = () => document.querySelector(".ui-toast") !== null;

/** 覆盖层已就绪（层监听挂上）后再让 Toast 出现，使 Toast 层后入栈成为最高层。 */
async function toastOverOverlay(role: "dialog" | "alertdialog") {
  const content = await screen.findByRole(role);
  await yieldMacrotask();
  showToast();
  await yieldMacrotask();
  expect(toastPresent()).toBe(true);
  return focusedIn(content);
}

/** 覆盖层内的焦点元素（Radix 打开时自动聚焦首个可聚焦控件）。 */
function focusedIn(content: HTMLElement) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !content.contains(active)) {
    throw new Error("焦点不在覆盖层内");
  }
  return active;
}

function pressEscape(target: Element) {
  fireEvent.keyDown(target, { key: "Escape" });
}

describe("Toast 在覆盖层之后出现 (D1/D2/D3)", () => {
  it("D1 dismissible Dialog：Escape → onOpenChange(false) 恰一次，Toast 仍在", async () => {
    const onOpenChange = vi.fn();
    renderWithToasts(
      <Dialog onOpenChange={onOpenChange} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    pressEscape(await toastOverOverlay("dialog"));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastPresent()).toBe(true);
  });

  it("D1 输入法组合中的 Escape 不触发兜底关闭", async () => {
    const onOpenChange = vi.fn();
    renderWithToasts(
      <Dialog onOpenChange={onOpenChange} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    fireEvent.keyDown(await toastOverOverlay("dialog"), { key: "Escape", isComposing: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "新建" })).toBeTruthy();
  });

  it("D2 dismissible=false Dialog：Escape 不调用 onOpenChange，对话框仍在", async () => {
    const onOpenChange = vi.fn();
    renderWithToasts(
      <Dialog dismissible={false} onOpenChange={onOpenChange} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    pressEscape(await toastOverOverlay("dialog"));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "新建" })).toBeTruthy();
  });

  it("D3 ConfirmDialog：Escape = 取消，onOpenChange(false) 恰一次、onConfirm 未调用，Toast 仍在", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    renderWithToasts(
      <ConfirmDialog
        confirmText="退出"
        description="确认退出？"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open
        title="退出登录？"
      />,
    );
    pressEscape(await toastOverOverlay("alertdialog"));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(toastPresent()).toBe(true);
  });
});

describe("无 Toast 时覆盖层为最高层 (D4)", () => {
  it.each([
    [
      "Drawer",
      (onOpenChange: (open: boolean) => void) => (
        <Drawer onOpenChange={onOpenChange} open title="导航">
          <button type="button">项</button>
        </Drawer>
      ),
    ],
    [
      "Dialog",
      (onOpenChange: (open: boolean) => void) => (
        <Dialog onOpenChange={onOpenChange} open title="新建">
          <input aria-label="名称" />
        </Dialog>
      ),
    ],
  ])("D4 %s：Radix 关闭，兜底不重复，onOpenChange(false) 恰一次", async (_, overlay) => {
    const onOpenChange = vi.fn();
    renderWithToasts(overlay(onOpenChange));
    const content = await screen.findByRole("dialog");
    await yieldMacrotask();
    pressEscape(focusedIn(content));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Toast 只响应通知区内的 Escape (D6)", () => {
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("D6 焦点在页面其它元素时 Escape 不关 Toast、2400ms 后到期；目标在 toast 内时 Escape 关闭", () => {
    vi.useFakeTimers();
    renderWithToasts(<button type="button">页面</button>);
    showToast();
    const page = screen.getByRole("button", { name: "页面" });
    page.focus();
    pressEscape(page);
    expect(toastPresent(), "焦点外的 Escape 关闭了 Toast").toBe(true);
    advance(2400);
    expect(toastPresent()).toBe(false);

    showToast("已复制");
    const toast = document.querySelector(".ui-toast");
    if (!toast) throw new Error("未渲染 .ui-toast");
    pressEscape(toast);
    expect(toastPresent()).toBe(false);
  });
});
