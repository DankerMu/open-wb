import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { emit } from "../core/audit/index.js";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { HttpError } from "../core/errors/index.js";
import type { FileChange } from "./file-changes.js";
import {
  approvalsBySession,
  cancelTimer,
  faultTurnSignal,
  finishOwnedTurn,
  flushPending,
  insertPendingApproval,
  reconcileRunning,
  releaseTurn,
  settlePendingApproval,
  turnSignal,
} from "./store-approvals.js";
import { readAttachmentPaths } from "./store-attachments.js";
import {
  copyForkHistory,
  decodeNullableText,
  type ForkCommit,
  hasChanges,
  INSERT_MESSAGE,
  MESSAGE_COLUMNS,
  type MessageDbRow,
  replaceLastAssistant,
  requireAtMostOne,
  requireChanges,
  runOwnedTransaction,
  STEP_COLUMNS,
  type StepDbRow,
  titlePrefix,
  toMessageView,
  toStepView,
} from "./store-branch.js";
import { setStepChanges as setStepChangesText } from "./store-changes.js";
import {
  COMPOSER_COLUMNS,
  type ComposerConfig,
  type ComposerDbRow,
  rawComposer,
} from "./store-composer.js";
import { appendThinking as appendThinkingText } from "./store-thinking.js";
import {
  createSessionTodoStore,
  type SessionTodoOptions,
  type SessionTodoStore,
} from "./store-todo.js";
import {
  readSessionView,
  SESSION_COLUMNS,
  type SessionDbRow,
  type SessionStatus,
  type SessionView,
  toSessionView,
} from "./store-view.js";

export type { SessionView };

export type MessageRole = "user" | "assistant";
export type MessageStatus = "done" | "running" | "failed" | "stopped";
export type StepStatus = "running" | "done" | "failed" | "stopped";
export type FinishStatus = "done" | "failed" | "stopped";

