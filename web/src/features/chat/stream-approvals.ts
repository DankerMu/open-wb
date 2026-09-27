import { hasExactlyKeys } from "../../lib/api-json.js";
import type { ChatMessage } from "../../lib/session-contract.js";

type ChatSnapshotApproval = ChatMessage["approvals"][number];
type ChatApprovalOutcome = Exclude<ChatSnapshotApproval["decision"], null>;

/** View element of a message's approvals: the snapshot element without `requestedAt`. */
export type ChatApprovalView = Omit<ChatSnapshotApproval, "requestedAt">;

type ApprovalRequestData = {
  messageId: number;
  approvalId: number;
  tool: string;
  title: string;
  expiresAt: number;
};

type ApprovalResolvedData = {
  messageId: number;
  approvalId: number;
  decision: ChatApprovalOutcome;
};

export type ChatApprovalEvent =
  | { type: "approval.request"; data: ApprovalRequestData }
  | { type: "approval.resolved"; data: ApprovalResolvedData };

type WithApprovals = { approvals: ChatApprovalView[] };

export function approvalViews(approvals: ChatMessage["approvals"]): ChatApprovalView[] {
  return approvals.map((approval) => ({
    id: approval.id,
    tool: approval.tool,
    title: approval.title,
    expiresAt: approval.expiresAt,
    decision: approval.decision,
  }));
}

/**
 * Adds a pending entry keyed by `approvalId`, keeping ascending id order. An id already present
 * (e.g. a replay) returns the same message; other entries are never replaced or removed.
 */
export function requestApproval<M extends WithApprovals>(message: M, data: ApprovalRequestData): M {
  if (message.approvals.some((approval) => approval.id === data.approvalId)) {
    return message;
  }
  const entry: ChatApprovalView = {
    id: data.approvalId,
    tool: data.tool,
    title: data.title,
    expiresAt: data.expiresAt,
    decision: null,
  };
  const at = message.approvals.findIndex((approval) => approval.id > data.approvalId);
  const approvals = message.approvals.slice();
  approvals.splice(at < 0 ? approvals.length : at, 0, entry);
  return { ...message, approvals };
}

/** Updates only the entry with `approvalId`; an unknown id or an unchanged decision is a no-op. */
export function resolveApproval<M extends WithApprovals>(
  message: M,
  data: ApprovalResolvedData,
): M {
  const index = message.approvals.findIndex((approval) => approval.id === data.approvalId);
  const current = index < 0 ? undefined : message.approvals[index];
  if (current === undefined || current.decision === data.decision) {
    return message;
  }
  const approvals = message.approvals.slice();
  approvals[index] = { ...current, decision: data.decision };
  return { ...message, approvals };
}

export function decodeApprovalRequest(value: unknown): ChatApprovalEvent | undefined {
  if (
    !hasExactlyKeys(value, ["messageId", "approvalId", "tool", "title", "expiresAt"]) ||
    !isSafeInteger(value.messageId) ||
    !isSafeInteger(value.approvalId) ||
    typeof value.tool !== "string" ||
    typeof value.title !== "string" ||
    !isSafeInteger(value.expiresAt)
  ) {
    return undefined;
  }
  return {
    type: "approval.request",
    data: {
      messageId: value.messageId,
      approvalId: value.approvalId,
      tool: value.tool,
      title: value.title,
      expiresAt: value.expiresAt,
    },
  };
}

export function decodeApprovalResolved(value: unknown): ChatApprovalEvent | undefined {
  if (
    !hasExactlyKeys(value, ["messageId", "approvalId", "decision"]) ||
    !isSafeInteger(value.messageId) ||
    !isSafeInteger(value.approvalId) ||
    !isApprovalOutcome(value.decision)
  ) {
    return undefined;
  }
  return {
    type: "approval.resolved",
    data: { messageId: value.messageId, approvalId: value.approvalId, decision: value.decision },
  };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isApprovalOutcome(value: unknown): value is ChatApprovalOutcome {
  return value === "allow" || value === "deny" || value === "timeout";
}
