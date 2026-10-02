/**
 * Issue #522 file-change write (turn-artifacts「文件变更推导与归属」): `chat_steps.changes` takes the
 * JSON array text of a step's owned files, and only while that step row is still `running`. A
 * step settled before its tool end frame arrived therefore keeps NULL, and a write that does not
 * hit exactly one row throws, so the supervisor publishes no `files.changed` for it.
 */
import type { DatabaseSync } from "node:sqlite";
import { requireChanges } from "./store-branch.js";

const SET_CHANGES = "UPDATE chat_steps SET changes = ? WHERE id = ? AND status = 'running'";

export function setStepChanges(db: DatabaseSync, stepId: number, json: string): void {
  requireChanges(db.prepare(SET_CHANGES).run(json, stepId).changes, 1, "step changes");
}
