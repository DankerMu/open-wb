import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";

type SessionStatus = "idle" | "running" | "done" | "failed";
type MessageRole = "user" | "assistant";
type MessageStatus = "done" | "running" | "failed";
type StepStatus = "running" | "done" | "failed";
type FinishStatus = "done" | "failed";

interface SessionView {
  id: string;
  title: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

interface StepView {
  id: number;
  ordinal: number;
  name: string;
  detail: string;
  status: StepStatus;
  startedAt: number;
  endedAt: number | null;
}

interface MessageView {
  id: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
  steps: StepView[];
}

interface SessionMessageTree {
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
}

interface FlushError {
  sessionId: string;
  assistantMessageId: number;
  error: unknown;
}

export interface SessionStoreOptions {
  onFlushError: (failure: FlushError) => void;
}

interface StartStepInput {
  ordinal: number;
  name: string;
  detail: string;
}

export interface SessionStore {
  create(ownerId: string): SessionView;
  list(ownerId: string): SessionView[];
  getMessages(sessionId: string, ownerId: string): SessionMessageTree | null;
  acceptPrompt(sessionId: string, ownerId: string, text: string): AcceptedPrompt;
  rollbackPrompt(assistantMessageId: number): boolean;
  bumpStreamEpoch(sessionId: string): number;
  setSessionFile(sessionId: string, sessionFile: string | null): void;
  appendDelta(assistantMessageId: number, delta: string): boolean;
  startStep(assistantMessageId: number, input: StartStepInput): number;
  finishStep(stepId: number, status: FinishStatus, detail?: string): boolean;
  finishTurn(assistantMessageId: number, status: FinishStatus): boolean;
  reconcileOnStartup(): void;
  runtimeState(sessionId: string): SessionRuntimeState | null;
  close(): void;
}

type SessionDbRow = {
  id: string;
  owner_id: string;
  title: string | null;
  status: SessionStatus;
  omp_session_file: string | null;
  stream_epoch: number;
  created_at: number;
  updated_at: number;
};

type MessageDbRow = {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  created_at: number;
};

type StepDbRow = {
  id: number;
  message_id: number;
  ordinal: number;
  name: string;
  detail: string;
  status: StepStatus;
  started_at: number;
  ended_at: number | null;
};

type RuntimeDbRow = {
  owner_id: string;
  omp_session_file: string | null;
  stream_epoch: number;
};

type Turn = {
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
  timer: NodeJS.Timeout | undefined;
  timerGeneration: number;
  faulted: boolean;
  fault: unknown;
  notified: boolean;
};

const FLUSH_BYTES = 2_048;
const FLUSH_MS = 2_000;
const SESSION_COLUMNS =
  "id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at";
const MESSAGE_COLUMNS = "id, session_id, role, content, status, created_at";
const STEP_COLUMNS = "id, message_id, ordinal, name, detail, status, started_at, ended_at";
const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at) VALUES (?, ?, NULL, 'idle', ?, ?)";
const INSERT_MESSAGE =
  "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?)";

