import type { FormEvent, ReactNode } from "react";
import type { ChatSession } from "../../lib/session-contract.js";
import type { ChatState } from "./stream.js";

type ConversationViewProps = {
  composerDisabled: boolean;
  composerLabel: string;
  draft: string;
  emptySelection: string;
  generating: boolean;
  generatingLabel: string;
  historyError: string | null;
  historyView: ChatState | null;
  listError: string | null;
  listLoading: boolean;
  onChangeDraft(value: string): void;
  onCreateSession(): void;
  onSelectSession(sessionId: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  promptError: string | null;
  requestedSessionId: string | null;
  sendDisabled: boolean;
  sessions: ChatSession[] | null;
  sessionTitle(session: ChatSession): string;
  streamError: string | null;
};

const exactWhitespace = { whiteSpace: "pre-wrap" as const };

function SessionList({
  onCreateSession,
  onSelectSession,
  requestedSessionId,
  sessions,
  sessionTitle,
}: {
  onCreateSession(): void;
  onSelectSession(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[];
  sessionTitle(session: ChatSession): string;
}) {
  return (
    <nav aria-label="会话列表">
      <button onClick={onCreateSession} type="button">
        新建会话
      </button>
      <ul>
        {sessions.map((session) => {
          const selected = session.id === requestedSessionId;
          const title = sessionTitle(session);
          return (
            <li key={session.id} style={{ marginBottom: "0.5rem" }}>
              <button
                aria-current={selected ? "true" : undefined}
                aria-label={title}
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <strong style={{ display: "block" }}>{title}</strong>
                <span
                  aria-label={`${title} ${session.status}`}
                  role="status"
                  style={{ display: "block", marginTop: "0.25rem" }}
                >
                  {session.status}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function MessageThread({ historyView }: { historyView: ChatState }) {
  return (
    <section aria-label="消息">
      {historyView.messages.map((message) => (
        <article
          aria-label={message.role === "user" ? "用户" : "助手"}
          key={message.id}
          style={{
            background: message.role === "user" ? "rgba(0, 0, 0, 0.04)" : "transparent",
            marginBottom: "0.75rem",
            padding: "0.5rem 0.75rem",
          }}
        >
          <p style={exactWhitespace}>{message.content}</p>
          {message.steps.map((step) => (
            <section key={step.id} aria-label={step.name} style={{ marginTop: "0.5rem" }}>
              <strong>{step.name}</strong>
              <p>{step.detail}</p>
              <p role="status" aria-label={`${step.name} ${step.status}`}>
                {step.status}
              </p>
            </section>
          ))}
          {message.error ? <p role="alert">{message.error}</p> : null}
        </article>
      ))}
    </section>
  );
}

export function ConversationView({
  composerDisabled,
  composerLabel,
  draft,
  emptySelection,
  generating,
  generatingLabel,
  historyError,
  historyView,
  listError,
  listLoading,
  onChangeDraft,
  onCreateSession,
  onSelectSession,
  onSubmit,
  promptError,
  requestedSessionId,
  sendDisabled,
  sessions,
  sessionTitle,
  streamError,
}: ConversationViewProps) {
  const listColumn: ReactNode = (
    <aside aria-label="会话侧栏" style={{ minWidth: 0 }}>
      {listError ? <p role="alert">{listError}</p> : null}
      {listLoading ? <p role="status">正在读取会话</p> : null}
      {sessions ? (
        <SessionList
          onCreateSession={onCreateSession}
          onSelectSession={onSelectSession}
          requestedSessionId={requestedSessionId}
          sessions={sessions}
          sessionTitle={sessionTitle}
        />
      ) : null}
    </aside>
  );

  return (
    <div
      style={{
        display: "grid",
        gap: "1rem",
        gridTemplateColumns: "minmax(15rem, 22rem) minmax(0, 1fr)",
      }}
    >
      {listColumn}
      <div style={{ minWidth: 0 }}>
        {historyError ? <p role="alert">{historyError}</p> : null}
        {promptError ? <p role="alert">{promptError}</p> : null}
        {streamError ? <p role="alert">{streamError}</p> : null}
        {requestedSessionId && historyView ? (
          <MessageThread historyView={historyView} />
        ) : (
          <p>{emptySelection}</p>
        )}
        <form onSubmit={onSubmit}>
          <label>
            {composerLabel}
            <textarea
              disabled={composerDisabled}
              onChange={(event) => onChangeDraft(event.target.value)}
              value={draft}
            />
          </label>
          {generating ? <p role="status">{generatingLabel}</p> : null}
          <button disabled={sendDisabled} type="submit">
            发送
          </button>
        </form>
      </div>
    </div>
  );
}
