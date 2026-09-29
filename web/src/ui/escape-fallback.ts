import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";

/**
 * 覆盖层 Escape 兜底（Drawer 与 DialogFrame 共用，issue 643）。Radix DismissableLayer 的层栈是模块级共享的，
 * document 上的 Escape 监听只挂在最高层、交接要等一轮重新渲染；Toast 的每条 Root 也是一层，于是 Toast 在场
 * （后入栈，或交接未完成）时本层 Radix 收不到 Escape。兜底经 Content 的 React `onKeyDown` 自行关闭。
 *
 * - `onEscapeKeyDown`：本层 Radix 分派到本层时调用；记下这次原生事件已由本层处理，再跑 `onEscape`。Radix 的
 *   监听在 document 捕获阶段，先于 React 在根容器上的委托，所以标记总在 `onKeyDown` 之前写好。
 * - `onKeyDown`：Escape、非输入法组合、目标在本 Content 的 DOM 子树内（portal 在外的嵌套 Menu/Popover 不算）、
 *   且不是本层已处理的那次原生事件时，若 `canClose` 则 `onOpenChange(false)`。不看 `defaultPrevented`：
 *   Toast 层对同一事件的 `preventDefault` 与本层无关。
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
