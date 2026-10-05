import type { ComponentProps, FormEvent, ReactNode, Ref } from "react";
import type { ApiClient } from "../../lib/api.js";
import { Composer } from "./composer.js";
import { ComposerFooter } from "./composer-footer.js";
import { ThreadMessages } from "./message-thread.js";
import { FollowTranscript, type TranscriptHandle } from "./scroll-follow.js";
import type { useSlashMenu } from "./slash-menu.js";
import type { ChatState } from "./stream.js";
import { WelcomeIntro, WelcomePlaybooks } from "./welcome.js";
import type { WelcomeOptions } from "./welcome-options.js";
import type { Workspace } from "./workspace-list.js";

type AnswerApproval = ComponentProps<typeof ThreadMessages>["onAnswerApproval"];
type StopTurn = ComponentProps<typeof Composer>["onStop"];

type ConversationViewProps = {
  /** 当前账号的 API client；产物卡经它按需拉取预览。 */
  client: ApiClient;
  composerDisabled: boolean;
  /** 输入框元素：回到欢迎态后由会话页聚焦它。 */
  composerRef: Ref<HTMLTextAreaElement>;
  draft: string;
  generating: boolean;
  historyError: string | null;
  historyView: ChatState | null;
  onAnswerApproval: AnswerApproval;
  onChangeDraft(value: string): void;
  onFork(messageId: number): Promise<void>;
  onRegenerate(): Promise<boolean>;
  /** 现有发送路径的文本入口：运行时适配器的 `onNew` 委托给它。 */
  onSend(prompt: string): void;
  onStop: StopTurn;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  promptError: string | null;
  requestedSessionId: string | null;
  /** 对话内搜索：搜索框（未打开时为 null）、当前匹配的消息 id、交给转录区的句柄。 */
  search: { box: ReactNode; currentId: number | null; handleRef: Ref<TranscriptHandle> };
  sendDisabled: boolean;
  /** 斜杠命令候选：输入框上方的面板（不可见时为 null）与先于 Enter 规则的按键拦截。 */
  slash: ReturnType<typeof useSlashMenu>;
  streamError: string | null;
  /** 欢迎态的场景与空间选择（状态在会话页）；有当前会话时不渲染对应控件。 */
  welcome: WelcomeOptions;
  /** 当前会话的空间（取自空间列表）；未绑定、不在列表里、列表读取中或读取失败时为 undefined。 */
  workspace: Workspace | undefined;
};

export function ConversationView({
  client,
  composerDisabled,
  composerRef,
  draft,
  generating,
  historyError,
  historyView,
  onAnswerApproval,
  onChangeDraft,
  onFork,
  onRegenerate,
  onSend,
  onStop,
  onSubmit,
  promptError,
  requestedSessionId,
  search,
  sendDisabled,
  slash,
  streamError,
  welcome,
  workspace,
}: ConversationViewProps) {
  return (
    <div className="chat-layout">
      <div className={requestedSessionId ? "chat-main" : "chat-main chat-main--welcome"}>
        {search.box}
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
          <FollowTranscript
            content={historyView}
            handleRef={search.handleRef}
            key={requestedSessionId}
          >
            {historyView ? (
              <section aria-label="消息" className="chat-thread">
                <ThreadMessages
                  client={client}
                  currentId={search.currentId}
                  locked={composerDisabled}
                  onAnswerApproval={onAnswerApproval}
                  onFork={onFork}
                  onRegenerate={onRegenerate}
                  onSend={onSend}
                  onStop={onStop}
                  view={historyView}
                  workspace={workspace ?? null}
                />
              </section>
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
          inputRef={composerRef}
          interceptKeyDown={slash.interceptKeyDown}
          onChangeDraft={onChangeDraft}
          onStop={onStop}
          onSubmit={onSubmit}
          placeholder={requestedSessionId ? "继续追问，或派一个新任务…" : "今天帮你做些什么"}
          sendDisabled={sendDisabled}
          slashMenu={slash.menu}
          stopSessionId={requestedSessionId}
        />
        {requestedSessionId ? null : (
          <WelcomePlaybooks disabled={composerDisabled} onPick={onChangeDraft} />
        )}
      </div>
    </div>
  );
}
