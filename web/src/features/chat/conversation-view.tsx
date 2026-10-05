import type { ComponentProps, FormEvent, ReactNode, Ref, RefObject } from "react";
import type { ApiClient } from "../../lib/api.js";
import { CapabilityBar } from "./capability-bar.js";
import { Composer } from "./composer.js";
import { Thread } from "./message-thread.js";
import type { useSlashMenu } from "./slash-menu.js";
import type { ChatState } from "./stream.js";
import type { TranscriptHandle } from "./thread-viewport.js";
import { WelcomeIntro, WelcomePlaybooks } from "./welcome.js";
import type { WelcomeOptions } from "./welcome-options.js";
import type { Workspace } from "./workspace-list.js";

type AnswerApproval = ComponentProps<typeof Thread>["onAnswerApproval"];
type StopTurn = ComponentProps<typeof Composer>["onStop"];

type ConversationViewProps = {
  /** 当前账号的 API client；产物卡经它按需拉取预览。 */
  client: ApiClient;
  composerDisabled: boolean;
  /** 输入框元素：回到欢迎态后由会话页聚焦它，「+」菜单点选后也聚焦它。 */
  composerRef: RefObject<HTMLTextAreaElement | null>;
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
  /** 斜杠命令候选：输入框上方的面板（不可见时为 null）、先于 Enter 规则的按键拦截，以及「+」菜单的状态。 */
  slash: ReturnType<typeof useSlashMenu>;
  streamError: string | null;
  /** 欢迎态的场景与空间选择（状态在会话页）；有当前会话时场景不渲染，空间位换成只读标签。 */
  welcome: WelcomeOptions;
  /** 当前会话的空间（取自空间列表）；未绑定、不在列表里、列表读取中或读取失败时为 undefined。 */
  workspace: Workspace | undefined;
  /** 当前会话绑定的工作空间 id：未绑定为 null，会话还没解析出来时为 undefined。 */
  workspaceId: string | null | undefined;
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
  workspaceId,
}: ConversationViewProps) {
  return (
    <div className="chat-layout">
      <div
        className={requestedSessionId ? "chat-main" : "chat-main chat-main--welcome"}
        data-slot="chat-column"
      >
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
          <Thread
            client={client}
            currentId={search.currentId}
            generating={generating}
            key={requestedSessionId}
            locked={composerDisabled}
            onAnswerApproval={onAnswerApproval}
            onFork={onFork}
            onRegenerate={onRegenerate}
            onSend={onSend}
            onStop={onStop}
            scrollHandleRef={search.handleRef}
            view={historyView}
            workspace={workspace ?? null}
          />
        ) : (
          <div className="mt-auto min-w-0 flex-none">
            <WelcomeIntro
              disabled={composerDisabled}
              onPick={onChangeDraft}
              onSelectScene={welcome.selectScene}
              scene={welcome.scene}
            />
          </div>
        )}
        <Composer
          capabilityBar={
            <CapabilityBar
              choice={{
                onSelect: welcome.selectWorkspace,
                workspace: welcome.workspace,
                workspaces: welcome.workspaces,
                workspacesError: welcome.workspacesError,
              }}
              disabled={composerDisabled}
              inputRef={composerRef}
              plus={slash.plus}
              {...(requestedSessionId ? { session: { id: workspaceId, workspace } } : {})}
            />
          }
          disabled={composerDisabled}
          draft={draft}
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
