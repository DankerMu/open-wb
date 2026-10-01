import { useRef } from "react";
import type { ChatSession } from "../../lib/session-contract.js";
import { Button, Icon, Menu } from "../../ui/index.js";

type SessionMenuProps = {
  session: ChatSession;
  /** 条目的显示标题（无标题时的回退已由调用方算好）。 */
  title: string;
  /** `trigger` 是本菜单的「更多」按钮，供重命名 Dialog 关闭后归还焦点。 */
  onRename(trigger: HTMLElement | null): void;
  onTogglePin(): void;
};

/**
 * 条目行尾的「更多」菜单（demo:1909-1921）：`重命名`、`置顶任务` | `取消置顶`，对任何状态的会话
 * 可用。按钮始终在 DOM 中且可聚焦（demo:296-297 的「悬停才出现」不采用：触屏与键盘不可达）。
 */
export function SessionMenu({ session, title, onRename, onTogglePin }: SessionMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Menu
      items={[
        { label: "重命名", icon: "pencil", onSelect: () => onRename(triggerRef.current) },
        {
          label: session.pinnedAt === null ? "置顶任务" : "取消置顶",
          icon: "star",
          onSelect: onTogglePin,
        },
      ]}
      trigger={
        <Button
          aria-label={`更多操作：${title}`}
          className="chat-session-more"
          ref={triggerRef}
          size="icon"
          variant="ghost"
        >
          <Icon name="more-horizontal" />
        </Button>
      }
    />
  );
}
