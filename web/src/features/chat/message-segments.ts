// 助手消息分段（chat-web「助手消息分段」；change chat-interleaved-segments design D8、D9、D10）。纯模块：实时归约
// 出的视图与快照生成的视图都只经 `segmentMessage` 切段，不渲染、不持有状态。偏移与长度一律按 UTF-16 码元
// （`length` / `slice`），与服务端记下的位置同一单位。
import type { ChatMessage } from "../../lib/session-contract.js";
import type { ChatThinkingSegment } from "../../lib/session-contract-segments.js";
import type { ChatStepView } from "./stream-steps.js";

/** 切段的输入：消息视图里的这几项（视图里的 `thinking` 可为 null，运行时消息里是空串）。 */
export type SegmentSource = {
  content: string;
  thinking: string | null;
  status: ChatMessage["status"];
  thinkingActive: boolean;
  steps: readonly ChatStepView[];
  thinkingSegments: readonly ChatThinkingSegment[];
};

/**
 * 分段区的一块。`key` 在消息内稳定且互不相同，按种类加前缀（D10）：先思考后正文时思考段的
 * `thinkingOffset` 与第一个正文段的起点都是 0，二者是同级元素。
 */
export type MessageSegment =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string; thinkingMs: number | null; active: boolean }
  | { kind: "tool"; key: string; steps: ChatStepView[] };

type Item =
  | { offset: number; step: ChatStepView }
  | { offset: number; segment: ChatThinkingSegment; last: boolean };

/** 规则 3：段首尾相接、只有末段可以开着、不越界，`stepsBefore` 非递减且不超过步骤数。 */
function segmentsConsistent({ steps, thinking, thinkingSegments }: SegmentSource): boolean {
  let end = 0;
  let before = 0;
  for (const [index, segment] of thinkingSegments.entries()) {
    const last = index === thinkingSegments.length - 1;
    if (segment.thinkingOffset !== end || (segment.thinkingLength === null && !last)) return false;
    if (segment.stepsBefore < before || segment.stepsBefore > steps.length) return false;
    end = segment.thinkingOffset + (segment.thinkingLength ?? 0);
    before = segment.stepsBefore;
  }
  return end <= (thinking ?? "").length;
}

/**
 * 合并次序：第 j 段排在第 k 个步骤之前当且仅当 `stepsBefore ≤ k`。各项的正文偏移取 `bodyOffset`，
 * 超过 `content` 长度的按末尾计（宿主崩溃丢了尚未落库的正文尾部）。调用方已排除 `bodyOffset` 为 null。
 */
function mergeItems({ content, steps, thinkingSegments }: SegmentSource): Item[] {
  const clamp = (offset: number) => Math.min(offset, content.length);
  const items: Item[] = [];
  let next = 0;
  const takeSegmentsBefore = (k: number) => {
    for (; next < thinkingSegments.length; next += 1) {
      const segment = thinkingSegments[next] as ChatThinkingSegment;
      if (segment.stepsBefore > k) return;
      const last = next === thinkingSegments.length - 1;
      items.push({ offset: clamp(segment.bodyOffset), segment, last });
    }
  };
  for (const [k, step] of steps.entries()) {
    takeSegmentsBefore(k);
    items.push({ offset: clamp(step.bodyOffset ?? 0), step });
  }
  takeSegmentsBefore(Number.POSITIVE_INFINITY);
  return items;
}

/**
 * 规则 1、2、3 不成立时返回合并后的各项，否则 null（旧布局）；规则 4 比较的是按末尾截断后的偏移
 * （规格把截断后的值定义为该项的正文偏移）。
 */
function orderedItems(message: SegmentSource): Item[] | null {
  const { steps, thinking, thinkingSegments } = message;
  if (steps.some((step) => step.bodyOffset === null)) return null;
  if (thinking && thinkingSegments.length === 0) return null;
  if (!segmentsConsistent(message)) return null;
  const items = mergeItems(message);
  return items.every((item, index) => index === 0 || item.offset >= (items[index - 1]?.offset ?? 0))
    ? items
    : null;
}

/**
 * 切段：先输出 [游标, 偏移) 的正文段，再输出该项；步骤并入紧挨着的前一个工具段，否则新起一段。只含空白
 * 的正文段与原文为空串的思考段不输出，所以也不分隔两侧的工具段。全条消息判为旧布局时返回 null。
 */
export function segmentMessage(message: SegmentSource): MessageSegment[] | null {
  const items = orderedItems(message);
  if (items === null) return null;
  const { content, status, thinkingActive } = message;
  const thinking = message.thinking ?? "";
  const blocks: MessageSegment[] = [];
  let cursor = 0;
  const textUntil = (offset: number) => {
    const text = content.slice(cursor, offset);
    if (/\S/u.test(text)) blocks.push({ kind: "text", key: `text:${String(cursor)}`, text });
    cursor = offset;
  };
  for (const item of items) {
    textUntil(item.offset);
    const previous = blocks.at(-1);
    if ("step" in item) {
      if (previous?.kind === "tool") previous.steps.push(item.step);
      else blocks.push({ kind: "tool", key: `tool:${String(item.step.id)}`, steps: [item.step] });
      continue;
    }
    const { thinkingLength, thinkingMs, thinkingOffset } = item.segment;
    const end = thinkingLength === null ? thinking.length : thinkingOffset + thinkingLength;
    const text = thinking.slice(thinkingOffset, end);
    if (text === "") continue;
    const active = item.last && thinkingLength === null && status === "running" && thinkingActive;
    blocks.push({
      kind: "thinking",
      key: `thinking:${String(thinkingOffset)}`,
      text,
      thinkingMs,
      active,
    });
  }
  textUntil(content.length);
  return blocks;
}
