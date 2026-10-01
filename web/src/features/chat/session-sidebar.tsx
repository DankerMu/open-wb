import { type ReactNode, useId } from "react";
import type { ChatSession } from "../../lib/session-contract.js";
import { useSidebarNavigate } from "../../lib/sidebar-slot.js";
import { Button } from "../../ui/index.js";
import { SessionFilter } from "./session-filter.js";
import {
  filterSessions,
  groupSessions,
  type SessionFilter as SessionFilterValue,
} from "./session-groups.js";
import { sessionTitle } from "./session-path.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";

type SessionSidebarProps = {
  filter: SessionFilterValue;
  listError: string | null;
  listLoading: boolean;
  onCreateSession(): void;
  onFilterChange(filter: SessionFilterValue): void;
  onSelectSession(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[] | null;
  workspaces: readonly { id: string; name: string }[] | null;
};

type EntriesProps = {
  onSelect(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[];
};

function SessionEntries({ onSelect, requestedSessionId, sessions }: EntriesProps) {
  return (
    <ul className="chat-session-list">
      {sessions.map((session) => {
        const selected = session.id === requestedSessionId;
        const title = sessionTitle(session);
        const label = SESSION_STATUS_LABEL[session.status];
        const pulse = session.status === "running" ? " ui-pulse" : "";
        return (
          <li className="chat-session-item" key={session.id}>
            <button
              aria-current={selected ? "true" : undefined}
              aria-label={title}
              className="chat-session-button"
              onClick={() => onSelect(session.id)}
              type="button"
            >
              <span aria-label={`${title} ${label}`} className="chat-session-status" role="status">
                <span
                  aria-hidden="true"
                  className={`chat-session-dot chat-session-dot-${session.status}${pulse}`}
                />
                <span className="ui-sr-only">{label}</span>
              </span>
              <strong className="chat-session-title">{title}</strong>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 分区或空间子组：`fieldset` 即 `role="group"`（同 approval-bar），accessible name 取自可见标签
 * （demo:275、1873-1889）。
 */
function SessionGroup({
  children,
  label,
  nested = false,
}: {
  children: ReactNode;
  label: string;
  nested?: boolean;
}) {
  const labelId = useId();
  return (
    <fieldset aria-labelledby={labelId} className="chat-session-group">
      <div
        className={`chat-session-group-label${nested ? " chat-session-group-label-nested" : ""}`}
        id={labelId}
      >
        {label}
      </div>
      {children}
    </fieldset>
  );
}

/**
 * 侧栏列表区：`新建会话`、`筛选任务` 与「置顶任务 / 任务 / 空间」三分区列表，由 ChatPage 经侧栏
 * 槽位上报、在 shell 侧栏内渲染（issue 424、530）。数据、筛选值与回调都来自 ChatPage（槽位节点
 * 会随折叠与覆盖层关闭卸载）；覆盖层内选择或新建后调用侧栏提供的关闭回调，筛选不调用。
 * 「今天」的当前时间取渲染时刻，不设定时器。
 */
export function SessionSidebar({
  filter,
  listError,
  listLoading,
  onCreateSession,
  onFilterChange,
  onSelectSession,
  requestedSessionId,
  sessions,
  workspaces,
}: SessionSidebarProps) {
  const onNavigate = useSidebarNavigate();
  const visible = sessions ? filterSessions(sessions, filter, Date.now()) : null;
  const { pinned, spaces, tasks } = groupSessions(visible ?? [], workspaces);
  const spaceCount = spaces.reduce((total, space) => total + space.sessions.length, 0);
  const entries = (items: ChatSession[]) => (
    <SessionEntries
      onSelect={(sessionId) => {
        onSelectSession(sessionId);
        onNavigate?.();
      }}
      requestedSessionId={requestedSessionId}
      sessions={items}
    />
  );
  return (
    <nav aria-label="会话列表" className="chat-session-nav">
      <div className="chat-session-toolbar">
        <Button
          className="chat-new-session"
          onClick={() => {
            onCreateSession();
            onNavigate?.();
          }}
          variant="primary"
        >
          新建会话
        </Button>
        <SessionFilter onChange={onFilterChange} value={filter} />
      </div>
      {listError ? (
        <p className="ui-alert" role="alert">
          {listError}
        </p>
      ) : null}
      {listLoading ? (
        <p className="ui-muted chat-session-loading" role="status">
          正在读取会话
        </p>
      ) : null}
      {visible?.length === 0 ? <p className="chat-session-empty">没有匹配的任务</p> : null}
      {visible && visible.length > 0 ? (
        <div className="chat-session-groups">
          {pinned.length > 0 ? (
            <SessionGroup label="置顶任务">{entries(pinned)}</SessionGroup>
          ) : null}
          {tasks.length > 0 ? (
            <SessionGroup label={`任务 (${tasks.length})`}>{entries(tasks)}</SessionGroup>
          ) : null}
          {spaceCount > 0 ? (
            <SessionGroup label={`空间 (${spaceCount})`}>
              {spaces.map((space) => (
                <SessionGroup key={space.key} label={space.name} nested>
                  {entries(space.sessions)}
                </SessionGroup>
              ))}
            </SessionGroup>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
