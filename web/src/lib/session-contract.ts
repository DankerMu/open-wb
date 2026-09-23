import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

type ChatSessionStatus = "idle" | "running" | "done" | "failed";
type ChatMessageRole = "user" | "assistant";
type ChatDeliveryStatus = "running" | "done" | "failed";

export type ChatSession = {
  id: string;
  title: string | null;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
};

type ChatStep = {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  status: ChatDeliveryStatus;
};

type ChatMessage = {
  id: number;
  role: ChatMessageRole;
  content: string;
  status: ChatDeliveryStatus;
  createdAt: number;
  steps: ChatStep[];
};

type ChatStreamCursor = {
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

const SESSION_ID = /^[0-9a-f]{32}$/;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isSessionStatus(value: unknown): value is ChatSessionStatus {
  return value === "idle" || value === "running" || value === "done" || value === "failed";
}

function isMessageRole(value: unknown): value is ChatMessageRole {
  return value === "user" || value === "assistant";
}

function isDeliveryStatus(value: unknown): value is ChatDeliveryStatus {
  return value === "running" || value === "done" || value === "failed";
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
  if (!hasExactlyKeys(value, ["id", "ordinal", "name", "detail", "status"])) {
    return null;
  }

  const { detail, id, name, ordinal, status } = value;
  if (
    !isSafeInteger(id) ||
    !isNonNegativeSafeInteger(ordinal) ||
    typeof name !== "string" ||
    typeof detail !== "string" ||
    !isDeliveryStatus(status)
  ) {
    return null;
  }

  return { id, ordinal, name, detail, status };
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