export interface StepView {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  output: string;
  /** `chat_steps.changes` elements; element validity is the writer's (3.4) job. */
  changes: FileChange[] | null;
  status: StepStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface MessageView {
  id: number;
  role: MessageRole;
  content: string;
  thinking: string | null;
  status: MessageStatus;
  createdAt: number;
  steps: StepView[];
  /** Every approval row of this message in ascending id order; `[]` for user messages. */
  approvals: ApprovalEntry[];
}

export interface SessionMessageTree {
  session: SessionView;
  messages: MessageView[];
}

interface AcceptedPrompt {
  userMessageId: number;
  assistantMessageId: number;
}

interface SessionRuntimeState {
  ownerId: string;
  ompSessionFile: string | null;
  streamEpoch: number;
  activeTurn: AcceptedPrompt | null;
  workspaceId: string | null;
  /** The three raw composer columns, each null when never chosen (`effectiveComposer`'s `raw`). */
  composer: ReturnType<typeof rawComposer>;
}

interface FlushError {
  sessionId: string;
  assistantMessageId: number;
  error: unknown;
}

export interface SessionStoreOptions extends SessionTodoOptions {
  onFlushError: (failure: FlushError) => void;
  /** core/audit emit bound per call to this DB; settling an approval without it fails closed. */
  emit?: typeof emit;
  /** What turns the three raw composer columns into a view's effective values. */
  composer: ComposerConfig;
}

export type ApprovalOutcome = "allow" | "deny" | "timeout";

/** One snapshot approval element; `decision` stays null while the approval is pending. */
export interface ApprovalEntry {
  id: number;
  tool: string;
  title: string;
  requestedAt: number;
  expiresAt: number;
  decision: ApprovalOutcome | null;
}

/** One settled approval, the shape `decide` resolves with (a snapshot element, never pending). */
export interface ApprovalView extends ApprovalEntry {
  decision: ApprovalOutcome;
}

/** One pending approval a terminal transaction settled (committed) to `deny`. */
export interface SettledApproval {
  messageId: number;
  approvalId: number;
  decision: "deny";
}

export interface ApprovalInput {
  requestId: string;
  tool: string;
  title: string;
}

export interface PendingApproval {
  approvalId: number;
  messageId: number;
  expiresAt: number;
}

interface StartStepInput {
  ordinal: number;
  name: string;
  detail: string;
}

export interface SessionStore extends SessionTodoStore {
  create(ownerId: string): SessionView;
  list(ownerId: string): SessionView[];
  getMessages(sessionId: string, ownerId: string): SessionMessageTree | null;
  /** Message id → stored attachment paths (#1018, store-attachments.ts); absent means none. */
  attachmentPaths(sessionId: string): Map<number, string[]>;
  acceptPrompt(sessionId: string, ownerId: string, text: string): AcceptedPrompt;
  rollbackPrompt(assistantMessageId: number): boolean;
  /** A metadata PATCH wrote the title: an in-flight admission's rollback keeps it (no-op if idle). */
  noteTitleWrite(sessionId: string): void;
  /** Regenerate CAS + Turn registration (#465); session_busy on a CAS miss. The new assistant id. */
  acceptRegenerate(sessionId: string, expectedAssistantId: number, sessionFile: string): number;
  /** Fork CAS + insert + copy (#466); session_busy on a CAS miss. The new session's view. */
  commitFork(input: ForkCommit): SessionView;
  bumpStreamEpoch(sessionId: string): number;
  setSessionFile(sessionId: string, sessionFile: string | null): void;
  appendDelta(assistantMessageId: number, delta: string): boolean;
  /** Bounded thinking append (#519, store-thinking.ts): the fragment stored, "" once capped. */
  appendThinking(messageId: number, chunk: string): string;
  startStep(assistantMessageId: number, input: StartStepInput): number;
  /** Owned file changes of a still-running step (#522, store-changes.ts); throws off one row. */
  setStepChanges(stepId: number, json: string): void;
  // step.end 不扩展：stopped 步骤只由 finishTurn 结算（output 保持 NULL）。
  finishStep(stepId: number, status: "done" | "failed", output: string): boolean;
  /** Pending approvals denied in the terminal transaction are appended to `settled` once committed. */
  finishTurn(
    assistantMessageId: number,
    status: FinishStatus,
    settled?: SettledApproval[],
  ): boolean;
  reconcileOnStartup(): void;
  /** Pending row on the session's running assistant; expires 60000ms after `requestedAt`. */
  insertApproval(sessionId: string, input: ApprovalInput, requestedAt: number): PendingApproval;
  /** CAS + audit in one transaction; null when already settled; not_found if not this session's. */
  settleApproval(
    sessionId: string,
    approvalId: number,
    decision: ApprovalOutcome,
    decidedAt: number,
  ): ApprovalView | null;
  runtimeState(sessionId: string): SessionRuntimeState | null;
  /** No turn → resolved; else settles with the in-flight turn's release (resolve) or fault. */
  turnReleased(sessionId: string): Promise<void>;
  /** Faults the still-active turn (first fault wins); a released or unknown id is a no-op. */
  faultTurn(assistantMessageId: number, error: Error): void;
  close(): void;
}

type RuntimeDbRow = ComposerDbRow & {
  owner_id: string;
  omp_session_file: Uint8Array | null;
  stream_epoch: number;
  workspace_id: string | null;
};

type AdmissionDbRow = Pick<SessionDbRow, "id" | "owner_id" | "title" | "status" | "updated_at">;

export type Turn = {
  sessionId: string;
  ownerId: string;
  userMessageId: number;
  assistantMessageId: number;
  previousStatus: SessionStatus;
  previousTitle: string | null;
  previousUpdatedAt: number;
  pending: string[];
  pendingBytes: number;
  progress: boolean;
  titleTouched: boolean;
  timer: NodeJS.Timeout | undefined;
  timerGeneration: number;
  faulted: boolean;
  fault: unknown;
  notified: boolean;
  /** One-shot (#526): resolved by releaseTurn, rejected by the first fault; never unhandled. */
  released: Promise<void>;
  release: () => void;
  fail: (error: unknown) => void;
};

const FLUSH_BYTES = 2_048;
const FLUSH_MS = 2_000;
const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at) VALUES (?, ?, NULL, 'idle', ?, ?)";

