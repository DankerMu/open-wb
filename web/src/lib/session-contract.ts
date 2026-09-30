import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

type ChatSessionStatus = "idle" | "running" | "done" | "failed" | "stopped";
type ChatMessageRole = "user" | "assistant";
type ChatDeliveryStatus = "running" | "done" | "failed" | "stopped";
type ChatSessionScene = "office" | "code" | "design";

type ChatSessionMeta = {
  scene: ChatSessionScene | null;
  workspaceId: string | null;
  pinnedAt: number | null;
};

export type ChatSession = {
  id: string;
  title: string | null;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
} & ChatSessionMeta;

type ChatFileChange =
  | { path: string; added: number; removed: number; kind: "edit" }
  | { path: string; added: null; removed: null; kind: "write" };

export type ChatStep = {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  output: string;
  changes: ChatFileChange[] | null;
  status: ChatDeliveryStatus;
};

export type ChatMessage = {
  id: number;
  role: ChatMessageRole;
  content: string;
  thinking: string | null;
  status: ChatDeliveryStatus;
  createdAt: number;
  steps: ChatStep[];
  approvals: ChatApproval[];
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
const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const MAX_FILE_CHANGES = 50;

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

function isSessionScene(value: unknown): value is ChatSessionScene {
  return value === "office" || value === "code" || value === "design";
}

function parseSessionMeta(value: Record<string, unknown>): ChatSessionMeta | null {
  const { pinnedAt, scene, workspaceId } = value;
  if (
    (scene !== null && !isSessionScene(scene)) ||
    (workspaceId !== null &&
      (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId))) ||
    (pinnedAt !== null && !isNonNegativeSafeInteger(pinnedAt))
  ) {
    return null;
  }

  return { scene, workspaceId, pinnedAt };
}

export function parseSession(value: unknown): ChatSession | null {
  if (
    !hasExactlyKeys(value, [
      "id",
      "title",
      "status",
      "createdAt",
      "updatedAt",
      "scene",
      "workspaceId",
      "pinnedAt",
    ])
  ) {
    return null;
  }

  const { createdAt, id, status, title, updatedAt } = value;
  const meta = parseSessionMeta(value);
  if (
    typeof id !== "string" ||
    !SESSION_ID.test(id) ||
    (title !== null && typeof title !== "string") ||
    !isSessionStatus(status) ||
    !isNonNegativeSafeInteger(createdAt) ||
    !isNonNegativeSafeInteger(updatedAt) ||
    !meta
  ) {
    return null;
  }

  return { id, title, status, createdAt, updatedAt, ...meta };
}

/** `edit` carries non-negative line counts; `write` carries exactly null counts. */
function parseFileChange(value: unknown): ChatFileChange | null {
  if (!hasExactlyKeys(value, ["path", "added", "removed", "kind"])) {
    return null;
  }

  const { added, kind, path, removed } = value;
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }

  if (kind === "edit" && isNonNegativeSafeInteger(added) && isNonNegativeSafeInteger(removed)) {
    return { path, added, removed, kind };
  }

  return kind === "write" && added === null && removed === null
    ? { path, added, removed, kind }
    : null;
}

/** 1..50 valid changes, else null: `[]` and oversize arrays reject the whole step. */
function parseFileChanges(value: unknown): ChatFileChange[] | null {
  const changes = parseJsonArray(value, parseFileChange);
  return changes && changes.length > 0 && changes.length <= MAX_FILE_CHANGES ? changes : null;
}

function parseStep(value: unknown): ChatStep | null {
  if (!hasExactlyKeys(value, ["id", "ordinal", "name", "detail", "output", "changes", "status"])) {
    return null;
  }

  const { changes, detail, id, name, ordinal, output, status } = value;
  const parsedChanges = changes === null ? null : parseFileChanges(changes);
  if (
    !isSafeInteger(id) ||
    !isNonNegativeSafeInteger(ordinal) ||
    typeof name !== "string" ||
    typeof detail !== "string" ||
    typeof output !== "string" ||
    (changes !== null && !parsedChanges) ||
    !isDeliveryStatus(status)
  ) {
    return null;
  }

  return { id, ordinal, name, detail, output, changes: parsedChanges, status };
}

function parseMessage(value: unknown): ChatMessage | null {
  if (
    !hasExactlyKeys(value, [
      "id",
      "role",
      "content",
      "thinking",
      "status",
      "createdAt",
      "steps",
      "approvals",
    ])
  ) {
    return null;
  }

  const { approvals, content, createdAt, id, role, status, steps, thinking } = value;
  if (
    !isSafeInteger(id) ||
    !isMessageRole(role) ||
    typeof content !== "string" ||
    !isMessageThinking(thinking, role) ||
    !isDeliveryStatus(status) ||
    !isSafeInteger(createdAt)
  ) {
    return null;
  }

  const parsedSteps = parseJsonArray(steps, parseStep);
  const parsedApprovals = parseMessageApprovals(approvals, role);
  if (!parsedSteps || !parsedApprovals) {
    return null;
  }

  return {
    id,
    role,
    content,
    thinking,
    status,
    createdAt,
    steps: parsedSteps,
    approvals: parsedApprovals,
  };
}

/** A string or null on assistant messages; a user message never carries thinking. */
function isMessageThinking(value: unknown, role: ChatMessageRole): value is string | null {
  return value === null || (role === "assistant" && typeof value === "string");
}

/** Strictly ascending, duplicate-free ids; a user message never carries approvals. */
function parseMessageApprovals(value: unknown, role: ChatMessageRole): ChatApproval[] | null {
  const approvals = parseJsonArray(value, parseApproval);
  if (!approvals || (role === "user" && approvals.length > 0)) {
    return null;
  }

  let previous: number | undefined;
  for (const approval of approvals) {
    if (previous !== undefined && approval.id <= previous) {
      return null;
    }
    previous = approval.id;
  }

  return approvals;
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
