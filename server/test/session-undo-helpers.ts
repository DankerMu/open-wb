/**
 * Issue #951 undo test plumbing, composed over the #466 fork worlds (production createApp →
 * registerSessions; real fake-omp `branch` children with a stdout hold, or scripted FakeChild
 * processes for exits, the shutdown gap, the pool and the list event connection). Undo is only ever
 * requested over REST. A message seeded through the store has no snapshot registration (it reads
 * `none`), so the seeds here write the row a real turn would have written. Oracles are SQLite rows,
 * the directories under the sandbox and the snapshot root, spawn argv and count, stdin frames and
 * the bytes of a real list connection; never internals.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { insertTurnSnapshot, type TurnSnapshotOutcome } from "../src/sessions/store-undo.js";
import { auditCount } from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import { type BodyInput, messageSeq, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { rowCounts, type Seeded, seedTwoTurns } from "./session-fork-helpers.js";
import {
  CHANGED_FRAME,
  drainedBy,
  HEARTBEAT_FRAME,
  type ListClient,
  type Listening,
  listening,
  openList,
} from "./session-list-events-helpers.js";
import { SESSION_VIEW_KEYS } from "./session-meta-fixtures.js";
import {
  type ChildScript,
  count,
  type ScriptedChild,
  scriptedRuntime,
  sendPrompt,
  snapshot,
} from "./session-regenerate-helpers.js";
import { getSessionMessages, SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import {
  createSession,
  openRecordingSession,
  type RecordingWorld,
  type SpawnCall,
  waitFor,
} from "./session-supervisor-helpers.js";

export const THIRD = "third question";
/** The `files` of every 200 here: `keep` restores nothing (message-undo「文件还原与结果」). */
const KEPT = {
  mode: "kept",
  restored: 0,
  removed: 0,
  skipped: { count: 0, paths: [] },
  failed: { count: 0, paths: [] },
} as const;

/** Any of the fork worlds: the runtime's two roots and its spawn record are all undo reads. */
export type UndoWorld = RecordingWorld & {
  rt: { runtime: { sandboxRoot: string; stateDir: string }; calls: readonly SpawnCall[] };
};

export interface UndoBody {
  session: Record<string, unknown> & { id: string; status: string; title: string | null };
  draft: string;
  files: unknown;
}

interface UndoHistory {
  session: Record<string, unknown>;
  messages: Array<Record<string, unknown> & { id: number; role: string }>;
  todo: unknown;
}

export function undoBody(messageId: unknown, files: unknown = "keep", extra: object = {}) {
  const payload = JSON.stringify({ messageId, files, ...extra });
  return { name: payload, payload, contentType: "application/json" } satisfies BodyInput;
}

export function postUndo(
  world: RecordingWorld,
  messageId: number,
  session = world.session,
): Promise<LightMyRequestResponse> {
  return postSessionAction(world.fixture.app, "undo", session, world.cookie, undoBody(messageId));
}

/** A 200 with no-store whose body is exactly `{session:<eleven keys>, draft, files:<kept>}`. */
export function undone(response: LightMyRequestResponse): UndoBody {
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([200, "no-store"]);
  const body = response.json() as UndoBody;
  expect(Object.keys(body)).toEqual(["session", "draft", "files"]);
  expect(Object.keys(body.session)).toEqual(SESSION_VIEW_KEYS);
  expect(body.files).toEqual(KEPT);
  return body;
}

export async function historyOf(world: RecordingWorld, session = world.session) {
  const response = await getSessionMessages(world.fixture.app, session, world.cookie);
  expect(response.statusCode).toBe(200);
  return response.json() as UndoHistory;
}

/** The registration row a real turn of this user message would have written (default `ok`). */
export function register(
  db: DatabaseSync,
  session: string,
  messageId: number,
  outcome: TurnSnapshotOutcome = "ok",
  todo: string | null = null,
): void {
  const row = db.prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?").get(session);
  const workspaceId = row?.workspace_id;
  if (typeof workspaceId !== "string") {
    throw new Error("a registration row needs a bound session");
  }
  insertTurnSnapshot(db, { messageId, workspaceId, outcome, skipped: [], todo, createdAt: 1 });
}

/** `seedTwoTurns` with every user message registered `ok`: each of them reads `available`. */
export function seedUndoable(
  world: RecordingWorld,
  options: Parameters<typeof seedTwoTurns>[1] = {},
  session = world.session,
): Seeded {
  const seeded = seedTwoTurns(world, options, session);
  for (const messageId of [seeded.u1, seeded.u2, seeded.u3].filter((id) => id !== -1)) {
    register(world.fixture.db, session, messageId);
  }
  return seeded;
}

/** A second session of the same owner with its own undoable two turns. */
export async function seededSession(
  world: RecordingWorld,
  options: Parameters<typeof seedTwoTurns>[1] = {},
): Promise<Seeded & { session: string }> {
  const session = await createSession(world.fixture.app, world.cookie);
  return { session, ...seedUndoable(world, options, session) };
}

