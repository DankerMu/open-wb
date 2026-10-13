import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";

/**
 * 覆盖层 Escape 兜底（issue 643）。它当初是为「Toast 在场时本层 Radix 收不到 Escape」加的：Radix
 * DismissableLayer 的层栈是模块级共享的，document 上的 Escape 监听只挂在最高层。Toast 已删除（issue 1398）；
 * 这个兜底是否仍然需要由 issue 1393 的 Escape 实测决定，在那之前十处调用原样保留。兜底经 Content 的 React
 * `onKeyDown` 自行关闭。
 *
 * - `onEscapeKeyDown`：本层 Radix 分派到本层时调用；记下这次原生事件已由本层处理，再跑 `onEscape`。Radix 的
 *   监听在 document 捕获阶段，先于 React 在根容器上的委托，所以标记总在 `onKeyDown` 之前写好。
 * - `onKeyDown`：Escape、非输入法组合、目标在本 Content 的 DOM 子树内（portal 在外的嵌套 Menu/Popover 不算）、
 *   且不是本层已处理的那次原生事件时，若 `canClose` 则 `onOpenChange(false)`。不看 `defaultPrevented`。
 */
export function useEscapeFallback({
  canClose,
  onOpenChange,
  onEscape,
}: {
  canClose: boolean;
  onOpenChange: (open: boolean) => void;
  onEscape?: ((event: KeyboardEvent) => void) | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handled = useRef<KeyboardEvent | null>(null);
  return {
    ref,
    onEscapeKeyDown(event: KeyboardEvent) {
      handled.current = event;
      onEscape?.(event);
    },
    onKeyDown(event: ReactKeyboardEvent) {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
      if (handled.current === event.nativeEvent) return;
      const target = event.target;
      if (!(target instanceof Node) || !ref.current?.contains(target)) return;
      if (canClose) onOpenChange(false);
    },
  };
}
