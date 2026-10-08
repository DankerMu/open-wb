/**
 * Issue #952 undo with a file restore: the world of session-undo-files.test.ts. Production
 * createApp → registerSessions over scripted FakeChild processes, with the snapshot service
 * createApp builds itself (real `take` and `restore`), a real workspace directory and a real
 * snapshots directory under the runtime's temp root.
 *
 * Every snapshot comes from a real REST prompt; what a turn "wrote" is written by the test after
 * the 202 (the registration row is in by then). `Date` is the only faked clock: the store stamps
 * rows with `Date.now()`, so each event is given its moment with `at` first.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { expect, vi } from "vitest";
import { settle } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import { FIRST, type forkWorlds } from "./session-fork-helpers.js";
import {
  type ChildScript,
  QUESTION,
  type ScriptedChild,
  scriptedRuntime,
  sendPrompt,
} from "./session-regenerate-helpers.js";
import { type SessionSeed, seedSession } from "./session-store-helpers.js";
import { OWNER_ID, openRecordingSession, waitForTurn } from "./session-supervisor-helpers.js";
import {
  postUndo,
  THIRD,
  type UndoBody,
  type UndoWorld,
  undoneWithFiles,
} from "./session-undo-helpers.js";
import { workspaceOf } from "./support/temporary-workspace.js";

/** The moment the world is opened at. */
const EPOCH = 1_800_000_000_000;

/** `offset` milliseconds after the world was opened, as the rows store it. */
export function moment(offset: number): number {
  return EPOCH + offset;
}

export interface FilesWorld extends UndoWorld {
  scripted: ScriptedChild[];
  workspaceId: string;
  /** The workspace directory the world's first session is bound to. */
  root: string;
  /** `<state dir>/snapshots/<workspaceId>`. */
  snapshots: string;
}

interface Settings {
  snapshotMaxFileBytes?: number;
}

export interface Files {
  mode: string;
  restored: number;
  removed: number;
  skipped: { count: number; paths: Array<{ path: string; reason: string }> };
  failed: { count: number; paths: Array<{ path: string }> };
}

/** Moves the faked `Date` to `moment(offset)`: it stands still until the next call. */
export function at(offset: number): void {
  vi.setSystemTime(moment(offset));
}

/**
 * A scripted world opened at `at(0)`: child n runs `scripts[n]` (the last one repeats). The
 * snapshot settings travel in the runtime settings object, as `sessionRuntimeOf` puts them.
 */
export async function openFilesWorld(
  worlds: ReturnType<typeof forkWorlds>,
  scripts: ChildScript[] = [{}],
  settings: Settings = {},
): Promise<FilesWorld> {
  at(0);
  const { rt, scripted } = scriptedRuntime(scripts);
  Object.assign(rt.runtime, settings);
  const world = worlds.track({ ...(await openRecordingSession(rt.runtime)), rt, scripted });
  const workspaceId = workspaceOf(world.fixture.db, world.session);
  return {
    ...world,
    workspaceId,
    root: realpathSync(join(rt.runtime.sandboxRoot, OWNER_ID, `tmp-${workspaceId}`)),
    snapshots: join(rt.runtime.stateDir, "snapshots", workspaceId),
  };
}

/** The `get_branch_messages` data of a session whose user messages are the first `count` texts. */
export function entries(count: 1 | 2 | 3) {
  return [FIRST, QUESTION, THIRD]
    .slice(0, count)
    .map((text, index) => ({ entryId: `fake-entry-${String(index + 1)}`, text }));
}

export function put(world: FilesWorld, path: string, bytes: string): void {
  const target = join(world.root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, bytes);
}

/** Every entry under the workspace root: a file by its text, a directory (`path/`) as null. */
export function contents(world: FilesWorld): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  const walk = (parent: string): void => {
    for (const entry of readdirSync(join(world.root, parent), { withFileTypes: true })) {
      const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
      if (entry.isDirectory()) {
        found[`${path}/`] = null;
        walk(path);
      } else {
        found[path] = readFileSync(join(world.root, path), "utf8");
      }
    }
  };
  walk("");
  return found;
}

/**
 * One REST turn accepted at `at(offset)` and completed by the scripted child; its user message,
 * which reads `available`. Whatever the turn is to have written, the test writes after this.
 */
export async function turnAt(
  world: FilesWorld,
  offset: number,
  message: string,
  session = world.session,
): Promise<number> {
  const accepted = await acceptedAt(world, offset, message, session);
  await waitForTurn(world.fixture, session, "done");
  await settle();
  return accepted;
}

/** The 202 of a prompt sent at `at(offset)`; the turn is left to its script. */
export async function acceptedAt(
  world: FilesWorld,
  offset: number,
  message: string,
  session = world.session,
): Promise<number> {
  at(offset);
  const response = await sendPrompt(world, message, session);
  expect([response.statusCode, response.json()]).toEqual([
    202,
    expect.objectContaining({ undo: "available" }),
  ]);
  return (response.json() as { userMessageId: number }).userMessageId;
}

/** The session a REST fork of `session` at `messageId` made, at `at(offset)`. */
export async function forkedAt(
  world: FilesWorld,
  offset: number,
  messageId: number,
  session = world.session,
): Promise<string> {
  at(offset);
  const payload = JSON.stringify({ messageId });
  const response = await postSessionAction(world.fixture.app, "fork", session, world.cookie, {
    name: payload,
    payload,
    contentType: "application/json",
  });
  expect(response.statusCode).toBe(201);
  await settle();
  return (response.json() as { session: { id: string } }).session.id;
}

/**
 * A session row written straight into the database and bound to the world's workspace: one that
 * REST cannot make (another account's, or a turn left `running`). Times are offsets.
 */
export function seedShared(
  world: FilesWorld,
  seed: Pick<SessionSeed, "id" | "ownerId" | "status" | "createdAt" | "updatedAt">,
): string {
  const { db } = world.fixture;
  seedSession(db, {
    ...seed,
    title: null,
    ompSessionFile: null,
    streamEpoch: 0,
    createdAt: moment(seed.createdAt),
    updatedAt: moment(seed.updatedAt),
  });
  db.prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?").run(
    world.workspaceId,
    seed.id,
  );
  return seed.id;
}

/** The three columns the conflict criterion reads off a session row. */
export function clockOf(db: DatabaseSync, session: string) {
  const row = db
    .prepare("SELECT status, created_at, updated_at FROM chat_sessions WHERE id = ?")
    .get(session) as { status: string; created_at: number; updated_at: number };
  return {
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** `created_at` of each registration row of the session's own messages, in message order. */
export function registeredAt(db: DatabaseSync, session: string): number[] {
  const rows = db
    .prepare(
      "SELECT t.created_at FROM chat_turn_snapshots AS t JOIN chat_messages AS m ON m.id = t.message_id WHERE m.session_id = ? ORDER BY m.id",
    )
    .all(session) as Array<{ created_at: number }>;
  return rows.map((row) => Number(row.created_at));
}

export function undoWith(
  world: FilesWorld,
  messageId: number,
  files: "restore" | "force" | "keep",
): Promise<LightMyRequestResponse> {
  return postUndo(world, messageId, world.session, files);
}

/** The 200 of an undo that restored files, with the exact keys of its `files`. */
export function restoredBy(response: LightMyRequestResponse): UndoBody & { files: Files } {
  const body = undoneWithFiles(response) as UndoBody & { files: Files };
  expect(Object.keys(body.files)).toEqual(["mode", "restored", "removed", "skipped", "failed"]);
  expect(body.files.mode).toBe("restored");
  return body;
}
