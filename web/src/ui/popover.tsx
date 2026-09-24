import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactElement, ReactNode } from "react";

type PopoverProps = {
  /** `Trigger asChild` 的单一元素，须能接 ref（如 `Button`）。 */
  trigger: ReactElement;
  children: ReactNode;
  /** 未传时非受控（Radix 自管 open 状态）。 */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** 覆盖 content 的 role（默认 Radix 的 `dialog`）。 */
  contentRole?: string | undefined;
  /** content 的可访问名；未传时 content 无名称（调用方自负）。 */
  contentLabel?: string | undefined;
};

/**
 * 非模态弹出面板：行为层为 Radix Popover（portal、打开聚焦 content 内首个可聚焦元素、Escape/外点关闭、
 * 关闭归还 trigger、碰撞定位）。`contentRole`/`contentLabel` 只在传入时展开——Radix 把默认
 * `role="dialog"` 写在透传 props 之前，传 `role={undefined}` 会抹掉默认角色。
 * 只提供面板壳 `.ui-popover`（demo `.pop`，popover.css），列表项/搜索框样式归消费者。
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  contentRole,
  contentLabel,
}: PopoverProps) {
  // exactOptionalPropertyTypes：Radix Root 的 open/onOpenChange 不接受显式 undefined，
  // 未传时不展开（= 非受控，Radix useControllableState 以 open === undefined 判定）。
  return (
    <PopoverPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="ui-popover"
          collisionPadding={8}
          sideOffset={6}
          {...(contentRole ? { role: contentRole } : {})}
          {...(contentLabel ? { "aria-label": contentLabel } : {})}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
