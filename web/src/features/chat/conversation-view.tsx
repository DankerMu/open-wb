import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";
import type { ApiClient } from "../../lib/api.js";
import type { ComposerOptions } from "../../lib/composer-contract.js";
import type { ChatSession } from "../../lib/session-contract.js";
import { ArchivedNotice } from "./archived-notice.js";
import type { useAttachmentArea } from "./attachment-chips.js";
import { CapabilityBar } from "./capability-bar.js";
import { Composer } from "./composer.js";
import { ComposerDock } from "./composer-dock.js";
import { Thread } from "./message-thread.js";
import { ModelPicker } from "./model-picker.js";
import type { useSlashMenu } from "./slash-menu.js";
import type { ChatState } from "./stream.js";
import type { TranscriptHandle } from "./thread-viewport.js";
import { UndoNotice } from "./undo-notice.js";
import { WelcomeIntro, WelcomePlaybooks } from "./welcome.js";
import type { WelcomeOptions } from "./welcome-options.js";
import type { SessionSpace, Workspace } from "./workspace-list.js";

type AnswerApproval = ComponentProps<typeof ComposerDock>["onAnswerApproval"];
type StopTurn = ComponentProps<typeof Composer>["onStop"];

type PermissionSlot = Pick<ComponentProps<typeof CapabilityBar>, "permission">;

/**
 * 能力栏的权限档位位（展开进 `CapabilityBar` 的 props）：输入框选项未取得时没有；已选会话取其视图的档位、选择即提交 PATCH（视图还没解析
 * 出来时没有）；欢迎态取页面内存里选过的值、没选过回落到缺省档，选择只改内存、不发请求。
 */
function permissionSlot({
  approvalMode,
  composerOptions,
  onPatchComposer,
  requestedSessionId,
  welcome,
}: Pick<
  ConversationViewProps,
  "approvalMode" | "composerOptions" | "onPatchComposer" | "requestedSessionId" | "welcome"
>): PermissionSlot {
  if (composerOptions === null) return {};
  const modes = composerOptions.approvalModes;
  if (!requestedSessionId) {
    return {
      permission: {
        mode: welcome.picked.approvalMode ?? composerOptions.defaults.approvalMode,
        modes,
        onChange: (mode) => welcome.pick({ approvalMode: mode }),
        scope: "",
      },
    };
  }
  if (approvalMode === undefined) return {};
  return {
    permission: {
      mode: approvalMode,
      modes,
      onChange: (mode) => onPatchComposer(requestedSessionId, { approvalMode: mode }),
      scope: requestedSessionId,
    },
  };
}

/**
 * 输入框右组的模型与强度控件：输入框选项未取得时没有；已选会话取其视图的模型与强度、选择即提交 PATCH（视图
 * 还没解析出来时没有）；欢迎态读写页面内存里选过的值。`key` 是会话 id：换会话即重挂，在途禁用不带过去。
 */
function modelSlot({
  composerOptions,
  modelId,
  onPatchComposer,
  reasoningEffort,
  requestedSessionId,
  welcome,
}: Pick<
  ConversationViewProps,
  | "composerOptions"
  | "modelId"
  | "onPatchComposer"
  | "reasoningEffort"
  | "requestedSessionId"
  | "welcome"
>): ReactNode {
  if (composerOptions === null) return null;
  if (!requestedSessionId) {
    return <ModelPicker key="" options={composerOptions} session={null} welcome={welcome} />;
  }
  if (modelId === undefined || reasoningEffort === undefined) return null;
  return (
    <ModelPicker
      key={requestedSessionId}
      options={composerOptions}
      session={{
        modelId,
        patch: (patch) => onPatchComposer(requestedSessionId, patch),
        reasoningEffort,
      }}
      welcome={welcome}
    />
  );
}

