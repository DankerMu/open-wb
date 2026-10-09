import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preParsingHookHandler,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { HttpError } from "../core/errors/index.js";
import type { SessionListNotifier } from "./list-events.js";
import { registerSessionMetadataRoutes } from "./rest-metadata.js";
import type { WorkspaceRootOf } from "./session-cwd.js";
import type { SessionDeleter } from "./session-delete.js";
import type { SessionTodo } from "./session-todo.js";
import { classifyPrompt, sessionSkillsResolver, toWireText } from "./slash-commands.js";
import type {
  ApprovalEntry,
  ApprovalView,
  SessionMessageTree,
  SessionStore,
  StepView,
} from "./store.js";
import type { StoredAttachment } from "./store-attachments.js";
import type { SessionMetadataStore } from "./store-metadata.js";
import type { UndoState } from "./store-undo.js";
import type { SessionSupervisor, StreamCursor } from "./supervisor.js";
import type { TurnSnapshots } from "./turn-snapshot.js";
import { registerUndoRoute, type UndoRequest, type UndoResult } from "./undo.js";

type ForkResult = Awaited<ReturnType<SessionSupervisor["fork"]>>;

export interface SessionSupervisorPort {
  prompt(sessionId: string, text: string, beforeDispatch?: () => Promise<void>): Promise<void>;
  streamCursor(sessionId: string): StreamCursor;
  decide(sessionId: string, approvalId: number, decision: "allow" | "deny"): Promise<ApprovalView>;
  stop(sessionId: string): Promise<void>;
  regenerate(sessionId: string, ownerId: string): Promise<{ assistantMessageId: number }>;
  fork(sessionId: string, ownerId: string, messageId: number): Promise<ForkResult>;
  undo(request: UndoRequest): Promise<UndoResult>;
  controlHeld(sessionId: string): boolean;
}

export interface SessionOwnerStore {
  getMessages(sessionId: string, ownerId: string): SessionMessageTree | null;
}

interface SessionRestDependencies {
  /** The undo route's two database steps: the undo state read and the undo transaction. */
  db: DatabaseSync;
  store: SessionStore;
  supervisor: SessionSupervisorPort;
  metadata: SessionMetadataStore;
  workspaceRootOf: WorkspaceRootOf;
  deleter: Pick<SessionDeleter, "deleteSession">;
  /** The omp agent directory of the slash whitelist; the prompt route lists its skills. */
  agentDir: string;
  /** With `workspaceRootOf`, the session cwd whose project skills the prompt route lists (#773). */
  sandboxRoot: string;
  /**
   * Told after each committed write of these routes that changes the owner's session list; a
   * committed undo also tells that the session was rewound.
   */
  listEvents: Pick<SessionListNotifier, "notify" | "notifyRewound">;
  /**
   * The per-turn workspace snapshot: the prompt's pre-dispatch step, its cleanup, and the `undo`
   * values its registrations give the message view and the prompt's 202.
   */
  turnSnapshots: TurnSnapshots;
}

interface PublicSession {
  id: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  scene: string | null;
  workspaceId: string | null;
  pinnedAt: number | null;
  archivedAt: number | null;
  pendingApproval: boolean;
  temporaryWorkspace: boolean;
  approvalMode: string;
  modelId: string;
  reasoningEffort: string | null;
}

interface PublicStep {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  output: string;
  changes: StepView["changes"];
  status: string;
}

interface PublicMessage {
  id: number;
  role: string;
  content: string;
  thinking: string | null;
  status: string;
  createdAt: number;
  approvals: ApprovalEntry[];
  /** Always null on an assistant message. */
  undo: UndoState | null;
  /** The list recorded at admission; never re-checked against the files on a read. */
  attachments: StoredAttachment[];
  steps: PublicStep[];
}

interface OwnedSnapshot {
  tree: SessionMessageTree;
  streamCursor: StreamCursor;
  todo: SessionTodo | null;
  /** The undo state of each user message; null until the history route's own hook reads it. */
  undoOf: ((userMessageId: number) => UndoState) | null;
}

interface SessionIdParams {
  id: string;
}

interface ApprovalParams {
  id: string;
  approvalId: string;
}

