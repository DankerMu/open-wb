/**
 * Issue #953 snapshot directory cleanup (s1f-session-list-temp-space task 12.3) on the production
 * createApp → registerSessions assembly: scripted FakeChild processes, the snapshot service
 * createApp builds, or a real one with one removal made to reject. Every snapshot directory comes
 * from a real REST prompt (real `take` and registration row). Oracles are the response, SQLite
 * rows, `GET /api/audit`, the directories under the sandbox and the snapshot root, the error
 * channel and the bytes of a real list connection.
 *
 * Specs: workspace-snapshots「快照清理」, session-metadata「删除连同快照与独占的临时空间」
 * 「绑定正式空间的会话只清自己的快照」「归档保留临时空间与快照」, message-undo「对话原地回退」step 6.
 *
 * Each scenario's comment lists its spawns in order: the scripted runtime hands script n to the
 * n-th child. Only `Date` is faked; every turn is given its own moment.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnSnapshotService } from "../src/sessions/turn-snapshot.js";
import { patch, patched } from "./session-archive-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import {
  auditEvents,
  expectDeleted,
  JSON_TYPE,
  ownedFile,
  ownerSessionDir,
  presetFile,
  sendDelete,
  sessionState,
} from "./session-delete-helpers.js";
import { FIRST, forkWorlds } from "./session-fork-helpers.js";
import { closeListening } from "./session-list-events-helpers.js";
import { count, QUESTION } from "./session-regenerate-helpers.js";
import { SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import { OWNER_ID, type RecordingWorld } from "./session-supervisor-helpers.js";
import {
  at,
  contents,
  entries,
  openFilesWorld,
  put,
  restoredBy,
  turnAt,
  undoWith,
} from "./session-undo-files-helpers.js";
import {
  framesSince,
  listFrom,
  openListeningScripted,
  postUndo,
  rewoundFrame,
  THIRD,
  tempClosing,
  undone,
  withoutChanged,
} from "./session-undo-helpers.js";

const TEXTS = [FIRST, QUESTION, THIRD];
const KEPT = "kept across the turns";
const REFUSED = new Error("snapshot removal refused");
const refuse = (): Promise<void> => Promise.reject(REFUSED);

const worlds = forkWorlds();
let clock = 0;
beforeEach(() => {
  // `Date` alone: the bare form would also freeze the timers the scripted runtime runs on.
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  await closeListening();
});

type Roots = { rt: { runtime: { sandboxRoot: string; stateDir: string } } };

interface Workspace {
  id: string;
  /** The workspace directory. */
  root: string;
  /** `<state dir>/snapshots/<workspaceId>`. */
  snapshots: string;
}

/** `count` REST turns of `session`, each completed by its scripted child; their user messages. */
async function turns(world: RecordingWorld, count: 1 | 2 | 3, session = world.session) {
  const ids: number[] = [];
  for (const text of TEXTS.slice(0, count)) {
    clock += 10;
    ids.push(await turnAt(world, clock, text, session));
  }
  return ids;
}

/** An ordinary workspace made over REST, holding `a.txt`. */
async function formalWorkspace(world: RecordingWorld & Roots): Promise<Workspace> {
  const { sandboxRoot, stateDir } = world.rt.runtime;
  const created = await world.fixture.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie: world.cookie, "content-type": JSON_TYPE },
    payload: JSON.stringify({ name: "shared", dir: "shared" }),
  });
  expect(created.statusCode).toBe(201);
  const { id } = created.json() as { id: string };
  const root = join(realpathSync(sandboxRoot), OWNER_ID, "shared");
  writeFileSync(join(root, "a.txt"), KEPT);
  return { id, root, snapshots: join(stateDir, "snapshots", id) };
}

async function boundSession(world: RecordingWorld, workspace: Workspace): Promise<string> {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: world.cookie, "content-type": JSON_TYPE },
    payload: JSON.stringify({ workspaceId: workspace.id }),
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

/**
 * Ordinary workspace W with session A (`mine` turns) and session B (one turn, taken last). Child 0
 * is A's process, child 1 is B's.
 */