function entriesOf(dir: string): string[] {
  return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [];
}

/**
 * Everything a refused or failed undo must leave alone: the session's rows (every column the
 * regenerate snapshot reads, plus the task list, the archive mark and the binding), every table's
 * count and the message high-water mark, the registrations, the audit trail, the spawn count and
 * the entries under the sandbox and the snapshot root.
 */
export function observed(world: UndoWorld, session = world.session) {
  const { db } = world.fixture;
  const { sandboxRoot, stateDir } = world.rt.runtime;
  return {
    rows: snapshot(db, session, true),
    meta: db
      .prepare("SELECT todo, archived_at, workspace_id FROM chat_sessions WHERE id = ?")
      .get(session),
    counts: rowCounts(db),
    seq: messageSeq(db),
    registrations: count(db, "SELECT COUNT(*) AS count FROM chat_turn_snapshots"),
    audits: auditCount(db),
    spawns: world.rt.calls.length,
    disk: [entriesOf(sandboxRoot), entriesOf(join(stateDir, "snapshots"))],
  };
}

/**
 * While an undo holds the session: prompt, regenerate, fork, a second undo, archiving and DELETE
 * are each 409 `session_busy`.
 */
export async function expectClaimed(world: RecordingWorld, messageId: number): Promise<void> {
  const { app } = world.fixture;
  const action = (name: string, body?: BodyInput) =>
    postSessionAction(app, name, world.session, world.cookie, body);
  const refused = [
    ["prompt", await sendPrompt(world, "injected")],
    ["regenerate", await action("regenerate")],
    [
      "fork",
      await action("fork", { ...undoBody(messageId), payload: JSON.stringify({ messageId }) }),
    ],
    ["undo", await postUndo(world, messageId)],
    ["archive", await patch(world, { archived: true })],
    [
      "delete",
      await app.inject({
        method: "DELETE",
        url: `/api/sessions/${world.session}`,
        headers: { cookie: world.cookie },
      }),
    ],
  ] as const;
  for (const [name, response] of refused) {
    expect([name, response.statusCode, response.json()]).toEqual([
      name,
      409,
      SESSION_BUSY_ENVELOPE,
    ]);
  }
}

/** The session file the child's last `get_state` reply named (the one `branch` switched to). */
export function lastStateFile(replies: readonly OmpFrame[] | undefined): unknown {
  const reply = (replies ?? []).findLast(
    (frame) => frame.type === "response" && frame.command === "get_state",
  );
  return (reply?.data as { sessionFile?: unknown } | undefined)?.sessionFile;
}

export type ScriptedUndoWorld = Listening<UndoWorld & { scripted: ScriptedChild[] }>;

/**
 * A scripted world on a real listener (closed by `closeListening`, never tracked by the fork
 * worlds), for the cases that read the owner's list event connection.
 */
export async function openListeningScripted(scripts: ChildScript[]): Promise<ScriptedUndoWorld> {
  const { rt, scripted } = scriptedRuntime(scripts);
  const world = await openRecordingSession(rt.runtime);
  return listening({ ...world, rt, scripted }, rt.clock);
}

/** The owner's list connection, read empty: `mark` is where "after this" starts. */
export async function listFrom(world: ScriptedUndoWorld) {
  const client = await openList(world, world.cookie);
  const [mark] = await drainedBy(world.clock, [client]);
  return { client, mark: mark ?? 0 };
}

/** Everything written to the connection after `mark`, once all of it has arrived. */
export async function framesSince(world: ScriptedUndoWorld, client: ListClient, mark: number) {
  await drainedBy(world.clock, [client]);
  return client.text().slice(mark).replaceAll(HEARTBEAT_FRAME, "");
}

export function rewoundFrame(session: string): string {
  return `event: session.rewound\ndata: ${JSON.stringify({ sessionId: session })}\n\n`;
}

/** `frames` with every `sessions.changed` taken out, and how many there were. */
export function withoutChanged(frames: string): { rest: string; changed: number } {
  return {
    rest: frames.replaceAll(CHANGED_FRAME, ""),
    changed: frames.split(CHANGED_FRAME).length - 1,
  };
}

/** The scripted child whose `branch` reply is being held. */
export function heldBranch(world: { scripted: ScriptedChild[] }, index = 0) {
  return waitFor(
    () => (world.scripted[index]?.release === undefined ? undefined : world.scripted[index]),
    "held branch",
  );
}

/** The scripted child after its stdin EOF (its shutdown is pending until the test ends it). */
export function tempClosing(world: { scripted: ScriptedChild[] }, index = 0) {
  return waitFor(() => {
    const child = world.scripted[index]?.child;
    return child?.stdin.writableEnded === true ? child : undefined;
  }, "temporary stdin EOF");
}
