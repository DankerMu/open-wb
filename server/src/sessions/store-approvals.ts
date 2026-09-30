import type { DatabaseSync } from "node:sqlite";
import type { emit as auditEmit } from "../core/audit/index.js";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { HttpError } from "../core/errors/index.js";
import type {
  ApprovalEntry,
  ApprovalInput,
  ApprovalOutcome,
  ApprovalView,
  FinishStatus,
  PendingApproval,
  SettledApproval,
  Turn,
} from "./store.js";
import { countRows, hasChanges, requireChanges, runOwnedTransaction } from "./store-branch.js";

const APPROVAL_TTL_MS = 60_000;
const AUDIT_TITLE = "工具执行审批";

type ApprovalDbRow = {
  id: number;
  message_id: number;
  session_id: string;
  owner_id: string;
  tool: Uint8Array;
  title: Uint8Array;
  requested_at: number;
  expires_at: number;
};

type SnapshotApprovalDbRow = {
  id: number;
  message_id: number;
  tool: Uint8Array;
  title: Uint8Array;
  requested_at: number;
  expires_at: number;
  decision: ApprovalOutcome | null;
};

type PendingDbRow = Pick<ApprovalDbRow, "id" | "session_id" | "owner_id" | "tool">;

interface Settlement {
  sessionId: string;
  approvalId: number;
  decision: ApprovalOutcome;
  decidedAt: number;
}

/** Inserts a pending row only while that session's assistant message is still running. */
export function insertPendingApproval(
  db: DatabaseSync,
  sessionId: string,
  assistantMessageId: number,
  input: ApprovalInput,
  requestedAt: number,
): PendingApproval {
  const expiresAt = requestedAt + APPROVAL_TTL_MS;
  const approvalId = runOwnedTransaction(db, "approval insert rollback failed", () => {
    const receipt = db
      .prepare(
        `INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM chat_messages
           WHERE id = ? AND session_id = ? AND role = 'assistant' AND status = 'running'
         )`,
      )
      .run(
        assistantMessageId,
        input.requestId,
        input.tool,
        input.title,
        requestedAt,
        expiresAt,
        assistantMessageId,
        sessionId,
      );
    requireChanges(receipt.changes, 1, "approval insert");
    return Number(receipt.lastInsertRowid);
  });
  return { approvalId, messageId: assistantMessageId, expiresAt };
}

/**
 * Snapshot projection: every approval row of the session's assistant messages, keyed by message
 * and in ascending id order. User messages never carry rows here, whatever the table holds.
 */
export function approvalsBySession(
  db: DatabaseSync,
  sessionId: string,
  decoder: TextDecoder,
): Map<number, ApprovalEntry[]> {
  const rows = db
    .prepare(
      `SELECT a.id, a.message_id, CAST(a.tool AS BLOB) AS tool, CAST(a.title AS BLOB) AS title,
              a.requested_at, a.expires_at, a.decision
         FROM chat_approvals AS a
         JOIN chat_messages AS m ON m.id = a.message_id
        WHERE m.session_id = ? AND m.role = 'assistant'
        ORDER BY a.id ASC`,
    )
    .all(sessionId) as unknown as SnapshotApprovalDbRow[];
  const byMessage = new Map<number, ApprovalEntry[]>();
  for (const row of rows) {
    const messageId = Number(row.message_id);
    const entry: ApprovalEntry = {
      id: Number(row.id),
      tool: decoder.decode(row.tool),
      title: decoder.decode(row.title),
      requestedAt: Number(row.requested_at),
      expiresAt: Number(row.expires_at),
      decision: row.decision,
    };
    const current = byMessage.get(messageId);
    if (current === undefined) {
      byMessage.set(messageId, [entry]);
    } else {
      current.push(entry);
    }
  }
  return byMessage;
}

/**
 * One owned transaction: ownership check, `decision IS NULL` compare-and-set, then the
 * session.approval audit row. A CAS miss returns null and writes nothing; a missing emit or a
 * failing audit rolls the decision back, so no decision ever exists without its audit row.
 */
export function settlePendingApproval(
  db: DatabaseSync,
  emit: typeof auditEmit | undefined,
  settlement: Settlement,
): ApprovalView | null {
  const { sessionId, approvalId, decision, decidedAt } = settlement;
  return runOwnedTransaction(db, "approval settlement rollback failed", () => {
    const row = db
      .prepare(
        `SELECT a.id, a.message_id, m.session_id, s.owner_id, CAST(a.tool AS BLOB) AS tool,
                CAST(a.title AS BLOB) AS title, a.requested_at, a.expires_at
           FROM chat_approvals AS a
           JOIN chat_messages AS m ON m.id = a.message_id
           JOIN chat_sessions AS s ON s.id = m.session_id
          WHERE a.id = ?`,
      )
      .get(approvalId) as unknown as ApprovalDbRow | undefined;
    if (row === undefined || row.session_id !== sessionId) {
      throw new HttpError("not_found");
    }
    const receipt = db
      .prepare(
        "UPDATE chat_approvals SET decision = ?, decided_at = ? WHERE id = ? AND decision IS NULL",
      )
      .run(decision, decidedAt, approvalId);
    if (!hasChanges(receipt.changes)) {
      return null;
    }
    if (emit === undefined) {
      throw new Error("approval settlement requires an audit emit");
    }
    const decoder = createSqliteTextDecoder(db);
    const tool = decoder.decode(row.tool);
    const messageId = Number(row.message_id);
    emit(db, {
      kind: "session.approval",
      actorId: row.owner_id,
      title: AUDIT_TITLE,
      detail: { sessionId, messageId, tool, decision },
    });
    return {
      id: Number(row.id),
      tool,
      title: decoder.decode(row.title),
      requestedAt: Number(row.requested_at),
      expiresAt: Number(row.expires_at),
      decision,
    };
  });
}

