import "./radix-platform.js";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ConfirmDialog, Dialog } from "../src/ui/index.js";
import { yieldMacrotask } from "./ui-support.js";

// 忙碌期焦点救回（DialogFrame 的 busy 上升沿）。jsdom 不做 focus fixup：禁用已聚焦按钮后活动元素
// 仍是该按钮（真实 Chromium 在设置 disabled 时同步移到 body），所以「内容内已禁用」与「body」两个分支分别构造。
// 真实浏览器的 fixup 由 ui-walk 退出段证明。

afterEach(async () => {
  cleanup();
  await yieldMacrotask();
  vi.restoreAllMocks();
});

/** 内容内首个未禁用可聚焦控件的独立判定（与实现同义的选择器，测试里显式算出）。 */
const FIRST_ENABLED_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function confirmElement(pending: boolean, children?: ReactNode) {
  return (
    <ConfirmDialog
      cancelText={pending ? "关闭" : "取消"}
      confirmText="退出"
      danger
      description="确认退出当前账号？"
      onConfirm={() => {}}
      onOpenChange={() => {}}
      open
      pending={pending}
      title="退出登录？"
    >
      {children}
    </ConfirmDialog>
  );
}

function formElement(busy: boolean, submitDisabled: boolean) {
  return (
    <Dialog
      busy={busy}
      footer={
        <Button disabled={submitDisabled} type="submit" variant="primary">
          创建
        </Button>
      }
      onOpenChange={() => {}}
      open
      title="新建"
    >
      <input aria-label="名称" />
    </Dialog>
  );
}

/** B1 的完整步骤：聚焦 `退出` 后 pending false→true；返回 rerender 供后续用例继续。 */
function focusConfirmThenGoPending() {
  const view = render(confirmElement(false));
  const confirm = screen.getByRole("button", { name: "退出" });
  confirm.focus();
  expect(document.activeElement).toBe(confirm);
  view.rerender(confirmElement(true));
  expect(confirm.hasAttribute("disabled")).toBe(true);
  return view;
}

describe("DialogFrame busy 焦点救回", () => {
  it("B1 ConfirmDialog：焦点在 退出 时 pending 上升 → 焦点救回取消按钮（关闭）", () => {
    focusConfirmThenGoPending();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
  });

  it("B2 ConfirmDialog：焦点已落到 body 时 pending 上升 → 焦点救回取消按钮（关闭）", () => {
    const view = render(confirmElement(false));
    const confirm = screen.getByRole("button", { name: "退出" });
    confirm.focus();
    confirm.blur();
    expect(document.activeElement).toBe(document.body);
    view.rerender(confirmElement(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
  });

  it("B3 Dialog：焦点在未禁用的 input 上时 busy 上升 → 不移动焦点", () => {
    const view = render(formElement(false, false));
    const input = screen.getByRole("textbox", { name: "名称" });
    input.focus();
    expect(document.activeElement).toBe(input);
    view.rerender(formElement(true, false));
    expect(document.activeElement).toBe(input);
  });

  it("B4 Dialog：聚焦的提交按钮随 busy 上升被禁用 → 焦点落到内容内首个未禁用控件", () => {
    const view = render(formElement(false, false));
    const submit = screen.getByRole("button", { name: "创建" });
    submit.focus();
    expect(document.activeElement).toBe(submit);
    view.rerender(formElement(true, true));
    expect(submit.hasAttribute("disabled")).toBe(true);
    const expected = screen.getByRole("dialog").querySelector<HTMLElement>(FIRST_ENABLED_FOCUSABLE);
    expect(expected).toBe(screen.getByRole("button", { name: "关闭" }));
    expect(document.activeElement).toBe(expected);
  });

  it("B5 ConfirmDialog：pending 保持 true 的后续重渲染不再救回（仅上升沿触发）", () => {
    const view = focusConfirmThenGoPending();
    const cancel = screen.getByRole("button", { name: "关闭" });
    expect(document.activeElement).toBe(cancel);
    cancel.blur();
    expect(document.activeElement).toBe(document.body);
    // 只新增节点（不删除/替换），避免 FocusScope 的 removedNodes 分支把焦点移到容器。
    view.rerender(confirmElement(true, <p>退出请求已发送</p>));
    expect(screen.getByText("退出请求已发送")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});
