import { hasExactlyKeys } from "../../lib/api-json.js";

export type ChatThinkingEvent =
  | { type: "thinking.delta"; data: { messageId: number; delta: string } }
  | { type: "thinking.end"; data: { messageId: number; thinkingMs: number } };

/** 消息视图的思考字段（issue 910）：快照原值或事件值；`thinkingActive` 为「思考段进行中」。 */
type ThinkingView = { thinking: string | null; thinkingMs: number | null; thinkingActive: boolean };

/** Strict key set `{messageId, delta}`: a safe-integer id and a non-empty string, else `undefined`. */
export function decodeThinkingDelta(value: unknown): ChatThinkingEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "delta"]) &&
    isSafeInteger(value.messageId) &&
    typeof value.delta === "string" &&
    value.delta !== ""
    ? { type: "thinking.delta", data: { messageId: value.messageId, delta: value.delta } }
    : undefined;
}

/** Strict key set `{messageId, thinkingMs}`: a safe-integer id and a non-negative safe integer. */
export function decodeThinkingEnd(value: unknown): ChatThinkingEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "thinkingMs"]) &&
    isSafeInteger(value.messageId) &&
    isSafeInteger(value.thinkingMs) &&
    value.thinkingMs >= 0
    ? {
        type: "thinking.end",
        data: { messageId: value.messageId, thinkingMs: value.thinkingMs },
      }
    : undefined;
}

/**
 * 由快照生成时的进行中标记：服务端开段即把 `thinking_ms` 置空，所以 running 消息已有思考而
 * `thinkingMs` 为 null 就是「段开着」。
 */
export function snapshotThinkingActive(message: {
  status: string;
  thinking: string | null;
  thinkingMs: number | null;
}): boolean {
  return message.status === "running" && !!message.thinking && message.thinkingMs === null;
}

/**
 * Appends `delta` to the message's thinking (`null` counts as empty) and marks thinking active;
 * the input is not modified.
 */
export function appendThinking<M extends ThinkingView>(message: M, delta: string): M {
  return { ...message, thinking: (message.thinking ?? "") + delta, thinkingActive: true };
}

/** A span closed: the event's accumulated milliseconds; body, thinking and steps are untouched. */
export function endThinking<M extends ThinkingView>(
  message: M,
  { thinkingMs }: { thinkingMs: number },
): M {
  return { ...message, thinkingMs, thinkingActive: false };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
