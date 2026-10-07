import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ChatSession } from "../../lib/session-contract.js";
import { useSidebarNavigate } from "../../lib/sidebar-slot.js";
import { Icon } from "../../ui/index.js";
import {
  groupSessionList,
  type SessionGroup,
  type SessionGrouping,
  searchSessions,
} from "./session-groups.js";
import { SessionMenu } from "./session-menu.js";
import { sessionTitle } from "./session-path.js";
import { SessionStatusMark } from "./session-status-mark.js";
import type { SessionListView } from "./use-session-list-view.js";

const SEARCH_LABEL = "搜索任务";
const GROUPING_LABEL = "分组方式";
const GROUPING_OPTIONS: readonly { value: SessionGrouping; label: string }[] = [
  { value: "workspace", label: "按工作空间" },
  { value: "time", label: "按时间" },
];

type EntryActions = {
  /** `trigger` 是该条目的「更多」按钮：确认框与重命名 Dialog 关闭后把焦点还给它。 */
  onDeleteSession(session: ChatSession, trigger: HTMLElement | null): void;
  onRenameSession(session: ChatSession, trigger: HTMLElement | null): void;
  onTogglePin(session: ChatSession): void;
};

type SessionSidebarProps = EntryActions & {
  /** 列表动作的失败（没有对话框可显示的那些）：列表区顶部的一条可关闭提示；null 为没有。 */
  actionAlert: string | null;
  listError: string | null;
  listLoading: boolean;
  onCreateSession(): void;
  onDismissActionAlert(): void;
  onSelectSession(sessionId: string): void;
  requestedSessionId: string | null;
  sessions: ChatSession[] | null;
  /** 搜索词、分组方式与折叠状态：由会话页持有（列表节点会随侧栏折叠与覆盖层关闭卸载）。 */
  view: SessionListView;
  workspaces: readonly { id: string; name: string }[] | null;
};

type GroupProps = EntryActions & {
  group: SessionGroup;
  onSelect(sessionId: string): void;
  onToggle(): void;
  open: boolean;
  requestedSessionId: string | null;
};

/**
 * 一个分组：`role="group"`，accessible name 取自标签按钮；按钮以 `aria-expanded` 表示展开与否，
 * 折叠时 Collapsible 不渲染条目。条目是选择按钮（内含状态元素）与同级的「更多」按钮。
 */