const MESSAGE_LIMIT = 32_768;
const CANONICAL_APPROVAL_ID = /^[1-9][0-9]*$/;
/** Fastify 拒绝 bodyLimit 0（须 >0），故取最小合法值；显式 no-body 校验负责 0 字节合同。 */
const BODYLESS_BODY_LIMIT = 1;
/**
 * The longest valid fork body is ~30 bytes (`{"messageId":9007199254740991}`). 1 KiB keeps every
 * oversized body a deterministic owned 400: Fastify rejects on content-length before reading.
 */
const FORK_BODY_LIMIT = 1_024;

const noStoreSessionResponse: onRequestHookHandler = (_request, reply, done) => {
  reply.header("Cache-Control", "no-store");
  done();
};

export const noStoreSessionHeaders: onRequestHookHandler = noStoreSessionResponse;

export function requireOwnedSession(
  store: SessionOwnerStore,
  request: FastifyRequest<{ Params: SessionIdParams }>,
): SessionMessageTree {
  const principal = currentPrincipal(request);
  const tree = store.getMessages(request.params.id, principal.id);
  if (tree === null) {
    throw new HttpError("not_found");
  }
  return tree;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: SessionRestDependencies,
): void {
  const authorizedHistory = new WeakMap<FastifyRequest, OwnedSnapshot>();
  const skillsOf = sessionSkillsResolver(
    dependencies.agentDir,
    dependencies.sandboxRoot,
    dependencies.workspaceRootOf,
  );

  const authorizeOwnedBeforeParse: preParsingHookHandler<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    { Params: SessionIdParams }
  > = (request, _reply, payload, done) => {
    const tree = requireOwnedSession(dependencies.store, request);
    const streamCursor = dependencies.supervisor.streamCursor(request.params.id);
    authorizedHistory.set(request, { tree, streamCursor, todo: null, undoOf: null });
    done(null, payload);
  };

  /**
   * History route only, right after the owner check above and in the same synchronous segment, so
   * the task list and the undo states match the tree and the cursor; no other route reads
   * `chat_sessions.todo`.
   */
  const readTodoBeforeParse: typeof authorizeOwnedBeforeParse = (
    request,
    _reply,
    payload,
    done,
  ) => {
    const snapshot = authorizedHistory.get(request);
    if (snapshot !== undefined) {
      snapshot.todo = dependencies.store.readTodo(request.params.id, currentPrincipal(request).id);
      snapshot.undoOf = dependencies.turnSnapshots.undoStates(
        request.params.id,
        snapshot.tree.session.workspaceId,
      );
    }
    done(null, payload);
  };

  const authorizeApprovalBeforeParse: preParsingHookHandler<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    { Params: ApprovalParams }
  > = (request, _reply, payload, done) => {
    requireOwnedSession(dependencies.store, request);
    parseApprovalId(request.params.approvalId);
    done(null, payload);
  };

  const authorizeSessionBeforeParse: preParsingHookHandler<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    { Params: SessionIdParams }
  > = (request, _reply, payload, done) => {
    requireOwnedSession(dependencies.store, request);
    done(null, payload);
  };

  app.get("/api/sessions", { onRequest: noStoreSessionResponse }, async (request) => {
    const principal = currentPrincipal(request);
    return {
      sessions: dependencies.store.list(principal.id).map(toPublicSession),
    };
  });
  registerSessionMetadataRoutes(app, {
    metadata: dependencies.metadata,
    workspaceRootOf: dependencies.workspaceRootOf,
    store: dependencies.store,
    deleter: dependencies.deleter,
    supervisor: dependencies.supervisor,
    listEvents: dependencies.listEvents,
  });
  app.get<{ Params: SessionIdParams }>(
    "/api/sessions/:id/messages",
    {
      onRequest: noStoreSessionResponse,
      preParsing: [authorizeOwnedBeforeParse, readTodoBeforeParse],
    },
    async (request) => {
      const snapshot = authorizedHistory.get(request);
      if (snapshot === undefined || snapshot.undoOf === null) {
        throw new HttpError("not_found");
      }
      return toPublicHistory(snapshot, snapshot.undoOf);
    },
  );
  app.post<{ Params: SessionIdParams }>(
    "/api/sessions/:id/prompt",
    { onRequest: noStoreSessionResponse, preParsing: authorizeOwnedBeforeParse },
    async (request, reply) => {
      const principal = currentPrincipal(request);
      const text = parsePromptMessage(request.body);
      // Archive read, claim check and admission share one synchronous segment: no await in
      // between. The read is fresh: the tree cached before the body arrived may predate a PATCH.
      if (dependencies.metadata.archivedAt(request.params.id, principal.id) !== null) {
        throw new HttpError("session_archived");
      }
      if (dependencies.supervisor.controlHeld(request.params.id)) {
        throw new HttpError("session_busy");
      }
      const accepted = dependencies.store.acceptPrompt(request.params.id, principal.id, text);
      dependencies.listEvents.notify(principal.id);
      // The binding is immutable, so the tree cached before the body arrived still has it.
      const bound = authorizedHistory.get(request)?.tree.session.workspaceId ?? null;
      try {
        // The stored text stays as typed; only `/` text is classified, so no other prompt scans.
        // The skills are those of this session's cwd: its workspace root, else the owner root.
        const skills = text.startsWith("/") ? skillsOf(principal.id, bound) : [];
        // The snapshot is the supervisor's pre-dispatch step, not awaited here: a stop is only
        // kept once `supervisor.prompt` has opened the turn (design D9「接入点」).
        const snapshot = dependencies.turnSnapshots.step({
          ownerId: principal.id,
          sessionId: request.params.id,
          workspaceId: bound,
          userMessageId: accepted.userMessageId,
          command: classifyPrompt(text, skills).kind !== "text",
        });
        await dependencies.supervisor.prompt(request.params.id, toWireText(text, skills), snapshot);
      } catch (error) {
        // false: the turn already reached a terminal state, which had its own notification, and
        // its user message (with its snapshot registration) stays.
        if (dependencies.store.rollbackPrompt(accepted.assistantMessageId)) {
          dependencies.listEvents.notify(principal.id);
          await dependencies.turnSnapshots.discard(bound, accepted.userMessageId);
        }
        throw error;
      }
      // Read once `supervisor.prompt` has resolved: the snapshot step has settled by then, so the
      // registration is the one the history will show. Outside the `try`: this turn is dispatched,
      // and a failed read must not compensate it.
      const undoOf = dependencies.turnSnapshots.undoStates(request.params.id, bound);
      return reply.code(202).send({
        userMessageId: accepted.userMessageId,
        assistantMessageId: accepted.assistantMessageId,
        undo: undoOf(accepted.userMessageId),
      });
    },
  );
  app.post<{ Params: SessionIdParams }>(
    "/api/sessions/:id/stop",
    {
      bodyLimit: BODYLESS_BODY_LIMIT,
      onRequest: noStoreSessionResponse,
      preParsing: authorizeSessionBeforeParse,
    },
    async (request, reply) => {
      if (request.body !== undefined) {
        throw new HttpError("bad_request");
      }
      // Status read and supervisor.stop share one synchronous segment: no await in between.
      const tree = requireOwnedSession(dependencies.store, request);
      if (tree.session.status !== "running") {
        return reply.code(204).send();
      }
      await dependencies.supervisor.stop(request.params.id);
      return reply.code(202).send({});
    },
  );
  app.post<{ Params: SessionIdParams }>(
    "/api/sessions/:id/regenerate",
    {
      bodyLimit: BODYLESS_BODY_LIMIT,
      onRequest: noStoreSessionResponse,
      preParsing: authorizeSessionBeforeParse,
    },
    async (request, reply) => {
      if (request.body !== undefined) {
        throw new HttpError("bad_request");
      }
      const principal = currentPrincipal(request);
      let assistantMessageId: number;
      try {
        ({ assistantMessageId } = await dependencies.supervisor.regenerate(
          request.params.id,
          principal.id,
        ));
      } catch (error) {
        // A dispatch that failed after the commit settled the new row `failed` without a published
        // event, and the route cannot tell it from an uncommitted 502: both notify once.
        if (error instanceof HttpError && error.code === "agent_unavailable") {
          dependencies.listEvents.notify(principal.id);
        }
        throw error;
      }
      dependencies.listEvents.notify(principal.id);
      return reply.code(202).send({ assistantMessageId });
    },
  );
  app.post<{ Params: SessionIdParams }>(
    "/api/sessions/:id/fork",
    {
      bodyLimit: FORK_BODY_LIMIT,
      onRequest: noStoreSessionResponse,
      preParsing: authorizeSessionBeforeParse,
    },
    async (request, reply) => {
      const messageId = parseForkMessageId(request.body);
      const principal = currentPrincipal(request);
      const result = await dependencies.supervisor.fork(request.params.id, principal.id, messageId);
      dependencies.listEvents.notify(principal.id);
      return reply.code(201).send({
        session: toPublicSession(result.session),
        draft: result.draft,
        attachments: result.attachments.map(toPublicAttachment),
      });
    },
  );
  registerUndoRoute(app, dependencies);
  app.post<{ Params: ApprovalParams }>(
    "/api/sessions/:id/approvals/:approvalId",
    { onRequest: noStoreSessionResponse, preParsing: authorizeApprovalBeforeParse },
    async (request) => {
      const decision = parseDecision(request.body);
      const approvalId = parseApprovalId(request.params.approvalId);
      return toPublicApproval(
        await dependencies.supervisor.decide(request.params.id, approvalId, decision),
      );
    },
  );
}

