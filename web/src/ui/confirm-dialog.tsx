import type { ReactNode, RefObject } from "react";
import { Button } from "./button.js";
import { DialogFrame } from "./dialog.js";
import { Icon } from "./icon.js";

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  cancelText?: string;
  confirmText: string;
  danger?: boolean;
  /** 确认进行中：确认按钮 loading（禁用 + aria-busy）；忙碌期焦点救回到取消按钮。 */
  pending?: boolean;
  onConfirm: () => void;
  returnFocus?: RefObject<HTMLElement | null> | undefined;
  /** 渲染在 `.ui-dialog-body` 的附加内容（如 pending 提示行）；`description` 是 `<p>`，块级内容放这里。 */
  children?: ReactNode;
};

/**
 * 确认框：`role="alertdialog"` 的 Dialog 变体，映射 demo `confirmDialog`（:1116-1128）。
 * sm 宽、无右上关闭按钮、遮罩点击不关闭、Escape = 取消；确认后是否关闭由调用方经 `open` 决定。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelText = "取消",
  confirmText,
  danger = false,
  pending = false,
  onConfirm,
  returnFocus,
  children,
}: ConfirmDialogProps) {
  return (
    <DialogFrame
      busy={pending}
      closeOnEscape
      closeOnOverlay={false}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            {cancelText}
          </Button>
          <Button loading={pending} onClick={onConfirm} variant={danger ? "danger" : "primary"}>
            {confirmText}
          </Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      returnFocus={returnFocus}
      role="alertdialog"
      showClose={false}
      size="sm"
      title={
        <>
          <Icon name={danger ? "triangle-alert" : "info"} />
          {title}
        </>
      }
    >
      {children}
    </DialogFrame>
  );
}
