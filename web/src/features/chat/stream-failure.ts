import { hasExactlyKeys } from "../../lib/api-json.js";
import { type ChatMessageError, isMessageErrorFields } from "../../lib/message-error-contract.js";

/**
 * 失败与重试事件（issue 909，chat-web「失败与重试事件严格解码」「失败对象与重试标记归约」）：`error`
 * 带完整的失败对象，`turn.retry` 表示 omp 开始了一轮会话级重试（「上游出错，正在重试…」）。
 */
export type ChatFailureEvent =
  | { type: "error"; data: { messageId: number } & ChatMessageError }
  | { type: "turn.retry"; data: { messageId: number } };

const ERROR_EVENT_KEYS = ["messageId", "reason", "message", "status", "detail"] as const;

/** 严格键集 `{messageId, message, reason, status, detail}`，字段规则同快照的 `error`；否则 `undefined`。 */
export function decodeFailure(value: unknown): ChatFailureEvent | undefined {
  if (
    !hasExactlyKeys(value, ERROR_EVENT_KEYS) ||
    !isSafeInteger(value.messageId) ||
    !isMessageErrorFields(value)
  ) {
    return undefined;
  }
  return {
    type: "error",
    data: {
      messageId: value.messageId,
      reason: value.reason as string,
      message: value.message as string,
      status: value.status as number | null,
      detail: value.detail as string,
    },
  };
}

/** 严格键集 `{messageId}`（安全整数）；否则 `undefined`。 */
export function decodeTurnRetry(value: unknown): ChatFailureEvent | undefined {
  return hasExactlyKeys(value, ["messageId"]) && isSafeInteger(value.messageId)
    ? { type: "turn.retry", data: { messageId: value.messageId } }
    : undefined;
}

type FailureView = { error: ChatMessageError | null; retrying: boolean };

/** 事件负载里的失败对象：恰为四个字段（不带 `messageId`）。 */
export function failureOf(data: { messageId: number } & ChatMessageError): ChatMessageError {
  const { detail, message, reason, status } = data;
  return { reason, message, status, detail };
}

/** `turn.retry`：只把重试标记置真（已为真时原样返回同一引用）。 */
export function markRetrying<M extends FailureView>(message: M): M {
  return message.retrying ? message : { ...message, retrying: true };
}

/** 同一助手消息随后的 turn.start、text.delta、thinking.delta、step.start、error、turn.end 都清掉重试标记。 */
export function clearRetrying<M extends FailureView>(message: M): M {
  return message.retrying ? { ...message, retrying: false } : message;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
