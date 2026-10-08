import { type NameDialogState, NameForm } from "./rename-dialog.js";
import { workspaceNameOf } from "./session-actions.js";

/**
 * `另存为工作空间` 对话框（session-sidebar「另存为工作空间对话框」）；`promote` 为 null 时不渲染。
 * 与重命名对话框同一个表单：每次打开都是空的输入框，请求中仍可关闭（请求不因此取消），失败在
 * 对话框内以 `role="alert"` 显示。名字去掉首尾空白后为空或超过上限时 `保存` 禁用。
 */
export function PromoteDialog({ promote }: { promote: NameDialogState | null }) {
  return promote ? (
    <NameForm
      {...promote}
      description="临时空间会原地变成正式工作空间，文件不移动；之后它出现在文件页，删除会话不再删除这些文件。"
      heading="另存为工作空间"
      initial=""
      label="工作空间名称"
      valid={(text) => workspaceNameOf(text) !== null}
    />
  ) : null;
}
