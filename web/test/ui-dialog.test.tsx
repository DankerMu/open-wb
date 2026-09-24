import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ConfirmDialog, Dialog, Drawer, Icon } from "../src/ui/index.js";
import { blockBody, readRepoFile, stripComments, topLevelBlocks } from "./ui-support.js";

/** FocusScope 卸载归还在 setTimeout(0) 里跑；每个用例结束后让出一个宏任务，避免残留计时器串到下一个用例。 */
function yieldMacrotask() {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

afterEach(async () => {
  cleanup();
  await yieldMacrotask();
  vi.restoreAllMocks();
});

/**
 * 真实浏览器里一次遮罩点击的事件序列。Radix Dialog 以 `deferPointerDownOutside` 挂 DismissableLayer：
 * 左键 pointerdown 只登记，匹配的 click 到达后才判定「外点」并关闭。
 */
function pressOverlay(overlay: Element) {
  fireEvent.pointerDown(overlay);
  fireEvent.mouseDown(overlay);
  fireEvent.pointerUp(overlay);
  fireEvent.mouseUp(overlay);
  fireEvent.click(overlay);
}

function activeElement() {
  return document.activeElement;
}

function closeButton() {
  return screen.getByRole("button", { name: "关闭" });
}

function ruleBody(css: string, selector: string): string {
  const block = topLevelBlocks(css).find((candidate) =>
    candidate.prelude.split(",").some((part) => part.trim() === selector),
  );
  if (!block) throw new Error(`未找到规则 ${selector}`);
  return block.body;
}

/** 页面上的打开者按钮 + 另一个按钮（returnFocus 目标）+ 受控 Dialog。 */
function DialogHarness({ open, withReturnFocus }: { open: boolean; withReturnFocus?: boolean }) {
  const other = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button">打开者</button>
      <button ref={other} type="button">
        其他
      </button>
      <Dialog
        onOpenChange={() => {}}
        open={open}
        returnFocus={withReturnFocus ? other : undefined}
        title="新建"
      >
        <input aria-label="名称" />
      </Dialog>
    </>
  );
}

/** 经 Dialog.Trigger 打开的非受控外壳：状态由 Radix 的 onOpenChange 驱动。 */
function TriggerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      onOpenChange={setOpen}
      open={open}
      title="新建"
      trigger={<button type="button">打开对话框</button>}
    >
      <input aria-label="名称" />
    </Dialog>
  );
}

/** 同上，另传 returnFocus 指向对话框外的另一个按钮：此时由本组件拦截归还，不交给 Radix。 */
function TriggerReturnFocusHarness() {
  const [open, setOpen] = useState(false);
  const other = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={other} type="button">
        其他
      </button>
      <Dialog
        onOpenChange={setOpen}
        open={open}
        returnFocus={other}
        title="新建"
        trigger={<button type="button">打开对话框</button>}
      >
        <input aria-label="名称" />
      </Dialog>
    </>
  );
}

function InitialFocusProbe() {
  const second = useRef<HTMLButtonElement>(null);
  return (
    <Dialog initialFocus={second} onOpenChange={() => {}} open title="新建">
      <input aria-label="名称" />
      <button ref={second} type="button">
        第二个
      </button>
    </Dialog>
  );
}

/** 页面上的「设置」按钮作为 returnFocus 目标 + 受控 ConfirmDialog。 */
function ConfirmHarness({ open }: { open: boolean }) {
  const target = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={target} type="button">
        设置
      </button>
      <ConfirmDialog
        confirmText="退出"
        description="确认退出？"
        onConfirm={() => {}}
        onOpenChange={() => {}}
        open={open}
        returnFocus={target}
        title="退出登录？"
      />
    </>
  );
}

function DrawerHarness({ open }: { open: boolean }) {
  return (
    <>
      <button type="button">导航按钮</button>
      <Drawer onOpenChange={() => {}} open={open} title="导航">
        <a href="/chat">对话</a>
      </Drawer>
    </>
  );
}

