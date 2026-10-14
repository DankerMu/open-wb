import { hasExactlyKeys } from "./api-json.js";

/**
 * 失败回合的公开形状（upstream-failure「失败的公开形状」，issue 909）：快照消息的 `error` 与 `error`
 * 事件共用这四个字段。`message` 是服务端按 `reason` 给的固定句子；`status` 有值时界面在句子后接
 * `（HTTP <status>）`；`detail` 是服务端净化过的上游原文，只能当纯文本显示。
 */
export type ChatMessageError = {
  reason: string;
  message: string;
  status: number | null;
  detail: string;
};

const ERROR_KEYS = ["reason", "message", "status", "detail"] as const;

/** 四个字段的取值：`reason`、`message` 为非空字符串，`status` 为 null 或 100–599 的整数，`detail` 为字符串。 */
export function isMessageErrorFields(value: Record<string, unknown>): boolean {
  const { detail, message, reason, status } = value;
  return (
    typeof reason === "string" &&
    reason !== "" &&
    typeof message === "string" &&
    message !== "" &&
    (status === null ||
      (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)) &&
    typeof detail === "string"
  );
}

/**
 * 快照消息的 `error` 键：`null`，或恰含四键的对象（user 消息只能是 `null`）。非法时返回 `undefined`，
 * 调用方据此整体拒绝快照。
 */
export function parseMessageError(
  value: unknown,
  role: "user" | "assistant",
): ChatMessageError | null | undefined {
  if (value === null) {
    return null;
  }
  if (role !== "assistant" || !hasExactlyKeys(value, ERROR_KEYS) || !isMessageErrorFields(value)) {
    return undefined;
  }
  return {
    reason: value.reason as string,
    message: value.message as string,
    status: value.status as number | null,
    detail: value.detail as string,
  };
}
