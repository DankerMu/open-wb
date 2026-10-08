import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import type { ChatSession } from "../../lib/session-contract.js";
import { Icon } from "../../ui/index.js";
import { type EntryActions, SessionEntryList } from "./session-entry.js";
import { searchSessions, splitArchived } from "./session-groups.js";

const BACK_LABEL = "返回会话列表";

type ArchivedViewProps = EntryActions & {
  /** `返回会话列表` 按钮：进入归档视图时列表区把焦点交给它。 */
  backRef: Ref<HTMLButtonElement>;
  onBack(): void;
  onSelect(sessionId: string): void;
  /** 与默认视图共用的搜索词：这里只在已归档的会话里搜。 */
  query: string;
  requestedSessionId: string | null;
  /** 已读取的会话列表（含未归档的）；读取中或读取失败时为 null，此时只渲染标题行。 */
  sessions: readonly ChatSession[] | null;
};

/**
 * 归档视图（session-sidebar「归档视图」）：在列表区内取代 `分组方式`、分组列表与 `已归档` 入口。
 * 标题 `已归档`、`返回会话列表`，其下按服务端次序平铺全部已归档的会话（不分组、没有置顶区）；
 * 没有已归档会话或搜索无匹配时显示 `没有匹配的任务`。条目与默认视图同形，菜单为 `恢复`、`删除`。
 */
export function ArchivedView({
  backRef,
  onBack,
  onSelect,
  query,
  requestedSessionId,
  sessions,
  ...actions
}: ArchivedViewProps) {
  const archived = sessions ? searchSessions(splitArchived(sessions).archived, query) : null;
  return (
    <>
      <div className="flex flex-none items-center gap-1">
        <Button
          aria-label={BACK_LABEL}
          className="flex-none text-muted-foreground"
          onClick={onBack}
          ref={backRef}
          size="icon"
          title={BACK_LABEL}
          variant="ghost"
        >
          <span className="flex rotate-180">
            <Icon name="chevron-right" size={16} />
          </span>
        </Button>
        <h2 className="m-0 min-w-0 truncate text-[13px] leading-5 font-semibold text-(--wb-text-primary)">
          已归档
        </h2>
      </div>
      {archived?.length === 0 ? (
        <p className="m-0 flex-none px-2 text-xs leading-8 text-(--wb-text-secondary)">
          没有匹配的任务
        </p>
      ) : null}
      {archived && archived.length > 0 ? (
        // 与默认视图的分组容器同样滚动；覆盖层由 Drawer 主体整体滚动，这里保持内容高度。
        <div
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto in-data-[variant=overlay]:flex-none"
          data-slot="archived-sessions"
        >
          <SessionEntryList
            {...actions}
            onSelect={onSelect}
            requestedSessionId={requestedSessionId}
            sessions={archived}
          />
        </div>
      ) : null}
    </>
  );
}
