import type { RefObject } from "react";
import { ConfirmDialog } from "../../ui/index.js";

type RemoveProps = {
  /** 打开那一刻的显示标题。 */
  title: string;
  /** 该会话的 DELETE 在途。 */
  pending: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  onConfirm(): void;
  onCancel(): void;
};

/**
 * `删除任务` 确认框（demo:1918）；`remove` 为 null 时不渲染，按「有打开的删除」条件挂载（卸载即
 * 关闭）。请求中仍可关闭（`关闭`、Escape）：运行中会话的删除要等停止完成，网络停滞时不锁死页面，
 * 请求不因此取消（同退出确认的先例）。
 */
export function DeleteDialog({ remove }: { remove: RemoveProps | null }) {
  if (!remove) return null;
  const { title, pending, returnFocus, onConfirm, onCancel } = remove;
  return (
    <ConfirmDialog
      cancelText={pending ? "关闭" : "取消"}
      confirmText="删除"
      danger
      description={`确定要删除「${title}」吗？删除后不可恢复。`}
      onConfirm={onConfirm}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
      pending={pending}
      returnFocus={returnFocus}
      title="删除任务"
    >
      {pending ? <p className="ui-muted">删除请求已发送，关闭窗口不会撤销请求。</p> : null}
    </ConfirmDialog>
  );
}
