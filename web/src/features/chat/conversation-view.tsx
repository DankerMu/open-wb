import { type ComponentProps, type FormEvent, memo } from "react";
import { MarkdownView } from "../../lib/markdown-view.js";
import { BrandMark, Icon } from "../../ui/index.js";
import { ApprovalBars } from "./approval-bar.js";
import { Composer } from "./composer.js";
import { ComposerFooter } from "./composer-footer.js";
import { ForkAction, MessageActions } from "./message-actions.js";
import { FollowTranscript } from "./scroll-follow.js";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { summarizeStepDetail } from "./step-summary.js";
import type { ChatState } from "./stream.js";
import { WelcomeIntro, WelcomePlaybooks } from "./welcome.js";
import type { WelcomeOptions } from "./welcome-options.js";

type AnswerApproval = ComponentProps<typeof ApprovalBars>["onAnswer"];
type StopTurn = ComponentProps<typeof Composer>["onStop"];
type Regenerate = ComponentProps<typeof MessageActions>["regenerate"];

type ConversationViewProps = {
  composerDisabled: boolean;
  draft: string;
  generating: boolean;
  historyError: string | null;
  historyView: ChatState | null;
  onAnswerApproval: AnswerApproval;
  onChangeDraft(value: string): void;
  onFork(messageId: number): Promise<void>;
  onRegenerate(): Promise<boolean>;
  onStop: StopTurn;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  promptError: string | null;
  requestedSessionId: string | null;
  sendDisabled: boolean;
  streamError: string | null;
  /** 欢迎态的场景与空间选择（状态在会话页）；有当前会话时不渲染对应控件。 */
  welcome: WelcomeOptions;
};

type ChatMessageView = ChatState["messages"][number];
type ChatStepView = ChatMessageView["steps"][number];

/** Sessions whose last assistant message may be regenerated (a running or `idle` one may not). */
const REGENERABLE: ReadonlySet<ChatState["status"]> = new Set(["done", "failed", "stopped"]);

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

const MessageArticle = memo(function MessageArticle({
  forkDisabled,
  message,
  onAnswerApproval,
  onFork,
  regenerate,
}: {
  forkDisabled: boolean;
  message: ChatMessageView;
  onAnswerApproval: AnswerApproval;
  onFork(messageId: number): Promise<void>;
  regenerate: Regenerate;
}) {
  const assistant = message.role !== "user";
  const stopped = message.status === "stopped";
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
        <ForkAction disabled={forkDisabled} onFork={() => void onFork(message.id)} />
      </article>
    );
  }
  return (
    <article aria-label="助手" className="chat-msg chat-msg-assistant">
      <span aria-hidden="true" className="chat-msg-avatar">
        <BrandMark size={28} />
      </span>
      <div className="chat-msg-main">
        <ApprovalBars approvals={message.approvals} onAnswer={onAnswerApproval} />
        <div className="chat-md">
          {stopped && message.content === "" ? (
            <p className="chat-msg-stopped-empty">（已停止生成）</p>
          ) : (
            <MarkdownView source={message.content} />
          )}
          {message.status === "running" ? (
            <span aria-hidden="true" className="ui-caret chat-caret" />
          ) : null}
        </div>
        {steps}
        {error}
        {stopped ? (
          <p aria-label="助手消息 已停止" className="chat-msg-stopped" role="status">
            已停止
          </p>
        ) : null}
        {message.status !== "running" && (message.content !== "" || regenerate) ? (
          <MessageActions regenerate={regenerate} text={message.content} />
        ) : null}
      </div>
    </article>
  );
});

function MessageThread({
  composerDisabled,
  historyView,
  onAnswerApproval,
  onFork,
  onRegenerate,
}: {
  composerDisabled: boolean;
  historyView: ChatState;
  onAnswerApproval: AnswerApproval;
  onFork(messageId: number): Promise<void>;
  onRegenerate(): Promise<boolean>;
}) {
  const last = historyView.messages.at(-1);
  const eligible = last?.role === "assistant" && REGENERABLE.has(historyView.status);
  return (
    <section aria-label="消息" className="chat-thread">
      {historyView.messages.map((message) => (
        <MessageArticle
          forkDisabled={message.role === "user" && composerDisabled}
          key={message.id}
          message={message}
          onAnswerApproval={onAnswerApproval}
          onFork={onFork}
          regenerate={
            eligible && message === last ? { disabled: composerDisabled, onRegenerate } : undefined
          }
        />
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
  onAnswerApproval,
  onChangeDraft,
  onFork,
  onRegenerate,
  onStop,
  onSubmit,
  promptError,
  requestedSessionId,
  sendDisabled,
  streamError,
  welcome,
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
            {historyView ? (
              <MessageThread
                composerDisabled={composerDisabled}
                historyView={historyView}
                onAnswerApproval={onAnswerApproval}
                onFork={onFork}
                onRegenerate={onRegenerate}
              />
            ) : null}
          </FollowTranscript>
        ) : (
          <div className="chat-transcript">
            <WelcomeIntro
              disabled={composerDisabled}
              onPick={onChangeDraft}
              onSelectScene={welcome.selectScene}
              scene={welcome.scene}
            />
          </div>
        )}
        <Composer
          disabled={composerDisabled}
          draft={draft}
          footer={
            requestedSessionId ? null : (
              <ComposerFooter
                disabled={composerDisabled}
                onSelect={welcome.selectWorkspace}
                workspace={welcome.workspace}
                workspaces={welcome.workspaces}
                workspacesError={welcome.workspacesError}
              />
            )
          }
          generating={generating}
          onChangeDraft={onChangeDraft}
          onStop={onStop}
          onSubmit={onSubmit}
          placeholder={requestedSessionId ? "继续追问，或派一个新任务…" : "今天帮你做些什么"}
          sendDisabled={sendDisabled}
          stopSessionId={requestedSessionId}
        />
        {requestedSessionId ? null : (
          <WelcomePlaybooks disabled={composerDisabled} onPick={onChangeDraft} />
        )}
      </div>
    </div>
  );
}
