import type { ChatSession } from "../../lib/session-contract.js";
import { SessionMenu } from "./session-menu.js";
import { sessionTitle } from "./session-path.js";
import { SessionStatusMark } from "./session-status-mark.js";

/** 条目菜单的动作，由会话页的 `useSessionActions` 提供；默认视图与归档视图的条目共用。 */
export type EntryActions = {
  onArchiveSession(session: ChatSession): void;
  /** `trigger` 是该条目的「更多」按钮：确认框与重命名 Dialog 关闭后把焦点还给它。 */
  onDeleteSession(session: ChatSession, trigger: HTMLElement | null): void;
  onRenameSession(session: ChatSession, trigger: HTMLElement | null): void;
  onRestoreSession(session: ChatSession): void;
  onTogglePin(session: ChatSession): void;
};

type SessionEntryProps = EntryActions & {
  onSelect(sessionId: string): void;
  selected: boolean;
  session: ChatSession;
};

/** 一个会话条目（`li`）：选择按钮（内含状态元素，选中时 `aria-current="true"`）与同级的「更多」按钮。 */
function SessionEntry({
  onArchiveSession,
  onDeleteSession,
  onRenameSession,
  onRestoreSession,
  onSelect,
  onTogglePin,
  selected,
  session,
}: SessionEntryProps) {
  const title = sessionTitle(session);
  return (
    // `group/session`：条目菜单的「更多」按钮（session-menu.tsx）按它的悬停与焦点显现。
    <li className="group/session flex min-w-0 items-center gap-0.5">
      <button
        aria-current={selected ? "true" : undefined}
        aria-label={title}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-transparent bg-transparent px-2.5 py-2 text-left text-(--wb-text-primary) outline-none hover:bg-(--wb-brand-primary-subtle) focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=true]:border-(--wb-border-default) aria-[current=true]:bg-(--wb-brand-primary-subtle) aria-[current=true]:text-(--wb-brand-primary-deep)"
        data-slot="session-select"
        onClick={() => onSelect(session.id)}
        type="button"
      >
        <SessionStatusMark session={session} title={title} />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold">{title}</span>
      </button>
      <SessionMenu
        onArchive={() => onArchiveSession(session)}
        onDelete={(trigger) => onDeleteSession(session, trigger)}
        onRename={(trigger) => onRenameSession(session, trigger)}
        onRestore={() => onRestoreSession(session)}
        onTogglePin={() => onTogglePin(session)}
        session={session}
        title={title}
      />
    </li>
  );
}

type SessionEntryListProps = EntryActions & {
  onSelect(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: readonly ChatSession[];
};

/** 按给定次序的条目列表：默认视图的每个分组与归档视图的平铺列表都用它。 */
export function SessionEntryList({
  onSelect,
  requestedSessionId,
  sessions,
  ...actions
}: SessionEntryListProps) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
    <ul className="m-0 flex list-none flex-col gap-1 p-0" role="list">
      {sessions.map((session) => (
        <SessionEntry
          {...actions}
          key={session.id}
          onSelect={onSelect}
          selected={session.id === requestedSessionId}
          session={session}
        />
      ))}
    </ul>
  );
}