describe("Dialog：打开/关闭与 portal (1)", () => {
  it("open 时 portal 到 body、aria-modal、labelledby/describedby 指向标题与说明", () => {
    render(
      <Dialog
        description="说明"
        footer={<Button>确定</Button>}
        onOpenChange={() => {}}
        open
        title="新建"
      >
        <input aria-label="名称" />
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toBe("ui-dialog ui-dialog--md");
    const overlay = dialog.parentElement;
    expect(overlay?.classList.contains("ui-dialog-overlay")).toBe(true);
    expect(overlay?.parentElement).toBe(document.body);
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const title = screen.getByRole("heading", { name: "新建" });
    expect(title.tagName).toBe("H2");
    expect(title.classList.contains("ui-dialog-title")).toBe(true);
    expect(title.id).not.toBe("");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);

    const description = screen.getByText("说明");
    expect(description.classList.contains("ui-dialog-desc")).toBe(true);
    expect(description.id).not.toBe("");
    expect(dialog.getAttribute("aria-describedby")).toBe(description.id);

    expect(dialog.querySelector(".ui-dialog-body input")).not.toBeNull();
    const footer = dialog.querySelector(".ui-dialog-foot");
    expect(footer?.textContent).toBe("确定");
  });

  it("size=sm 映射类名；无 description 时无 describedby 与说明节点；无 footer 不渲染 foot", () => {
    render(
      <Dialog onOpenChange={() => {}} open size="sm" title="新建">
        正文
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toBe("ui-dialog ui-dialog--sm");
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
    expect(dialog.querySelector(".ui-dialog-desc")).toBeNull();
    expect(dialog.querySelector(".ui-dialog-foot")).toBeNull();
  });

  it("open=false 时不渲染", () => {
    render(
      <Dialog onOpenChange={() => {}} open={false} title="新建">
        正文
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".ui-dialog-overlay")).toBeNull();
  });
});

