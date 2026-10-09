// 过渡分支（change `s1g-composer-capabilities`，design D16「三步落地」第 1 步）：`withTransitionalDefaults`
// 与两个 `TRANSITIONAL_*` 常量让解析同时接受服务端发出新键之前与之后的键集（会话十一键或十四键；
// 消息、fork 响应、undo 响应带或不带 `attachments`），缺席时补缺省值。这是合同迁移的过渡分支，
// 不是并行实现：服务端（任务组 8、12）发出新键之后，由任务 13.5 整块删除，解析收回恰好键集。
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

type ChatSessionStatus = "idle" | "running" | "done" | "failed" | "stopped";
type ChatMessageRole = "user" | "assistant";
type ChatDeliveryStatus = "running" | "done" | "failed" | "stopped";
type ChatSessionScene = "office" | "code" | "design";
/** 用户消息的可撤回状态（message-undo「可撤回状态」）；只读派生值。 */
type ChatUndoState = "available" | "too_large" | "failed" | "command" | "unbound" | "none";

type ChatApprovalMode = "always-ask" | "write" | "yolo";
type ChatReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 会话的三项输入框设置。 */
type ChatSessionComposer = {
  approvalMode: ChatApprovalMode;
  modelId: string;
  reasoningEffort: ChatReasoningEffort | null;
};

/** 消息附件：工作空间内的相对路径与字节数。 */
type ChatAttachment = { path: string; size: number };

type ChatSessionMeta = {
  scene: ChatSessionScene | null;
  workspaceId: string | null;
  pinnedAt: number | null;
  archivedAt: number | null;
  pendingApproval: boolean;
  temporaryWorkspace: boolean;
};

export type ChatSession = {
  id: string;
  title: string | null;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
} & ChatSessionMeta &
  ChatSessionComposer;

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
  /** 助手消息恒为 null；用户消息恒为六个取值之一。 */
  undo: ChatUndoState | null;
  /** 助手消息恒为空数组。 */
  attachments: ChatAttachment[];
};

export type ChatStreamCursor = {
  epoch: number;
  seq: number | null;
};

export type ChatSessionList = {
  sessions: ChatSession[];
};

type ChatTodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
type ChatTodoTask = { content: string; status: ChatTodoStatus };
type ChatTodoPhase = { name: string; tasks: ChatTodoTask[] };

/** 归一化任务清单：1..200 个阶段、每个阶段至少一个任务、任务总数 1..200。 */
type ChatTodo = { phases: ChatTodoPhase[] };

export type ChatMessageSnapshot = {
  session: ChatSession;
  messages: ChatMessage[];
  streamCursor: ChatStreamCursor;
  todo: ChatTodo | null;
};

export type ChatPromptAccepted = {
  userMessageId: number;
  assistantMessageId: number;
  /** 刚受理的那条用户消息的可撤回状态。 */
  undo: ChatUndoState;
};

export type ChatRegenerateAccepted = {
  assistantMessageId: number;
};

export type ChatSessionFork = {
  session: ChatSession;
  draft: string;
  attachments: ChatAttachment[];
};

type ChatUndoSkipReason =
  | "too_large"
  | "excluded"
  | "unreadable"
  | "special"
  | "name_encoding"
  | "mount";
type ChatUndoSkippedPath = { path: string; reason: ChatUndoSkipReason };
type ChatUndoFailedPath = { path: string };
/** `count` 是总数，`paths` 可能被服务端截断，所以 `count >= paths.length`。 */
type ChatUndoPathList<T> = { count: number; paths: T[] };

type ChatUndoFiles = {
  mode: "restored" | "kept";
  restored: number;
  removed: number;
  skipped: ChatUndoPathList<ChatUndoSkippedPath>;
  failed: ChatUndoPathList<ChatUndoFailedPath>;
};

