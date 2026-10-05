// 深度思考折叠块（thinking-fold；design D4、D13）：应用层组合拷入层 `reasoning` 的
// Root / Trigger / Content / Text。行为在这里定，不用 registry 的默认：
// - 折叠态受控。拷入组件的 `streaming` 模式在第一次手动切换后永久沿用该选择；规格要的是每次
//   running ↔ 终态迁移都回到默认态（进行中展开、终态收起），两次迁移之间才保留手动选择。
//   不传 `streaming` 也就不进它的预览路径（那条路径无条件构造 `ResizeObserver`）。
// - 用不带滚动锁的 Root：`reasoning.aui.tsx` 的 Root 在切换时锁住转录滚动容器 200ms，与滚动层的
//   贴底跟随冲突。
// - 主体限高：终态 12rem 并在盒内滚动，进行中不限高（由转录贴底跟随）；拷入组件默认恒为 16rem。
// - 不传 Trigger 的 `active`：它只加 `shimmer` 类，而该类来自 `tw-shimmer`，要在 styles.css 里多一条
//   导入才生效（ui-foundation「入口结构」不允许），所以本仓没有装这个包。
import { useState } from "react";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning";

export function ThinkingFold({ running, text }: { running: boolean; text: string }) {
  const [open, setOpen] = useState(running);
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    setWasRunning(running);
    setOpen(running);
  }
  return (
    <ReasoningRoot
      className="mb-0 border-l-[3px] border-(--wb-border-default) py-1 pl-3"
      data-running={running ? "" : undefined}
      onOpenChange={setOpen}
      open={open}
      variant="ghost"
    >
      <ReasoningTrigger />
      <ReasoningContent>
        <ReasoningText
          className={`wrap-anywhere whitespace-pre-wrap ${running ? "max-h-none" : "max-h-48 overflow-auto"}`}
        >
          {text}
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
