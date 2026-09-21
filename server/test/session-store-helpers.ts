import type { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";

export const FIXED_NOW = 1_740_000_000_000;
export const HEX32 = /^[0-9a-f]{32}$/u;

interface FlushFailure {
  sessionId: string;
  assistantMessageId: number;
  error: unknown;
}

export interface SessionStoreHarness {
  db: DatabaseSync;
  store: SessionStore;
  flushFailures: FlushFailure[];
}

export interface SessionRow {
  id: string;
  owner_id: string;
  title: string | null;
  status: string;
  omp_session_file: string | null;
  stream_epoch: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  status: string;
  created_at: number;
}

export interface StepRow {
  id: number;
  message_id: number;
  ordinal: number;
  name: string;
  detail: string;
  status: string;
  started_at: number;
  ended_at: number | null;
}

export interface SessionSeed {
  id: string;
  ownerId: string;
  title: string | null;
  status: "idle" | "running" | "done" | "failed";
  ompSessionFile: string | null;
  streamEpoch: number;
  createdAt: number;
  updatedAt: number;
}

export interface MessageSeed {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "running" | "failed";
  createdAt: number;
}

export interface StepSeed {
  messageId: number;
  ordinal: number;
  name: string;
  detail: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
}

const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_MESSAGE =
  "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?)";
const INSERT_STEP =
  "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
const SESSION_COLUMNS =
  "id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at";
const MESSAGE_COLUMNS = "id, session_id, role, content, status, created_at";
const STEP_COLUMNS = "id, message_id, ordinal, name, detail, status, started_at, ended_at";

export function withSessionStore<T>(
  run: (harness: SessionStoreHarness) => T,
  prepare?: (db: DatabaseSync) => void,
): T {
  const db = openDb(":memory:");
  const flushFailures: FlushFailure[] = [];
  let store: SessionStore | undefined;
  let result: { value: T } | undefined;
  let bodyFailed = false;
  let bodyError: unknown;

  try {
    prepare?.(db);
    store = createSessionStore(db, {
      onFlushError(failure) {
        flushFailures.push(failure);
      },
    });
    result = { value: run({ db, store, flushFailures }) };
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  const attemptCleanup = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
  };

  attemptCleanup(() => db.setAuthorizer(null));
  attemptCleanup(() => {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
  });
  if (store !== undefined) {
    attemptCleanup(() => store.close());
  }
  attemptCleanup(() => db.setAuthorizer(null));
  attemptCleanup(() => {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
  });
  attemptCleanup(() => db.close());

  if (bodyFailed) {
    throw bodyError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  if (result === undefined) {
    throw new Error("session store harness completed without a result");
  }
  return result.value;
}

export function withFakeClock<T>(now: number, run: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    return run();
  } finally {
    vi.useRealTimers();
  }
}

export function sessionId(marker: string): string {
  const id = marker.repeat(32);
  if (!HEX32.test(id)) {
    throw new Error(`invalid session id marker: ${marker}`);
  }
  return id;
}

export function seedSession(db: DatabaseSync, seed: SessionSeed): void {
  db.prepare(INSERT_SESSION).run(
    seed.id,
    seed.ownerId,
    seed.title,
    seed.status,
    seed.ompSessionFile,
    seed.streamEpoch,
    seed.createdAt,
    seed.updatedAt,
  );
}

export function seedMessage(db: DatabaseSync, seed: MessageSeed): number {
  return Number(
    db
      .prepare(INSERT_MESSAGE)
      .run(seed.sessionId, seed.role, seed.content, seed.status, seed.createdAt).lastInsertRowid,
  );
}

export function seedStep(db: DatabaseSync, seed: StepSeed): number {
  return Number(
    db
      .prepare(INSERT_STEP)
      .run(
        seed.messageId,
        seed.ordinal,
        seed.name,
        seed.detail,
        seed.status,
        seed.startedAt,
        seed.endedAt,
      ).lastInsertRowid,
  );
}

export function sessionRows(db: DatabaseSync): SessionRow[] {
  return db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions ORDER BY id`)
    .all() as unknown as SessionRow[];
}

export function messageRows(db: DatabaseSync): MessageRow[] {
  return db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages ORDER BY id`)
    .all() as unknown as MessageRow[];
}

export function stepRows(db: DatabaseSync): StepRow[] {
  return db
    .prepare(`SELECT ${STEP_COLUMNS} FROM chat_steps ORDER BY id`)
    .all() as unknown as StepRow[];
}

export function sessionRow(db: DatabaseSync, id: string): SessionRow {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`)
    .get(id) as unknown as SessionRow | undefined;
  if (row === undefined) {
    throw new Error(`missing session ${id}`);
  }
  return row;
}

export function messageRow(db: DatabaseSync, id: number): MessageRow {
  const row = db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE id = ?`)
    .get(id) as unknown as MessageRow | undefined;
  if (row === undefined) {
    throw new Error(`missing message ${id}`);
  }
  return row;
}

export function stepRow(db: DatabaseSync, id: number): StepRow {
  const row = db
    .prepare(`SELECT ${STEP_COLUMNS} FROM chat_steps WHERE id = ?`)
    .get(id) as unknown as StepRow | undefined;
  if (row === undefined) {
    throw new Error(`missing step ${id}`);
  }
  return row;
}

export function persistenceSnapshot(db: DatabaseSync) {
  return {
    sessions: sessionRows(db),
    messages: messageRows(db),
    steps: stepRows(db),
  };
}

export function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  expect.fail("expected operation to throw");
}

export function expectHttpError(run: () => unknown, code: "not_found" | "session_busy"): HttpError {
  const error = captureThrown(run);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ name: "HttpError", code });
  return error as HttpError;
}
