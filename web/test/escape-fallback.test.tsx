import "./radix-platform.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useEscapeFallback } from "../src/components/escape-fallback.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * 兜底 hook 自身的性质（ui-primitives「覆盖层的 Escape 关闭」场景「保留兜底时不重复、不抢输入法」）：
 * 同一次 Escape 不关两次、输入法组合中不关、不响应本层子树之外的目标。整页渲染测不出这三条——Radix 自己
 * 就会关掉最高层，去掉兜底里任何一个判断整页用例都照样通过——所以把 hook 直接接在元素上测。
 */

type Fallback = ReturnType<typeof useEscapeFallback>;

afterEach(async () => {
  cleanup();
  await yieldMacrotask();
});

/**
 * 搭台 (1)：hook 接在一个普通 `div` 上，没有 Radix。`嵌套层` 按钮在 React 树里是该 `div` 的后代、
 * DOM 上却 portal 到 body：它上面的按键会冒泡进 `div` 的 `onKeyDown`，而目标不在 `div` 的 DOM 子树内。
 */
function Plain({
  canClose = true,
  onOpenChange,
  expose,
}: {
  canClose?: boolean;
  onOpenChange: (open: boolean) => void;
  expose?: (fallback: Fallback) => void;
}) {
  const fallback = useEscapeFallback({ canClose, onOpenChange });
  expose?.(fallback);
  return (
    <div onKeyDown={fallback.onKeyDown} ref={fallback.ref} role="dialog">
      <input aria-label="名称" />
      {createPortal(<button type="button">嵌套层</button>, document.body)}
    </div>
  );
}

/** 搭台 (2)：按调用点的写法（三个属性）接在拷入层 `Dialog` 的内容元素上；同一个回调既给 Radix 也给兜底。 */
function Overlay({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogTitle>新建</DialogTitle>
        <DialogDescription>填写名称</DialogDescription>
        <input aria-label="名称" />
      </DialogContent>
    </Dialog>
  );
}

const field = () => screen.getByRole("textbox", { name: "名称" });

describe("兜底接在普通元素上（没有 Radix）", () => {
  it("子树内的 Escape → 关闭回调以 false 恰一次；其它键不关闭", () => {
    const onOpenChange = vi.fn();
    render(<Plain onOpenChange={onOpenChange} />);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("输入法组合中的 Escape 不关闭", () => {
    const onOpenChange = vi.fn();
    render(<Plain onOpenChange={onOpenChange} />);
    fireEvent.keyDown(field(), { key: "Escape", isComposing: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("目标在本层 DOM 子树之外（portal 在外的嵌套层）的 Escape 不关闭", () => {
    const onOpenChange = vi.fn();
    const onKeyDown = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: 只用来证明这次按键确实冒泡经过了 React 树
      <div onKeyDown={onKeyDown}>
        <Plain onOpenChange={onOpenChange} />
      </div>,
    );
    const nested = screen.getByRole("button", { name: "嵌套层" });
    expect(screen.getByRole("dialog").contains(nested)).toBe(false);
    fireEvent.keyDown(nested, { key: "Escape" });
    // 按键经 React 树到达了兜底所在的元素之上，兜底没有因为它关闭。
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("已由 onEscapeKeyDown 标记的同一个原生事件再进 onKeyDown 不关闭；下一次 Escape 照常关闭", () => {
    const onOpenChange = vi.fn();
    let fallback: Fallback | undefined;
    render(
      <Plain
        expose={(value) => {
          fallback = value;
        }}
        onOpenChange={onOpenChange}
      />,
    );
    // 与 Radix 相同的次序：document 捕获阶段先拿到原生事件并标记，随后 React 才分派 onKeyDown。
    const marked: KeyboardEvent[] = [];
    document.addEventListener(
      "keydown",
      (event) => {
        marked.push(event);
        fallback?.onEscapeKeyDown(event);
      },
      { capture: true, once: true },
    );
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(marked).toHaveLength(1);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it("canClose 为 false 时 Escape 不关闭", () => {
    const onOpenChange = vi.fn();
    render(<Plain canClose={false} onOpenChange={onOpenChange} />);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("兜底按调用点的写法接在拷入层 Dialog 上", () => {
  it("焦点在内容内按一次 Escape：Radix 的分派与兜底都经过，关闭回调以 false 恰一次", async () => {
    const onOpenChange = vi.fn();
    render(<Overlay onOpenChange={onOpenChange} />);
    const content = await screen.findByRole("dialog", { name: "新建" });
    await yieldMacrotask();
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !content.contains(focused)) {
      throw new Error("焦点不在对话框内容内");
    }
    fireEvent.keyDown(focused, { key: "Escape" });
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });
});
