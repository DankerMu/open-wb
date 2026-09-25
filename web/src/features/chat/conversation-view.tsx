import type { FormEvent, ReactNode } from "react";
import type { ChatSession } from "../../lib/session-contract.js";
import type { ChatState } from "./stream.js";

type ConversationViewProps = {
  composerDisabled: boolean;
  composerLabel: string;
  draft: string;
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

type ChatMessageView = ChatState["messages"][number];
type ChatStepView = ChatMessageView["steps"][number];

function isVerboseToolDetail(detail: string): boolean {
  const start = detail.trimStart();
  return start.startsWith("{") || start.startsWith("[");
}

function SessionEntries({
  onSelectSession,
  requestedSessionId,
  sessions,
  sessionTitle,
}: {
  onSelectSession(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[];
  sessionTitle(session: ChatSession): string;
}) {
  return (
    <ul className="chat-session-list">
      {sessions.map((session) => {
        const selected = session.id === requestedSessionId;
        const title = sessionTitle(session);
        return (
          <li className="chat-session-item" key={session.id}>
            <button
              aria-current={selected ? "true" : undefined}
              aria-label={title}
              className="chat-session-button"
              onClick={() => onSelectSession(session.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className={`chat-session-dot chat-session-dot-${session.status}`}
              />
              <strong className="chat-session-title">{title}</strong>
              <span
                aria-label={`${title} ${session.status}`}
                className={`chat-session-status chat-session-status-${session.status}`}
                role="status"
              >
                {session.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StepCard({ step }: { step: ChatStepView }) {
  const detail = isVerboseToolDetail(step.detail) ? (
    <details className="chat-step-disclosure" open>
      <summary className="chat-step-summary">原始输出</summary>
      <p className="chat-step-detail">{step.detail}</p>
    </details>
  ) : (
    <p className="chat-step-detail">{step.detail}</p>
  );
  return (
    <section aria-label={step.name} className="chat-step">
      <div className="chat-step-head">
        <strong className="chat-step-name">{step.name}</strong>
        <p
          aria-label={`${step.name} ${step.status}`}
          className={`chat-step-status chat-step-status-${step.status}`}
          role="status"
        >
          {step.status}
        </p>
      </div>
      {detail}
    </section>
  );
}

function MessageArticle({ message }: { message: ChatMessageView }) {
  const assistant = message.role !== "user";
  const roleLabel = assistant ? "助手" : "用户";
  return (
    <article
      aria-label={roleLabel}
      className={assistant ? "chat-msg chat-msg-assistant" : "chat-msg chat-msg-user"}
    >
      <div aria-hidden="true" className="chat-msg-role">
        {roleLabel}
      </div>
      <p className="chat-msg-body">{message.content}</p>
      {message.steps.map((step) => (
        <StepCard key={step.id} step={step} />
      ))}
      {message.error ? (
        <p className="ui-alert chat-msg-error" role="alert">
          {message.error}
        </p>
      ) : null}
    </article>
  );
}

function MessageThread({ historyView }: { historyView: ChatState }) {
  return (
    <section aria-label="消息" className="chat-thread">
      {historyView.messages.map((message) => (
        <MessageArticle key={message.id} message={message} />
      ))}
    </section>
  );
}

export function ConversationView({
  composerDisabled,
  composerLabel,
  draft,
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
    <aside aria-label="会话侧栏" className="chat-sidebar">
      <nav aria-label="会话列表" className="chat-session-nav">
        <button
          className="ui-button ui-button-primary chat-new-session"
          onClick={onCreateSession}
          type="button"
        >
          新建会话
        </button>
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
            onSelectSession={onSelectSession}
            requestedSessionId={requestedSessionId}
            sessions={sessions}
            sessionTitle={sessionTitle}
          />
        ) : null}
      </nav>
    </aside>
  );

  return (
    <div className="chat-layout">
      {listColumn}
      <div className="chat-main">
        {historyError ? (
          <p className="ui-alert" role="alert">
            {historyError}
          </p>
        ) : null}
        {promptError ? (
          <p className="ui-alert" role="alert">
            {promptError}
          </p>
        ) : null}
        {streamError ? (
          <p className="ui-alert" role="alert">
            {streamError}
          </p>
        ) : null}
        <div className="chat-transcript">
          {requestedSessionId ? (
            historyView ? (
              <MessageThread historyView={historyView} />
            ) : null
          ) : (
            <h1 className="chat-hero">WorkBuddy，我帮你</h1>
          )}
        </div>
        <form className="chat-composer" onSubmit={onSubmit}>
          <label className="chat-composer-label">
            {composerLabel}
            <textarea
              aria-describedby="chat-send-hint"
              className="chat-composer-input"
              disabled={composerDisabled}
              onChange={(event) => onChangeDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  return;
                }
                event.preventDefault();
                if (!event.repeat && !sendDisabled) {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={3}
              value={draft}
            />
          </label>
          <div className="chat-composer-foot">
            <span className="ui-muted" id="chat-send-hint">
              Enter 发送 · Shift+Enter 换行
            </span>
            {generating ? (
              <p className="chat-composer-pending" role="status">
                {generatingLabel}
              </p>
            ) : null}
            <button
              className="ui-button ui-button-primary chat-send"
              disabled={sendDisabled}
              type="submit"
            >
              发送
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
