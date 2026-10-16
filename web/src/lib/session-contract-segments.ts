// issue 1474（chat-interleaved-segments design D8）：消息 `thinkingSegments` 与 `thinking.end` 事件
// `segment` 的严格解析（步骤 `bodyOffset`、审批 `stepId` 随各自键集在 session-contract.ts 解析）。只校验
// 形状；数值是否自洽（偏移越界、段首尾相接）由切段函数的旧布局判定处理，不在这里判定。
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/** 一段思考（`chat_thinking_segments` 的一行）；段开着时长度与毫秒为 null。 */
export type ChatThinkingSegment = {
  bodyOffset: number;
  thinkingOffset: number;
  thinkingLength: number | null;
  stepsBefore: number;
  thinkingMs: number | null;
};

/** 刚结束的一段（`thinking.end` 的 `segment`）：五个值都已写入。 */
export type ChatClosedSegment = { [K in keyof ChatThinkingSegment]: number };

const SEGMENT_KEYS = [
  "bodyOffset",
  "thinkingOffset",
  "thinkingLength",
  "stepsBefore",
  "thinkingMs",
] as const;

/** null，或非负安全整数（步骤的 `bodyOffset`、段的长度与毫秒）。 */
function isNullableCount(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

/** null，或安全整数（审批的 `stepId`、`step.start` 的 `approvalId`）。 */
export function isNullableId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function parseSegment(value: unknown): ChatThinkingSegment | null {
  if (!hasExactlyKeys(value, SEGMENT_KEYS)) {
    return null;
  }

  const { bodyOffset, stepsBefore, thinkingLength, thinkingMs, thinkingOffset } = value;
  if (
    !isNonNegativeSafeInteger(bodyOffset) ||
    !isNonNegativeSafeInteger(thinkingOffset) ||
    !isNullableCount(thinkingLength) ||
    !isNonNegativeSafeInteger(stepsBefore) ||
    !isNullableCount(thinkingMs)
  ) {
    return null;
  }

  return { bodyOffset, thinkingOffset, thinkingLength, stepsBefore, thinkingMs };
}

/** 按给出的次序逐值保留；user 消息只能是空数组。 */
export function parseThinkingSegments(
  value: unknown,
  role: "user" | "assistant",
): ChatThinkingSegment[] | null {
  const segments = parseJsonArray(value, parseSegment);
  return segments && (role === "assistant" || segments.length === 0) ? segments : null;
}

/** `thinking.end` 的 `segment`：同一键集，五个值都是非负安全整数，不为 null。 */
export function parseClosedSegment(value: unknown): ChatClosedSegment | null {
  const segment = parseSegment(value);
  if (!segment) {
    return null;
  }

  const { thinkingLength, thinkingMs } = segment;
  return thinkingLength === null || thinkingMs === null
    ? null
    : { ...segment, thinkingLength, thinkingMs };
}
