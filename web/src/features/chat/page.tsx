import type { ComponentProps } from "react";
import { useSidebarNavigate, useSidebarSlot } from "../../lib/sidebar-slot.js";
import { useTopbar } from "../../lib/topbar.js";
import { useAttachmentArea } from "./attachment-chips.js";
import { useConversationSearch } from "./conversation-search.js";
import { ConversationView } from "./conversation-view.js";
import { DeleteDialog } from "./delete-dialog.js";
import { useProjectConfig } from "./project-config.js";
import { PromoteDialog } from "./promote-dialog.js";
import { RenameDialog } from "./rename-dialog.js";
import { SessionSidebar } from "./session-sidebar.js";
import { useSlashMenu } from "./slash-menu.js";
import { chatTopbar } from "./topbar-actions.js";
import { UndoConflictDialog } from "./undo-conflict-dialog.js";
import { useChatSession } from "./use-chat-session.js";
import {
  useExpertHandOff,
  useExpertList,
  useSessionCapabilities,
  useSkillDefaults,
} from "./use-session-capabilities.js";
import { useSessionListView } from "./use-session-list-view.js";
import { useWorkspaceSidebar } from "./use-workspace-sidebar.js";
import { WorkspaceSplit } from "./workspace-sidebar.js";

type SessionListProps = Omit<ComponentProps<typeof SessionSidebar>, "onCreateSession"> & {
  onShowWelcome(focusComposer: boolean): void;
};

/**
 * 侧栏槽位里的列表：`新建会话` 只回欢迎态。它渲染在侧栏树内，读得到覆盖层的关闭回调——侧栏是
 * 覆盖层时不抢焦点（外壳关闭覆盖层并把焦点还给 `打开导航`），否则聚焦输入框。
 */
function SessionList({ onShowWelcome, ...props }: SessionListProps) {
  const overlay = useSidebarNavigate() !== undefined;
  return <SessionSidebar {...props} onCreateSession={() => onShowWelcome(!overlay)} />;
}

export function ChatPage() {
  // 页面状态、回调与 fence 都在 useChatSession；本组件只做组合与外壳接线。
  const session = useChatSession();
  const { client, draft, historyView, requestedSessionId, selected, sessionActions, workspace } =
    session;
  const sidebar = useWorkspaceSidebar(selected?.workspaceId, selected?.id);
  const search = useConversationSearch(selected?.id, historyView);
  const config = useProjectConfig(client, selected);
  useTopbar(
    chatTopbar(selected, sessionActions.openRename, search.slot, sidebar.slot, config.slot),
  );
  const listView = useSessionListView();
  // 只读判定（chat-web「会话页」）：`archivedAt` 可以是 0，所以与 null 比较；会话还没解析出来时按未归档。
  const archived =
    selected !== undefined && selected.archivedAt !== null
      ? sessionActions.restoreNotice(selected.id)
      : null;
  // 专家清单每个 client 取一次（与输入框选项同一时机）；会话能力按解析出的选中会话 id 每变化取一次（归档会话
  // 同样取；欢迎态与无法解析的 id 不取）。
  const experts = useExpertList(client, requestedSessionId);
  const capabilities = useSessionCapabilities(client, selected?.id);
  useExpertHandOff(session.welcome.selectExpert);
  // 欢迎态 `能力` 弹层的账号缺省停用列表：每个 client 在第一次打开弹层时取一次。
  const skillDefaults = useSkillDefaults(client);
  // 「+」菜单与斜杠候选不列的技能（chat-web「停用技能过滤」）：会话中为已取得的会话能力（未取得或失败时不过滤），
  // 欢迎态为弹层的页面选择 ?? 已取得的账号缺省 ?? 不过滤。
  const disabledSkills = requestedSessionId
    ? (capabilities.capabilities?.disabledSkills ?? null)
    : (session.welcome.disabledSkills ?? skillDefaults.disabledSkills);
  const slash = useSlashMenu(
    client,
    session.slashWorkspaceId,
    draft,
    !session.composerDisabled,
    session.setDraft,
    disabledSkills,
    // 能力弹层随输入框所在的上下文关闭：换会话、进出欢迎态、归档会话卸下输入框。
    archived ? undefined : requestedSessionId,
  );
  const files = useAttachmentArea({
    attachments: session.attachments,
    locked: session.composerDisabled,
    ready: session.composerOptions !== null,
    sessionId: requestedSessionId,
    workspaceId: session.slashWorkspaceId,
  });
  // 列表渲染进 shell 侧栏列表区（issue 424）；数据与回调经 SessionSidebar 的既有 props 传入。
  useSidebarSlot(
    <SessionList
      actionAlert={sessionActions.alert}
      listError={session.listError}
      listLoading={session.listLoading}
      onArchiveSession={sessionActions.archive}
      onDeleteSession={sessionActions.openDelete}
      onDismissActionAlert={sessionActions.dismissAlert}
      onExportSession={sessionActions.exportSession}
      onPromoteSession={sessionActions.openPromote}
      onRenameSession={sessionActions.openRename}
      onRestoreSession={sessionActions.restore}
      onSelectSession={session.selectSession}
      onShowWelcome={session.showWelcome}
      onTogglePin={sessionActions.togglePin}
      requestedSessionId={requestedSessionId}
      sessions={session.sessions}
      view={listView}
      workspaces={session.workspaces}
    />,
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <WorkspaceSplit
        sidebar={sidebar}
        target={
          sidebar.open && selected?.workspaceId
            ? {
                client,
                sessionId: selected.id,
                view: historyView,
                workspace,
                workspaceId: selected.workspaceId,
              }
            : null
        }
      >
        <ConversationView
          approvalMode={selected?.approvalMode}
          archived={archived}
          capabilities={capabilities}
          client={client}
          composerDisabled={session.composerDisabled}
          composerOptions={session.composerOptions}
          composerRef={session.composerRef}
          draft={draft}
          experts={experts}
          files={files}
          generating={session.generating}
          historyError={session.historyError}
          historyView={historyView}
          modelId={selected?.modelId}
          onAnswerApproval={session.answerApproval}
          onChangeDraft={session.setDraft}
          onFork={session.forkTurn}
          onModelMenuOpen={session.invalidateComposerOptions}
          onPatchComposer={sessionActions.patchComposer}
          onRegenerate={session.regenerateTurn}
          onReveal={sidebar.reveal}
          onSend={session.sendPrompt}
          onStop={session.stopTurn}
          onSubmit={session.submitComposer}
          onUndo={session.undoTurn}
          promptError={session.promptError}
          reasoningEffort={selected?.reasoningEffort}
          requestedSessionId={requestedSessionId}
          search={search}
          sendDisabled={session.sendDisabled}
          sending={session.sending}
          skillDefaults={skillDefaults}
          slash={slash}
          space={session.space}
          streamError={session.streamError}
          temporaryWorkspace={selected?.temporaryWorkspace ?? false}
          undoNotice={session.undoNotice}
          welcome={session.welcome}
          workspace={workspace}
          workspaceId={session.slashWorkspaceId}
        />
      </WorkspaceSplit>
      <RenameDialog rename={sessionActions.rename} />
      <PromoteDialog promote={sessionActions.promote} />
      <DeleteDialog remove={sessionActions.remove} />
      <UndoConflictDialog conflict={session.undoConflict} />
      {config.dialog}
    </section>
  );
}