export function createSessionStore(db: DatabaseSync, options: SessionStoreOptions): SessionStore {
  const activeTurns = new Map<number, Turn>();
  const activeSessions = new Map<string, number>();
  const activeSteps = new Map<number, number>();
  let closed = false;
  const finish = (turn: Turn, status: FinishStatus): SettledApproval[] =>
    finishOwnedTurn(db, options.emit, turn, status, activeTurns, activeSessions, activeSteps);

  return {
    ...createSessionTodoStore(db, options),
    create(ownerId) {
      assertOpen(closed);
      const now = Date.now();
      const id = randomBytes(16).toString("hex");
      runOwnedTransaction(db, "session create rollback failed", () => {
        requireChanges(
          db.prepare(INSERT_SESSION).run(id, ownerId, now, now).changes,
          1,
          "session create",
        );
      });
      return readSessionView(db, id, options.composer, "created session row missing");
    },

    list(ownerId) {
      const decoder = createSqliteTextDecoder(db);
      const rows = db
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE owner_id = ? ORDER BY updated_at DESC, id ASC`,
        )
        .all(ownerId) as unknown as SessionDbRow[];
      const listed: SessionView[] = [];
      for (const row of rows) {
        listed.push(toSessionView(row, decoder, options.composer));
      }
      return listed;
    },

    getMessages(sessionId, ownerId) {
      const decoder = createSqliteTextDecoder(db);
      const session = db
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ? AND owner_id = ? LIMIT 1`,
        )
        .get(sessionId, ownerId) as unknown as SessionDbRow | undefined;
      if (session === undefined) {
        return null;
      }
      const messages = db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(sessionId) as unknown as MessageDbRow[];
      const steps = db
        .prepare(
          `SELECT ${STEP_COLUMNS} FROM chat_steps AS s
         JOIN chat_messages AS m ON m.id = s.message_id
         WHERE m.session_id = ? ORDER BY s.ordinal ASC, s.id ASC`,
        )
        .all(sessionId) as unknown as StepDbRow[];
      const stepsByMessage = new Map<number, StepView[]>();
      for (const step of steps) {
        const current = stepsByMessage.get(step.message_id);
        const view = toStepView(step, decoder);
        if (current === undefined) {
          stepsByMessage.set(step.message_id, [view]);
        } else {
          current.push(view);
        }
      }
      const approvalsByMessage = approvalsBySession(db, sessionId, decoder);
      const views: MessageView[] = [];
      for (const message of messages) {
        const view = toMessageView(message, decoder);
        const turn = currentTurn(activeTurns, activeSessions, message.id);
        view.content += turn !== undefined && turn.pending.length > 0 ? turn.pending.join("") : "";
        views.push({
          ...view,
          steps: stepsByMessage.get(message.id) ?? [],
          approvals: approvalsByMessage.get(message.id) ?? [],
        });
      }
      return { session: toSessionView(session, decoder, options.composer), messages: views };
    },

    acceptPrompt(sessionId, ownerId, text) {
      assertOpen(closed);
      const now = Date.now();
      const accepted = runOwnedTransaction(db, "prompt admission rollback failed", () => {
        const decoder = createSqliteTextDecoder(db);
        const session = db
          .prepare(
            "SELECT id, owner_id, CAST(title AS BLOB) AS title, status, updated_at FROM chat_sessions WHERE id = ? LIMIT 1",
          )
          .get(sessionId) as unknown as AdmissionDbRow | undefined;
        if (session === undefined || session.owner_id !== ownerId) {
          throw new HttpError("not_found");
        }
        if (session.status === "running") {
          throw new HttpError("session_busy");
        }
        const userReceipt = db.prepare(INSERT_MESSAGE).run(sessionId, "user", text, "done", now);
        requireChanges(userReceipt.changes, 1, "user message insert");
        const assistantReceipt = db
          .prepare(INSERT_MESSAGE)
          .run(sessionId, "assistant", "", "running", now);
        requireChanges(assistantReceipt.changes, 1, "assistant message insert");
        const previousTitle = decodeNullableText(decoder, session.title);
        const title = previousTitle === null ? titlePrefix(text) : previousTitle;
        requireChanges(
          db
            .prepare(
              "UPDATE chat_sessions SET title = ?, status = 'running', updated_at = ? WHERE id = ?",
            )
            .run(title, now, sessionId).changes,
          1,
          "session admission",
        );
        return {
          userMessageId: Number(userReceipt.lastInsertRowid),
          assistantMessageId: Number(assistantReceipt.lastInsertRowid),
          previousStatus: session.status,
          previousTitle,
          previousUpdatedAt: Number(session.updated_at),
        };
      });
      const turn = openTurn(
        { sessionId, ownerId, ...accepted },
        false,
        activeTurns,
        activeSessions,
      );
      return { userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId };
    },

    acceptRegenerate(sessionId, expectedAssistantId, sessionFile) {
      assertOpen(closed);
      const replaced = replaceLastAssistant(db, createSqliteTextDecoder(db), {
        sessionId,
        expectedAssistantId,
        sessionFile,
        now: Date.now(),
      });
      // progress: rollbackPrompt must refuse; its userMessageId is the kept, existing user row.
      return openTurn({ sessionId, ...replaced }, true, activeTurns, activeSessions)
        .assistantMessageId;
    },

    commitFork(input) {
      assertOpen(closed);
      copyForkHistory(db, input, Date.now());
      return readSessionView(db, input.sessionId, options.composer, "forked session row missing");
    },

    rollbackPrompt(assistantMessageId) {
      assertOpen(closed);
      const turn = currentTurn(activeTurns, activeSessions, assistantMessageId);
      if (turn === undefined) {
        return false;
      }
      if (turn.progress) {
        throw new Error("cannot roll back a progressed prompt");
      }
      // Only this admission's own prefix goes back to NULL; a PATCHed or pre-existing title stays.
      const restoreTitle = turn.previousTitle === null && !turn.titleTouched;
      try {
        runOwnedTransaction(db, "prompt rollback compensation failed", () => {
          requireChanges(
            db
              .prepare("DELETE FROM chat_messages WHERE id = ? AND session_id = ?")
              .run(turn.assistantMessageId, turn.sessionId).changes,
            1,
            "assistant rollback delete",
          );
          requireChanges(
            db
              .prepare("DELETE FROM chat_messages WHERE id = ? AND session_id = ?")
              .run(turn.userMessageId, turn.sessionId).changes,
            1,
            "user rollback delete",
          );
          requireChanges(
            db
              .prepare(
                "UPDATE chat_sessions SET status = ?, updated_at = ?, title = CASE WHEN ? THEN NULL ELSE title END WHERE id = ?",
              )
              .run(
                turn.previousStatus,
                turn.previousUpdatedAt,
                restoreTitle ? 1 : 0,
                turn.sessionId,
              ).changes,
            1,
            "session rollback restore",
          );
        });
      } catch (error) {
        faultTurnSignal(turn, error);
        throw error;
      }
      releaseTurn(turn, activeTurns, activeSessions, activeSteps);
      return true;
    },

    noteTitleWrite(sessionId) {
      const assistantMessageId = activeSessions.get(sessionId);
      const turn =
        assistantMessageId === undefined ? undefined : activeTurns.get(assistantMessageId);
      if (turn !== undefined) {
        turn.titleTouched = true;
      }
    },

    // Trusted supervisor write: callers own session existence; missing row = receipt error.
    bumpStreamEpoch(sessionId) {
      assertOpen(closed);
      return runOwnedTransaction(db, "stream epoch rollback failed", () => {
        requireChanges(
          db
            .prepare("UPDATE chat_sessions SET stream_epoch = stream_epoch + 1 WHERE id = ?")
            .run(sessionId).changes,
          1,
          "stream epoch update",
        );
        const row = db
          .prepare("SELECT stream_epoch FROM chat_sessions WHERE id = ?")
          .get(sessionId) as { stream_epoch: number };
        return Number(row.stream_epoch);
      });
    },

    // Trusted supervisor write: callers own session existence; missing row = receipt error.
    setSessionFile(sessionId, sessionFile) {
      assertOpen(closed);
      runOwnedTransaction(db, "session file rollback failed", () => {
        requireChanges(
          db
            .prepare("UPDATE chat_sessions SET omp_session_file = ? WHERE id = ?")
            .run(sessionFile, sessionId).changes,
          1,
          "session file update",
        );
      });
    },

    appendDelta(assistantMessageId, delta) {
      assertOpen(closed);
      const turn = currentTurn(activeTurns, activeSessions, assistantMessageId);
      if (turn === undefined) {
        return false;
      }
      if (turn.faulted) {
        throw turn.fault;
      }
      if (delta.length === 0) {
        return true;
      }
      turn.progress = true;
      turn.pending.push(delta);
      turn.pendingBytes += Buffer.byteLength(delta, "utf8");
      if (turn.pendingBytes >= FLUSH_BYTES) {
        flushPending(db, turn);
      } else {
        armFlushTimer(db, turn, activeTurns, options.onFlushError);
      }
      return true;
    },

    appendThinking(messageId, chunk) {
      assertOpen(closed);
      return appendThinkingText(db, messageId, chunk);
    },

    startStep(assistantMessageId, input) {
      assertOpen(closed);
      const turn = currentTurn(activeTurns, activeSessions, assistantMessageId);
      if (turn === undefined) {
        throw new HttpError("not_found");
      }
      turn.progress = true;
      const now = Date.now();
      const stepId = runOwnedTransaction(db, "step start rollback failed", () => {
        const receipt = db
          .prepare(
            `INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at)
           SELECT ?, ?, ?, ?, 'running', ?
           WHERE EXISTS (
             SELECT 1 FROM chat_messages
             WHERE id = ? AND session_id = ? AND role = 'assistant' AND status = 'running'
           )`,
          )
          .run(
            turn.assistantMessageId,
            input.ordinal,
            input.name,
            input.detail,
            now,
            turn.assistantMessageId,
            turn.sessionId,
          );
        requireChanges(receipt.changes, 1, "step insert");
        return Number(receipt.lastInsertRowid);
      });
      activeSteps.set(stepId, turn.assistantMessageId);
      return stepId;
    },

    setStepChanges(stepId, json) {
      assertOpen(closed);
      setStepChangesText(db, stepId, json);
    },

    finishStep(stepId, status, output) {
      assertOpen(closed);
      const assistantMessageId = activeSteps.get(stepId);
      if (assistantMessageId === undefined) {
        return false;
      }
      const turn = currentTurn(activeTurns, activeSessions, assistantMessageId);
      if (turn === undefined) {
        activeSteps.delete(stepId);
        return false;
      }
      const changed = runOwnedTransaction(db, "step finish rollback failed", () => {
        const receipt = db
          .prepare(
            `UPDATE chat_steps
           SET status = ?, output = ?, ended_at = ?
           WHERE id = ? AND message_id = ? AND status = 'running'`,
          )
          .run(status, output, Date.now(), stepId, turn.assistantMessageId);
        requireAtMostOne(receipt.changes, "step finish");
        return hasChanges(receipt.changes);
      });
      activeSteps.delete(stepId);
      return changed;
    },

    finishTurn(assistantMessageId, status, settled) {
      assertOpen(closed);
      const turn = currentTurn(activeTurns, activeSessions, assistantMessageId);
      if (turn === undefined) {
        return false;
      }
      const entries = finish(turn, status);
      settled?.push(...entries);
      return true;
    },

    reconcileOnStartup() {
      assertOpen(closed);
      if (activeTurns.size > 0) {
        throw new Error("cannot reconcile while a turn is active");
      }
      const now = Date.now();
      runOwnedTransaction(db, "startup reconciliation rollback failed", () => {
        reconcileRunning(db, options.emit, now);
      });
    },

    insertApproval(sessionId, input, requestedAt) {
      assertOpen(closed);
      const assistantMessageId = activeSessions.get(sessionId);
      if (assistantMessageId === undefined) {
        throw new HttpError("not_found");
      }
      return insertPendingApproval(db, sessionId, assistantMessageId, input, requestedAt);
    },

    settleApproval(sessionId, approvalId, decision, decidedAt) {
      assertOpen(closed);
      return settlePendingApproval(db, options.emit, {
        sessionId,
        approvalId,
        decision,
        decidedAt,
      });
    },

    attachmentPaths: (sessionId) => readAttachmentPaths(db, sessionId),

    runtimeState(sessionId) {
      const decoder = createSqliteTextDecoder(db);
      const row = db
        .prepare(
          `SELECT owner_id, CAST(omp_session_file AS BLOB) AS omp_session_file, stream_epoch, workspace_id, ${COMPOSER_COLUMNS} FROM chat_sessions WHERE id = ? LIMIT 1`,
        )
        .get(sessionId) as unknown as RuntimeDbRow | undefined;
      if (row === undefined) {
        return null;
      }
      const assistantMessageId = activeSessions.get(sessionId);
      const turn =
        assistantMessageId === undefined ? undefined : activeTurns.get(assistantMessageId);
      return {
        ownerId: row.owner_id,
        ompSessionFile: decodeNullableText(decoder, row.omp_session_file),
        streamEpoch: Number(row.stream_epoch),
        activeTurn:
          turn === undefined
            ? null
            : { userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId },
        workspaceId: row.workspace_id,
        composer: rawComposer(row),
      };
    },

    turnReleased(sessionId) {
      const assistantMessageId = activeSessions.get(sessionId);
      const turn =
        assistantMessageId === undefined ? undefined : activeTurns.get(assistantMessageId);
      if (turn === undefined) {
        return Promise.resolve();
      }
      return turn.faulted ? Promise.reject(turn.fault) : turn.released;
    },

    faultTurn(assistantMessageId, error) {
      const turn = activeTurns.get(assistantMessageId);
      if (turn !== undefined && !turn.faulted) {
        faultTurnSignal(turn, error);
      }
    },

    close() {
      if (closed) {
        return;
      }
      const turns = [...activeTurns.values()];
      for (const turn of turns) {
        cancelTimer(turn);
      }
      for (const turn of turns) {
        finish(turn, "failed");
      }
      closed = true;
    },
  };
}

