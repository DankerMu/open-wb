import type { ComponentProps } from "react";
import { useSidebarNavigate, useSidebarSlot } from "../../lib/sidebar-slot.js";
import { useTopbar } from "../../lib/topbar.js";
import { useArtifactsPanel } from "./artifacts-panel.js";
import { useConversationSearch } from "./conversation-search.js";
import { ConversationView } from "./conversation-view.js";
import { DeleteDialog } from "./delete-dialog.js";
import { useProjectConfig } from "./project-config.js";
import { RenameDialog } from "./rename-dialog.js";
import { SessionSidebar } from "./session-sidebar.js";
import { useSlashMenu } from "./slash-menu.js";
import { chatTopbar } from "./topbar-actions.js";
import { useChatSession } from "./use-chat-session.js";
import { useSessionListView } from "./use-session-list-view.js";

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
  const artifacts = useArtifactsPanel(client, historyView, workspace, selected?.id);
  const search = useConversationSearch(selected?.id, historyView);
  const config = useProjectConfig(client, selected);
  useTopbar(
    chatTopbar(selected, sessionActions.openRename, search.slot, artifacts.open, config.slot),
  );
  const listView = useSessionListView();
  const slash = useSlashMenu(
    client,
    session.slashWorkspaceId,
    draft,
    !session.composerDisabled,
    session.setDraft,
  );
  // 列表渲染进 shell 侧栏列表区（issue 424）；数据与回调经 SessionSidebar 的既有 props 传入。
  useSidebarSlot(
    <SessionList
      listError={session.listError}
      listLoading={session.listLoading}
      onDeleteSession={sessionActions.openDelete}
      onRenameSession={sessionActions.openRename}
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
      <ConversationView
        client={client}
        composerDisabled={session.composerDisabled}
        composerRef={session.composerRef}
        draft={draft}
        generating={session.generating}
        historyError={session.historyError}
        historyView={historyView}
        onAnswerApproval={session.answerApproval}
        onChangeDraft={session.setDraft}
        onFork={session.forkTurn}
        onRegenerate={session.regenerateTurn}
        onSend={session.sendPrompt}
        onStop={session.stopTurn}
        onSubmit={session.submitComposer}
        promptError={session.promptError}
        requestedSessionId={requestedSessionId}
        search={search}
        sendDisabled={session.sendDisabled}
        slash={slash}
        streamError={session.streamError}
        welcome={session.welcome}
        workspace={workspace}
        workspaceId={session.slashWorkspaceId}
      />
      <RenameDialog rename={sessionActions.rename} />
      <DeleteDialog remove={sessionActions.remove} />
      {artifacts.panel}
      {config.dialog}
    </section>
  );
}
