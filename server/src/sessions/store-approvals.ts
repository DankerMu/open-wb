import type { DatabaseSync } from "node:sqlite";
import type { FinishStatus, Turn } from "./store.js";
import { countRows, requireChanges, runOwnedTransaction } from "./store-branch.js";

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
