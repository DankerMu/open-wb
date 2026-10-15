// 逐字展开（chat-web「消息线程」的「正文逐字展开」段，design D8、O2）：应用层调用 `@assistant-ui/react`
// 的 `useSmooth`，规则是它的——每字间隔 min(5ms, 250ms ÷ 尚未显示的字数)，挂载时已有的文本立即全显示，
// 从空串开始的第一段直接提交，`running` 变假（终态）时立即返回全文，`prefers-reduced-motion: reduce` 下
// 自己停用（7a 实测，jsdom + 假时钟）。
// - 不打开 `MarkdownText` 的 `smooth`：基元追赶期间把容器 `data-status` 置为 `running`，拷入的 dot.css
//   会在末块之后再加一个脉动点，与消息自己的小圆点叠成两个运行指示（见 markdown-body.tsx）。这里的
//   part 由 `TextMessagePartProvider` 造，状态恒为「已完成」，交给子渲染的只是前缀字符串。
// - 文本增长时 provider 的 `aui.part` 引用不变（7a 实测），所以 `useSmooth` 不走「换了 part」的分支，
//   不需要另包一层稳定的 provider。
// - 只决定「显示到哪」：`复制` 与对话内搜索读消息视图的全文，不经这里。
import { TextMessagePartProvider, useMessagePartText, useSmooth } from "@assistant-ui/react";
import type { ReactNode } from "react";

type SmoothTextProps = {
  /** 消息 running 时为真；终态（或从未 running）时为假，`children` 收到的就是全文。 */
  running: boolean;
  /** 已收到的全文。 */
  text: string;
  /** 拿到当前要显示的前缀后渲染。 */
  children(shown: string): ReactNode;
};

function Reveal({ children, running }: Omit<SmoothTextProps, "text">) {
  const { text } = useSmooth(useMessagePartText(), running);
  return children(text);
}

/** 把 `text` 按 `useSmooth` 的规则逐字交给 `children`；正文用它，思考（7b）同用。 */
export function SmoothText({ children, running, text }: SmoothTextProps) {
  return (
    <TextMessagePartProvider text={text}>
      <Reveal running={running}>{children}</Reveal>
    </TextMessagePartProvider>
  );
}