export type ChatSessionUndo = {
  session: ChatSession;
  draft: string;
  files: ChatUndoFiles;
  attachments: ChatAttachment[];
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
const UNDO_STATES: ReadonlySet<unknown> = new Set<ChatUndoState>([
  "available",
  "too_large",
  "failed",
  "command",
  "unbound",
  "none",
]);
const UNDO_SKIP_REASONS: ReadonlySet<unknown> = new Set<ChatUndoSkipReason>([
  "too_large",
  "excluded",
  "unreadable",
  "special",
  "name_encoding",
  "mount",
]);
export const APPROVAL_MODES: ReadonlySet<unknown> = new Set<ChatApprovalMode>([
  "always-ask",
  "write",
  "yolo",
]);
export const REASONING_EFFORTS: ReadonlySet<unknown> = new Set<ChatReasoningEffort>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const TRANSITIONAL_SESSION_COMPOSER: ChatSessionComposer = {
  approvalMode: "write",
  modelId: "",
  reasoningEffort: null,
};
const TRANSITIONAL_ATTACHMENTS: { attachments: ChatAttachment[] } = { attachments: [] };
const TODO_STATUSES: ReadonlySet<unknown> = new Set<ChatTodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "abandoned",
  "blocked",
]);
/** `name` / `content` 各自的码点上限，以及跨阶段的任务总数上限。 */
const MAX_TODO_TEXT_POINTS = 200;
const MAX_TODO_TASKS = 200;

/**
 * 键集恰为 `base` 时补上 `defaults`；恰为 `base` 加 `defaults` 的各键时原样返回；其余（只带其中
 * 一部分、或多出别的键）为 null。
 */
function withTransitionalDefaults(
  value: unknown,
  base: readonly string[],
  defaults: Record<string, unknown>,
): Record<string, unknown> | null {
  if (hasExactlyKeys(value, base)) {
    return { ...value, ...defaults };
  }
  return hasExactlyKeys(value, [...base, ...Object.keys(defaults)]) ? value : null;
}

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

function isUndoState(value: unknown): value is ChatUndoState {
  return UNDO_STATES.has(value);
}

function isSessionScene(value: unknown): value is ChatSessionScene {
  return value === "office" || value === "code" || value === "design";
}

function parseSessionMeta(value: Record<string, unknown>): ChatSessionMeta | null {
  const { archivedAt, pendingApproval, pinnedAt, scene, temporaryWorkspace, workspaceId } = value;
  if (
    (scene !== null && !isSessionScene(scene)) ||
    (workspaceId !== null &&
      (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId))) ||
    (pinnedAt !== null && !isNonNegativeSafeInteger(pinnedAt)) ||
    (archivedAt !== null && !isNonNegativeSafeInteger(archivedAt)) ||
    typeof pendingApproval !== "boolean" ||
    typeof temporaryWorkspace !== "boolean" ||
    // 临时空间标记只能随一个已绑定的空间出现。
    (workspaceId === null && temporaryWorkspace)
  ) {
    return null;
  }

  return { scene, workspaceId, pinnedAt, archivedAt, pendingApproval, temporaryWorkspace };
}

function parseSessionComposer(value: Record<string, unknown>): ChatSessionComposer | null {
  const { approvalMode, modelId, reasoningEffort } = value;
  if (
    !APPROVAL_MODES.has(approvalMode) ||
    typeof modelId !== "string" ||
    (reasoningEffort !== null && !REASONING_EFFORTS.has(reasoningEffort))
  ) {
    return null;
  }

  return {
    approvalMode: approvalMode as ChatApprovalMode,
    modelId,
    reasoningEffort: reasoningEffort as ChatReasoningEffort | null,
  };
}

