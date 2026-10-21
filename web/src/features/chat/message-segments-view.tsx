// 分段区的呈现（chat-web「消息线程」；change chat-interleaved-segments design D10）：按 message-segments.ts 的切段
// 结果逐块渲染既有部件——正文段 → `MessageBody`，思考段 → `ThinkingFold`，工具段 → `ToolCallGroup`。分段区不设
// 包裹元素：各块直接是消息内容容器的子元素，React key 取块键，流式增长与快照原地重装都不重挂载已有的块，
// 所以折叠块与工具段的手动展开态保留。旧布局（切段函数判为旧布局）的消息仍由 message-thread.tsx 按 issue 910
// 的次序渲染，这里只供它用 `MessageBody`。
// - 小圆点（D10）：全条消息恰一个。最后一块是正文段时在其 `MarkdownBody` 之后（同 issue 910 的位置），否则
//   单独一行在最后一块之下；一块也没有时单独一行在分段区的位置（即等待指示原本所在处）。
// - 已停止且没有正文段时，`（已停止生成）` 占位是分段区末尾的一个 `message-body`；此外分段布局不为空正文
//   或只含空白的正文渲染 `message-body`（空白正文段由切段函数丢掉）。
// - 折叠块的「进行中」取该段的（只展开正在思考的那一段，owner 裁定 B12），标题取该段的时长（B5）。
// - 工具段拿到整条消息的审批，各步骤卡按 `stepId` 取配上自己的那一条画确认小标记（D12）。
import { Component, type ReactNode } from "react";
import { MarkdownBody } from "./markdown-body.js";
import type { MessageSegment } from "./message-segments.js";
import type { ChatMessageCustom } from "./runtime-convert.js";
import { SmoothText } from "./smooth-text.js";
import { ThinkingFold } from "./thinking-fold.js";
import { ToolCallGroup } from "./tool-call-group.js";

type Status = ChatMessageCustom["status"];
type Approvals = ChatMessageCustom["approvals"];

/**
 * 脉动的小圆点（design D6），减少动态效果时无动画。圆形写 `rounded-[50%]` 而不是 rounded-full：规格要求
 * 计算 `border-radius` 恰为 50%，Tailwind 4 的 rounded-full 编译成一个极大的像素值（实测：计算值为
 * 3.35544e+07px）。
 */
function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block size-2 animate-pulse rounded-[50%] bg-(--wb-brand-primary) align-middle motion-reduce:animate-none"
      data-slot="message-caret"
    />
  );
}

/**
 * 正文段的本地错误边界（issue 1534，chat-web「消息线程」场景「正文转换栈溢出时回退纯文本」）：嵌套过深时
 * Markdown→hast 转换在渲染期栈溢出抛 `RangeError`，这里接住、回退为原文纯文本（React 文本节点，不经 HTML
 * 解析），不冒到路由的默认错误页。上一次提交已是回退态且文本变了才清错误态重试（接住错误那次提交的
 * `prevState` 还不是错误态，不会多试一次）；同一文本再抛只是再落回回退态，不会循环。
 */
class MarkdownErrorBoundary extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidUpdate(prevProps: { text: string }, prevState: { failed: boolean }) {
    if (prevState.failed && prevProps.text !== this.props.text) this.setState({ failed: false });
  }

  override render() {
    if (this.state.failed) return <p className="whitespace-pre-wrap">{this.props.text}</p>;
    return this.props.children;
  }
}

/**
 * 正文：Markdown，或已停止且为空（含只有空白：运行时消息里它本来就是空串）时的占位；`dot` 时在末尾带小圆点。running 时正文经 smooth-text.tsx 逐字展开
 * （design D8）；等待指示让位时本组件才挂载，此时的首段与「从空串开始的第一段」同样直接整段显示（useSmooth
 * 的分支，7a 实测）。已被后续块隔开的正文段不再增长，只有最后一个正文段会逐字展开。
 */
export function MessageBody({ dot, status, text }: { dot: boolean; status: Status; text: string }) {
  return (
    <div className="text-sm leading-7 wrap-anywhere text-foreground" data-slot="message-body">
      {status === "stopped" && !/\S/u.test(text) ? (
        <p className="text-(--wb-text-tertiary)">（已停止生成）</p>
      ) : (
        <SmoothText running={status === "running"} text={text}>
          {(shown) => (
            <MarkdownErrorBoundary text={shown}>
              <MarkdownBody text={shown} />
            </MarkdownErrorBoundary>
          )}
        </SmoothText>
      )}
      {dot ? <Caret /> : null}
    </div>
  );
}

function Block({
  approvals,
  block,
  dot,
  status,
}: {
  approvals: Approvals;
  block: MessageSegment;
  dot: boolean;
  status: Status;
}) {
  switch (block.kind) {
    case "text":
      return <MessageBody dot={dot} status={status} text={block.text} />;
    case "thinking":
      return (
        <ThinkingFold
          inProgress={block.active}
          text={block.text}
          thinkingActive={block.active}
          thinkingMs={block.thinkingMs}
        />
      );
    default:
      return <ToolCallGroup approvals={approvals} steps={block.steps} />;
  }
}

/**
 * 分段布局的分段区。`dot` 为「运行中且已有可见块」（message-waiting.tsx 的判据）；等待指示由调用方在其后渲染。
 */
export function MessageSegments({
  approvals,
  blocks,
  dot,
  status,
}: {
  approvals: Approvals;
  blocks: readonly MessageSegment[];
  dot: boolean;
  status: Status;
}) {
  const last = blocks.at(-1);
  const dotInText = dot && last?.kind === "text";
  const placeholder = status === "stopped" && !blocks.some((block) => block.kind === "text");
  return (
    <>
      {blocks.map((block) => (
        <Block
          approvals={approvals}
          block={block}
          dot={dotInText && block === last}
          key={block.key}
          status={status}
        />
      ))}
      {placeholder ? <MessageBody dot={false} status={status} text="" /> : null}
      {dot && !dotInText ? (
        <div className="leading-7" data-slot="message-caret-row">
          <Caret />
        </div>
      ) : null}
    </>
  );
}
