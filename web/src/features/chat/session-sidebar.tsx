import { useEffect, useId, useRef } from "react";
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
import { ArchivedView } from "./archived-view.js";
import { type EntryActions, SessionEntryList } from "./session-entry.js";
import {
  groupSessionList,
  type SessionGroup,
  type SessionGrouping,
  searchSessions,
} from "./session-groups.js";
import type { SessionListView } from "./use-session-list-view.js";

const SEARCH_LABEL = "搜索任务";
const GROUPING_LABEL = "分组方式";
const GROUPING_OPTIONS: readonly { value: SessionGrouping; label: string }[] = [
  { value: "workspace", label: "按工作空间" },
  { value: "time", label: "按时间" },
];

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
  /** 搜索词、分组方式、折叠状态与归档视图开关：由会话页持有（列表节点会随侧栏折叠与覆盖层关闭卸载）。 */
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
 * 折叠时 Collapsible 不渲染条目。
 */
function SessionGroupSection({
  group,
  onSelect,
  onToggle,
  open,
  requestedSessionId,
  ...actions
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
        <SessionEntryList
          {...actions}
          onSelect={onSelect}
          requestedSessionId={requestedSessionId}
          sessions={group.sessions}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 侧栏列表区（session-sidebar「分组侧栏」「标题搜索」「归档视图」）：`新建会话`、搜索框、`分组方式`
 * 菜单、可折叠分组与底部的 `已归档` 入口，由 ChatPage 经侧栏槽位上报、在 shell 侧栏内渲染。数据、视图状态与回调都来自
 * ChatPage；覆盖层内选择会话或新建后调用侧栏提供的关闭回调，搜索、分组方式、分组标签与条目的
 * 「更多」菜单不调用。
 * 默认视图只含未归档的会话（`groupSessionList` 不产出已归档的）；搜索词非空时忽略折叠（不改写存储值），标签按钮此时不切换。
 * 按时间分组的当前时间取渲染时刻，不设定时器。
 * `view.archived` 时 `分组方式`、分组列表与入口换成 `ArchivedView`；`新建会话`（nav 的第一个直接子
 * 按钮，对话框关闭后的焦点回落靠它）、搜索框与读取状态两个视图共用。入口只在默认视图渲染（含空、
 * 读取中、读取失败），与 `返回会话列表` 互为焦点落点：切换时原按钮已卸载，焦点在 effect 里交给对方。
 */
export function SessionSidebar({
  actionAlert,
  listError,
  listLoading,
  onCreateSession,
  onDismissActionAlert,
  onSelectSession,
  requestedSessionId,
  sessions,
  view,
  workspaces,
  ...actions
}: SessionSidebarProps) {
  const onNavigate = useSidebarNavigate();
  const createRef = useRef<HTMLButtonElement>(null);
  const archivedEntryRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  /** 本次视图切换由这里的按钮发起：只有这时才移动焦点（列表区重新挂载时不抢焦点）。 */
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    (view.archived ? backRef : archivedEntryRef).current?.focus();
  }, [view.archived]);
  const switchView = (archived: boolean) => {
    switched.current = true;
    view.setArchived(archived);
  };
  const select = (sessionId: string) => {
    onSelectSession(sessionId);
    onNavigate?.();
  };
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
        {view.archived ? null : (
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
        )}
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
      {view.archived ? (
        <ArchivedView
          {...actions}
          backRef={backRef}
          onBack={() => switchView(false)}
          onSelect={select}
          query={view.query}
          requestedSessionId={requestedSessionId}
          sessions={sessions}
        />
      ) : (
        <>
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
                  {...actions}
                  group={group}
                  key={group.key}
                  onSelect={select}
                  onToggle={() => {
                    if (!searching) view.toggleGroup(group.key);
                  }}
                  open={searching || !view.collapsed.includes(group.key)}
                  requestedSessionId={requestedSessionId}
                />
              ))}
            </div>
          ) : null}
          <Button
            className="mt-auto w-full flex-none justify-start gap-2 text-muted-foreground"
            onClick={() => switchView(true)}
            ref={archivedEntryRef}
            size="sm"
            variant="ghost"
          >
            <Icon name="archive" size={14} />
            已归档
          </Button>
        </>
      )}
    </nav>
  );
}
