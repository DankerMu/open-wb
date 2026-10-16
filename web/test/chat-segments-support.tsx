// change chat-interleaved-segments 切片 6（issue 1475）的 jsdom 夹具：一条助手消息（id 0）的会话快照、整页挂载与
// 逐事件投递，以及按 `data-slot` 读出分段区的块。页面搭法同 chat-thinking-title.test.tsx（不改它）。
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, latestSource, SESSION_ID, settle } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

export type Message = ChatMessageSnapshot["messages"][number];
type Step = Message["steps"][number];
type Segment = Message["thinkingSegments"][number];

const FOLD = '[data-slot="reasoning-root"]';
export const BODY = '[data-slot="message-body"]';
export const CARET = '[data-slot="message-caret"]';
const GROUP = '[data-slot="tool-group-root"]';

/** `historyUser` 之后一条助手消息（id 0），状态随会话；`fields` 覆盖它的字段。 */
export function session(
  status: "running" | "done" | "failed",
  fields: Partial<Message> = {},
): ChatMessageSnapshot {
  const base = chatSnapshot({ status, assistantStatus: status });
  const [user, reply] = base.messages as [Message, Message];
  return { ...base, messages: [user, { ...reply, ...fields }] };
}

export function step(
  id: number,
  ordinal: number,
  name: string,
  bodyOffset: number | null,
  status: Step["status"] = "done",
): Step {
  return {
    id,
    ordinal,
    name,
    detail: `${name} args`,
    output: "",
    status,
    changes: null,
    bodyOffset,
  };
}

export function segment(
  bodyOffset: number,
  thinkingOffset: number,
  thinkingLength: number | null,
  stepsBefore: number,
  thinkingMs: number | null,
): Segment {
  return { bodyOffset, thinkingOffset, thinkingLength, stepsBefore, thinkingMs };
}

/**
 * 打开会话并接通事件流；`emit` 从 `1:1` 起编号、同步生效，`emitAsync` 另让出宏任务（假时钟用例），
 * `resync` 让事件源重开并按 `next`（游标对齐到已投递的最后一条事件）原地重装快照。
 */
export async function openSession(first: ChatMessageSnapshot) {
  let served = first;
  renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [first.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(served),
  });
  await screen.findAllByRole("article", { name: "助手" });
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  const source = latestSource();
  const settleAll = async () => {
    for (let round = 0; round < 3; round += 1) await act(settle);
  };
  act(() => source.emitOpen());
  await settleAll();
  let seq = 0;
  const frame = (type: string, data: Record<string, unknown>) => {
    seq += 1;
    source.emitData(type, `1:${String(seq)}`, { messageId: 0, ...data });
  };
  return {
    emit(type: string, data: Record<string, unknown> = {}) {
      act(() => frame(type, data));
    },
    async emitAsync(type: string, data: Record<string, unknown> = {}) {
      await act(async () => {
        frame(type, data);
        await settle();
      });
    },
    async resync(next: ChatMessageSnapshot) {
      // 游标取已投递的最后一条，快照与已收到的事件对齐。
      served = { ...next, streamCursor: { epoch: 1, seq } };
      act(() => source.emitOpen());
      await settleAll();
    },
  };
}

export function assistant() {
  return screen.getByRole("article", { name: "助手" });
}

/** 消息内容容器（分段区各块与其后各部件的父元素）。 */
export function contentOf(article = assistant()) {
  const content = article.querySelector<HTMLElement>('[data-slot="message-content"]');
  if (!content) throw new Error("助手消息缺少 message-content");
  return content;
}

/** 消息内容容器各子元素的 `data-slot`。 */
export function slots(article = assistant()) {
  return [...contentOf(article).children].map((child) => child.getAttribute("data-slot"));
}

export function folds(article = assistant()) {
  return [...article.querySelectorAll<HTMLElement>(FOLD)];
}

export function groups(article = assistant()) {
  return [...article.querySelectorAll<HTMLElement>(GROUP)];
}

/** 折叠块或工具段的展开/收起控件。 */
export function triggerOf(block: HTMLElement) {
  const trigger = block.querySelector<HTMLElement>("[aria-expanded]");
  if (!trigger) throw new Error("没有展开/收起控件");
  return trigger;
}

export function isOpen(block: HTMLElement) {
  return triggerOf(block).getAttribute("aria-expanded") === "true";
}

/** 折叠块的标题（控件的可见文本，也经可访问名找回同一个按钮）与是否带流光。 */
export function titleOf(fold: HTMLElement): [string, boolean] {
  const trigger = triggerOf(fold);
  const label = trigger.querySelector('[data-slot="reasoning-trigger-label"]');
  const text = label?.textContent ?? "";
  expect(within(fold).getByRole("button", { name: text })).toBe(trigger);
  return [text, label?.classList.contains("shimmer") === true];
}

/** 每个折叠块的 `[标题, 是否展开, 是否带 data-running]`，按文档次序。 */
export function foldStates(article = assistant()) {
  return folds(article).map((fold) => [
    titleOf(fold)[0],
    isOpen(fold),
    fold.hasAttribute("data-running"),
  ]);
}
