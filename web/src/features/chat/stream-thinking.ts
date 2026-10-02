import { hasExactlyKeys } from "../../lib/api-json.js";

export type ChatThinkingEvent = {
  type: "thinking.delta";
  data: { messageId: number; delta: string };
};

/** Strict key set `{messageId, delta}`: a safe-integer id and a non-empty string, else `undefined`. */
export function decodeThinkingDelta(value: unknown): ChatThinkingEvent | undefined {
  return hasExactlyKeys(value, ["messageId", "delta"]) &&
    isSafeInteger(value.messageId) &&
    typeof value.delta === "string" &&
    value.delta !== ""
    ? { type: "thinking.delta", data: { messageId: value.messageId, delta: value.delta } }
    : undefined;
}

/** Appends `delta` to the message's thinking (`null` counts as empty); the input is not modified. */
export function appendThinking<M extends { thinking: string | null }>(
  message: M,
  delta: string,
): M {
  return { ...message, thinking: (message.thinking ?? "") + delta };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
