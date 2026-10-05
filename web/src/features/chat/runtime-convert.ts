// 会话视图消息 → assistant-ui 运行时消息的映射（design D1）。纯模块：无副作用、不持有状态、不渲染。
import type { MessageStatus, ThreadMessageLike } from "@assistant-ui/react";
import type { ChatState } from "./stream.js";

type ChatMessageView = ChatState["messages"][number];
type ChatStepView = ChatMessageView["steps"][number];

/**
 * 应用自有字段，经 `metadata.custom` 原值透传给应用层组件：审批、原始状态、错误文本与步骤
 * （步骤带 `changes` 与四态 `status`，tool-call part 表达不了它们）。
 */
export type ChatMessageCustom = Pick<ChatMessageView, "approvals" | "error" | "status" | "steps">;

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
 * part 顺序固定为 reasoning（仅 `thinking` 非空时）、text、每个步骤一个 tool-call：数据里正文与步骤
 * 没有交错信息。运行时只接受助手消息带 `status`、reasoning 与 tool-call，用户消息只有 text part，
 * 它的步骤仍在透传字段里。
 */
export function convertMessage(message: ChatMessageView): ThreadMessageLike {
  const custom: ChatMessageCustom = {
    approvals: message.approvals,
    error: message.error,
    status: message.status,
    steps: message.steps,
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
