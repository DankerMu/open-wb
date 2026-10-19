// 任务清单面板（design D10）：停靠区最上方的只读清单，内容是归约出的 `ChatState.todo`。头部按钮
// `任务清单 <完成数>/<总数>` 切换展开与收起；收起时列表不渲染。列表有自己的限高并在内部滚动，头部按钮
// 在它之外。限高分两档：停靠区里有待决提问卡时（`compact`）取小——展开的面板要与第一张提问卡（正文
// 顶满限高、带超长提示与失败文案时）一起落在停靠区的半列高之内，1440×900 与 390×844 下都是如此；没有
// 提问卡时取大，多显示几项。显隐（含未完结任务，或本页保留的已完结清单，epic-acceptance-followups D6）与
// 按会话保存的展开状态由 composer-dock.tsx 决定。
// 状态标记（epic-acceptance-followups D5，owner C1）：每项开头是 `aria-hidden` 的状态图标，颜色在图标的外包
// span 上（svg 取 `currentColor`）；状态词放在 `data-slot="todo-status"` 的 `sr-only` 节点里，只供读屏，
// 列表项的可访问文本因此以状态词开头、视觉上只见图标。任务项带 `relative`：`sr-only` 节点绝对定位，没有
// 定位祖先时以初始包含块为准，长清单会撑高文档（390×844 下 20 项实测 895 > 844）。`name` 与 `content`
// 按文本渲染。列表被限高裁掉时带 `tabindex="0"`（可由键盘聚焦滚动，design D3）：它不是控件，没有角色之外的交互。
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "../../components/icon.js";
import type { ChatState } from "./stream.js";
import { useClipped } from "./use-clipped.js";

type Todo = NonNullable<ChatState["todo"]>;
type TaskStatus = Todo["phases"][number]["tasks"][number]["status"];

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  abandoned: "已放弃",
  blocked: "受阻",
};

/** owner C1：待办空心圆、进行中半圆弧、完成带勾的圆、放弃带叉的圆、受阻禁止符。 */
const STATUS_ICON: Record<TaskStatus, IconName> = {
  pending: "circle",
  in_progress: "loader-circle",
  completed: "circle-check",
  abandoned: "circle-x",
  blocked: "ban",
};

const STATUS_TONE: Record<TaskStatus, string> = {
  pending: "text-(--wb-text-secondary)",
  in_progress: "text-(--wb-brand-primary-deep)",
  completed: "text-(--wb-status-success-text)",
  abandoned: "text-(--wb-text-secondary)",
  blocked: "text-(--wb-status-warning-text)",
};

/** 已经了结的任务：正文划线并减淡。 */
const CLOSED_TEXT = "text-(--wb-text-secondary) line-through";

const CONTENT_TONE: Record<TaskStatus, string> = {
  pending: "text-(--wb-text-primary)",
  in_progress: "text-(--wb-text-primary)",
  completed: CLOSED_TEXT,
  abandoned: CLOSED_TEXT,
  blocked: "text-(--wb-text-primary)",
};

function tasksOf(todo: Todo) {
  return todo.phases.flatMap((phase) => phase.tasks);
}

/** 至少有一个任务既没完成也没放弃；全部完结的清单只在 composer-dock.tsx 保留它时显示。 */
export function hasUnfinishedTask(todo: Todo): boolean {
  return tasksOf(todo).some((task) => task.status !== "completed" && task.status !== "abandoned");
}

export function TodoPanel({
  compact,
  expanded,
  onToggle,
  todo,
}: {
  /** 停靠区里有待决提问卡：列表用较小的限高。 */
  compact: boolean;
  expanded: boolean;
  onToggle(): void;
  todo: Todo;
}) {
  const tasks = tasksOf(todo);
  const done = tasks.filter((task) => task.status === "completed").length;
  const named = todo.phases.length > 1;
  const listRef = useRef<HTMLUListElement>(null);
  // 列表只在展开时渲染：收起态挂载后再展开要重量，并把观察器挂到新元素上。
  const clipped = useClipped(listRef, [todo, compact, expanded]);
  return (
    <div
      className="flex min-w-0 flex-none flex-col rounded-xl border border-(--wb-border-default) bg-(--wb-bg-secondary)"
      data-slot="todo-panel"
    >
      <Button
        aria-expanded={expanded}
        className="h-8 w-full justify-between rounded-xl px-4 text-[13px] font-semibold text-(--wb-text-primary)"
        data-slot="todo-toggle"
        onClick={onToggle}
        type="button"
        variant="ghost"
      >
        {`任务清单 ${done}/${tasks.length}`}
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
      </Button>
      {expanded ? (
        <ul
          className={`m-0 flex list-none flex-col gap-1 overflow-y-auto px-4 pt-0 pb-2 ${compact ? "max-h-16" : "max-h-40"}`}
          data-slot="todo-list"
          ref={listRef}
          // biome-ignore lint/a11y/noRedundantRoles: list-none 会让 Safari 丢掉列表语义，显式写回。
          role="list"
          tabIndex={clipped ? 0 : undefined}
        >
          {todo.phases.map((phase, at) => (
            <Phase
              // biome-ignore lint/suspicious/noArrayIndexKey: 清单整体替换、没有稳定 id，阶段名可以重复。
              key={at}
              name={named ? phase.name : null}
              tasks={phase.tasks}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Phase({ name, tasks }: { name: string | null; tasks: Todo["phases"][number]["tasks"] }) {
  return (
    <>
      {name === null ? null : (
        <li
          className="mt-1 flex-none text-xs font-medium wrap-anywhere text-(--wb-text-secondary) first:mt-0"
          data-slot="todo-phase"
          role="presentation"
        >
          {name}
        </li>
      )}
      {tasks.map((task, at) => (
        <li
          className="relative flex min-w-0 flex-none items-start gap-2 text-[12.5px] leading-normal"
          data-slot="todo-task"
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上，任务文本可以重复。
          key={at}
        >
          <span
            aria-hidden="true"
            className={`flex h-lh flex-none items-center ${STATUS_TONE[task.status]}`}
          >
            <Icon name={STATUS_ICON[task.status]} size={14} />
          </span>
          <span className="sr-only" data-slot="todo-status" data-status={task.status}>
            {STATUS_LABEL[task.status]}
          </span>
          <span
            className={`min-w-0 wrap-anywhere ${CONTENT_TONE[task.status]}`}
            data-slot="todo-content"
          >
            {task.content}
          </span>
        </li>
      ))}
    </>
  );
}
