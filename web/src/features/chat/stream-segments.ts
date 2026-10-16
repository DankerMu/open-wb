// issue 1474（chat-interleaved-segments design D8）：分段位置的事件归约与 `step.start` 解码。
// thinking.delta 在没有开着的末段时记一个临时段（位置 = 此刻正文长度、thinking 长度与步骤数，
// UTF-16 码元）；thinking.end 以服务端的段取代它（没有临时段时追加）；step.start 记正文偏移并把
// 配上的审批指向该步骤。turn.start 清空由 `emptyAssistant` 完成。本模块不做任何呈现。
import { hasExactlyKeys, isNonNegativeSafeInteger } from "../../lib/api-json.js";
import {
  type ChatClosedSegment,
  type ChatThinkingSegment,
  isNullableId,
} from "../../lib/session-contract-segments.js";
import type { ChatApprovalView } from "./stream-approvals.js";
import { type ChatStepView, startStep } from "./stream-steps.js";

export type ChatStepStartData = {
  messageId: number;
  stepId: number;
  name: string;
  detail: string;
  bodyOffset: number;
  approvalId: number | null;
};

type SegmentView = {
  content: string;
  thinking: string | null;
  steps: ChatStepView[];
  thinkingSegments: ChatThinkingSegment[];
};

/** 末段仍开着（`thinkingLength` 为 null）时返回同一引用；否则在末尾追加一段临时段。 */
export function openSegment<M extends SegmentView>(message: M): M {
  const last = message.thinkingSegments.at(-1);
  if (last !== undefined && last.thinkingLength === null) {
    return message;
  }
  const segment: ChatThinkingSegment = {
    bodyOffset: message.content.length,
    thinkingOffset: (message.thinking ?? "").length,
    thinkingLength: null,
    stepsBefore: message.steps.length,
    thinkingMs: null,
  };
  return { ...message, thinkingSegments: [...message.thinkingSegments, segment] };
}

/** 以事件的段取代开着的末段；末段已结束或没有段时追加（达到思考上限后的段）。 */
export function closeSegment<M extends SegmentView>(message: M, segment: ChatClosedSegment): M {
  const last = message.thinkingSegments.at(-1);
  const kept =
    last !== undefined && last.thinkingLength === null
      ? message.thinkingSegments.slice(0, -1)
      : message.thinkingSegments;
  return { ...message, thinkingSegments: [...kept, { ...segment }] };
}

/**
 * 新建步骤（`bodyOffset` 取事件值），并在 `approvalId` 非 null 且该消息有这一审批时把那一项的
 * `stepId` 置为该步骤；没有这一审批时忽略，不补建。
 */
export function startSegmentStep<M extends SegmentView & { approvals: ChatApprovalView[] }>(
  message: M,
  data: ChatStepStartData,
): M {
  const started = startStep(message, data);
  const index = started.approvals.findIndex((approval) => approval.id === data.approvalId);
  const current = index < 0 ? undefined : started.approvals[index];
  if (current === undefined || current.stepId === data.stepId) {
    return started;
  }
  const approvals = started.approvals.slice();
  approvals[index] = { ...current, stepId: data.stepId };
  return { ...started, approvals };
}

/** 严格键集 `{messageId, stepId, name, detail, bodyOffset, approvalId}`；旧四键负载不通过。 */
export function decodeStepStart(
  value: unknown,
): { type: "step.start"; data: ChatStepStartData } | undefined {
  if (
    !hasExactlyKeys(value, ["messageId", "stepId", "name", "detail", "bodyOffset", "approvalId"])
  ) {
    return undefined;
  }
  const { approvalId, bodyOffset, detail, messageId, name, stepId } = value;
  return isSafeInteger(messageId) &&
    isSafeInteger(stepId) &&
    typeof name === "string" &&
    typeof detail === "string" &&
    isNonNegativeSafeInteger(bodyOffset) &&
    isNullableId(approvalId)
    ? { type: "step.start", data: { messageId, stepId, name, detail, bodyOffset, approvalId } }
    : undefined;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
