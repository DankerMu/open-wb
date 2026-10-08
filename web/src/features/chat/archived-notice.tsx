import { Button } from "@/components/ui/button";

type ArchivedNoticeProps = {
  /** `恢复` 请求在途：按钮禁用。 */
  busy: boolean;
  /** 上一次 `恢复` 的失败文案；没有为 null。 */
  error: string | null;
  onRestore(): void;
};

/**
 * 已归档会话的只读说明（chat-web「会话页」）：在会话页列里取代输入框、能力栏与停靠区，与输入框同宽。
 * `恢复` 的失败就地显示在按钮旁（不进列表区顶部提示）；忙碌与失败的状态在 session-actions.ts。
 */
export function ArchivedNotice({ busy, error, onRestore }: ArchivedNoticeProps) {
  return (
    <div className="mx-auto box-border w-full max-w-3xl flex-none px-2 pt-2.5 pb-1 narrow:px-0">
      <div
        className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3"
        data-slot="archived-notice"
      >
        <p className="m-0 min-w-0 flex-1 text-sm leading-6 text-(--wb-text-secondary)">
          该会话已归档，恢复后才能继续对话
        </p>
        {error ? (
          <p
            className="m-0 min-w-0 text-xs text-(--wb-status-error-text) [overflow-wrap:anywhere]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <Button className="flex-none" disabled={busy} onClick={onRestore} variant="outline">
          恢复
        </Button>
      </div>
    </div>
  );
}
