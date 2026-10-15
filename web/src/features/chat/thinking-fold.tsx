// 深度思考折叠块（thinking-fold；design D4、D13，issue 910 的 D5、D8）：应用层组合拷入层 `reasoning` 的
// Root / Content / Text，控件由拷入的 `CollapsibleTrigger` 在这里组合。行为在这里定，不用 registry 的默认：
// - 折叠态受控。拷入组件的 `streaming` 模式在第一次手动切换后永久沿用该选择；规格要的是每次
//   running ↔ 终态迁移都回到默认态（进行中展开、终态收起），两次迁移之间才保留手动选择。
//   不传 `streaming` 也就不进它的预览路径（那条路径无条件构造 `ResizeObserver`）。
// - 用不带滚动锁的 Root：`reasoning.aui.tsx` 的 Root 在切换时锁住转录滚动容器 200ms，与滚动层的
//   贴底跟随冲突。
// - 主体限高：终态 12rem 并在盒内滚动，进行中不限高（由转录贴底跟随）；拷入组件默认恒为 16rem。
// - 标题三态（D5）：消息 running 且思考段进行中为 `正在思考…`，带 `shimmer` 类（`tw-shimmer`，经
//   styles.css 导入；reduce 下该插件自己把动画置为 paused，全局 reduce 块再把时长压到 0.01ms）；否则有
//   时长为 `已思考 N 秒`（N = max(1, round(ms ÷ 1000))）；否则 `深度思考过程`（历史消息、未闭段即中断）。
//   拷入的 `ReasoningTrigger` 把文案写死，换文案不在拷入层的六类修改里，所以不用它（D8）：结构、视觉类与
//   三个 `reasoning-trigger*` slot 照抄它，可见文本即可访问名。标题不带 `role="status"`：等待指示才是
//   播报用的状态（message-waiting.tsx），标题只是控件的名字。
// - 隐藏 Content 恒渲染的顶部渐隐遮罩（`reasoning-fade`，z-10、取页面底色）：它盖住滚动层的 回到最新
//   按钮，在搜索命中的消息底色上露出一条页面底色，并把首行压灰。拷入文件不改，从父元素的类上关掉。
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning";
import { CollapsibleTrigger } from "@/components/ui/collapsible";

type ThinkingFoldProps = {
  running: boolean;
  text: string;
  /** 视图字段（issue 910 的 D5）：服务端累计的思考毫秒数，null 为没有时长。 */
  thinkingMs: number | null;
  /** 视图字段：思考段进行中。 */
  thinkingActive: boolean;
};

function titleOf(active: boolean, thinkingMs: number | null) {
  if (active) return "正在思考…";
  if (thinkingMs !== null) return `已思考 ${String(Math.max(1, Math.round(thinkingMs / 1000)))} 秒`;
  return "深度思考过程";
}

export function ThinkingFold({ running, text, thinkingMs, thinkingActive }: ThinkingFoldProps) {
  const [open, setOpen] = useState(running);
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    setWasRunning(running);
    setOpen(running);
  }
  const active = running && thinkingActive;
  return (
    <ReasoningRoot
      className="mb-0 border-l-[3px] border-(--wb-border-default) py-1 pl-3"
      data-running={running ? "" : undefined}
      onOpenChange={setOpen}
      open={open}
      variant="ghost"
    >
      <CollapsibleTrigger
        className="group/trigger flex max-w-[75%] origin-left items-center gap-2 py-1.5 text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]"
        data-slot="reasoning-trigger"
      >
        <BrainIcon className="size-4 shrink-0" data-slot="reasoning-trigger-icon" />
        <span
          className={`inline-block leading-none tabular-nums ${active ? "shimmer motion-reduce:animate-none" : ""}`}
          data-slot="reasoning-trigger-label"
        >
          {titleOf(active, thinkingMs)}
        </span>
        <ChevronDownIcon
          className="mt-0.5 size-4 shrink-0 -rotate-90 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0 motion-reduce:transition-none"
          data-slot="reasoning-trigger-chevron"
        />
      </CollapsibleTrigger>
      <ReasoningContent className="[&>[data-slot=reasoning-fade]]:hidden">
        <ReasoningText
          className={`wrap-anywhere whitespace-pre-wrap ${running ? "max-h-none" : "max-h-48 overflow-auto"}`}
        >
          {text}
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
