// 深度思考折叠块（thinking-fold；design D4、D13，issue 910 的 D5、D7、D8）：应用层组合拷入层 `reasoning` 的
// Root / Content / Text，控件由拷入的 `CollapsibleTrigger` 在这里组合。行为在这里定，不用 registry 的默认：
// - 折叠态受控。拷入组件不受控时在第一次手动切换后永久沿用该选择；规格要的是每次「进行中 ↔ 不在进行中」
//   迁移都回到默认态（进行中展开、否则收起），两次迁移之间才保留手动选择。受控时 `streaming` 只决定预览
//   （拷入 Root 的 `isPreview = streaming && open`），不碰开合。「进行中」由调用方给（change
//   chat-interleaved-segments D10）：旧布局传消息的 running，行为同 issue 910；分段布局传该段的进行中，所以
//   一段思考结束即收起、不等整条消息结束（owner 裁定 B12），开合、`data-running`、预览与逐字展开都只跟这一段。
//   每个折叠块以块键为身份（message-segments-view.tsx），各自一份开合状态。
// - 用不带滚动锁的 Root：`reasoning.aui.tsx` 的 Root 在切换时锁住转录滚动容器 200ms，与滚动层的
//   贴底跟随冲突。
// - 主体两态都限高 12rem 并在盒内滚动（拷入组件默认 16rem，与终态不一致会在展开 / 收起间跳高度）。
//   running 且展开时是流式预览（D7）：拷入的 `ReasoningText` 用自己的 `ResizeObserver` 把盒内贴到最新
//   一行，用户在盒内上滚即暂停、滚回盒底恢复。它不再与转录区的贴底跟随冲突（读代码推出）：限高后思考
//   增长只改盒内 `scrollHeight`，折叠块外框长到 12rem 就不再变高；盒内的 scroll 事件不冒泡，
//   `thread-viewport.tsx` 的 `onScroll` 只看视口自己的 `scrollTop`；转录区观察的是内容根，外框长满
//   12rem 之后思考增长不再改变它的尺寸。终态不是预览，主体不自动滚动。
// - 标题三态（D5）：进行中且思考段进行中为 `正在思考…`，带 `shimmer` 类（`tw-shimmer`，经
//   styles.css 导入；reduce 下该插件自己把动画置为 paused，全局 reduce 块再把时长压到 0.01ms）；否则有
//   时长为 `已思考 N 秒`（N = max(1, round(ms ÷ 1000))）；否则 `深度思考过程`（历史消息、未闭段即中断）。
//   旧布局的时长是消息累计值，分段布局是该段的（B5）。
//   拷入的 `ReasoningTrigger` 把文案写死，换文案不在拷入层的六类修改里，所以不用它（D8）：结构、视觉类与
//   三个 `reasoning-trigger*` slot 照抄它，可见文本即可访问名。标题不带 `role="status"`：等待指示才是
//   播报用的状态（message-waiting.tsx），标题只是控件的名字。
// - 隐藏 Content 的两个渐隐遮罩（`reasoning-fade`，z-10、取页面底色）：顶部那个恒渲染，底部那个只在
//   预览时渲染，二者都是 Content 的直接子元素。它们盖住滚动层的 回到最新 按钮，在搜索命中的消息底色上
//   露出一条页面底色，并把首行 / 末行压灰。拷入文件不改，从父元素的类上一并关掉。
// - 主体文本经 smooth-text.tsx 逐字展开（D8）：与正文同一个 `SmoothText`、同一条 `useSmooth` 规则，进行中
//   时展开，不在进行中立即全文，reduce 下不展开。收起的退场动画放完后 Radix 卸下主体，再展开是重新挂载，
//   挂载时显示全文（读代码推出）。
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
} from "@/components/assistant-ui/elements/reasoning";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { SmoothText } from "./smooth-text.js";

type ThinkingFoldProps = {
  /** 开合、`data-running`、预览与逐字展开的依据：旧布局为消息 running，分段布局为该段进行中。 */
  inProgress: boolean;
  text: string;
  /** 思考毫秒数（旧布局为消息累计，分段布局为该段的），null 为没有时长。 */
  thinkingMs: number | null;
  /** 思考段进行中（标题的 `正在思考…`）。 */
  thinkingActive: boolean;
};

function titleOf(active: boolean, thinkingMs: number | null) {
  if (active) return "正在思考…";
  if (thinkingMs !== null) return `已思考 ${String(Math.max(1, Math.round(thinkingMs / 1000)))} 秒`;
  return "深度思考过程";
}

export function ThinkingFold({ inProgress, text, thinkingMs, thinkingActive }: ThinkingFoldProps) {
  const [open, setOpen] = useState(inProgress);
  const [wasInProgress, setWasInProgress] = useState(inProgress);
  if (wasInProgress !== inProgress) {
    setWasInProgress(inProgress);
    setOpen(inProgress);
  }
  const active = inProgress && thinkingActive;
  return (
    <ReasoningRoot
      className="mb-0 border-l-[3px] border-(--wb-border-default) py-1 pl-3"
      data-running={inProgress ? "" : undefined}
      onOpenChange={setOpen}
      open={open}
      streaming={inProgress}
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
        <ReasoningText className="wrap-anywhere whitespace-pre-wrap max-h-48 overflow-auto">
          <SmoothText running={inProgress} text={text}>
            {(shown) => shown}
          </SmoothText>
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