function assertOpen(closed: boolean): void {
  if (closed) {
    throw new Error("session store is closed");
  }
}

function openTurn(
  admitted: ReturnType<typeof replaceLastAssistant> & { sessionId: string },
  progress: boolean,
  activeTurns: Map<number, Turn>,
  activeSessions: Map<string, number>,
): Turn {
  const turn: Turn = {
    ...admitted,
    pending: [],
    pendingBytes: 0,
    progress,
    titleTouched: false,
    timer: undefined,
    timerGeneration: 0,
    faulted: false,
    fault: undefined,
    notified: false,
    ...turnSignal(),
  };
  activeTurns.set(turn.assistantMessageId, turn);
  activeSessions.set(turn.sessionId, turn.assistantMessageId);
  return turn;
}

function currentTurn(
  activeTurns: Map<number, Turn>,
  activeSessions: Map<string, number>,
  assistantMessageId: number,
): Turn | undefined {
  const turn = activeTurns.get(assistantMessageId);
  if (turn === undefined || activeSessions.get(turn.sessionId) !== assistantMessageId) {
    return undefined;
  }
  return turn;
}

function armFlushTimer(
  db: DatabaseSync,
  turn: Turn,
  activeTurns: Map<number, Turn>,
  onFlushError: (failure: FlushError) => void,
): void {
  if (turn.timer !== undefined || turn.pendingBytes === 0 || turn.faulted) {
    return;
  }
  turn.timerGeneration += 1;
  const generation = turn.timerGeneration;
  turn.timer = setTimeout(() => {
    if (activeTurns.get(turn.assistantMessageId) !== turn || turn.timerGeneration !== generation) {
      return;
    }
    turn.timer = undefined;
    try {
      flushPending(db, turn);
    } catch (error) {
      if (!turn.notified) {
        turn.notified = true;
        onFlushError({
          sessionId: turn.sessionId,
          assistantMessageId: turn.assistantMessageId,
          error,
        });
      }
    }
  }, FLUSH_MS);
}