describe("Dialog：焦点进入 (2)", () => {
  it("默认聚焦 head 的 关闭 按钮（首个可聚焦控件）", () => {
    render(
      <Dialog onOpenChange={() => {}} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    expect(activeElement()).toBe(closeButton());
  });

  it("dismissible=false：无 关闭 按钮，聚焦 body 内首个控件", () => {
    render(
      <Dialog dismissible={false} onOpenChange={() => {}} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(activeElement()).toBe(screen.getByRole("textbox", { name: "名称" }));
  });

  it("initialFocus 指向 body 内第二个控件时该控件获焦", () => {
    render(<InitialFocusProbe />);
    expect(activeElement()).toBe(screen.getByRole("button", { name: "第二个" }));
  });
});

describe("Dialog：Tab 循环 (3)", () => {
  function renderLoop() {
    render(
      <Dialog footer={<Button>确定</Button>} onOpenChange={() => {}} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    return { first: closeButton(), last: screen.getByRole("button", { name: "确定" }) };
  }

  it("最后一个控件上 Tab → 第一个", () => {
    const { first, last } = renderLoop();
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(activeElement()).toBe(first);
  });

  it("第一个控件上 Shift+Tab → 最后一个", () => {
    const { first, last } = renderLoop();
    expect(activeElement()).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(activeElement()).toBe(last);
  });
});

describe("Dialog：Escape 与 关闭 按钮 (4)", () => {
  it("Escape → onOpenChange(false) 一次", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog onOpenChange={onOpenChange} open title="新建">
        正文
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("dismissible=false：Escape 不调用", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog dismissible={false} onOpenChange={onOpenChange} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("关闭 按钮点击 → onOpenChange(false)，按钮为 ghost icon", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog onOpenChange={onOpenChange} open title="新建">
        正文
      </Dialog>,
    );
    const close = closeButton();
    expect(close.className).toBe("ui-btn ui-btn--ghost ui-btn--icon");
    expect(close.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("Dialog：遮罩 (5)", () => {
  it("遮罩点击 → onOpenChange(false) 一次；内容内点击不关闭", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog onOpenChange={onOpenChange} open title="新建">
        <p>正文</p>
      </Dialog>,
    );
    await yieldMacrotask();
    pressOverlay(screen.getByText("正文"));
    expect(onOpenChange).not.toHaveBeenCalled();
    const overlay = document.querySelector(".ui-dialog-overlay");
    if (!overlay) throw new Error("缺遮罩");
    pressOverlay(overlay);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("dismissible=false：遮罩点击不调用", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog dismissible={false} onOpenChange={onOpenChange} open title="新建">
        <input aria-label="名称" />
      </Dialog>,
    );
    await yieldMacrotask();
    const overlay = document.querySelector(".ui-dialog-overlay");
    if (!overlay) throw new Error("缺遮罩");
    pressOverlay(overlay);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("Dialog：焦点归还 (6)", () => {
  it("无 trigger、无 returnFocus：归还打开瞬间的活动元素", async () => {
    const { rerender } = render(<DialogHarness open={false} />);
    const opener = screen.getByRole("button", { name: "打开者" });
    opener.focus();
    rerender(<DialogHarness open />);
    expect(activeElement()).toBe(closeButton());
    rerender(<DialogHarness open={false} />);
    await waitFor(() => expect(activeElement()).toBe(opener));
  });

  it("打开前活动元素为 body、传 returnFocus：关闭后焦点在其指向元素", async () => {
    const { rerender } = render(<DialogHarness open={false} withReturnFocus />);
    const other = screen.getByRole("button", { name: "其他" });
    expect(activeElement()).toBe(document.body);
    rerender(<DialogHarness open withReturnFocus />);
    expect(activeElement()).toBe(closeButton());
    rerender(<DialogHarness open={false} withReturnFocus />);
    await waitFor(() => expect(activeElement()).toBe(other));
  });

  it("returnFocus 优先于打开者", async () => {
    const { rerender } = render(<DialogHarness open={false} withReturnFocus />);
    const opener = screen.getByRole("button", { name: "打开者" });
    const other = screen.getByRole("button", { name: "其他" });
    opener.focus();
    rerender(<DialogHarness open withReturnFocus />);
    rerender(<DialogHarness open={false} withReturnFocus />);
    await waitFor(() => expect(activeElement()).toBe(other));
  });

  /** 点击 trigger 打开（焦点从 body 出发、未聚焦 trigger）→ 断言已打开 → Escape 关闭；返回 trigger。 */
  function openViaTriggerThenEscape() {
    const trigger = screen.getByRole("button", { name: "打开对话框" });
    expect(activeElement()).toBe(document.body);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(activeElement()).toBe(closeButton());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    return trigger;
  }

  it("有 trigger、无 returnFocus（点击打开、未聚焦 trigger）：由 Radix 归还 trigger", async () => {
    render(<TriggerHarness />);
    const trigger = openViaTriggerThenEscape();
    await waitFor(() => expect(activeElement()).toBe(trigger));
  });

  it("有 trigger 且传 returnFocus：关闭后焦点归还 returnFocus 而非 trigger", async () => {
    render(<TriggerReturnFocusHarness />);
    const other = screen.getByRole("button", { name: "其他" });
    const trigger = openViaTriggerThenEscape();
    await waitFor(() => expect(activeElement()).toBe(other));
    expect(activeElement()).not.toBe(trigger);
  });
});

describe("ConfirmDialog (7)", () => {
  function renderConfirm(props: { danger?: boolean; pending?: boolean; cancelText?: string } = {}) {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        confirmText="退出"
        description="确认退出当前账号？"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open
        title="退出登录？"
        {...props}
      />,
    );
    return { onOpenChange, onConfirm };
  }

  it("alertdialog：sm 宽、aria-modal、h2 标题带装饰图标、describedby 指向说明、无 关闭 按钮", () => {
    renderConfirm({ danger: true });
    const dialog = screen.getByRole("alertdialog");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialog.className).toBe("ui-dialog ui-dialog--sm");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { name: "退出登录？" });
    expect(heading.tagName).toBe("H2");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    const icon = heading.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.classList.contains("lucide-triangle-alert")).toBe(true);
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("确认退出当前账号？").id);
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("取消 → onOpenChange(false)；退出 → onConfirm 一次；danger 确认按钮为 ui-btn--danger", () => {
    const { onOpenChange, onConfirm } = renderConfirm({ danger: true });
    const cancel = screen.getByRole("button", { name: "取消" });
    const confirm = screen.getByRole("button", { name: "退出" });
    expect(cancel.classList.contains("ui-btn--ghost")).toBe(true);
    expect(confirm.classList.contains("ui-btn--danger")).toBe(true);
    fireEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("非 danger：确认为 primary、标题图标为 info；cancelText 可改", () => {
    renderConfirm({ cancelText: "再想想" });
    expect(screen.getByRole("button", { name: "退出" }).classList.contains("ui-btn--primary")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "再想想" })).toBeTruthy();
    const icon = screen.getByRole("heading", { name: "退出登录？" }).querySelector("svg");
    expect(icon?.classList.contains("lucide-info")).toBe(true);
  });

  it("pending：确认按钮 aria-busy 且禁用，点击不触发 onConfirm", () => {
    const { onConfirm } = renderConfirm({ danger: true, pending: true });
    const confirm = screen.getByRole("button", { name: "退出" });
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("遮罩点击不关闭；Escape 关闭（= 取消）", async () => {
    const { onOpenChange } = renderConfirm({ danger: true });
    await yieldMacrotask();
    const overlay = document.querySelector(".ui-dialog-overlay");
    if (!overlay) throw new Error("缺遮罩");
    pressOverlay(overlay);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("children 渲染在 .ui-dialog-body 内（可放块级 <p>），无 DOM 嵌套告警", async () => {
    const error = vi.spyOn(console, "error");
    render(
      <ConfirmDialog
        confirmText="退出"
        description="确认退出当前账号？"
        onConfirm={() => {}}
        onOpenChange={() => {}}
        open
        pending
        title="退出登录？"
      >
        <p>退出请求已发送</p>
      </ConfirmDialog>,
    );
    await yieldMacrotask();
    const hint = screen.getByText("退出请求已发送");
    expect(hint.tagName).toBe("P");
    expect(hint.parentElement?.classList.contains("ui-dialog-body")).toBe(true);
    expect(screen.getByRole("alertdialog").contains(hint)).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("returnFocus 透传：关闭后焦点回到其指向元素", async () => {
    const { rerender } = render(<ConfirmHarness open={false} />);
    const target = screen.getByRole("button", { name: "设置" });
    expect(activeElement()).toBe(document.body);
    rerender(<ConfirmHarness open />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    rerender(<ConfirmHarness open={false} />);
    await waitFor(() => expect(activeElement()).toBe(target));
  });
});

describe("Drawer (8)", () => {
  it("默认右侧 420：类名、data-side、aria-modal、labelledby、无 describedby，遮罩与内容同级于 body", () => {
    render(
      <Drawer footer={<Button>保存</Button>} onOpenChange={() => {}} open title="详情">
        正文
      </Drawer>,
    );
    const drawer = screen.getByRole("dialog");
    expect(drawer.className).toBe("ui-drawer ui-drawer--right ui-drawer--w420");
    expect(drawer.getAttribute("data-side")).toBe("right");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    const title = screen.getByRole("heading", { name: "详情" });
    expect(title.classList.contains("ui-drawer-title")).toBe(true);
    expect(drawer.getAttribute("aria-labelledby")).toBe(title.id);
    expect(drawer.hasAttribute("aria-describedby")).toBe(false);
    expect(drawer.parentElement).toBe(document.body);
    const overlay = document.querySelector(".ui-drawer-overlay");
    expect(overlay?.parentElement).toBe(document.body);
    expect(overlay?.contains(drawer)).toBe(false);
    expect(drawer.querySelector(".ui-drawer-body")?.textContent).toBe("正文");
    expect(drawer.querySelector(".ui-drawer-foot")?.textContent).toBe("保存");
  });

  it("side=left width=288 映射类名与 data-side", () => {
    render(
      <Drawer onOpenChange={() => {}} open side="left" title="导航" width={288}>
        正文
      </Drawer>,
    );
    const drawer = screen.getByRole("dialog");
    expect(drawer.className).toBe("ui-drawer ui-drawer--left ui-drawer--w288");
    expect(drawer.getAttribute("data-side")).toBe("left");
    expect(drawer.querySelector(".ui-drawer-foot")).toBeNull();
  });

  it("关闭 按钮、Escape、遮罩点击各调用 onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer onOpenChange={onOpenChange} open title="导航">
        正文
      </Drawer>,
    );
    fireEvent.click(closeButton());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    await yieldMacrotask();
    const overlay = document.querySelector(".ui-drawer-overlay");
    if (!overlay) throw new Error("缺遮罩");
    pressOverlay(overlay);
    expect(onOpenChange).toHaveBeenCalledTimes(3);
    expect(onOpenChange.mock.calls).toEqual([[false], [false], [false]]);
  });

  it("焦点归还到打开者", async () => {
    const { rerender } = render(<DrawerHarness open={false} />);
    const opener = screen.getByRole("button", { name: "导航按钮" });
    opener.focus();
    rerender(<DrawerHarness open />);
    expect(activeElement()).toBe(closeButton());
    rerender(<DrawerHarness open={false} />);
    await waitFor(() => expect(activeElement()).toBe(opener));
  });
});

describe("静态契约 (9)", () => {
  const dialogCss = () => stripComments(readRepoFile("web/src/ui/dialog.css"));

  it.each([
    [".ui-drawer--w288", /width:\s*288px/],
    [".ui-drawer--w420", /width:\s*420px/],
    [".ui-drawer", /max-width:\s*92vw/],
    [".ui-dialog--sm", /width:\s*400px/],
    [".ui-dialog", /width:\s*520px/],
    [".ui-dialog", /max-height:\s*82vh/],
    [".ui-dialog-overlay", /z-index:\s*1400\b/],
    [".ui-drawer-overlay", /z-index:\s*1350\b/],
    [".ui-drawer", /z-index:\s*1360\b/],
    [".ui-drawer--left", /animation:\s*ui-drawer-in-left\b/],
    [".ui-drawer--right", /animation:\s*wb-drawer-in\b/],
    [".ui-dialog:focus-visible", /border-radius:\s*14px/],
  ])("dialog.css %s 含 %s", (selector, pattern) => {
    expect(ruleBody(dialogCss(), selector)).toMatch(pattern);
  });

  it("reduced-motion 块把覆盖层与两侧抽屉选择器（六个）置为 animation: none", () => {
    const reduced = blockBody(dialogCss(), /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    const rules = [...reduced.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
      ([, selectors = "", body = ""]) => ({
        selectors: selectors.split(",").map((selector) => selector.trim()),
        body,
      }),
    );
    for (const name of [
      ".ui-dialog-overlay",
      ".ui-dialog",
      ".ui-drawer-overlay",
      ".ui-drawer",
      ".ui-drawer--left",
      ".ui-drawer--right",
    ]) {
      const covering = rules.filter(
        (rule) => rule.selectors.includes(name) && /animation:\s*none/.test(rule.body),
      );
      expect(covering, name).not.toHaveLength(0);
    }
  });

  it("左侧入场关键帧写在 dialog.css；ui.css 汇总 dialog.css", () => {
    expect(dialogCss()).toMatch(/@keyframes ui-drawer-in-left\s*\{/);
    expect(readRepoFile("web/src/ui/ui.css")).toContain('@import "./dialog.css";');
  });

  it("radix-platform.ts 只在缺失时定义四项 shim，且不补 PointerEvent", () => {
    const shim = readRepoFile("web/test/radix-platform.ts");
    expect(shim).toContain('!("ResizeObserver" in globalThis)');
    for (const name of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
      "scrollIntoView",
    ]) {
      expect(shim).toMatch(new RegExp(`\\.${name} \\?\\?= `));
      expect(shim).not.toMatch(new RegExp(`\\.${name} = `));
    }
    expect(shim).not.toContain("PointerEvent");
  });

  it("radix-platform.ts 重新执行时不覆盖已有实现", async () => {
    const prototype = Element.prototype;
    const saved = {
      resizeObserver: globalThis.ResizeObserver,
      hasPointerCapture: prototype.hasPointerCapture,
      setPointerCapture: prototype.setPointerCapture,
      releasePointerCapture: prototype.releasePointerCapture,
      scrollIntoView: prototype.scrollIntoView,
    };
    class ExistingResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const existing = {
      hasPointerCapture: () => true,
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      scrollIntoView: () => {},
    };
    globalThis.ResizeObserver = ExistingResizeObserver;
    Object.assign(prototype, existing);
    try {
      vi.resetModules();
      await import("./radix-platform.js");
      expect(globalThis.ResizeObserver).toBe(ExistingResizeObserver);
      expect(prototype.hasPointerCapture).toBe(existing.hasPointerCapture);
      expect(prototype.setPointerCapture).toBe(existing.setPointerCapture);
      expect(prototype.releasePointerCapture).toBe(existing.releasePointerCapture);
      expect(prototype.scrollIntoView).toBe(existing.scrollIntoView);
    } finally {
      globalThis.ResizeObserver = saved.resizeObserver;
      Object.assign(prototype, {
        hasPointerCapture: saved.hasPointerCapture,
        setPointerCapture: saved.setPointerCapture,
        releasePointerCapture: saved.releasePointerCapture,
        scrollIntoView: saved.scrollIntoView,
      });
    }
  });
});

describe("无 description 时无控制台告警 (9b)", () => {
  it("Dialog/Drawer 打开与关闭期间 console.warn/error 未被调用", async () => {
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const view = render(
      <>
        <Dialog onOpenChange={() => {}} open title="新建">
          正文
        </Dialog>
        <Drawer onOpenChange={() => {}} open title="导航">
          正文
        </Drawer>
      </>,
    );
    await yieldMacrotask();
    view.rerender(
      <>
        <Dialog onOpenChange={() => {}} open={false} title="新建">
          正文
        </Dialog>
        <Drawer onOpenChange={() => {}} open={false} title="导航">
          正文
        </Drawer>
      </>,
    );
    await yieldMacrotask();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("出口 (10)", () => {
  it("三组件经 ui/index 导出", () => {
    for (const component of [Dialog, ConfirmDialog, Drawer]) {
      expect(typeof component).toBe("function");
    }
  });

  it.each([
    ["triangle-alert", "lucide-triangle-alert"],
    ["info", "lucide-info"],
  ] as const)("Icon %s 渲染 svg", (name, className) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg?.classList.contains(className)).toBe(true);
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});
