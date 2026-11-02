import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useEscapeFallback } from "../../components/escape-fallback.js";

const ERROR_TEXT = "m-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]";

type Props = {
  title: string;
  description?: string;
  error?: string | null;
  /** 确认按钮的文案；缺省 `删除`。 */
  confirmLabel?: string;
  pending: boolean;
  restoreFocus(): void;
  onConfirm(): void;
  onCancel(): void;
};

/**
 * 中心页各 tab 共用的破坏性确认框（拷入层 alert-dialog），缺省是 `删除 <对象>？`；模型 tab 的更换嵌入模型确认把按钮换成
 * `重建并保存`。`取消` 不发请求；确认按钮恰发一次。请求在途时
 * 两个按钮都禁用、Escape 与遮罩也关不掉（结果总落在打开的确认框上，没有晚到结果）。给了 `error` 就显示在框内、框保持打开。
 */
export function RemoveDialog({
  title,
  description = "删除后不可恢复。",
  error,
  confirmLabel = "删除",
  pending,
  restoreFocus,
  onConfirm,
  onCancel,
}: Props) {
  const onOpenChange = (open: boolean) => {
    if (!open && !pending) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: !pending, onOpenChange });

  return (
    <AlertDialog onOpenChange={onOpenChange} open>
      <AlertDialogContent
        aria-modal="true"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onEscapeKeyDown={fallback.onEscapeKeyDown}
        onKeyDown={fallback.onKeyDown}
        ref={fallback.ref}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className={`${ERROR_TEXT} rounded-lg bg-destructive/10 px-2.5 py-2`} role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
          <Button
            aria-busy={pending ? true : undefined}
            disabled={pending}
            onClick={onConfirm}
            variant="destructive"
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
