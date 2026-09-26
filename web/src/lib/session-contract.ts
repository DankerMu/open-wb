import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

type ChatSessionStatus = "idle" | "running" | "done" | "failed" | "stopped";
type ChatMessageRole = "user" | "assistant";
type ChatDeliveryStatus = "running" | "done" | "failed" | "stopped";

export type ChatSession = {
  id: string;
  title: string | null;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
};

export type ChatStep = {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  output: string;
  status: ChatDeliveryStatus;
};

export type ChatMessage = {
  id: number;
  role: ChatMessageRole;
  content: string;
  status: ChatDeliveryStatus;
  createdAt: number;
  steps: ChatStep[];
};

export type ChatStreamCursor = {
  epoch: number;
  seq: number | null;
};

export type ChatSessionList = {
  sessions: ChatSession[];
};

export type ChatMessageSnapshot = {
  session: ChatSession;
  messages: ChatMessage[];
  streamCursor: ChatStreamCursor;
};

export type ChatPromptAccepted = {
  userMessageId: number;
  assistantMessageId: number;
};

export type ChatRegenerateAccepted = {
  assistantMessageId: number;
};

export type ChatSessionFork = {
  session: ChatSession;
  draft: string;
};

type ChatApprovalDecision = "allow" | "deny" | "timeout";

type ChatApproval = {
  id: number;
  tool: string;
  title: string;
  requestedAt: number;
  expiresAt: number;
  decision: ChatApprovalDecision | null;
};

export type ChatSettledApproval = ChatApproval & { decision: ChatApprovalDecision };

const SESSION_ID = /^[0-9a-f]{32}$/;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSessionStatus(value: unknown): value is ChatSessionStatus {
  return value === "idle" || isDeliveryStatus(value);
}

function isMessageRole(value: unknown): value is ChatMessageRole {
  return value === "user" || value === "assistant";
}

function isDeliveryStatus(value: unknown): value is ChatDeliveryStatus {
  return value === "running" || value === "done" || value === "failed" || value === "stopped";
}

function isApprovalDecision(value: unknown): value is ChatApprovalDecision {
  return value === "allow" || value === "deny" || value === "timeout";
}

export function parseSession(value: unknown): ChatSession | null {
  if (!hasExactlyKeys(value, ["id", "title", "status", "createdAt", "updatedAt"])) {
    return null;
  }

  const { createdAt, id, status, title, updatedAt } = value;
  if (
    typeof id !== "string" ||
    !SESSION_ID.test(id) ||
    (title !== null && typeof title !== "string") ||
    !isSessionStatus(status) ||
    !isNonNegativeSafeInteger(createdAt) ||
    !isNonNegativeSafeInteger(updatedAt)
  ) {
    return null;
  }

  return { id, title, status, createdAt, updatedAt };
}

function parseStep(value: unknown): ChatStep | null {
  if (!hasExactlyKeys(value, ["id", "ordinal", "name", "detail", "output", "status"])) {
    return null;
  }

  const { detail, id, name, ordinal, output, status } = value;
  if (
    !isSafeInteger(id) ||
    !isNonNegativeSafeInteger(ordinal) ||
    typeof name !== "string" ||
    typeof detail !== "string" ||
    typeof output !== "string" ||
    !isDeliveryStatus(status)
  ) {
    return null;
  }

  return { id, ordinal, name, detail, output, status };
}

function parseMessage(value: unknown): ChatMessage | null {
  if (!hasExactlyKeys(value, ["id", "role", "content", "status", "createdAt", "steps"])) {
    return null;
  }

  const { content, createdAt, id, role, status, steps } = value;
  if (
    !isSafeInteger(id) ||
    !isMessageRole(role) ||
    typeof content !== "string" ||
    !isDeliveryStatus(status) ||
    !isSafeInteger(createdAt)
  ) {
    return null;
  }

  const parsedSteps = parseJsonArray(steps, parseStep);
  if (!parsedSteps) {
    return null;
  }

  return { id, role, content, status, createdAt, steps: parsedSteps };
}

function parseStreamCursor(value: unknown): ChatStreamCursor | null {
  if (!hasExactlyKeys(value, ["epoch", "seq"])) {
    return null;
  }

  const { epoch, seq } = value;
  if (!isNonNegativeSafeInteger(epoch) || (seq !== null && !isNonNegativeSafeInteger(seq))) {
    return null;
  }

  return { epoch, seq };
}

export function parseSessionList(value: unknown): ChatSessionList | null {
  if (!hasExactlyKeys(value, ["sessions"])) {
    return null;
  }

  const sessions = parseJsonArray(value.sessions, parseSession);
  return sessions ? { sessions } : null;
}

export function parseMessageSnapshot(value: unknown): ChatMessageSnapshot | null {
  if (!hasExactlyKeys(value, ["session", "messages", "streamCursor"])) {
    return null;
  }

  const session = parseSession(value.session);
  const messages = parseJsonArray(value.messages, parseMessage);
  const streamCursor = parseStreamCursor(value.streamCursor);
  if (!session || !messages || !streamCursor) {
    return null;
  }

  return { session, messages, streamCursor };
}

export function parsePromptAccepted(value: unknown): ChatPromptAccepted | null {
  if (!hasExactlyKeys(value, ["userMessageId", "assistantMessageId"])) {
    return null;
  }

  const { assistantMessageId, userMessageId } = value;
  if (!isSafeInteger(userMessageId) || !isSafeInteger(assistantMessageId)) {
    return null;
  }

  return { userMessageId, assistantMessageId };
}

export function isStopAccepted(value: unknown): boolean {
  return hasExactlyKeys(value, []);
}

export function parseRegenerateAccepted(value: unknown): ChatRegenerateAccepted | null {
  if (!hasExactlyKeys(value, ["assistantMessageId"]) || !isSafeInteger(value.assistantMessageId)) {
    return null;
  }

  return { assistantMessageId: value.assistantMessageId };
}

export function parseSessionFork(value: unknown): ChatSessionFork | null {
  if (!hasExactlyKeys(value, ["session", "draft"]) || typeof value.draft !== "string") {
    return null;
  }

  const session = parseSession(value.session);
  return session ? { session, draft: value.draft } : null;
}

function parseApproval(value: unknown): ChatApproval | null {
  if (!hasExactlyKeys(value, ["id", "tool", "title", "requestedAt", "expiresAt", "decision"])) {
    return null;
  }

  const { decision, expiresAt, id, requestedAt, title, tool } = value;
  if (
    !isSafeInteger(id) ||
    typeof tool !== "string" ||
    typeof title !== "string" ||
    !isSafeInteger(requestedAt) ||
    !isSafeInteger(expiresAt) ||
    (decision !== null && !isApprovalDecision(decision))
  ) {
    return null;
  }

  return { id, tool, title, requestedAt, expiresAt, decision };
}

export function parseSettledApproval(value: unknown): ChatSettledApproval | null {
  const approval = parseApproval(value);
  if (!approval || approval.decision === null) {
    return null;
  }

  return { ...approval, decision: approval.decision };
}
