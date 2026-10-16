// 会话视图消息 → assistant-ui 运行时消息的映射（design D1）。纯模块：无副作用、不持有状态、不渲染。
import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/react";
import type { ChatState } from "./stream.js";

type ChatMessageView = ChatState["messages"][number];
type ChatStepView = ChatMessageView["steps"][number];

/**
 * 应用自有字段，经 `metadata.custom` 原值透传给应用层组件：审批、原始状态、失败对象与重试标记、步骤
 * （步骤带 `changes` 与四态 `status`，tool-call part 表达不了它们）、用户消息的可撤回状态与附件、
 * 思考时长与进行中标记（issue 910）、分段位置（issue 1474：段、步骤 `bodyOffset`、审批 `stepId`），
 * 以及助手消息的正文与思考原文（issue 1475）：运行时把只含空白的 text / reasoning part 整个丢掉
 * （`@assistant-ui/core` 0.3.22 `runtime/utils/thread-message-like.js:51`、`:54`），而分段的偏移、等待指示
 * 的「正文为空」都要按原文算。
 */
export type ChatMessageCustom = Pick<
  ChatMessageView,
  | "approvals"
  | "attachments"
  | "content"
  | "error"
  | "retrying"
  | "status"
  | "steps"
  | "thinkingActive"
  | "thinkingMs"
  | "thinking"
  | "thinkingSegments"
  | "undo"
>;

const STATUS: Record<ChatMessageView["status"], MessageStatus> = {
  running: { type: "running" },
  done: { type: "complete", reason: "stop" },
  failed: { type: "incomplete", reason: "error" },
  stopped: { type: "incomplete", reason: "cancelled" },
};

function toolCall(step: ChatStepView) {
  return {
    type: "tool-call" as const,
    toolCallId: String(step.id),
    toolName: step.name,
    argsText: step.detail,
    result: step.output,
    ...(step.status === "failed" ? { isError: true } : {}),
  };
}

/**
 * part 顺序固定为 reasoning（仅 `thinking` 非空时）、text、每个步骤一个 tool-call：part 不承载分段，
 * 分段由 `message-segments.ts` 从透传字段算。运行时只接受助手消息带 `status`、reasoning 与
 * tool-call，用户消息只有 text part，它的步骤仍在透传字段里。
 */
export function convertMessage(message: ChatMessageView): ThreadMessageLike {
  const custom: ChatMessageCustom = {
    approvals: message.approvals,
    attachments: message.attachments,
    content: message.content,
    error: message.error,
    retrying: message.retrying,
    status: message.status,
    steps: message.steps,
    thinking: message.thinking,
    thinkingActive: message.thinkingActive,
    thinkingMs: message.thinkingMs,
    thinkingSegments: message.thinkingSegments,
    undo: message.undo,
  };
  const text = { type: "text" as const, text: message.content };
  if (message.role !== "assistant") {
    return { id: String(message.id), role: message.role, content: [text], metadata: { custom } };
  }
  return {
    id: String(message.id),
    role: message.role,
    content: [
      ...(message.thinking ? [{ type: "reasoning" as const, text: message.thinking }] : []),
      text,
      ...message.steps.map(toolCall),
    ],
    status: STATUS[message.status],
    metadata: { custom },
  };
}

/** `convertMessage` 写入的透传字段；只用于读由它映射出的消息。 */
export function messageCustom(custom: Record<string, unknown>): ChatMessageCustom {
  return custom as ChatMessageCustom;
}
