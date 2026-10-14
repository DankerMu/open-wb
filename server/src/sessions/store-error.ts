/**
 * Issue #909 the three error columns of an assistant message (upstream-failure「迁移 043 消息错误列」
 * 「失败的公开形状」, design D13 / D14). `recordError` writes them with one UPDATE before the `error`
 * event is published (落库先于发布): `persistEvent` sanitises `detail` first, so this module never
 * sees raw upstream text. Reading them for the snapshot (`messageError`), the fork copy and the
 * regenerate delete live with the other message-row work in store-branch.ts; startup reconciliation
 * never writes them, so a turn it settles as `failed` keeps whatever it already had (NULL unless the
 * `error` was stored just before a crash).
 */
import type { DatabaseSync } from "node:sqlite";
import { requireChanges } from "./store-branch.js";
import type { FailureReason } from "./upstream-classify.js";

/** What one failed turn stores: the classification and the sanitised detail. */
interface StoredFailure {
  reason: FailureReason;
  status: number | null;
  detail: string;
}

/** The snapshot's `error` object: the stored failure and its sentence. */
export interface MessageError extends StoredFailure {
  message: string;
}

export interface SessionErrorStore {
  /** The three columns of the assistant row, in one UPDATE; throws off exactly one row. */
  recordError(assistantMessageId: number, failure: StoredFailure): void;
}

const RECORD_ERROR =
  "UPDATE chat_messages SET error_reason = ?, error_status = ?, error_detail = ? WHERE id = ?";

export function createSessionErrorStore(db: DatabaseSync): SessionErrorStore {
  return {
    recordError(assistantMessageId, { reason, status, detail }) {
      requireChanges(
        db.prepare(RECORD_ERROR).run(reason, status, detail, assistantMessageId).changes,
        1,
        "message error",
      );
    },
  };
}