export function cancelTimer(turn: Turn): void {
  turn.timerGeneration += 1;
  if (turn.timer !== undefined) {
    clearTimeout(turn.timer);
    turn.timer = undefined;
  }
}

/** Appends the turn's buffered deltas; a failure faults the turn (and its release signal). */
export function flushPending(db: DatabaseSync, turn: Turn): void {
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
    faultTurnSignal(turn, error);
    throw error;
  }
  turn.pending = [];
  turn.pendingBytes = 0;
  turn.faulted = false;
  turn.fault = undefined;
  cancelTimer(turn);
}

/** The Turn's one-shot release signal (#526); a rejection nobody awaits is consumed here. */
export function turnSignal(): Pick<Turn, "released" | "release" | "fail"> {
  let release!: () => void;
  let fail!: (error: unknown) => void;
  const released = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  released.catch(() => undefined);
  return { released, release, fail };
}

/** Marks the turn faulted with `error` and rejects its release signal (no-op once settled). */
export function faultTurnSignal(turn: Turn, error: unknown): void {
  turn.faulted = true;
  turn.fault = error;
  turn.fail(error);
}

/**
 * Non-answer settlement inside the caller's owned transaction: each NULL row of the message, in
 * id order, becomes `deny` with its audit row. Only when rows exist does a missing emit throw.
 */
function settlePendingForMessage(
  db: DatabaseSync,
  emit: typeof auditEmit | undefined,
  messageId: number,
  decision: "deny",
  decidedAt: number,
): SettledApproval[] {
  const rows = db
    .prepare(
      `SELECT a.id, m.session_id, s.owner_id, CAST(a.tool AS BLOB) AS tool
         FROM chat_approvals AS a
         JOIN chat_messages AS m ON m.id = a.message_id
         JOIN chat_sessions AS s ON s.id = m.session_id
        WHERE a.message_id = ? AND a.decision IS NULL
        ORDER BY a.id ASC`,
    )
    .all(messageId) as unknown as PendingDbRow[];
  if (rows.length === 0) {
    return [];
  }
  if (emit === undefined) {
    throw new Error("terminal approval settlement requires an audit emit");
  }
  const decoder = createSqliteTextDecoder(db);
  const settled: SettledApproval[] = [];
  for (const row of rows) {
    const approvalId = Number(row.id);
    requireChanges(
      db
        .prepare(
          "UPDATE chat_approvals SET decision = ?, decided_at = ? WHERE id = ? AND decision IS NULL",
        )
        .run(decision, decidedAt, approvalId).changes,
      1,
      "terminal approval settlement",
    );
    emit(db, {
      kind: "session.approval",
      actorId: row.owner_id,
      title: AUDIT_TITLE,
      detail: { sessionId: row.session_id, messageId, tool: decoder.decode(row.tool), decision },
    });
    settled.push({ messageId, approvalId, decision });
  }
  return settled;
}

/** Terminal flip and pending-approval `deny` in one transaction; the settled rows once committed. */
export function finishOwnedTurn(
  db: DatabaseSync,
  emit: typeof auditEmit | undefined,
  turn: Turn,
  status: FinishStatus,
  activeTurns: Map<number, Turn>,
  activeSessions: Map<string, number>,
  activeSteps: Map<number, number>,
): SettledApproval[] {
  turn.progress = true;
  cancelTimer(turn);
  const content = turn.pending.length === 0 ? undefined : turn.pending.join("");
  const now = Date.now();
  let settled: SettledApproval[];
  try {
    settled = runOwnedTransaction(db, "turn finish rollback failed", () => {
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
      return settlePendingForMessage(db, emit, turn.assistantMessageId, "deny", now);
    });
  } catch (error) {
    faultTurnSignal(turn, error);
    throw error;
  }
  turn.pending = [];
  turn.pendingBytes = 0;
  releaseTurn(turn, activeTurns, activeSessions, activeSteps);
  return settled;
}

export function releaseTurn(
  turn: Turn,
  activeTurns: Map<number, Turn>,
  activeSessions: Map<string, number>,
  activeSteps: Map<number, number>,
): void {
  cancelTimer(turn);
  turn.release();
  activeTurns.delete(turn.assistantMessageId);
  activeSessions.delete(turn.sessionId);
  for (const [stepId, assistantMessageId] of activeSteps) {
    if (assistantMessageId === turn.assistantMessageId) {
      activeSteps.delete(stepId);
    }
  }
}

/** Startup reconciliation (caller's transaction): deny running messages' approvals, then flip. */
export function reconcileRunning(
  db: DatabaseSync,
  emit: typeof auditEmit | undefined,
  decidedAt: number,
): void {
  const running = db
    .prepare(
      "SELECT id FROM chat_messages WHERE role = 'assistant' AND status = 'running' ORDER BY id",
    )
    .all() as Array<{ id: number }>;
  for (const message of running) {
    settlePendingForMessage(db, emit, Number(message.id), "deny", decidedAt);
  }
  reconcileStatuses(db, "chat_sessions");
  reconcileStatuses(db, "chat_messages");
  reconcileStatuses(db, "chat_steps");
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