function SessionGroupSection({
  group,
  onDeleteSession,
  onRenameSession,
  onSelect,
  onToggle,
  onTogglePin,
  open,
  requestedSessionId,
}: GroupProps) {
  const labelId = useId();
  return (
    <Collapsible
      aria-labelledby={labelId}
      className="flex min-w-0 flex-none flex-col gap-1"
      onOpenChange={onToggle}
      open={open}
      role="group"
    >
      <CollapsibleTrigger asChild>
        <Button
          className="w-full justify-start gap-1 px-1 text-[11px] text-muted-foreground"
          id={labelId}
          size="sm"
          variant="ghost"
        >
          <span className="flex flex-none transition-transform group-aria-expanded/button:rotate-90">
            <Icon name="chevron-right" size={12} />
          </span>
          <span className="min-w-0 truncate">{group.name}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。 */}
        <ul className="m-0 flex list-none flex-col gap-1 p-0" role="list">
          {group.sessions.map((session) => {
            const title = sessionTitle(session);
            return (
              // `group/session`：条目菜单的「更多」按钮（session-menu.tsx）按它的悬停与焦点显现。
              <li className="group/session flex min-w-0 items-center gap-0.5" key={session.id}>
                <button
                  aria-current={session.id === requestedSessionId ? "true" : undefined}
                  aria-label={title}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-transparent bg-transparent px-2.5 py-2 text-left text-(--wb-text-primary) outline-none hover:bg-(--wb-brand-primary-subtle) focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=true]:border-(--wb-border-default) aria-[current=true]:bg-(--wb-brand-primary-subtle) aria-[current=true]:text-(--wb-brand-primary-deep)"
                  data-slot="session-select"
                  onClick={() => onSelect(session.id)}
                  type="button"
                >
                  <SessionStatusMark session={session} title={title} />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold">
                    {title}
                  </span>
                </button>
                <SessionMenu
                  onDelete={(trigger) => onDeleteSession(session, trigger)}
                  onRename={(trigger) => onRenameSession(session, trigger)}
                  onTogglePin={() => onTogglePin(session)}
                  session={session}
                  title={title}
                />
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 侧栏列表区（session-sidebar「分组侧栏」「标题搜索」）：`新建会话`、搜索框、`分组方式` 菜单与
 * 可折叠分组，由 ChatPage 经侧栏槽位上报、在 shell 侧栏内渲染。数据、视图状态与回调都来自
 * ChatPage；覆盖层内选择会话或新建后调用侧栏提供的关闭回调，搜索、分组方式、分组标签与条目的
 * 「更多」菜单不调用。
 * 默认视图只含未归档的会话（`groupSessionList` 不产出已归档的）；搜索词非空时忽略折叠（不改写存储值），标签按钮此时不切换。
 * 按时间分组的当前时间取渲染时刻，不设定时器。
 */
export function SessionSidebar({
  actionAlert,
  listError,
  listLoading,
  onCreateSession,
  onDeleteSession,
  onDismissActionAlert,
  onRenameSession,
  onSelectSession,
  onTogglePin,
  requestedSessionId,
  sessions,
  view,
  workspaces,
}: SessionSidebarProps) {
  const onNavigate = useSidebarNavigate();
  const createRef = useRef<HTMLButtonElement>(null);
  const searching = view.query.trim() !== "";
  const groups = sessions
    ? groupSessionList(searchSessions(sessions, view.query), workspaces, view.grouping, Date.now())
    : null;
  return (
    <nav aria-label="会话列表" className="flex min-h-0 flex-1 flex-col gap-2.5 pt-1 pb-3">
      {actionAlert ? (
        <p
          className="m-0 flex flex-none items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-(--wb-status-error-text)"
          role="alert"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{actionAlert}</span>
          <Button
            aria-label="关闭提示"
            className="text-inherit"
            onClick={() => {
              onDismissActionAlert();
              // 按钮随提示卸载，焦点交给 新建会话，不落回 body。
              createRef.current?.focus();
            }}
            size="icon-xs"
            variant="ghost"
          >
            <Icon name="x" />
          </Button>
        </p>
      ) : null}
      <Button
        className="w-full flex-none"
        ref={createRef}
        onClick={() => {
          onCreateSession();
          onNavigate?.();
        }}
      >
        新建会话
      </Button>
      <div className="flex flex-none items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-(--wb-icon-muted)">
            <Icon name="search" size={14} />
          </span>
          <Input
            aria-label={SEARCH_LABEL}
            className="pl-8"
            onChange={(event) => view.setQuery(event.target.value)}
            placeholder={SEARCH_LABEL}
            type="search"
            value={view.query}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={GROUPING_LABEL}
              className="flex-none text-muted-foreground"
              size="icon"
              title={GROUPING_LABEL}
              variant="ghost"
            >
              <Icon name="layout-grid" size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuRadioGroup
              onValueChange={(value) => view.setGrouping(value === "time" ? "time" : "workspace")}
              value={view.grouping}
            >
              {GROUPING_OPTIONS.map(({ label, value }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {listError ? (
        <p className="ui-alert flex-none" role="alert">
          {listError}
        </p>
      ) : null}
      {listLoading ? (
        <p className="ui-muted m-0 flex-none" role="status">
          正在读取会话
        </p>
      ) : null}
      {groups?.length === 0 ? (
        <p className="m-0 flex-none px-2 text-xs leading-8 text-(--wb-text-secondary)">
          没有匹配的任务
        </p>
      ) : null}
      {groups && groups.length > 0 ? (
        // 全部分组一起滚动；覆盖层由 Drawer 主体整体滚动，这里保持内容高度、不形成嵌套滚动。
        <div
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto in-data-[variant=overlay]:flex-none"
          data-slot="session-groups"
        >
          {groups.map((group) => (
            <SessionGroupSection
              group={group}
              key={group.key}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onSelect={(sessionId) => {
                onSelectSession(sessionId);
                onNavigate?.();
              }}
              onToggle={() => {
                if (!searching) view.toggleGroup(group.key);
              }}
              onTogglePin={onTogglePin}
              open={searching || !view.collapsed.includes(group.key)}
              requestedSessionId={requestedSessionId}
            />
          ))}
        </div>
      ) : null}
    </nav>
  );
}
