/**
 * Issue #525 DELETE /api/sessions/:id test plumbing over the production createApp →
 * registerSessions assembly (real fake-omp or a controlled FakeChild runtime), a real in-memory
 * SQLite and `app.inject()`. Oracles: status/headers/bytes, SQLite rows, `GET /api/audit` per
 * account role, child liveness, file existence and the public supervisor surface. Every file a
 * DELETE may unlink is a test-owned mkdtemp path or a `branch-*.jsonl` under the test stateDir;
 * the fake's shared `/tmp/open-wb-fake-session.jsonl` is never created, deleted or asserted.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, expect } from "vitest";
import { settle } from "./session-approval-helpers.js";
import {
  closeOnEof,
  completeHeldTurn,
  createControlledRuntime,
  createRealFakeRuntime,
  emitAssistantDelta,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  type SupervisorApp,
  waitFor,
} from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

export const JSON_TYPE = "application/json";

const NOT_FOUND_BODY = JSON.stringify({
  error: { code: "not_found", message: "请求的资源不存在" },
});

/** The exact wire of a no-store typed 404 (identical for foreign, unknown and deleted ids). */
export const NOT_FOUND_WIRE = {
  status: 404,
  cacheControl: "no-store",
  contentType: "application/json; charset=utf-8",
  contentLength: String(Buffer.byteLength(NOT_FOUND_BODY, "utf8")),
  body: NOT_FOUND_BODY,
};

interface Owned {
  fixture: SupervisorApp;
  /** Controlled children still alive at teardown are let go so shutdown never waits on them. */
  fakes: FakeChild[];
}

const owned: Owned[] = [];
const dirs: string[] = [];

