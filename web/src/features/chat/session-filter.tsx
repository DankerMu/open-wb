import { Button, Icon, Popover, SegmentedControl } from "../../ui/index.js";
import type { SessionFilter as SessionFilterValue } from "./session-groups.js";

const LABEL = "筛选任务";

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "running", label: "进行中" },
  { value: "finished", label: "已完成" },
] as const;

const TIME_OPTIONS = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "earlier", label: "更早" },
] as const;

/**
 * `筛选任务`（demo:1787、1828-1851）：图标按钮打开弹层，状态与时间各一个分段单选组，选择即回调、
 * 弹层保持打开。筛选值由会话页持有；键盘、焦点与关闭行为全部来自 Popover 与 SegmentedControl。
 */
export function SessionFilter({
  onChange,
  value,
}: {
  onChange(next: SessionFilterValue): void;
  value: SessionFilterValue;
}) {
  return (
    <Popover
      contentLabel={LABEL}
      trigger={
        <Button
          aria-label={LABEL}
          className="chat-session-filter-trigger"
          size="icon"
          title={LABEL}
          variant="ghost"
        >
          <Icon name="filter" />
        </Button>
      }
    >
      <div className="chat-session-filter">
        <span className="chat-session-filter-title">状态</span>
        <SegmentedControl
          label="状态"
          onValueChange={(status) => onChange({ ...value, status })}
          options={STATUS_OPTIONS}
          value={value.status}
        />
        <span className="chat-session-filter-title">时间</span>
        <SegmentedControl
          label="时间"
          onValueChange={(time) => onChange({ ...value, time })}
          options={TIME_OPTIONS}
          value={value.time}
        />
      </div>
    </Popover>
  );
}
