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

export function finishOwnedTurn(
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

export function releaseTurn(
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

export function reconcileStatuses(
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