/** Per-test ownership: every tracked fixture is closed and every owned directory removed. */
export function deleteWorlds(): void {
  afterEach(async () => {
    try {
      for (const { fixture, fakes } of owned.splice(0)) {
        for (const child of fakes) {
          if (isLive(child)) {
            release(child);
          }
        }
        await fixture.close();
      }
    } finally {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

export function track(fixture: SupervisorApp, fakes: FakeChild[] = []): void {
  owned.push({ fixture, fakes });
}

/** A fresh test-owned directory (removed after the case). */
export function ownedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-525-"));
  dirs.push(dir);
  return dir;
}

/** A real test-owned session file. */
export function ownedFile(): string {
  const file = join(ownedDir(), "owned.jsonl");
  writeFileSync(file, '{"type":"session","id":"owned"}\n');
  return file;
}

export interface DeleteBody {
  payload: string;
  contentType: string;
}

export function sendDelete(
  app: FastifyInstance,
  session: string,
  cookie: string | null,
  body?: DeleteBody,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (cookie !== null) {
    headers.cookie = cookie;
  }
  if (body !== undefined) {
    headers["content-type"] = body.contentType;
  }
  return app.inject({
    method: "DELETE",
    url: `/api/sessions/${session}`,
    headers,
    ...(body === undefined ? {} : { payload: body.payload }),
  });
}

export function wireShape(response: LightMyRequestResponse) {
  return {
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
    contentLength: response.headers["content-length"],
    body: response.payload,
  };
}

/** 204, no body, no content type, no-store. */
export function expectDeleted(response: LightMyRequestResponse): void {
  expect({
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
    body: response.payload,
  }).toEqual({ status: 204, cacheControl: "no-store", contentType: undefined, body: "" });
}

function countOf(db: DatabaseSync, sql: string, session: string): number {
  return Number((db.prepare(sql).get(session) as { n: number }).n);
}

/** Every column of the session row plus its message/step/approval row counts. */
export function sessionState(db: DatabaseSync, session: string) {
  return {
    row: db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(session),
    messages: countOf(db, "SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?", session),
    steps: countOf(
      db,
      "SELECT COUNT(*) AS n FROM chat_steps AS s JOIN chat_messages AS m ON m.id = s.message_id WHERE m.session_id = ?",
      session,
    ),
    approvals: countOf(
      db,
      "SELECT COUNT(*) AS n FROM chat_approvals AS a JOIN chat_messages AS m ON m.id = a.message_id WHERE m.session_id = ?",
      session,
    ),
  };
}

export function auditRows(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n);
}

export interface AuditEventWire {
  id: number;
  ts: number;
  actorId: string;
  kind: string;
  title: string;
  detail: unknown;
  workspaceId: string | null;
}

export async function auditEvents(
  app: FastifyInstance,
  cookie: string,
  limit = 200,
): Promise<AuditEventWire[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/audit?limit=${String(limit)}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { events: AuditEventWire[] }).events;
}

/** The `GET /api/audit` wire form of one zhangsan `session.delete` event. */
export function deleteEvent(
  sessionId: string,
  ompSessionFile: string | null,
  messageCount: number,
  workspaceId: string | null = null,
) {
  return {
    id: expect.any(Number),
    ts: expect.any(Number),
    actorId: OWNER_ID,
    kind: "session.delete",
    title: "删除会话",
    detail: { sessionId, ompSessionFile, messageCount },
    workspaceId,
  };
}

export function sessionFileOf(db: DatabaseSync, session: string): string | null {
  const row = db.prepare("SELECT omp_session_file FROM chat_sessions WHERE id = ?").get(session) as
    | { omp_session_file: string | null }
    | undefined;
  return row?.omp_session_file ?? null;
}

export function presetFile(db: DatabaseSync, session: string, file: string): void {
  db.prepare("UPDATE chat_sessions SET omp_session_file = ? WHERE id = ?").run(file, session);
}

/** Real fake-omp world (production createApp), tracked for teardown. */
export async function openRealWorld(scenario?: string) {
  const rt = createRealFakeRuntime(scenario);
  const world = await openRecordingSession(rt.runtime);
  track(world.fixture);
  return { ...world, rt };
}

/**
 * Controlled world whose first child ignores stdin EOF (a retire of it parks until `release`);
 * later children exit on EOF. Every handshake reports the test-owned `file`, so a prompt stores
 * it as `omp_session_file`. Each prompt runs one delta to `done`.
 */
export async function openLingeringWorld() {
  const file = ownedFile();
  const rt = createControlledRuntime((child, _call, ordinal) => {
    child.replyHandshake({ sessionFile: file });
    if (ordinal > 0) {
      closeOnEof(child);
    }
    child.onCommand("prompt", () => {
      child.emitLine({ type: "agent_start" });
      emitAssistantDelta(child, "Hello");
      completeHeldTurn(child);
    });
  });
  const world = await openRecordingSession(rt.runtime);
  track(world.fixture, rt.children);
  return { ...world, rt, file };
}

/** Lets a lingering child go: stdout ends and the process exits. */
export function release(child: FakeChild | undefined): void {
  if (child === undefined) {
    throw new Error("missing lingering child");
  }
  if (!child.stdout.writableEnded) {
    child.endStdout();
  }
  child.exit(0);
}

/**
 * A DELETE sent and parked inside its retire: its control claim is held and it has not
 * answered after a few macrotasks. Wrapped so awaiting this does not await the DELETE.
 */
export async function parkedDelete(
  world: RecordingWorld,
): Promise<{ pending: Promise<LightMyRequestResponse> }> {
  let answered = false;
  const pending = sendDelete(world.fixture.app, world.session, world.cookie).finally(() => {
    answered = true;
  });
  await waitFor(
    () => (world.fixture.supervisor.controlHeld(world.session) ? true : undefined),
    "DELETE holding the control claim",
  );
  await settle();
  expect(answered, "DELETE parked in retire").toBe(false);
  expect(world.fixture.supervisor.controlHeld(world.session)).toBe(true);
  return { pending };
}

/** Inserts one `done` step on a message (SQL seeding, as the fork precedent does for approvals). */
export function insertStep(db: DatabaseSync, messageId: number): void {
  db.prepare(
    "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at) VALUES (?, 0, 'bash', 'echo', 'done', 60, 61)",
  ).run(messageId);
}
