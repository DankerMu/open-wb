import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import type { MessageRole, MessageStatus, MessageView, StepStatus, StepView } from "./store.js";

export type MessageDbRow = {
  id: number;
  session_id: string;
  role: MessageRole;
  content: Uint8Array;
  status: MessageStatus;
  created_at: number;
};

export type StepDbRow = {
  id: number;
  message_id: number;
  ordinal: number;
  name: Uint8Array;
  detail: Uint8Array;
  output: Uint8Array | null;
  status: StepStatus;
  started_at: number;
  ended_at: number | null;
};

export const MESSAGE_COLUMNS =
  "id, session_id, role, CAST(content AS BLOB) AS content, status, created_at";
export const STEP_COLUMNS =
  "s.id, s.message_id, s.ordinal, CAST(s.name AS BLOB) AS name, CAST(s.detail AS BLOB) AS detail, CAST(s.output AS BLOB) AS output, s.status, s.started_at, s.ended_at";
export const INSERT_MESSAGE =
  "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?)";

export function decodeNullableText(decoder: TextDecoder, bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

export function toMessageView(
  row: MessageDbRow,
  decoder: TextDecoder,
): Omit<MessageView, "steps" | "approvals"> {
  return {
    id: Number(row.id),
    role: row.role,
    content: decoder.decode(row.content),
    status: row.status,
    createdAt: Number(row.created_at),
  };
}

export function toStepView(row: StepDbRow, decoder: TextDecoder): StepView {
  return {
    id: Number(row.id),
    ordinal: Number(row.ordinal),
    name: decoder.decode(row.name),
    detail: decoder.decode(row.detail),
    output: row.output === null ? "" : decoder.decode(row.output),
    status: row.status,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  };
}

export function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { count: number | bigint } | undefined;
  if (row === undefined) {
    throw new Error("count query returned no row");
  }
  return Number(row.count);
}

export function hasChanges(changes: number | bigint): boolean {
  return changes === 1 || changes === 1n;
}

export function requireAtMostOne(changes: number | bigint, operation: string): void {
  if (changes !== 0 && changes !== 0n && !hasChanges(changes)) {
    throw new Error(`${operation} must change at most one row`);
  }
}

export function requireChanges(
  changes: number | bigint,
  expected: number,
  operation: string,
): void {
  if (changes !== expected && changes !== BigInt(expected)) {
    throw new Error(`${operation} must change exactly ${expected} row${expected === 1 ? "" : "s"}`);
  }
}

export function runOwnedTransaction<T>(
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

const CAS_SESSION =
  "SELECT owner_id, CAST(title AS BLOB) AS title, status, updated_at FROM chat_sessions WHERE id = ?";
const CAS_LAST_TWO =
  "SELECT id FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 2";
const CAS_MOVE =
  "UPDATE chat_sessions SET omp_session_file = ?, status = 'running', updated_at = ? WHERE id = ?";

type CasSessionRow = {
  owner_id: string;
  title: Uint8Array | null;
  status: MessageStatus | "idle";
  updated_at: number;
};

/**
 * Regenerate CAS (#465), one transaction: unless the session is running or its last message is no
 * longer the prechecked assistant (session_busy, no write), delete that assistant (steps and
 * approvals cascade), insert a running empty assistant and move the session to `sessionFile`.
 */
export function replaceLastAssistant(
  db: DatabaseSync,
  decoder: TextDecoder,
  input: { sessionId: string; expectedAssistantId: number; sessionFile: string; now: number },
) {
  const { sessionId, expectedAssistantId, sessionFile, now } = input;
  return runOwnedTransaction(db, "regenerate replacement rollback failed", () => {
    const session = db.prepare(CAS_SESSION).get(sessionId) as CasSessionRow | undefined;
    const [last, user] = db.prepare(CAS_LAST_TWO).all(sessionId) as Array<{ id: number }>;
    if (
      session === undefined ||
      session.status === "running" ||
      Number(last?.id) !== expectedAssistantId ||
      user === undefined
    ) {
      throw new HttpError("session_busy");
    }
    const deleted = db.prepare("DELETE FROM chat_messages WHERE id = ?").run(expectedAssistantId);
    requireChanges(deleted.changes, 1, "regenerate assistant delete");
    const inserted = db.prepare(INSERT_MESSAGE).run(sessionId, "assistant", "", "running", now);
    requireChanges(inserted.changes, 1, "regenerate assistant insert");
    const moved = db.prepare(CAS_MOVE).run(sessionFile, now, sessionId);
    requireChanges(moved.changes, 1, "regenerate session update");
    return {
      ownerId: session.owner_id,
      userMessageId: Number(user.id),
      assistantMessageId: Number(inserted.lastInsertRowid),
      previousStatus: session.status,
      previousTitle: decodeNullableText(decoder, session.title),
      previousUpdatedAt: Number(session.updated_at),
    };
  });
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
