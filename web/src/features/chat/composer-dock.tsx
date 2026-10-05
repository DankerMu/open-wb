// 输入框上方的停靠区（design D7）：会话页列里线程之后、输入框之前的一个容器，不在线程的滚动容器内。
// 此刻只承载选中会话的待决审批提问卡——全部消息里 `decision === null` 的审批按 `id` 升序各一张。
// 没有内容时不渲染（不占位）。整体限高为列高的一半并在内部滚动；卡不随它收缩（`flex-none`）。
// 防误点：停靠区底边贴着输入框，下方的卡消失会让上方的卡滑到同一位置。已有卡显示期间卡的集合一变
// （有卡消失或新卡加入），此后 `MOVED_CLICK_GUARD_MS` 内所有卡忽略作答点击；从空到出现第一张卡不计。
import { useEffect, useState } from "react";
import { type AnswerApproval, ApprovalPromptCard } from "./approval-card.js";
import type { ChatState } from "./stream.js";

const MOVED_CLICK_GUARD_MS = 400;

function pendingApprovals(view: ChatState | null) {
  return (view?.messages ?? [])
    .flatMap((message) => message.approvals.filter((approval) => approval.decision === null))
    .sort((a, b) => a.id - b.id);
}

export function ComposerDock({
  onAnswerApproval,
  view,
}: {
  onAnswerApproval: AnswerApproval;
  /** 选中会话的视图；历史尚未到达时为 null。 */
  view: ChatState | null;
}) {
  const pending = pendingApprovals(view);
  const hasPending = pending.length > 0;
  // 有待决卡时全停靠区共用一个每秒一次的 tick；`now` 在渲染时读。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasPending) {
      return;
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [hasPending]);
  // 渲染期间比对上一次的 id 列表（同 tool-call-group.tsx 的 `seenFailed`）；卡在点击时自己读时钟，不另设定时器。
  const ids = pending.map((approval) => approval.id).join(",");
  const [shown, setShown] = useState({ ids, ignoreClicksUntil: 0 });
  if (shown.ids !== ids) {
    // 只有「变化前后都有卡」才算位移；停靠区清空或从空出现第一张卡都把它归零。
    const moved = shown.ids !== "" && ids !== "";
    setShown({ ids, ignoreClicksUntil: moved ? Date.now() + MOVED_CLICK_GUARD_MS : 0 });
  }
  if (!hasPending) {
    return null;
  }
  const now = Date.now();
  return (
    <div
      className="mx-auto box-border flex max-h-1/2 w-full max-w-3xl flex-none flex-col gap-2 overflow-y-auto px-2 narrow:px-0"
      data-slot="composer-dock"
    >
      {pending.map((approval) => (
        <ApprovalPromptCard
          approval={approval}
          ignoreClicksUntil={shown.ignoreClicksUntil}
          key={approval.id}
          now={now}
          onAnswer={onAnswerApproval}
        />
      ))}
    </div>
  );
}
