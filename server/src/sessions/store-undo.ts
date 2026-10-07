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
 */
import type { DatabaseSync } from "node:sqlite";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { asPlain, own } from "./file-changes.js";
import { decodeNullableText } from "./store-branch.js";

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
