import type { ChatSession } from "../../lib/session-contract.js";
import { useSidebarNavigate } from "../../lib/sidebar-slot.js";
import { Button } from "../../ui/index.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";

type SessionNavProps = {
  listError: string | null;
  listLoading: boolean;
  onCreateSession(): void;
  onSelectSession(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[] | null;
  sessionTitle(session: ChatSession): string;
};

function SessionEntries({
  onSelect,
  requestedSessionId,
  sessions,
  sessionTitle,
}: {
  onSelect(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[];
  sessionTitle(session: ChatSession): string;
}) {
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
 * 会话列表与 `新建会话`：由 ChatPage 经侧栏槽位上报、在 shell 侧栏列表区内渲染（issue 424）。
 * 数据与回调仍来自 ChatPage；覆盖层内选择或新建后调用侧栏提供的关闭回调，与导航项同一时机。
 */
export function SessionNav({
  listError,
  listLoading,
  onCreateSession,
  onSelectSession,
  requestedSessionId,
  sessions,
  sessionTitle,
}: SessionNavProps) {
  const onNavigate = useSidebarNavigate();
  return (
    <nav aria-label="会话列表" className="chat-session-nav">
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
      {sessions ? (
        <SessionEntries
          onSelect={(sessionId) => {
            onSelectSession(sessionId);
            onNavigate?.();
          }}
          requestedSessionId={requestedSessionId}
          sessions={sessions}
          sessionTitle={sessionTitle}
        />
      ) : null}
    </nav>
  );
}
