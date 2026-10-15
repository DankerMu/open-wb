// 等待指示（chat-web「消息线程」的「等待指示与小圆点」段，design D6、O8）：运行中的助手消息还没有任何
// 可见块时，在正文的位置显示一行 `正在思考…`；有了可见块就换成正文末尾的小圆点，二者恰好一个。
// - 判据只读消息视图的数据，不看 DOM：空正文照样挂 MarkdownBody，DOM 里有没有正文节点说明不了什么。
// - 「同一回合不再出现」由判据自然成立：可见块在 running 期间不会消失，turn.start 重置只发生在新回合。
//   唯一会消失的块是重试提示（`retrying` 由下一个事件清掉，那些事件除 turn.start 外都带来内容或错误；
//   快照恒为 false，所以重试期间原地重装快照且别无内容时指示会回来——规格的判据就是这样写的，读代码推出）。
// - 流光沿用折叠块标题的 `shimmer motion-reduce:animate-none`；reduce 下 tw-shimmer 自己把动画置为 paused。
import type { ChatMessageCustom } from "./runtime-convert.js";

type VisibleBlockFields = Pick<ChatMessageCustom, "approvals" | "error" | "retrying" | "steps"> & {
  /** 正文原文；空串即「正文为空」。 */
  text: string;
  /** 思考原文；视图里的 `null` 在运行时消息里已是空串。 */
  thinking: string;
};

/**
 * 这条助手消息是否已有可见块：思考、正文、工具调用组、已结算审批、错误文本或重试提示。待决审批在
 * 输入框上方的停靠区，不算。
 */
export function hasVisibleBlock({
  approvals,
  error,
  retrying,
  steps,
  text,
  thinking,
}: VisibleBlockFields): boolean {
  return (
    thinking !== "" ||
    text !== "" ||
    steps.length > 0 ||
    approvals.some((approval) => approval.decision !== null) ||
    error !== null ||
    retrying
  );
}

/** 等待指示：只在消息 running 且还没有可见块时由调用方渲染；读屏经 `role="status"` 礼貌播报一次。 */
export function MessageWaiting() {
  return (
    <div
      className="shimmer self-start text-sm leading-7 text-(--wb-text-secondary) motion-reduce:animate-none"
      data-slot="message-waiting"
      role="status"
    >
      正在思考…
    </div>
  );
}