type ConversationViewProps = {
  /** 当前会话视图的权限档位；欢迎态与会话还没解析出来时为 undefined。 */
  approvalMode: ChatSession["approvalMode"] | undefined;
  /**
   * 选中的会话已归档时是只读说明的 props（`恢复` 的忙碌、失败文案与点击），否则为 null。非 null 时主区
   * 只读：不渲染输入框（含能力栏）与停靠区的内容，线程不出 `撤回`、`从此处分叉` 与 `重新生成`。
   */
  archived: ComponentProps<typeof ArchivedNotice> | null;
  /** 当前账号的 API client；产物卡经它按需拉取预览。 */
  client: ApiClient;
  composerDisabled: boolean;
  /** 输入框选项（可用档位、模型白名单与缺省值）；拉取中或失败时为 null，权限、模型与强度控件都不渲染。 */
  composerOptions: ComposerOptions | null;
  /** 输入框元素：回到欢迎态后由会话页聚焦它，「+」菜单点选后也聚焦它。 */
  composerRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  /** 附件区的四块：输入卡里的标签、提示、隐藏的文件输入框与「+」菜单的 `上传文件` 项。 */
  files: ReturnType<typeof useAttachmentArea>;
  generating: boolean;
  historyError: string | null;
  historyView: ChatState | null;
  /** 当前会话视图的模型；欢迎态与会话还没解析出来时为 undefined。 */
  modelId: ChatSession["modelId"] | undefined;
  onAnswerApproval: AnswerApproval;
  onChangeDraft(value: string): void;
  onFork(messageId: number): Promise<void>;
  /** 已选会话的设置提交（恰一次 PATCH）；返回的 promise 在任何结果下都落定。 */
  onPatchComposer(
    sessionId: string,
    patch: Pick<
      Parameters<ApiClient["patchSession"]>[1],
      "approvalMode" | "modelId" | "reasoningEffort"
    >,
  ): Promise<void>;
  onRegenerate(): Promise<void>;
  /** 现有发送路径的文本入口：运行时适配器的 `onNew` 委托给它。 */
  onSend(prompt: string): void;
  onStop: StopTurn;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onUndo: ComponentProps<typeof Thread>["onUndo"];
  promptError: string | null;
  /** 当前会话视图的推理强度（模型不支持推理时为 null）；欢迎态与会话还没解析出来时为 undefined。 */
  reasoningEffort: ChatSession["reasoningEffort"] | undefined;
  requestedSessionId: string | null;
  /** 对话内搜索：搜索框（未打开时为 null）、当前匹配的消息 id、交给转录区的句柄。 */
  search: { box: ReactNode; currentId: number | null; handleRef: Ref<TranscriptHandle> };
  sendDisabled: boolean;
  /** 斜杠命令候选：输入框上方的面板（不可见时为 null）、先于 Enter 规则的按键拦截，以及「+」菜单的状态。 */
  slash: ReturnType<typeof useSlashMenu>;
  /** 当前会话可解析的空间（文件变更卡与产物卡用；临时空间也算），不可解析时为 null。 */
  space: SessionSpace | null;
  streamError: string | null;
  /** 当前会话用的是临时空间（会话的 `temporaryWorkspace`；没有当前会话时为 false）：能力栏标签读作 `临时空间`。 */
  temporaryWorkspace: boolean;
  /** 撤回后未还原文件的说明；没有时为 null。只读（已归档）时不渲染。 */
  undoNotice: ComponentProps<typeof UndoNotice>["notice"];
  /** 欢迎态的场景与空间选择（状态在会话页）；有当前会话时场景不渲染，空间位换成只读标签。 */
  welcome: WelcomeOptions;
  /** 当前会话的空间（取自空间列表）；未绑定、不在列表里、列表读取中或读取失败时为 undefined。 */
  workspace: Workspace | undefined;
  /** 当前会话绑定的工作空间 id：未绑定为 null，会话还没解析出来时为 undefined。 */
  workspaceId: string | null | undefined;
};

