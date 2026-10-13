import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";

/**
 * 覆盖层 Escape 兜底：Radix 没有把某次 Escape 分派给本层时，由 Content 的 React `onKeyDown` 自行关闭。
 *
 * 为什么还需要它（issue 1399 的 Escape 实测；逐个调用点的结论与次数在 ADR-0013 增补「Escape 实测」）：
 * Radix DismissableLayer 的层栈是模块级共享的，document 上的 Escape 监听只由「最高层」挂，而一层是不是
 * 最高层在它渲染时才算（读代码推出，`@radix-ui/react-dismissable-layer` 1.1.19）——覆盖层挂载时栈里若还有
 * 别的层，它要等下一次重渲染才接过监听，这之前到达的 Escape 分派给了那一层、覆盖层收不到。实测到的
 * 「别的层」是打开它的那个顶栏按钮的 tooltip：键盘聚焦按钮时 tooltip 出现，按 Enter 打开覆盖层后 tooltip
 * 进入退出动画、仍在栈里。由顶栏按钮打开的三处因此需要兜底——重命名对话框（顶栏入口）、项目配置弹层、
 * 窄屏的工作空间侧边栏模态层：去掉兜底，紧跟着 Enter 的那次 Escape 会关不掉它们；接着兜底每次都关闭
 * （实测，Chromium，真实按键。只在按键紧挨着时出现：项目配置弹层上 Enter 与 Escape 相隔 20ms 即每次都
 * 关闭；这个间隔自动化按得出，人手按不出是推断）。其余七处在同一轮实测里没有测出差别；十处调用仍全部保留，
 * 同类覆盖层只有一种行为（s1f-legacy-layer-removal design D4）。常驻证据是这三处各一条单测
 * （`web/test/escape-race-support.ts` 搭台），兜底自身的三条性质在 `web/test/escape-fallback.test.tsx`。
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