export function parseSession(input: unknown): ChatSession | null {
  const value = withTransitionalDefaults(
    input,
    [
      "id",
      "title",
      "status",
      "createdAt",
      "updatedAt",
      "scene",
      "workspaceId",
      "pinnedAt",
      "archivedAt",
      "pendingApproval",
      "temporaryWorkspace",
    ],
    TRANSITIONAL_SESSION_COMPOSER,
  );
  if (!value) {
    return null;
  }

  const { createdAt, id, status, title, updatedAt } = value;
  const meta = parseSessionMeta(value);
  const composer = parseSessionComposer(value);
  if (
    typeof id !== "string" ||
    !SESSION_ID.test(id) ||
    (title !== null && typeof title !== "string") ||
    !isSessionStatus(status) ||
    !isNonNegativeSafeInteger(createdAt) ||
    !isNonNegativeSafeInteger(updatedAt) ||
    !meta ||
    !composer
  ) {
    return null;
  }

  return { id, title, status, createdAt, updatedAt, ...meta, ...composer };
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
export function parseFileChanges(value: unknown): ChatFileChange[] | null {
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

function parseAttachment(value: unknown): ChatAttachment | null {
  if (!hasExactlyKeys(value, ["path", "size"])) {
    return null;
  }

  const { path, size } = value;
  return typeof path === "string" && path.length > 0 && isNonNegativeSafeInteger(size)
    ? { path, size }
    : null;
}

function parseAttachments(value: unknown): ChatAttachment[] | null {
  return parseJsonArray(value, parseAttachment);
}

function parseMessage(input: unknown): ChatMessage | null {
  const value = withTransitionalDefaults(
    input,
    ["id", "role", "content", "thinking", "status", "createdAt", "steps", "approvals", "undo"],
    TRANSITIONAL_ATTACHMENTS,
  );
  if (!value) {
    return null;
  }

  const { approvals, content, createdAt, id, role, status, steps, thinking, undo } = value;
  if (
    !isSafeInteger(id) ||
    !isMessageRole(role) ||
    typeof content !== "string" ||
    !isMessageThinking(thinking, role) ||
    !isDeliveryStatus(status) ||
    !isSafeInteger(createdAt) ||
    !isMessageUndo(undo, role)
  ) {
    return null;
  }

  const parsedSteps = parseJsonArray(steps, parseStep);
  const parsedApprovals = parseMessageApprovals(approvals, role);
  const attachments = parseAttachments(value.attachments);
  // 附件只属于用户消息。
  if (
    !parsedSteps ||
    !parsedApprovals ||
    !attachments ||
    (role === "assistant" && attachments.length > 0)
  ) {
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
    undo,
    attachments,
  };
}

/** One of the six states on a user message; exactly null on an assistant message. */
function isMessageUndo(value: unknown, role: ChatMessageRole): value is ChatUndoState | null {
  return role === "user" ? isUndoState(value) : value === null;
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

/** 字符串且不超过 200 个码点（代理对算一个）。 */
function isTodoText(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_TODO_TEXT_POINTS * 2) {
    return false;
  }
  let points = 0;
  for (const _point of value) {
    points += 1;
  }
  return points <= MAX_TODO_TEXT_POINTS;
}

function parseTodoTask(value: unknown): ChatTodoTask | null {
  if (!hasExactlyKeys(value, ["content", "status"])) {
    return null;
  }

  const { content, status } = value;
  if (!isTodoText(content) || !TODO_STATUSES.has(status)) {
    return null;
  }

  return { content, status: status as ChatTodoStatus };
}

function parseTodoPhase(value: unknown): ChatTodoPhase | null {
  if (!hasExactlyKeys(value, ["name", "tasks"]) || !isTodoText(value.name)) {
    return null;
  }

  const tasks = parseJsonArray(value.tasks, parseTodoTask);
  return tasks && tasks.length > 0 ? { name: value.name, tasks } : null;
}

/** `null` 是合法的空清单，所以非法结构用 `undefined` 表示。 */
export function parseTodo(value: unknown): ChatTodo | null | undefined {
  if (value === null) {
    return null;
  }
  if (!hasExactlyKeys(value, ["phases"])) {
    return undefined;
  }

  const phases = parseJsonArray(value.phases, parseTodoPhase);
  if (!phases || phases.length === 0) {
    return undefined;
  }

  const total = phases.reduce((count, phase) => count + phase.tasks.length, 0);
  return total > MAX_TODO_TASKS ? undefined : { phases };
}

export function parseSessionList(value: unknown): ChatSessionList | null {
  if (!hasExactlyKeys(value, ["sessions"])) {
    return null;
  }

  const sessions = parseJsonArray(value.sessions, parseSession);
  return sessions ? { sessions } : null;
}

export function parseMessageSnapshot(value: unknown): ChatMessageSnapshot | null {
  if (!hasExactlyKeys(value, ["session", "messages", "streamCursor", "todo"])) {
    return null;
  }

  const session = parseSession(value.session);
  const messages = parseJsonArray(value.messages, parseMessage);
  const streamCursor = parseStreamCursor(value.streamCursor);
  const todo = parseTodo(value.todo);
  if (!session || !messages || !streamCursor || todo === undefined) {
    return null;
  }

  return { session, messages, streamCursor, todo };
}

export function parsePromptAccepted(value: unknown): ChatPromptAccepted | null {
  if (!hasExactlyKeys(value, ["userMessageId", "assistantMessageId", "undo"])) {
    return null;
  }

  const { assistantMessageId, undo, userMessageId } = value;
  if (!isSafeInteger(userMessageId) || !isSafeInteger(assistantMessageId) || !isUndoState(undo)) {
    return null;
  }

  return { userMessageId, assistantMessageId, undo };
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

export function parseSessionFork(input: unknown): ChatSessionFork | null {
  const value = withTransitionalDefaults(input, ["session", "draft"], TRANSITIONAL_ATTACHMENTS);
  if (!value || typeof value.draft !== "string") {
    return null;
  }

  const session = parseSession(value.session);
  const attachments = parseAttachments(value.attachments);
  return session && attachments ? { session, draft: value.draft, attachments } : null;
}

function parseUndoSkippedPath(value: unknown): ChatUndoSkippedPath | null {
  if (
    !hasExactlyKeys(value, ["path", "reason"]) ||
    typeof value.path !== "string" ||
    !UNDO_SKIP_REASONS.has(value.reason)
  ) {
    return null;
  }

  return { path: value.path, reason: value.reason as ChatUndoSkipReason };
}

function parseUndoFailedPath(value: unknown): ChatUndoFailedPath | null {
  if (!hasExactlyKeys(value, ["path"]) || typeof value.path !== "string") {
    return null;
  }

  return { path: value.path };
}

function parseUndoPathList<T>(
  value: unknown,
  parseItem: (value: unknown) => T | null,
): ChatUndoPathList<T> | null {
  if (!hasExactlyKeys(value, ["count", "paths"])) {
    return null;
  }

  const { count } = value;
  const paths = parseJsonArray(value.paths, parseItem);
  if (!paths || !isNonNegativeSafeInteger(count) || count < paths.length) {
    return null;
  }

  return { count, paths };
}

function parseUndoFiles(value: unknown): ChatUndoFiles | null {
  if (!hasExactlyKeys(value, ["mode", "restored", "removed", "skipped", "failed"])) {
    return null;
  }

  const { mode, removed, restored } = value;
  const skipped = parseUndoPathList(value.skipped, parseUndoSkippedPath);
  const failed = parseUndoPathList(value.failed, parseUndoFailedPath);
  if (
    (mode !== "restored" && mode !== "kept") ||
    !isNonNegativeSafeInteger(restored) ||
    !isNonNegativeSafeInteger(removed) ||
    !skipped ||
    !failed
  ) {
    return null;
  }

  return { mode, restored, removed, skipped, failed };
}

export function parseSessionUndo(input: unknown): ChatSessionUndo | null {
  const value = withTransitionalDefaults(
    input,
    ["session", "draft", "files"],
    TRANSITIONAL_ATTACHMENTS,
  );
  if (!value || typeof value.draft !== "string") {
    return null;
  }

  const session = parseSession(value.session);
  const files = parseUndoFiles(value.files);
  const attachments = parseAttachments(value.attachments);
  return session && files && attachments
    ? { session, draft: value.draft, files, attachments }
    : null;
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
