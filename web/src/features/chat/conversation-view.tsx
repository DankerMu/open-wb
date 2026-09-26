import { type FormEvent, memo } from "react";
import { MarkdownView } from "../../lib/markdown-view.js";
import { BrandMark, Icon } from "../../ui/index.js";
import { Composer } from "./composer.js";
import { MessageActions } from "./message-actions.js";
import { FollowTranscript } from "./scroll-follow.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { summarizeStepDetail } from "./step-summary.js";
import type { ChatState } from "./stream.js";
import { WelcomeIntro, WelcomePlaybooks } from "./welcome.js";

type ConversationViewProps = {
  composerDisabled: boolean;
  draft: string;
  generating: boolean;
  historyError: string | null;
  historyView: ChatState | null;
  onChangeDraft(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  promptError: string | null;
  requestedSessionId: string | null;
  sendDisabled: boolean;
  streamError: string | null;
};

type ChatMessageView = ChatState["messages"][number];
type ChatStepView = ChatMessageView["steps"][number];

function StepCard({ step }: { step: ChatStepView }) {
  const label = SESSION_STATUS_LABEL[step.status];
  const summary = summarizeStepDetail(step.detail);
  const pulse = step.status === "running" ? " ui-pulse" : "";
  return (
    <section aria-label={step.name} className="chat-step">
      <div className="chat-step-head">
        <span className="chat-step-icon">
          <Icon name={step.name === "bash" ? "terminal" : "wrench"} size={14} />
        </span>
        <strong className="chat-step-name">{step.name}</strong>
        <p
          aria-label={`${step.name} ${label}`}
          className={`chat-step-status chat-step-status-${step.status}${pulse}`}
          role="status"
        >
          {label}
        </p>
      </div>
      {summary === "" ? null : <p className="chat-step-line">{summary}</p>}
      {step.detail === "" && step.output === "" ? null : (
        <details className="chat-step-disclosure">
          <summary className="chat-step-summary">原始输出</summary>
          {step.detail === "" ? null : <pre className="chat-step-detail">{step.detail}</pre>}
          {step.output === "" ? null : <pre className="chat-step-output">{step.output}</pre>}
        </details>
      )}
    </section>
  );
}

const MessageArticle = memo(function MessageArticle({ message }: { message: ChatMessageView }) {
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
        {message.status !== "running" && message.content !== "" ? (
          <MessageActions text={message.content} />
        ) : null}
      </div>
    </article>
  );
});

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
  onChangeDraft,
  onSubmit,
  promptError,
  requestedSessionId,
  sendDisabled,
  streamError,
}: ConversationViewProps) {
  return (
    <div className="chat-layout">
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
        {requestedSessionId ? (
          <FollowTranscript content={historyView} key={requestedSessionId}>
            {historyView ? <MessageThread historyView={historyView} /> : null}
          </FollowTranscript>
        ) : (
          <div className="chat-transcript">
            <WelcomeIntro disabled={composerDisabled} onPick={onChangeDraft} />
          </div>
        )}
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
