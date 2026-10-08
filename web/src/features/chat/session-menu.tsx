import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatSession } from "../../lib/session-contract.js";
import { Icon } from "../../ui/index.js";

type SessionMenuProps = {
  session: ChatSession;
  /** 条目的显示标题（无标题时的回退已由调用方算好）。 */
  title: string;
  /** `trigger` 是本菜单的「更多」按钮，供重命名对话框与删除确认框关闭后归还焦点。 */
  onRename(trigger: HTMLElement | null): void;
  onTogglePin(): void;
  onArchive(): void;
  onRestore(): void;
  onDelete(trigger: HTMLElement | null): void;
  onPromote(trigger: HTMLElement | null): void;
  onExport(): void;
};

/**
 * 条目行尾的「更多」菜单（demo:1909-1921）。未归档的会话（默认视图）：`重命名`、`置顶任务` |
 * `取消置顶`、`归档`、`删除`，用临时空间的会话在其后多一项 `另存为工作空间`，最后是 `导出记录`；`归档`
 * 在 `running` 的会话上禁用，其余项对任何状态可用。已归档的会话
 * （归档视图）：恰 `恢复`、`删除`。两个视图各只渲染一类会话，所以按 `archivedAt` 分支。按钮始终在 DOM 中且可聚焦（demo:296-297 的「悬停才出现」不采用：触屏与键盘不可达）：
 * 只在可悬停的宽屏上以透明度弱化，条目（`group/session`，session-entry.tsx 的 `li`）悬停、其内
 * 有焦点或菜单打开时显现。`modal={false}`：外点关闭且点击到达目标，不锁 body 的指针事件。
 */
export function SessionMenu({
  session,
  title,
  onRename,
  onTogglePin,
  onArchive,
  onRestore,
  onDelete,
  onPromote,
  onExport,
}: SessionMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`更多操作：${title}`}
          className="flex-none text-muted-foreground group-hover/session:opacity-100 group-focus-within/session:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)_and_(min-width:761px)]:opacity-0"
          ref={triggerRef}
          size="icon"
          variant="ghost"
        >
          <Icon name="more-horizontal" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36" collisionPadding={8} loop>
        {session.archivedAt === null ? (
          <>
            <DropdownMenuItem onSelect={() => onRename(triggerRef.current)}>
              <Icon name="pencil" size={14} />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTogglePin}>
              <Icon name="star" size={14} />
              {session.pinnedAt === null ? "置顶任务" : "取消置顶"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={session.status === "running"} onSelect={onArchive}>
              <Icon name="archive" size={14} />
              归档
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={onRestore}>
            <Icon name="refresh-cw" size={14} />
            恢复
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onDelete(triggerRef.current)} variant="destructive">
          <Icon name="trash" size={14} />
          删除
        </DropdownMenuItem>
        {session.archivedAt === null && session.temporaryWorkspace ? (
          <DropdownMenuItem onSelect={() => onPromote(triggerRef.current)}>
            <Icon name="folder" size={14} />
            另存为工作空间
          </DropdownMenuItem>
        ) : null}
        {session.archivedAt === null ? (
          <DropdownMenuItem onSelect={onExport}>
            <Icon name="download" size={14} />
            导出记录
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
