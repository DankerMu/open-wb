import { Button } from "@/components/ui/button";
import { Icon } from "../../ui/index.js";

type PathList = { count: number; paths: { path: string }[] };

type UndoNoticeProps = {
  /** 撤回的 200 里没有还原的文件与关闭回调；没有要说的（或不属于当前会话）时为 null，不渲染。 */
  notice: { skipped: PathList; failed: PathList; onDismiss(): void } | null;
};

/**
 * 撤回后未还原的文件（message-undo「web 撤回」）：线程与输入框之间的一条可关闭说明。先 `skipped`、后
 * `failed`，各按响应里的次序，只显示路径、不去重；两个 `count` 之和大于所列行数时末行给出总数（截断只
 * 发生在服务端）。两张表合计至多 400 行，所以列表自带限高与内部滚动。
 */
export function UndoNotice({ notice }: UndoNoticeProps) {
  if (notice === null) {
    return null;
  }
  const { failed, onDismiss, skipped } = notice;
  const total = skipped.count + failed.count;
  return (
    <div
      className="mx-auto box-border flex w-full max-w-3xl flex-none items-start gap-2 px-2 narrow:px-0"
      data-slot="undo-notice"
      role="status"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-6">
        <div className="flex items-start gap-2">
          <p className="m-0 min-w-0 flex-1 text-(--wb-text-secondary)">已撤回，以下文件未还原</p>
          <Button
            aria-label="关闭提示"
            onClick={onDismiss}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Icon name="x" />
          </Button>
        </div>
        <ul
          className="m-0 flex max-h-30 list-none flex-col overflow-y-auto p-0 font-mono text-xs leading-5 [overflow-wrap:anywhere] narrow:max-h-24"
          // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
          role="list"
        >
          {/* key 用「表名 + 下标」：路径可以重复（有损的文件名解码）。 */}
          {skipped.paths.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表只读、整份替换，路径不唯一
            <li key={`skipped-${index}`}>{entry.path}</li>
          ))}
          {failed.paths.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <li key={`failed-${index}`}>{entry.path}</li>
          ))}
          {total > skipped.paths.length + failed.paths.length ? (
            <li className="font-sans text-(--wb-text-tertiary)">等共 {total} 项</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
