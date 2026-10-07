/**
 * Snapshot registration rows (#942, design D9「登记」of s1f-session-list-temp-space; spec
 * workspace-snapshots「迁移 039 回合快照登记表」「受理时做快照」): the only reader and writer of
 * `chat_turn_snapshots`, one row per accepted user message of a bound session.
 *
 * `skipped` is stored as `{count:<total>,paths:[first 200 {path,reason}]}`, or SQL NULL for an
 * empty list; the cut is made here, callers pass the whole list. `todo` is the text of
 * `chat_sessions.todo` at acceptance and is never parsed or re-serialised: it is bound as given and
 * read back through `CAST … AS BLOB` and the database's text decoder, like every other text column
 * of the store.
 *
 * Input and output types are this module's own; nothing is imported from `workspaces/`.
 *
 * `commitUndo` (#949, message-undo「对话原地回退」step 5) is the one transaction that removes
 * messages from the middle of a session; it is at the end of this file.
 */
import type { DatabaseSync } from "node:sqlite";
import type { emit as auditEmit } from "../core/audit/index.js";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { HttpError } from "../core/errors/index.js";
import { asPlain, own } from "./file-changes.js";
import type { MessageStatus } from "./store.js";
import { decodeNullableText, requireChanges, runOwnedTransaction } from "./store-branch.js";

export type TurnSnapshotOutcome = "ok" | "too_large" | "failed" | "command";

/** One entry the snapshot left out: a workspace-relative POSIX path and why. */
export interface SkippedPath {
  path: string;
  reason: string;
}

export interface TurnSnapshotInput {
  /** The accepted user message; the row's primary key. */
  messageId: number;
  workspaceId: string;
  outcome: TurnSnapshotOutcome;
  /** The complete list; only the first `SKIPPED_PATHS_LIMIT` entries are kept, with the total. */
  skipped: readonly SkippedPath[];
  /** The stored text of `chat_sessions.todo` at acceptance, verbatim, or null. */
  todo: string | null;
  createdAt: number;
}

export interface TurnSnapshotRow {
  messageId: number;
  workspaceId: string;
  outcome: TurnSnapshotOutcome;
  /** `count` is the total number skipped; `paths` holds at most the first 200 of them. */
  skipped: { count: number; paths: SkippedPath[] } | null;
  todo: string | null;
  createdAt: number;
}

type SnapshotDbRow = {
  message_id: number;
  workspace_id: string;
  outcome: TurnSnapshotOutcome;
  skipped: Uint8Array | null;
  todo: Uint8Array | null;
  created_at: number;
};

const SKIPPED_PATHS_LIMIT = 200;
const COLUMNS =
  "t.message_id, t.workspace_id, t.outcome, CAST(t.skipped AS BLOB) AS skipped, CAST(t.todo AS BLOB) AS todo, t.created_at";
const INSERT =
  "INSERT INTO chat_turn_snapshots(message_id, workspace_id, outcome, skipped, todo, created_at) VALUES (?, ?, ?, ?, ?, ?)";
const SELECT_BY_MESSAGE = `SELECT ${COLUMNS} FROM chat_turn_snapshots AS t WHERE t.message_id = ?`;
// `message_id` is the autoincrement key of chat_messages, so the highest one is the latest turn;
// `created_at` cannot say that for two rows of the same millisecond.
const SELECT_LATEST_OK = `SELECT ${COLUMNS} FROM chat_turn_snapshots AS t WHERE t.workspace_id = ? AND t.outcome = 'ok' ORDER BY t.message_id DESC LIMIT 1`;
const SELECT_BY_SESSION = `SELECT ${COLUMNS} FROM chat_turn_snapshots AS t JOIN chat_messages AS m ON m.id = t.message_id WHERE m.session_id = ? ORDER BY m.created_at ASC, m.id ASC`;

/**
 * Writes the row of one user message. A second row for the same message, or a message or workspace
 * that does not exist, is rejected by SQLite and the error propagates: nothing is overwritten.
 */
export function insertTurnSnapshot(db: DatabaseSync, input: TurnSnapshotInput): void {
  db.prepare(INSERT).run(
    input.messageId,
    input.workspaceId,
    input.outcome,
    skippedText(input.skipped),
    input.todo,
    input.createdAt,
  );
}

