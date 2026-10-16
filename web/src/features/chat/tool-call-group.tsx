// 工具调用组（design D4、D13；change chat-interleaved-segments D11）：应用层组合拷入层 `tool-group` 的
// Root / Trigger / Content，一条消息的全部步骤收在一个组里，步骤卡是应用层的 `StepCard`。行为在这里定：
// - 折叠态受控：首次出现一律收起（含失败步骤，owner 裁定 B7），之后只随用户点击变化；步骤开始与结束、
//   新的失败步骤、正文增量都不动它，快照原地重装不重挂载本组件（jsdom 实测，`chat-tool-group.test.tsx`
//   的「展开态只随用户点击变化」），所以手动展开或收起保留到组件卸载。
// - 没有步骤时不渲染，带状态的 `Group` 随之卸载：新回合清空步骤后，下一轮的组从收起态开始。
// - 摘要行是 `tool-summary.ts` 按动作归类的计数（B6），失败与进行中的后缀在同一个 `span` 的同一段文字里、
//   不另加颜色类（B7）；有步骤在跑时 `active`，摘要带 `shimmer`（`tw-shimmer`）与转圈图标，减少动态效果时
//   由插件与全局 reduce 块停掉。
// - 每张步骤卡取配上它的审批（`stepId` 等于步骤 id，至多取一条）的结算结果画确认小标记（step-card.tsx）。
// - 拷入的 Root 在每次手动切换时调用 `useScrollLock`：从 Root 自身起向上找第一个 `overflow-y` 为
//   auto / scroll 的元素，200ms 内把它的 `scrollTop` 钉回原值并改它的滚动条与内边距。落到转录滚动
//   容器上会被滚动层读成用户上滚、解除贴底。Root 自己带 `overflow-y-auto`（不限高，永不滚动）后锁只
//   落在组自身，转录容器不受影响；拷入文件不改。
// - Root 的 `overflow` 会裁掉画在按钮外的东西，所以两处在应用层收进组内：键盘焦点环改为内缩
//   （`-outline-offset-2`，utilities 层压过 base 层的全局 `:focus-visible`），按钮用 `-my-2 py-2` 占满
//   Root 的上下内边距（布局不变），内缩的环才不压在只有一行字高的文字上；摘要文字单行省略——拷入
//   的 label 是弹性子项，`*:min-w-0` 让它能收窄，省略号由里面的 `span` 给，折叠箭头留在组内。`span`
//   的 `py-0.5 -my-0.5` 只是不让 `leading-none` 的行框裁掉字形上下沿。
import { useState } from "react";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { StepCard } from "./step-card.js";
import type { ChatApprovalView } from "./stream-approvals.js";
import type { ChatStepView } from "./stream-steps.js";
import { summarizeTools } from "./tool-summary.js";

type GroupProps = {
  /** 所属消息的全部审批；只用来找配上各步骤的那一条。 */
  approvals: readonly ChatApprovalView[];
  steps: readonly ChatStepView[];
};

/** 一条消息的工具调用组；没有步骤时不渲染。 */
export function ToolCallGroup({ approvals, steps }: GroupProps) {
  return steps.length > 0 ? <Group approvals={approvals} steps={steps} /> : null;
}

function Group({ approvals, steps }: GroupProps) {
  const [open, setOpen] = useState(false);
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
          {summarizeTools(steps)}
        </span>
      </ToolGroupTrigger>
      <ToolGroupContent>
        {steps.map((step) => (
          <StepCard
            decision={approvals.find((approval) => approval.stepId === step.id)?.decision ?? null}
            key={step.id}
            step={step}
          />
        ))}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
}