export function ConversationView({
  approvalMode,
  archived,
  client,
  composerDisabled,
  composerOptions,
  composerRef,
  draft,
  files,
  generating,
  historyError,
  historyView,
  modelId,
  onAnswerApproval,
  onChangeDraft,
  onFork,
  onPatchComposer,
  onRegenerate,
  onSend,
  onStop,
  onSubmit,
  onUndo,
  promptError,
  reasoningEffort,
  requestedSessionId,
  search,
  sendDisabled,
  slash,
  space,
  streamError,
  temporaryWorkspace,
  undoNotice,
  welcome,
  workspace,
  workspaceId,
}: ConversationViewProps) {
  // 说明里的 `恢复` 成功后按钮随说明卸载：焦点若因此落回 body，就在输入框出现的那次提交里交给它。
  // 只认「上一次提交时同一个会话的 `恢复` 在途」——换会话、行菜单的 `恢复` 都不动焦点。
  const restoring = useRef<string | null>(null);
  const restoringId = archived?.busy ? requestedSessionId : null;
  useLayoutEffect(() => {
    if (
      !archived &&
      restoring.current !== null &&
      restoring.current === requestedSessionId &&
      document.activeElement === document.body
    ) {
      composerRef.current?.focus();
    }
    restoring.current = restoringId;
  });
  const permission = permissionSlot({
    approvalMode,
    composerOptions,
    onPatchComposer,
    requestedSessionId,
    welcome,
  });
  const actions = modelSlot({
    composerOptions,
    modelId,
    onPatchComposer,
    reasoningEffort,
    requestedSessionId,
    welcome,
  });
  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden px-5 pt-4 pb-5 narrow:flex narrow:flex-col">
      <div
        className={`flex min-h-0 min-w-0 flex-col gap-2 narrow:flex-[1_1_0px] ${requestedSessionId ? "overflow-hidden" : "overflow-x-hidden overflow-y-auto"}`}
        data-slot="chat-column"
      >
        {search.box}
        {historyError ? (
          <p className="ui-alert flex-none" role="alert">
            {historyError}
          </p>
        ) : null}
        {promptError ? (
          <p className="ui-alert flex-none" role="alert">
            {promptError}
          </p>
        ) : null}
        {streamError ? (
          <p className="ui-alert flex-none" role="alert">
            {streamError}
          </p>
        ) : null}
        {files.notice}
        {requestedSessionId ? (
          <Thread
            archived={archived !== null}
            client={client}
            currentId={search.currentId}
            key={requestedSessionId}
            locked={composerDisabled}
            onFork={onFork}
            onRegenerate={onRegenerate}
            onSend={onSend}
            onStop={onStop}
            onUndo={onUndo}
            scrollHandleRef={search.handleRef}
            space={space}
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
        <UndoNotice notice={archived ? null : undoNotice} />
        {/* 停靠区保持挂载（展开状态按会话记在它里面）；只读时不给它视图，它就不渲染任何内容。 */}
        <ComposerDock
          inputLocked={composerDisabled}
          inputRef={composerRef}
          onAnswerApproval={onAnswerApproval}
          sessionId={requestedSessionId}
          view={archived ? null : historyView}
        />
        {archived ? (
          <ArchivedNotice {...archived} />
        ) : (
          <Composer
            actions={actions}
            attachments={files.chips}
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
                upload={files.upload}
                {...permission}
                {...(requestedSessionId
                  ? { session: { id: workspaceId, workspace, temporary: temporaryWorkspace } }
                  : {})}
              />
            }
            disabled={composerDisabled}
            draft={draft}
            generating={generating}
            inputRef={composerRef}
            interceptKeyDown={slash.interceptKeyDown}
            onChangeDraft={onChangeDraft}
            onFiles={files.receive}
            onStop={onStop}
            onSubmit={onSubmit}
            placeholder={requestedSessionId ? "继续追问，或派一个新任务…" : "今天帮你做些什么"}
            sendDisabled={sendDisabled}
            slashMenu={slash.menu}
            stopSessionId={requestedSessionId}
          />
        )}
        {requestedSessionId ? null : (
          <WelcomePlaybooks disabled={composerDisabled} onPick={onChangeDraft} />
        )}
        {files.input}
      </div>
    </div>
  );
}
