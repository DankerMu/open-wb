import { useLayoutEffect, useRef } from "react";
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
import { useEscapeFallback } from "../../ui/index.js";

type RemoveProps = {
  /** 打开那一刻的显示标题。 */
  title: string;
  /** 会话用临时空间时：`sole` 没有别的会话共用它，`shared` 有；不用临时空间为 null。 */
  workspace: "sole" | "shared" | null;
  /** 该会话的 DELETE 在途。 */
  pending: boolean;
  /** 关闭后把焦点还给打开它的「更多」按钮（条目已被删除时落到列表区）。 */
  restoreFocus(): void;
  onConfirm(): void;
  onCancel(): void;
};

/** 临时空间会话的确认说明在普通文案之后追加的一句（session-sidebar「会话条目菜单与重命名」）。 */
const WORKSPACE_NOTES = {
  sole: "临时空间里的文件会一并删除。",
  shared: "它与其它会话共用临时空间，文件会保留到最后一个会话被删除。",
};

/**
 * `删除任务` 确认框（demo:1918）；`remove` 为 null 时不渲染，按「有打开的删除」条件挂载（卸载即
 * 关闭）。请求中仍可关闭（`关闭`、Escape）：运行中会话的删除要等停止完成，网络停滞时不锁死页面，
 * 请求不因此取消（同退出确认的先例）。遮罩点击不关闭。
 */
export function DeleteDialog({ remove }: { remove: RemoveProps | null }) {
  return remove ? <DeleteConfirm {...remove} /> : null;
}

function DeleteConfirm({
  title,
  workspace,
  pending,
  restoreFocus,
  onConfirm,
  onCancel,
}: RemoveProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });

  // `删除` 在请求发出的那次提交里被禁用：焦点若在它上面（或已被浏览器移到 body），移到取消按钮，
  // 不让焦点逃出确认框。
  useLayoutEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (active === document.body || (active as HTMLButtonElement | null)?.disabled) {
      cancelRef.current?.focus();
    }
  }, [pending]);

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
          <AlertDialogTitle>删除任务</AlertDialogTitle>
          <AlertDialogDescription>
            {`确定要删除「${title}」吗？删除后不可恢复。${workspace ? WORKSPACE_NOTES[workspace] : ""}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending ? (
          <p className="m-0 text-sm text-muted-foreground">
            删除请求已发送，关闭窗口不会撤销请求。
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef}>{pending ? "关闭" : "取消"}</AlertDialogCancel>
          <Button
            aria-busy={pending ? true : undefined}
            disabled={pending}
            onClick={onConfirm}
            variant="destructive"
          >
            删除
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
