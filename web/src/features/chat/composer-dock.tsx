// 输入框上方的停靠区（design D7）：会话页列里线程之后、输入框之前的一个容器，不在线程的滚动容器内。
// 自上而下承载选中会话的任务清单面板（design D10，todo-panel.tsx）与待决审批提问卡——全部消息里
// `decision === null` 的审批按 `id` 升序各一张。二者都没有时不渲染（不占位）；欢迎态没有视图（`view` 为
// null），同样不渲染，但组件保持挂载：面板的展开状态按会话记在这里（内存，默认展开），切换会话与往返欢迎态都保留。
// 整体限高为列高的一半并在内部滚动；面板与卡不随它收缩（`flex-none`）。
// 防误点：停靠区底边贴着输入框，下方的卡消失会让上方的卡滑到同一位置；停靠区滚动时，面板出现、消失、
// 收起或换了内容也会把它下方的卡整体推移。已有卡显示期间卡的集合或面板的形状一变，此后
// `MOVED_CLICK_GUARD_MS` 内所有卡忽略作答点击；从空到出现第一张卡不计。
import { useEffect, useState } from "react";
import { type AnswerApproval, ApprovalPromptCard } from "./approval-card.js";
import type { ChatState } from "./stream.js";
import { hasUnfinishedTask, TodoPanel } from "./todo-panel.js";

const MOVED_CLICK_GUARD_MS = 400;

function pendingApprovals(view: ChatState | null) {
  return (view?.messages ?? [])
    .flatMap((message) => message.approvals.filter((approval) => approval.decision === null))
    .sort((a, b) => a.id - b.id);
}

export function ComposerDock({
  onAnswerApproval,
  sessionId,
  view,
}: {
  onAnswerApproval: AnswerApproval;
  /** 选中的会话；欢迎态为 null。 */
  sessionId: string | null;
  /** 选中会话的视图；欢迎态与历史尚未到达时为 null。 */
  view: ChatState | null;
}) {
  const pending = pendingApprovals(view);
  const hasPending = pending.length > 0;
  const todo = view?.todo && hasUnfinishedTask(view.todo) ? view.todo : null;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const expanded = sessionId === null || !collapsed.has(sessionId);
  const toggle = () => {
    if (sessionId === null) return;
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  };
  // 有待决卡时全停靠区共用一个每秒一次的 tick；`now` 在渲染时读。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasPending) {
      return;
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [hasPending]);
  // 渲染期间比对上一次的布局（同 tool-call-group.tsx 的 `seenFailed`）；卡在点击时自己读时钟，不另设定时器。
  // 布局 = 卡的 id 列表 + 卡上方面板的形状（没有面板、收起、或展开时的清单内容）。面板列表的限高档位
  // 只在卡从无到有或从有到无时切换，那两种变化本来就不算位移，所以不进形状。
  const ids = pending.map((approval) => approval.id).join(",");
  const panel = todo === null ? "" : expanded ? JSON.stringify(todo) : "collapsed";
  const [layout, setLayout] = useState({ ids, panel, ignoreClicksUntil: 0 });
  if (layout.ids !== ids || layout.panel !== panel) {
    // 只有「变化前后都有卡」才算位移；停靠区清空或从空出现第一张卡都把它归零。
    const moved = layout.ids !== "" && ids !== "";
    setLayout({ ids, panel, ignoreClicksUntil: moved ? Date.now() + MOVED_CLICK_GUARD_MS : 0 });
  }
  if (!hasPending && todo === null) {
    return null;
  }
  const now = Date.now();
  return (
    <div
      className="mx-auto box-border flex max-h-1/2 w-full max-w-3xl flex-none flex-col gap-2 overflow-y-auto px-2 narrow:px-0"
      data-slot="composer-dock"
    >
      {todo === null ? null : (
        <TodoPanel compact={hasPending} expanded={expanded} onToggle={toggle} todo={todo} />
      )}
      {pending.map((approval) => (
        <ApprovalPromptCard
          approval={approval}
          ignoreClicksUntil={layout.ignoreClicksUntil}
          key={approval.id}
          now={now}
          onAnswer={onAnswerApproval}
        />
      ))}
    </div>
  );
}
