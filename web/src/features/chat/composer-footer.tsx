/* Composer footer adapted from resource/workbuddy-live-demo.html:2579-2582 (任务启动于), 3586-3608 (space popover); the permission axis, 新建工作空间 and 挂载目录 are not rendered. */
import { useEffect, useState } from "react";
import { Button, Icon, Input, Popover } from "../../ui/index.js";
import { useAuth } from "../auth/index.js";
import { logicalPath } from "../files/file-meta.js";
import type { WelcomeOptions } from "./welcome-options.js";

const SEARCH = "搜索工作空间";
const UNSELECTED = "未选择";

type WorkspaceChoice = Pick<WelcomeOptions, "workspace" | "workspaces" | "workspacesError"> & {
  onSelect(workspaceId: string | null): void;
};

/** `任务启动于 …` 按钮与空间选择弹层；composer 锁定时按钮禁用，已打开的弹层关闭且解锁后不重开。 */
export function ComposerFooter({ disabled, ...choice }: WorkspaceChoice & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="chat-workspace-picker">
      <Popover
        contentLabel="选择工作空间"
        onOpenChange={setOpen}
        open={open}
        trigger={
          <Button className="chat-workspace-trigger" disabled={disabled} size="sm" variant="ghost">
            <Icon name="folder" size={14} />
            <span className="chat-workspace-trigger-text">
              任务启动于 {choice.workspace?.name ?? UNSELECTED}
            </span>
            <Icon name="chevron-down" size={12} />
          </Button>
        }
      >
        <WorkspaceOptions
          {...choice}
          onSelect={(workspaceId) => {
            choice.onSelect(workspaceId);
            setOpen(false);
          }}
        />
      </Popover>
    </div>
  );
}

/** 弹层内容：只在弹层打开时挂载，所以查询每次打开都为空。按名称过滤，`未选择` 恒在。 */
function WorkspaceOptions({ onSelect, workspace, workspaces, workspacesError }: WorkspaceChoice) {
  const account = useAuth().principal?.account;
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = (workspaces ?? []).filter((item) =>
    item.name.toLocaleLowerCase().includes(needle),
  );
  return (
    <div className="chat-workspace-options">
      <Input
        aria-label={SEARCH}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={SEARCH}
        value={query}
      />
      <ul className="chat-workspace-list">
        <li>
          <button
            aria-pressed={workspace === null}
            className="chat-workspace-option"
            onClick={() => onSelect(null)}
            type="button"
          >
            {UNSELECTED}
          </button>
        </li>
        {matches.map((item) => (
          <li key={item.id}>
            <button
              aria-pressed={item.id === workspace?.id}
              className="chat-workspace-option"
              onClick={() => onSelect(item.id)}
              type="button"
            >
              <strong>{item.name}</strong>
              {account === undefined ? null : <span>{logicalPath(account, item.dir)}</span>}
            </button>
          </li>
        ))}
      </ul>
      <WorkspaceListNote
        error={workspacesError}
        loading={workspaces === null}
        unmatched={matches.length === 0}
      />
    </div>
  );
}

/** 列表之下的一句：读取失败的文案、读取在途，或已有列表但没有一项匹配。 */
function WorkspaceListNote(props: { error: string | null; loading: boolean; unmatched: boolean }) {
  if (props.error !== null) {
    return (
      <p className="chat-workspace-note" role="alert">
        {props.error}
      </p>
    );
  }
  if (!props.loading && !props.unmatched) return null;
  return (
    <p className="chat-workspace-note">
      {props.loading ? "正在读取工作空间" : "没有匹配的工作空间"}
    </p>
  );
}
