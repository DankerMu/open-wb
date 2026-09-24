import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";

type TooltipProps = {
  label: string;
  /** `Trigger asChild` 的单一元素，须能接 ref（如 `Button`）。 */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left" | undefined;
};

/**
 * 文字提示：行为层为 Radix Tooltip（聚焦即显、悬停 300ms 后显、blur/Escape/离开隐藏、
 * 打开期间 trigger `aria-describedby` 指向可见 content）。每个实例自带 Provider，无需应用根挂载；
 * `disableHoverableContent` 让离开 trigger 即隐藏（纯文字 label 无需悬停到内容上）。
 * Content 不传 `aria-label`：传了 Radix 会改渲染隐藏副本承载 role=tooltip，可见层失去角色。
 */
export function Tooltip({ label, children, side }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} disableHoverableContent>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="ui-tooltip"
            collisionPadding={8}
            side={side ?? "top"}
            sideOffset={6}
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
