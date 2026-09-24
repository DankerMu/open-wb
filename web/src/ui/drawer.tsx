import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./button.js";
import { useFocusHandoff } from "./dialog.js";
import { Icon } from "./icon.js";

type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  /** 宽度枚举为类名 `ui-drawer--w<width>`（不写内联 style）；新消费者需要时扩枚举。 */
  width?: 288 | 420;
  title: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
};

/**
 * 侧滑面板：同一 Radix Dialog 行为层（Escape/遮罩/右上 `关闭` 关闭），样式映射 demo `.drawer`
 * （dialog.css）。无 trigger，关闭后焦点总是归还打开者（侧栏覆盖层依赖此路径）。
 */
export function Drawer({
  open,
  onOpenChange,
  side = "right",
  width = 420,
  title,
  footer,
  children,
}: DrawerProps) {
  const focus = useFocusHandoff({});
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-drawer-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          aria-modal="true"
          className={`ui-drawer ui-drawer--${side} ui-drawer--w${width}`}
          data-side={side}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onOpenAutoFocus={focus.onOpenAutoFocus}
        >
          <div className="ui-drawer-head">
            <DialogPrimitive.Title className="ui-drawer-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button aria-label="关闭" size="icon" variant="ghost">
                <Icon name="x" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="ui-drawer-body">{children}</div>
          {footer && <div className="ui-drawer-foot">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
