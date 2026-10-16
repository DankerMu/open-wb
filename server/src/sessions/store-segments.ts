/**
 * Issue 1471 segment positions (chat-interleaved-segments design D1/D2/D16): the step insert moved
 * out of store.ts. `chat_steps.body_offset` is written by the same INSERT that creates the step row,
 * so the row never exists without it and a failed insert leaves neither. Its value is the turn's
 * published body length (`Turn.publishedLength`, UTF-16 code units of every delta `appendDelta`
 * took, pending ones included), never the stored `content` length, which lacks the pending deltas.
 */
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import type { Turn } from "./store.js";
import { requireChanges, runOwnedTransaction } from "./store-branch.js";

export interface StartStepInput {
  ordinal: number;
  name: string;
  detail: string;
}

const INSERT_STEP = `INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, body_offset)
           SELECT ?, ?, ?, ?, 'running', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM chat_messages
             WHERE id = ? AND session_id = ? AND role = 'assistant' AND status = 'running'
           )`;

/** Inserts the running step row of the current `turn` (not_found without one); the new step id. */
export function startStep(
  db: DatabaseSync,
  turn: Turn | undefined,
  activeSteps: Map<number, number>,
  input: StartStepInput,
): number {
  if (turn === undefined) {
    throw new HttpError("not_found");
  }
  turn.progress = true;
  const now = Date.now();
  const stepId = runOwnedTransaction(db, "step start rollback failed", () => {
    const receipt = db
      .prepare(INSERT_STEP)
      .run(
        turn.assistantMessageId,
        input.ordinal,
        input.name,
        input.detail,
        now,
        turn.publishedLength,
        turn.assistantMessageId,
        turn.sessionId,
      );
    requireChanges(receipt.changes, 1, "step insert");
    return Number(receipt.lastInsertRowid);
  });
  activeSteps.set(stepId, turn.assistantMessageId);
  return stepId;
}