export function readTurnSnapshot(db: DatabaseSync, messageId: number): TurnSnapshotRow | undefined {
  const row = db.prepare(SELECT_BY_MESSAGE).get(messageId) as unknown as SnapshotDbRow | undefined;
  return row === undefined ? undefined : toRow(row, createSqliteTextDecoder(db));
}

/** The `ok` row with the highest message id among every session bound to this workspace. */
export function latestOkTurnSnapshot(
  db: DatabaseSync,
  workspaceId: string,
): TurnSnapshotRow | undefined {
  const row = db.prepare(SELECT_LATEST_OK).get(workspaceId) as unknown as SnapshotDbRow | undefined;
  return row === undefined ? undefined : toRow(row, createSqliteTextDecoder(db));
}

/** Every row of the session's messages, in history order: message `created_at`, then message id. */
export function listSessionTurnSnapshots(db: DatabaseSync, sessionId: string): TurnSnapshotRow[] {
  const decoder = createSqliteTextDecoder(db);
  const rows = db.prepare(SELECT_BY_SESSION).all(sessionId) as unknown as SnapshotDbRow[];
  return rows.map((row) => toRow(row, decoder));
}

function skippedText(skipped: readonly SkippedPath[]): string | null {
  if (skipped.length === 0) {
    return null;
  }
  const paths = skipped.slice(0, SKIPPED_PATHS_LIMIT).map(({ path, reason }) => ({ path, reason }));
  return JSON.stringify({ count: skipped.length, paths });
}

function toRow(row: SnapshotDbRow, decoder: TextDecoder): TurnSnapshotRow {
  const skipped = decodeNullableText(decoder, row.skipped);
  return {
    messageId: Number(row.message_id),
    workspaceId: row.workspace_id,
    outcome: row.outcome,
    skipped: skipped === null ? null : parseSkipped(skipped),
    todo: decodeNullableText(decoder, row.todo),
    createdAt: Number(row.created_at),
  };
}

/** The stored text as `{count, paths}`, or `null` when it is not one (an out-of-band write). */
function parseSkipped(text: string): TurnSnapshotRow["skipped"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asPlain(parsed);
  const count = record === undefined ? undefined : own(record, "count");
  const listed = record === undefined ? undefined : own(record, "paths");
  if (typeof count !== "number" || !Array.isArray(listed)) {
    return null;
  }
  const paths: SkippedPath[] = [];
  for (const item of listed) {
    const entry = asPlain(item);
    const path = entry === undefined ? undefined : own(entry, "path");
    const reason = entry === undefined ? undefined : own(entry, "reason");
    if (typeof path !== "string" || typeof reason !== "string") {
      return null;
    }
    paths.push({ path, reason });
  }
  return { count, paths };
}

export interface UndoCommit {
  ownerId: string;
  sessionId: string;
  /** The user message being undone; it and every later message of the session are deleted. */
  messageId: number;
  /** The session's last assistant message as the pre-check read it; null when it had none. */
  expectedLastAssistantId: number | null;
  /** The session file `branch` produced; becomes the session's `omp_session_file`. */
  ompSessionFile: string;
  /** What the request asked for; recorded in the audit row only. */
  files: "restore" | "force" | "keep";
  now: number;
}

/** The registration of one removed user message; only an `ok` one has a snapshot directory. */
interface RemovedTurnSnapshot {
  messageId: number;
  workspaceId: string;
  outcome: TurnSnapshotOutcome;
}

export interface UndoResult {
  /** The number of `chat_messages` rows deleted. */
  removedMessages: number;
  /** In history order, the undone message's own first. */
  snapshots: RemovedTurnSnapshot[];
}

// History order is (created_at, id). `FROM_POINT` is "the undone message and everything after it",
// `BEFORE_POINT` its exact complement; both bind the message's created_at twice, then its id.
const FROM_POINT = "(m.created_at > ? OR (m.created_at = ? AND m.id >= ?))";
const BEFORE_POINT = "(m.created_at < ? OR (m.created_at = ? AND m.id < ?))";
const UNDO_SESSION =
  "SELECT status, archived_at, workspace_id FROM chat_sessions WHERE id = ? AND owner_id = ?";
const UNDO_LAST_ASSISTANT =
  "SELECT id FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1";
// The join is the fourth check's second half: no registration row, no point.
const UNDO_POINT =
  "SELECT m.created_at FROM chat_messages AS m JOIN chat_turn_snapshots AS t ON t.message_id = m.id WHERE m.id = ? AND m.session_id = ? AND m.role = 'user'";