export function currentPrincipal(request: FastifyRequest): { id: string } {
  const principal = request.principal;
  if (principal === null) {
    throw new HttpError("unauthorized");
  }
  return principal;
}

export function toPublicSession(session: PublicSession): PublicSession {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    scene: session.scene,
    workspaceId: session.workspaceId,
    pinnedAt: session.pinnedAt,
    archivedAt: session.archivedAt,
    pendingApproval: session.pendingApproval,
    temporaryWorkspace: session.temporaryWorkspace,
    approvalMode: session.approvalMode,
    modelId: session.modelId,
    reasoningEffort: session.reasoningEffort,
  };
}

/** Exactly the two declared keys, whatever else the element carries. */
function toPublicAttachment({ path, size }: StoredAttachment): StoredAttachment {
  return { path, size };
}

function toPublicHistory(
  snapshot: OwnedSnapshot,
  undoOf: (userMessageId: number) => UndoState,
): {
  session: PublicSession;
  messages: PublicMessage[];
  streamCursor: StreamCursor;
  todo: SessionTodo | null;
} {
  return {
    session: toPublicSession(snapshot.tree.session),
    messages: snapshot.tree.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      thinking: message.thinking,
      status: message.status,
      createdAt: message.createdAt,
      approvals: message.approvals.map(toPublicApproval),
      undo: message.role === "user" ? undoOf(message.id) : null,
      attachments: message.attachments.map(toPublicAttachment),
      steps: message.steps.map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        name: step.name,
        detail: step.detail,
        output: step.output,
        changes: step.changes,
        status: step.status,
      })),
    })),
    streamCursor: snapshot.streamCursor,
    todo: snapshot.todo,
  };
}

