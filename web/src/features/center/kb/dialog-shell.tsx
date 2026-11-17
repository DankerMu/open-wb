import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEscapeFallback } from "../../../components/escape-fallback.js";

const ERROR_TEXT =
  "m-0 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";

/** 对话框内的失败信封文案（`role="alert"`）；`message` 为 `null` 时不渲染。 */
export function DialogAlert({ message }: { message: string | null }) {
  return message === null ? null : (
    <p className={ERROR_TEXT} role="alert">
      {message}
    </p>
  );
}

/**
 * 「知识库」tab 对话框的外壳（新建、从工作空间入库、范围三处共用）：模态，标题即可访问名；按「有打开的对话框」
 * 条件挂载，关闭即卸载。请求在途（`pending`）时 Escape、遮罩与关闭按钮都关不掉；关闭后经 `restoreFocus` 还焦点。
 */
export function KbDialog({
  title,
  pending,
  restoreFocus,
  onCancel,
  children,
}: {
  title: string;
  pending: boolean;
  restoreFocus(): void;
  onCancel(): void;
  children: ReactNode;
}) {
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        aria-describedby={undefined}
        aria-modal="true"
        className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="leading-5">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 对话框底部的 `取消` 与确认按钮：在途时两个都禁用，确认按钮带 `aria-busy`。没给 `onConfirm` 时确认按钮提交所在的
 * 表单。
 */
export function DialogActions({
  label,
  pending,
  disabled,
  onCancel,
  onConfirm,
}: {
  label: string;
  pending: boolean;
  /** 确认按钮另外的禁用条件。 */
  disabled: boolean;
  onCancel(): void;
  onConfirm?(): void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button disabled={pending} onClick={onCancel} type="button" variant="ghost">
        取消
      </Button>
      <Button
        aria-busy={pending ? true : undefined}
        disabled={pending || disabled}
        onClick={onConfirm}
        type={onConfirm ? "button" : "submit"}
      >
        {label}
      </Button>
    </div>
  );
}