export function createSessionStore(db: DatabaseSync, options: SessionStoreOptions): SessionStore {
  const activeTurns = new Map<number, Turn>();
  const activeSessions = new Map<string, number>();
  const activeSteps = new Map<number, number>();
  let closed = false;

  return {
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
      return { id, title: null, status: "idle", createdAt: now, updatedAt: now };
    },

    list(ownerId) {
      const rows = db
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE owner_id = ? ORDER BY updated_at DESC, id ASC`,
        )
        .all(ownerId) as unknown as SessionDbRow[];
      const listed: SessionView[] = [];
      for (const row of rows) {
        listed.push(toSessionView(row));
      }
      return listed;
    },

    getMessages(sessionId, ownerId) {
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
          `SELECT s.${STEP_COLUMNS.replaceAll(", ", ", s.")} FROM chat_steps AS s
         JOIN chat_messages AS m ON m.id = s.message_id
         WHERE m.session_id = ? ORDER BY s.ordinal ASC, s.id ASC`,
        )
        .all(sessionId) as unknown as StepDbRow[];
      const stepsByMessage = new Map<number, StepView[]>();
      for (const step of steps) {
        const current = stepsByMessage.get(step.message_id);
        const view = toStepView(step);
        if (current === undefined) {
          stepsByMessage.set(step.message_id, [view]);
        } else {
          current.push(view);
        }
      }
      const views: MessageView[] = [];
      for (const message of messages) {
        views.push({ ...toMessageView(message), steps: stepsByMessage.get(message.id) ?? [] });
      }
      return { session: toSessionView(session), messages: views };
    },

    acceptPrompt(sessionId, ownerId, text) {
      assertOpen(closed);
      const now = Date.now();
      const accepted = runOwnedTransaction(db, "prompt admission rollback failed", () => {
        const session = db
          .prepare(
            "SELECT id, owner_id, title, status, updated_at FROM chat_sessions WHERE id = ? LIMIT 1",
          )
          .get(sessionId) as unknown as
          | Pick<SessionDbRow, "id" | "owner_id" | "title" | "status" | "updated_at">
          | undefined;
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
        const title = session.title === null ? titlePrefix(text) : session.title;
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
          previousTitle: session.title,
          previousUpdatedAt: Number(session.updated_at),
        };
      });
      const turn: Turn = {
        sessionId,
        ownerId,
        userMessageId: accepted.userMessageId,
        assistantMessageId: accepted.assistantMessageId,
        previousStatus: accepted.previousStatus,
        previousTitle: accepted.previousTitle,
        previousUpdatedAt: accepted.previousUpdatedAt,
        pending: [],
        pendingBytes: 0,
        progress: false,
        timer: undefined,
        timerGeneration: 0,
        faulted: false,
        fault: undefined,
        notified: false,
      };
      activeTurns.set(turn.assistantMessageId, turn);
      activeSessions.set(turn.sessionId, turn.assistantMessageId);
      return { userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId };
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
            .prepare("UPDATE chat_sessions SET status = ?, title = ?, updated_at = ? WHERE id = ?")
            .run(turn.previousStatus, turn.previousTitle, turn.previousUpdatedAt, turn.sessionId)
            .changes,
          1,
          "session rollback restore",
        );
      });
      releaseTurn(turn, activeTurns, activeSessions, activeSteps);
      return true;
    },

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
          .get(sessionId) as { stream_epoch: number } | undefined;
        if (row === undefined) {
          throw new HttpError("not_found");
        }
        return Number(row.stream_epoch);
      });
    },

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

    finishStep(stepId, status, detail) {
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
           SET status = ?, detail = COALESCE(?, detail), ended_at = ?
           WHERE id = ? AND message_id = ? AND status = 'running'`,
          )
          .run(status, detail ?? null, Date.now(), stepId, turn.assistantMessageId);
        requireAtMostOne(receipt.changes, "step finish");
        return hasChanges(receipt.changes);
      });
      if (!changed) {
        activeSteps.delete(stepId);
        return false;
      }
      activeSteps.delete(stepId);
      return true;
    },

    finishTurn(assistantMessageId, status) {
      assertOpen(closed);
      const turn = currentTurn(activeTurns, activeSessions, assistantMessageId);
      if (turn === undefined) {
        return false;
      }
      finishOwnedTurn(db, turn, status, activeTurns, activeSessions, activeSteps);
      return true;
    },

    reconcileOnStartup() {
      assertOpen(closed);
      if (activeTurns.size > 0) {
        throw new Error("cannot reconcile while a turn is active");
      }
      runOwnedTransaction(db, "startup reconciliation rollback failed", () => {
        reconcileStatuses(db, "chat_sessions");
        reconcileStatuses(db, "chat_messages");
        reconcileStatuses(db, "chat_steps");
      });
    },

    runtimeState(sessionId) {
      const row = db
        .prepare(
          "SELECT owner_id, omp_session_file, stream_epoch FROM chat_sessions WHERE id = ? LIMIT 1",
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
        ompSessionFile: row.omp_session_file,
        streamEpoch: Number(row.stream_epoch),
        activeTurn:
          turn === undefined
            ? null
            : { userMessageId: turn.userMessageId, assistantMessageId: turn.assistantMessageId },
      };
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
        finishOwnedTurn(db, turn, "failed", activeTurns, activeSessions, activeSteps);
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

function toSessionView(row: SessionDbRow): SessionView {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toMessageView(row: MessageDbRow): Omit<MessageView, "steps"> {
  return {
    id: Number(row.id),
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: Number(row.created_at),
  };
}

function toStepView(row: StepDbRow): StepView {
  return {
    id: Number(row.id),
    ordinal: Number(row.ordinal),
    name: row.name,
    detail: row.detail,
    status: row.status,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  };
}

function titlePrefix(text: string): string {
  let end = 0;
  let count = 0;
  for (const character of text) {
    end += character.length;
    count += 1;
    if (count === 18) {
      return text.slice(0, end);
    }
  }
  return text;
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

function cancelTimer(turn: Turn): void {
  turn.timerGeneration += 1;
  if (turn.timer !== undefined) {
    clearTimeout(turn.timer);
    turn.timer = undefined;
  }
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

function flushPending(db: DatabaseSync, turn: Turn): void {
  if (turn.pending.length === 0) {
    return;
  }
  const content = turn.pending.join("");
  try {
    runOwnedTransaction(db, "delta flush rollback failed", () => {
      requireChanges(
        db
          .prepare(
            "UPDATE chat_messages SET content = content || ? WHERE id = ? AND session_id = ? AND status = 'running'",
          )
          .run(content, turn.assistantMessageId, turn.sessionId).changes,
        1,
        "delta flush",
      );
    });
  } catch (error) {
    cancelTimer(turn);
    turn.faulted = true;
    turn.fault = error;
    throw error;
  }
  turn.pending = [];
  turn.pendingBytes = 0;
  turn.faulted = false;
  turn.fault = undefined;
  cancelTimer(turn);
}

function finishOwnedTurn(
  db: DatabaseSync,
  turn: Turn,
  status: FinishStatus,
  activeTurns: Map<number, Turn>,
  activeSessions: Map<string, number>,
  activeSteps: Map<number, number>,
): void {
  turn.progress = true;
  cancelTimer(turn);
  const content = turn.pending.length === 0 ? undefined : turn.pending.join("");
  const now = Date.now();
  try {
    runOwnedTransaction(db, "turn finish rollback failed", () => {
      if (content !== undefined) {
        requireChanges(
          db
            .prepare(
              "UPDATE chat_messages SET content = content || ? WHERE id = ? AND session_id = ? AND status = 'running'",
            )
            .run(content, turn.assistantMessageId, turn.sessionId).changes,
          1,
          "terminal content flush",
        );
      }
      requireChanges(
        db
          .prepare(
            "UPDATE chat_messages SET status = ? WHERE id = ? AND session_id = ? AND status = 'running'",
          )
          .run(status, turn.assistantMessageId, turn.sessionId).changes,
        1,
        "assistant terminal status",
      );
      requireChanges(
        db
          .prepare(
            "UPDATE chat_sessions SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'",
          )
          .run(status, now, turn.sessionId).changes,
        1,
        "session terminal status",
      );
      const runningSteps = countRows(
        db,
        "SELECT COUNT(*) AS count FROM chat_steps WHERE message_id = ? AND status = 'running'",
        turn.assistantMessageId,
      );
      requireChanges(
        db
          .prepare(
            "UPDATE chat_steps SET status = ?, ended_at = ? WHERE message_id = ? AND status = 'running'",
          )
          .run(status, now, turn.assistantMessageId).changes,
        runningSteps,
        "remaining step settlement",
      );
    });
  } catch (error) {
    turn.faulted = true;
    turn.fault = error;
    throw error;
  }
  turn.pending = [];
  turn.pendingBytes = 0;
  releaseTurn(turn, activeTurns, activeSessions, activeSteps);
}

function releaseTurn(
  turn: Turn,
  activeTurns: Map<number, Turn>,
  activeSessions: Map<string, number>,
  activeSteps: Map<number, number>,
): void {
  cancelTimer(turn);
  activeTurns.delete(turn.assistantMessageId);
  activeSessions.delete(turn.sessionId);
  for (const [stepId, assistantMessageId] of activeSteps) {
    if (assistantMessageId === turn.assistantMessageId) {
      activeSteps.delete(stepId);
    }
  }
}

function reconcileStatuses(
  db: DatabaseSync,
  table: "chat_sessions" | "chat_messages" | "chat_steps",
): void {
  const running = countRows(db, `SELECT COUNT(*) AS count FROM ${table} WHERE status = 'running'`);
  requireChanges(
    db.prepare(`UPDATE ${table} SET status = 'failed' WHERE status = 'running'`).run().changes,
    running,
    `${table} startup reconciliation`,
  );
}

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { count: number | bigint } | undefined;
  if (row === undefined) {
    throw new Error("count query returned no row");
  }
  return Number(row.count);
}

function hasChanges(changes: number | bigint): boolean {
  return changes === 1 || changes === 1n;
}

function requireAtMostOne(changes: number | bigint, operation: string): void {
  if (changes !== 0 && changes !== 0n && !hasChanges(changes)) {
    throw new Error(`${operation} must change at most one row`);
  }
}

function requireChanges(changes: number | bigint, expected: number, operation: string): void {
  if (changes !== expected && changes !== BigInt(expected)) {
    throw new Error(`${operation} must change exactly ${expected} row${expected === 1 ? "" : "s"}`);
  }
}

function runOwnedTransaction<T>(
  db: DatabaseSync,
  rollbackFailureMessage: string,
  work: () => T,
): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    rollbackOwnedTransaction(db, error, rollbackFailureMessage);
    throw error;
  }
}

function rollbackOwnedTransaction(db: DatabaseSync, originalError: unknown, message: string): void {
  if (!db.isTransaction) {
    return;
  }
  try {
    db.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError([originalError, rollbackError], message, { cause: originalError });
  }
}