function toPublicApproval(approval: ApprovalEntry): ApprovalEntry {
  return {
    id: approval.id,
    tool: approval.tool,
    title: approval.title,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    decision: approval.decision,
  };
}

/** Canonical positive safe integer; anything else (incl. a missing param) is the session 404. */
function parseApprovalId(raw: unknown): number {
  if (typeof raw !== "string" || !CANONICAL_APPROVAL_ID.test(raw)) {
    throw new HttpError("not_found");
  }
  const approvalId = Number(raw);
  if (!Number.isSafeInteger(approvalId)) {
    throw new HttpError("not_found");
  }
  return approvalId;
}

export function requirePlainRecord(body: unknown): Record<string, unknown> {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new HttpError("bad_request");
  }
  return body as Record<string, unknown>;
}

function parseDecision(body: unknown): "allow" | "deny" {
  const record = requirePlainRecord(body);
  const decision = record.decision;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "decision") ||
    (decision !== "allow" && decision !== "deny")
  ) {
    throw new HttpError("bad_request");
  }
  return decision;
}

/** Exactly `{messageId}` with a positive safe integer; ownership and role are the supervisor's. */
function parseForkMessageId(body: unknown): number {
  const record = requirePlainRecord(body);
  const messageId = record.messageId;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "messageId") ||
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0
  ) {
    throw new HttpError("bad_request");
  }
  return messageId;
}

function parsePromptMessage(body: unknown): string {
  const record = requirePlainRecord(body);
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, "message") ||
    typeof record.message !== "string"
  ) {
    throw new HttpError("bad_request");
  }
  const trimmed = record.message.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MESSAGE_LIMIT) {
    throw new HttpError("bad_request");
  }
  return trimmed;
}
