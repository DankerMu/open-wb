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
// - Root 的 `overflow` 会裁掉画在按钮外的东西，所以两处在应用层收进组内：键盘焦点环改为内缩
//   （`-outline-offset-2`，utilities 层压过 legacy 层的全局 `:focus-visible`），按钮用 `-my-2 py-2` 占满
//   Root 的上下内边距（布局不变），内缩的环才不压在只有一行字高的文字上；摘要文字单行省略——拷入
//   的 label 是弹性子项，`*:min-w-0` 让它能收窄，省略号由里面的 `span` 给，折叠箭头留在组内。`span`
//   的 `py-0.5 -my-0.5` 只是不让 `leading-none` 的行框裁掉字形上下沿。
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
        className="-my-2 cursor-pointer py-2 text-(--wb-text-secondary) *:min-w-0 hover:text-(--wb-text-primary) focus-visible:-outline-offset-2"
        count={steps.length}
      >
        <span className="-my-0.5 block truncate py-0.5" data-slot="tool-summary">
          {`${steps.length} 个步骤 · ${last.name} ${SESSION_STATUS_LABEL[last.status]}`}
        </span>
      </ToolGroupTrigger>
      <ToolGroupContent>
        {steps.map((step) => (
          <StepCard key={step.id} step={step} />
        ))}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
}
