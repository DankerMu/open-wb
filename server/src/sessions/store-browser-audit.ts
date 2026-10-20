/**
 * Issue #1568 (omp-pin-18-12 design D7): the step-end transaction moved out of store.ts, plus the
 * `session.browser` audit of an `eval` step (browser-runtime「浏览器调用审计」). omp v18.12.3 drives
 * its browser from the `eval` prelude; the reducer derives the calls from the end frame's
 * `details.statusEvents` (events.ts) and they are audited in the transaction that writes the step's
 * end, so without the audit (no emit, a failed write) the end is not stored and the caller publishes
 * nothing. It is the only `session.browser` writer since #1570 deleted the #1526 step.start one.
 */
import type { DatabaseSync } from "node:sqlite";
import type { emit as auditEmit } from "../core/audit/index.js";
import type { Turn } from "./store.js";
import { hasChanges, requireAtMostOne, runOwnedTransaction } from "./store-branch.js";

/** The reducer's `browser` field of an `eval` step.end: never stored in chat_steps or published. */
export interface EvalBrowserAudit {
  calls: Array<{ detail: string | null; error: string | null }>;
  /** omp's `statusEventsElided`, a positive integer, or null. */
  elided: number | null;
}

const FINISH_STEP = `UPDATE chat_steps SET status = ?, output = ?, ended_at = ?
           WHERE id = ? AND message_id = ? AND status = 'running'`;

/**
 * Ends the running step of the current `turn` (false without one, or when the row is no longer
 * running); with `browser`, the owner's `session.browser` rows go in the same transaction.
 */
export function finishStep(
  db: DatabaseSync,
  turn: Turn | undefined,
  activeSteps: Map<number, number>,
  step: { stepId: number; status: "done" | "failed"; output: string },
  browser: EvalBrowserAudit | undefined,
  emit: typeof auditEmit | undefined,
): boolean {
  const { stepId, status, output } = step;
  if (turn === undefined) {
    activeSteps.delete(stepId);
    return false;
  }
  const changed = runOwnedTransaction(db, "step finish rollback failed", () => {
    const receipt = db
      .prepare(FINISH_STEP)
      .run(status, output, Date.now(), stepId, turn.assistantMessageId);
    requireAtMostOne(receipt.changes, "step finish");
    const written = hasChanges(receipt.changes);
    if (written && browser !== undefined) {
      auditEvalBrowser(db, emit, turn, stepId, browser);
    }
    return written;
  });
  activeSteps.delete(stepId);
  return changed;
}

/** In the caller's transaction: one row per call, then the elided count; throws without an emit. */
function auditEvalBrowser(
  db: DatabaseSync,
  emit: typeof auditEmit | undefined,
  turn: Turn,
  stepId: number,
  { calls, elided }: EvalBrowserAudit,
): void {
  if (emit === undefined) {
    throw new Error("eval browser step requires an audit emit");
  }
  const base = { sessionId: turn.sessionId, messageId: turn.assistantMessageId, stepId };
  const details: object[] = calls.map(({ detail, error }) => ({ ...base, detail, error }));
  if (elided !== null) {
    details.push({ ...base, elided });
  }
  for (const detail of details) {
    emit(db, { kind: "session.browser", actorId: turn.ownerId, title: "浏览器操作", detail });
  }
}