async function sharedByTwo(world: RecordingWorld & Roots, mine: 1 | 2 | 3) {
  const workspace = await formalWorkspace(world);
  const a = await boundSession(world, workspace);
  const b = await boundSession(world, workspace);
  const own = await turns(world, mine, a);
  const [other] = await turns(world, 1, b);
  return { workspace, a, b, own, other: Number(other) };
}

function snapshotDir(workspace: Pick<Workspace, "snapshots">, messageId: number): string {
  return join(workspace.snapshots, String(messageId));
}

/** Every entry under `dir`, by relative path. */
function names(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

/** The snapshot is still there to be read: its manifest lists `a.txt`, its tree holds the bytes. */
function expectReadable(workspace: Pick<Workspace, "snapshots">, messageId: number): void {
  const dir = snapshotDir(workspace, messageId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    entries: Array<{ path: string }>;
  };
  expect(manifest.entries.map((entry) => entry.path)).toEqual(["a.txt"]);
  expect(readFileSync(join(dir, "tree", "a.txt"), "utf8")).toBe(KEPT);
}

/**
 * DELETE → 204 and no row. The scripted children report a session file outside the owner's session
 * dir, which the deleter would report; the row is given a real one there first, so the error
 * channel carries snapshot reports only.
 */
async function deleted(world: RecordingWorld & Roots, session: string): Promise<void> {
  const { app, db } = world.fixture;
  presetFile(
    db,
    session,
    ownedFile(ownerSessionDir(world.rt.runtime.stateDir), `${session}.jsonl`),
  );
  expectDeleted(await sendDelete(app, session, world.cookie));
  expect(sessionState(db, session).row).toBeUndefined();
}

function workspaceRow(world: RecordingWorld, id: string) {
  return world.fixture.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
}

function registrations(world: RecordingWorld): number {
  return count(world.fixture.db, "SELECT COUNT(*) AS count FROM chat_turn_snapshots");
}

/** The kinds of the audit events written since `before` was read. */
async function auditKindsSince(world: RecordingWorld, before: number): Promise<string[]> {
  const events = await auditEvents(world.fixture.app, world.cookie);
  return events
    .slice(0, events.length - before)
    .map((event) => event.kind)
    .sort();
}

describe("快照清理 — 会话删除 (workspace-snapshots「快照清理」, session-metadata「会话删除」)", () => {
  // Spawns: 0 A's process, 1 B's process.
  it("随会话删除清理: the three snapshots of the deleted session are gone, the other session's is readable", async () => {
    const world = await openFilesWorld(worlds);
    const { workspace, a, own, other } = await sharedByTwo(world, 3);
    expect(own.map((id) => existsSync(join(snapshotDir(workspace, id), "manifest.json")))).toEqual([
      true,
      true,
      true,
    ]);

    await deleted(world, a);

    expect(own.map((id) => existsSync(snapshotDir(workspace, id)))).toEqual([false, false, false]);
    expectReadable(workspace, other);
    expect(registrations(world)).toBe(1);
    expect(world.errors).toEqual([]);
  });

  it("绑定正式空间的会话只清自己的快照: B's snapshot, the workspace row, directory and files are as they were", async () => {
    const world = await openFilesWorld(worlds);
    const { workspace, a, own, other } = await sharedByTwo(world, 2);
    const before = {
      row: workspaceRow(world, workspace.id),
      files: names(workspace.root),
      snapshot: names(snapshotDir(workspace, other)),
    };
    const audits = (await auditEvents(world.fixture.app, world.cookie)).length;

    await deleted(world, a);

    expect(own.map((id) => existsSync(snapshotDir(workspace, id)))).toEqual([false, false]);
    expect({
      row: workspaceRow(world, workspace.id),
      files: names(workspace.root),
      snapshot: names(snapshotDir(workspace, other)),
    }).toEqual(before);
    expect(before.files).toEqual(["a.txt"]);
    expectReadable(workspace, other);
    expect(readFileSync(join(workspace.root, "a.txt"), "utf8")).toBe(KEPT);
    expect(await auditKindsSince(world, audits)).toEqual(["session.delete"]);
    expect(world.errors).toEqual([]);
  });

  it("清理失败不影响删除: a rejecting removal of the one snapshot is 204 and one report", async () => {
    const service = (real: TurnSnapshotService) => ({ ...real, remove: refuse });
    const world = await openFilesWorld(worlds, [{}], {}, service);
    const workspace = await formalWorkspace(world);
    const session = await boundSession(world, workspace);
    const [only] = await turns(world, 1, session);

    await deleted(world, session);

    expect(world.errors).toEqual([REFUSED]);
    expect(registrations(world)).toBe(0);
    expect(existsSync(snapshotDir(workspace, Number(only)))).toBe(true);
  });

  it("清理失败不影响删除: a rejecting whole-directory removal is 204, one report, and the workspace directory still goes", async () => {
    const service = (real: TurnSnapshotService) => ({ ...real, removeWorkspace: refuse });
    const world = await openFilesWorld(worlds, [{}], {}, service);
    await turns(world, 1);

    await deleted(world, world.session);

    expect(world.errors).toEqual([REFUSED]);
    expect(workspaceRow(world, world.workspaceId)).toBeUndefined();
    expect(existsSync(world.root)).toBe(false);
  });

  it("临时空间删除时整目录清理: the workspace's whole snapshot directory is gone with its only session", async () => {
    const world = await openFilesWorld(worlds);
    const [only] = await turns(world, 1);
    expect(existsSync(join(snapshotDir(world, Number(only)), "manifest.json"))).toBe(true);

    await deleted(world, world.session);

    expect(existsSync(world.snapshots)).toBe(false);
    expect(world.errors).toEqual([]);
  });

  it("删除连同快照与独占的临时空间: rows, the workspace directory and its snapshot directory are gone", async () => {
    const world = await openFilesWorld(worlds);
    const { db } = world.fixture;
    put(world, "a.txt", KEPT);
    const own = await turns(world, 2);
    expect(own.map((id) => existsSync(join(snapshotDir(world, id), "manifest.json")))).toEqual([
      true,
      true,
    ]);
    expect(sessionState(db, world.session)).toMatchObject({ messages: 4, row: { status: "done" } });
    const audits = (await auditEvents(world.fixture.app, world.cookie)).length;

    await deleted(world, world.session);

    expect(sessionState(db, world.session)).toMatchObject({ row: undefined, messages: 0 });
    expect(registrations(world)).toBe(0);
    expect(workspaceRow(world, world.workspaceId)).toBeUndefined();
    expect([existsSync(world.root), existsSync(world.snapshots)]).toEqual([false, false]);
    expect(await auditKindsSince(world, audits)).toEqual(["session.delete", "workspace.delete"]);
    expect(world.errors).toEqual([]);
  });
});

describe("快照清理 — 删除事务回滚 (workspace-snapshots「快照清理」: 事务提交后)", () => {
  it("删除事务回滚: a failing audit write is the generic 5xx and leaves rows and snapshot directories", async () => {
    const world = await openFilesWorld(worlds);
    const { app, db } = world.fixture;
    put(world, "a.txt", KEPT);
    const own = await turns(world, 2);
    const before = names(world.snapshots);
    db.exec(
      "CREATE TEMP TRIGGER delete_audit_down BEFORE INSERT ON audit_events WHEN NEW.kind = 'session.delete' BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );

    expectEnvelope(
      await sendDelete(app, world.session, world.cookie),
      500,
      INTERNAL_ERROR_ENVELOPE,
    );

    db.exec("DROP TRIGGER delete_audit_down");
    expect(sessionState(db, world.session)).toMatchObject({ messages: 4, row: { status: "done" } });
    expect(registrations(world)).toBe(2);
    expect(workspaceRow(world, world.workspaceId)).toBeDefined();
    expect(names(world.snapshots)).toEqual(before);
    for (const id of own) {
      expectReadable(world, id);
    }
    expect(existsSync(world.root)).toBe(true);
  });
});

describe("快照清理 — 归档 (session-metadata「归档保留临时空间与快照」)", () => {
  // Spawns: 0 the session's process, 1 the undo's temporary process.
  it("归档保留临时空间与快照: row, directory, files and both snapshots are unchanged; undo works once restored", async () => {
    const world = await openFilesWorld(worlds);
    put(world, "a.txt", KEPT);
    const [, u2] = await turns(world, 2);
    put(world, "b.txt", "made by the second turn");
    const seen = () => ({
      row: workspaceRow(world, world.workspaceId),
      files: contents(world),
      snapshots: names(world.snapshots),
      registrations: registrations(world),
    });
    const before = seen();
    expect(before.snapshots.filter((name) => name.endsWith("manifest.json"))).toHaveLength(2);

    expect((await patched(patch(world, { archived: true }))).archivedAt).toEqual(
      expect.any(Number),
    );

    expect(seen()).toEqual(before);
    expect(world.errors).toEqual([]);
    expect((await patched(patch(world, { archived: false }))).archivedAt).toBeNull();
    at(clock + 10);
    const body = restoredBy(await undoWith(world, Number(u2), "restore"));
    expect(body.files).toMatchObject({ restored: 0, removed: 1 });
    expect(contents(world)).toEqual({ "a.txt": KEPT });
    expect(existsSync(snapshotDir(world, Number(u2)))).toBe(false);
  });
});

describe("快照清理 — 撤回 (message-undo「对话原地回退」step 6)", () => {
  // Spawns: 0 A's process, 1 B's process, 2 the undo's temporary process.
  it("撤回 u2: the snapshots of u2 and u3 are gone, u1's and the other session's are readable", async () => {
    const world = await openFilesWorld(worlds, [{}, {}, { messages: entries(3) }]);
    const { workspace, a, own, other } = await sharedByTwo(world, 3);
    const [u1, u2, u3] = own.map(Number) as [number, number, number];
    at(clock + 10);

    expect(undone(await postUndo(world, u2, a, "keep")).draft).toBe(QUESTION);

    expect([u2, u3].map((id) => existsSync(snapshotDir(workspace, id)))).toEqual([false, false]);
    expectReadable(workspace, u1);
    expectReadable(workspace, other);
    expect(registrations(world)).toBe(2);
    expect(world.errors).toEqual([]);
  });

  // Spawns: 0 the session's process, 1 the undo's temporary process (stdout kept open).
  it("最终事务复核失败: an undo refused by its transaction leaves every snapshot directory", async () => {
    const world = await openFilesWorld(worlds, [{}, { keepStdout: true }]);
    const { db } = world.fixture;
    put(world, "a.txt", KEPT);
    const own = await turns(world, 2);
    const before = names(world.snapshots);
    const work = Promise.resolve(postUndo(world, Number(own[1])));
    // After the get_state reply: the temporary process is closing, the commit has not run.
    const temp = await tempClosing(world, 1);
    db.prepare("UPDATE chat_sessions SET status = 'running' WHERE id = ?").run(world.session);
    temp.endStdout();
    temp.exit(0);

    expectEnvelope(await work, 409, SESSION_BUSY_ENVELOPE);

    expect(names(world.snapshots)).toEqual(before);
    for (const id of own) {
      expectReadable(world, id);
    }
    expect(registrations(world)).toBe(2);
    expect(world.errors).toEqual([]);
    db.prepare("UPDATE chat_sessions SET status = 'done' WHERE id = ?").run(world.session);
  });

  // Spawns: 0 the session's process, 1 the undo's temporary process.
  it("清理失败不影响撤回: rejecting removals are 200, both list events, one report per removed snapshot", async () => {
    const world = await openListeningScripted([{}, { messages: entries(3) }], (real) => ({
      ...real,
      remove: refuse,
    }));
    const [, u2] = await turns(world, 3);
    const { client, mark } = await listFrom(world);
    at(clock + 10);

    expect(undone(await postUndo(world, Number(u2))).draft).toBe(QUESTION);

    expect(world.errors).toEqual([REFUSED, REFUSED]);
    expect(registrations(world)).toBe(1);
    expect(withoutChanged(await framesSince(world, client, mark))).toEqual({
      rest: rewoundFrame(world.session),
      changed: expect.toSatisfy((changed: number) => changed >= 1),
    });
  });
});
