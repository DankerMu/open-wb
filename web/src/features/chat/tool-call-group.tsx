// 工具调用组（design D4、D13）：应用层组合拷入层 `tool-group` 的 Root / Trigger / Content，一条消息的全部
// 步骤收在一个组里，步骤卡是应用层的 `StepCard`。行为在这里定：
// - 折叠态受控：默认收起，打开时已有失败步骤则展开；失败步骤数变多（出现新的失败步骤）时展开，其余变化
//   （正文增量、步骤开始或正常结束）不动它，所以手动收起、手动展开都保留到下一个新失败为止。
// - 没有步骤时不渲染，带状态的 `Group` 随之卸载：新回合清空步骤后，下一轮的组从默认态开始。
// - 摘要行（步骤数、末位步骤的名称与状态文字）经 Trigger 的 children 给出；有步骤在跑时 `active`，
//   摘要带 `shimmer`（`tw-shimmer`）与转圈图标，减少动态效果时由插件与全局 reduce 块停掉。
// - 拷入的 Root 在每次手动切换时调用 `useScrollLock`：从 Root 自身起向上找第一个 `overflow-y` 为
//   auto / scroll 的元素，200ms 内把它的 `scrollTop` 钉回原值并改它的滚动条与内边距。落到转录滚动
//   容器上会被滚动层读成用户上滚、解除贴底。Root 自己带 `overflow-y-auto`（不限高，永不滚动）后锁只
//   落在组自身，转录容器不受影响；拷入文件不改。
import { useState } from "react";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { SESSION_STATUS_LABEL } from "./status-label.js";
import { StepCard } from "./step-card.js";
import type { ChatStepView } from "./stream-steps.js";

function failedCount(steps: readonly ChatStepView[]): number {
  return steps.filter((step) => step.status === "failed").length;
}

/** 一条消息的工具调用组；没有步骤时不渲染。 */
export function ToolCallGroup({ steps }: { steps: readonly ChatStepView[] }) {
  const last = steps.at(-1);
  return last ? <Group last={last} steps={steps} /> : null;
}

function Group({ last, steps }: { last: ChatStepView; steps: readonly ChatStepView[] }) {
  const failed = failedCount(steps);
  const [open, setOpen] = useState(failed > 0);
  const [seenFailed, setSeenFailed] = useState(failed);
  if (seenFailed !== failed) {
    setSeenFailed(failed);
    if (failed > seenFailed) setOpen(true);
  }
  return (
    <ToolGroupRoot
      aria-label="工具调用"
      className="overflow-x-hidden overflow-y-auto border-(--wb-border-default) py-2"
      onOpenChange={setOpen}
      open={open}
      role="group"
    >
      <ToolGroupTrigger
        active={steps.some((step) => step.status === "running")}
        className="cursor-pointer text-(--wb-text-secondary) hover:text-(--wb-text-primary)"
        count={steps.length}
      >
        {`${steps.length} 个步骤 · ${last.name} ${SESSION_STATUS_LABEL[last.status]}`}
      </ToolGroupTrigger>
      <ToolGroupContent>
        {steps.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
}
