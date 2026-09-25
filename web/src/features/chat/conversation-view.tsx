import type { FormEvent, ReactNode } from "react";
import { MarkdownView } from "../../lib/markdown-view.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { BrandMark } from "../../ui/index.js";
import { Composer } from "./composer.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import type { ChatState } from "./stream.js";
import { WelcomeIntro, WelcomePlaybooks } from "./welcome.js";

type ConversationViewProps = {
  composerDisabled: boolean;
  draft: string;
  generating: boolean;
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
        const label = SESSION_STATUS_LABEL[session.status];
        const pulse = session.status === "running" ? " ui-pulse" : "";
        return (
          <li className="chat-session-item" key={session.id}>
            <button
              aria-current={selected ? "true" : undefined}
              aria-label={title}
              className="chat-session-button"
              onClick={() => onSelectSession(session.id)}
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
  const steps = message.steps.map((step) => <StepCard key={step.id} step={step} />);
  const error = message.error ? (
    <p className="ui-alert chat-msg-error" role="alert">
      {message.error}
    </p>
  ) : null;
  if (!assistant) {
    return (
      <article aria-label="用户" className="chat-msg chat-msg-user">
        <p className="chat-msg-body">{message.content}</p>
        {steps}
        {error}
      </article>
    );
  }
  return (
    <article aria-label="助手" className="chat-msg chat-msg-assistant">
      <span aria-hidden="true" className="chat-msg-avatar">
        <BrandMark size={28} />
      </span>
      <div className="chat-msg-main">
        <div className="chat-md">
          <MarkdownView source={message.content} />
          {message.status === "running" ? (
            <span aria-hidden="true" className="ui-caret chat-caret" />
          ) : null}
        </div>
        {steps}
        {error}
      </div>
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
  draft,
  generating,
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
      <div className={requestedSessionId ? "chat-main" : "chat-main chat-main--welcome"}>
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
            <WelcomeIntro disabled={composerDisabled} onPick={onChangeDraft} />
          )}
        </div>
        <Composer
          disabled={composerDisabled}
          draft={draft}
          generating={generating}
          onChangeDraft={onChangeDraft}
          onSubmit={onSubmit}
          placeholder={requestedSessionId ? "继续追问，或派一个新任务…" : "今天帮你做些什么"}
          sendDisabled={sendDisabled}
        />
        {requestedSessionId ? null : (
          <WelcomePlaybooks disabled={composerDisabled} onPick={onChangeDraft} />
        )}
      </div>
    </div>
  );
}