const UNDO_REMOVED_SNAPSHOTS = `SELECT t.message_id, t.workspace_id, t.outcome FROM chat_turn_snapshots AS t JOIN chat_messages AS m ON m.id = t.message_id WHERE m.session_id = ? AND ${FROM_POINT} ORDER BY m.created_at ASC, m.id ASC`;
const UNDO_REMAINING_STATUS = `SELECT m.status FROM chat_messages AS m WHERE m.session_id = ? AND m.role = 'assistant' AND ${BEFORE_POINT} ORDER BY m.created_at DESC, m.id DESC LIMIT 1`;
// `todo` is copied inside SQLite from the undone message's registration, so it is the same bytes
// and the same storage class (text or NULL). This must run before the delete: the registration row
// goes with its message (039 cascade).
const UNDO_SESSION_UPDATE =
  "UPDATE chat_sessions SET omp_session_file = ?, status = ?, updated_at = ?, todo = (SELECT todo FROM chat_turn_snapshots WHERE message_id = ?) WHERE id = ?";
const UNDO_DELETE = `DELETE FROM chat_messages AS m WHERE m.session_id = ? AND ${FROM_POINT}`;

/**
 * Undo CAS (#949), one transaction. Unless the session is not the owner's, is running, is archived,
 * has another last assistant than the prechecked one, or the user message (with its registration
 * row) is no longer in it (session_busy, no write):
 *   1. read the registrations of the user messages about to go and the status the session will take
 *      (the last assistant before the undone message, else `idle`);
 *   2. update the session row: `omp_session_file`, `status`, `updated_at`, `todo`; nothing else;
 *   3. delete the undone message and every later message of the session; their steps, approvals and
 *      registration rows go by foreign-key cascade (`openDb` turns foreign keys on);
 *   4. write the `session.undo` audit row.
 * A throw anywhere, the audit included, rolls all of it back.
 */
export function commitUndo(
  db: DatabaseSync,
  emit: typeof auditEmit,
  input: UndoCommit,
): UndoResult {
  const { ownerId, sessionId, messageId, expectedLastAssistantId, ompSessionFile, files, now } =
    input;
  return runOwnedTransaction(db, "undo rollback failed", () => {
    const session = db.prepare(UNDO_SESSION).get(sessionId, ownerId) as
      | {
          status: string;
          archived_at: number | null;
          workspace_id: string | null;
        }
      | undefined;
    const last = db.prepare(UNDO_LAST_ASSISTANT).get(sessionId) as { id: number } | undefined;
    const point = db.prepare(UNDO_POINT).get(messageId, sessionId) as
      | { created_at: number }
      | undefined;
    if (
      session === undefined ||
      session.status === "running" ||
      session.archived_at !== null ||
      (last === undefined ? null : Number(last.id)) !== expectedLastAssistantId ||
      point === undefined
    ) {
      throw new HttpError("session_busy");
    }
    const at = Number(point.created_at);
    const snapshots = (
      db.prepare(UNDO_REMOVED_SNAPSHOTS).all(sessionId, at, at, messageId) as Array<{
        message_id: number;
        workspace_id: string;
        outcome: TurnSnapshotOutcome;
      }>
    ).map((row) => ({
      messageId: Number(row.message_id),
      workspaceId: row.workspace_id,
      outcome: row.outcome,
    }));
    const remaining = db.prepare(UNDO_REMAINING_STATUS).get(sessionId, at, at, messageId) as
      | { status: MessageStatus }
      | undefined;
    const status = remaining === undefined ? "idle" : remaining.status;
    if (status === "running") {
      throw new Error("undo leaves a running assistant");
    }
    const updated = db
      .prepare(UNDO_SESSION_UPDATE)
      .run(ompSessionFile, status, now, messageId, sessionId);
    requireChanges(updated.changes, 1, "undo session update");
    const removedMessages = Number(
      db.prepare(UNDO_DELETE).run(sessionId, at, at, messageId).changes,
    );
    emit(db, {
      kind: "session.undo",
      actorId: ownerId,
      title: "撤回消息",
      detail: { sessionId, messageId, removedMessages, files },
      ...(session.workspace_id === null ? {} : { workspaceId: session.workspace_id }),
      ts: now,
    });
    return { removedMessages, snapshots };
  });
}
