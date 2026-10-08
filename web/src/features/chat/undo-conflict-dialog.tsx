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

type ConflictProps = {
  /** 关闭后把焦点还给被点的 `撤回` 按钮（消息已被撤回时落到输入框）。 */
  restoreFocus(): void;
  /** `只撤回对话`：以 `keep` 重发。 */
  onKeep(): void;
  /** `连文件一起还原`：以 `force` 重发。 */
  onForce(): void;
  onCancel(): void;
};

/**
 * 撤回遇 409 `undo_conflict` 时的三选一（message-undo「web 撤回」）；`conflict` 为 null 时不渲染，按
 * 「有待决的冲突」条件挂载（卸载即关闭）。`只撤回对话` 与 `连文件一起还原` 先关框再重发，框内没有忙碌
 * 与失败态；`取消` 与 Escape 不发请求。遮罩点击不关闭。
 */
export function UndoConflictDialog({ conflict }: { conflict: ConflictProps | null }) {
  return conflict ? <UndoConflict {...conflict} /> : null;
}

function UndoConflict({ restoreFocus, onKeep, onForce, onCancel }: ConflictProps) {
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };
  const fallback = useEscapeFallback({ canClose: true, onOpenChange });

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
          <AlertDialogTitle>其它会话改动过这个工作空间</AlertDialogTitle>
          <AlertDialogDescription>
            这条消息发出之后，共用这个工作空间的其它会话还运行过回合。连文件一起还原会把它们的改动一并冲掉。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <Button onClick={onKeep} variant="outline">
            只撤回对话
          </Button>
          <Button onClick={onForce} variant="destructive">
            连文件一起还原
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
