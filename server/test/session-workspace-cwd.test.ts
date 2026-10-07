/**
 * Issue #521 session spawn cwd follows the workspace binding (parent s1c-session-metadata-
 * presentation tasks 2.2, design D4). Every world is the production createApp → registerSessions
 * assembly over real fake-omp children whose probe turn reports `cwd=<process.cwd()>` (#520).
 * Workspaces are created over `POST /api/workspaces` (the sandbox root is created first: the
 * workspace store realpaths it); the binding is a direct SQL write of `chat_sessions.workspace_id`
 * (no binding route before 4.1) with foreign keys on. Oracles: spawn argv and spawn cwd, the probe
 * report, REST envelope bytes, SQLite rows, the filesystem and `liveProcessCount`. Paths are
 * compared through realpath (macOS tmpdir is /var → /private/var; `rootOf` answers canonical).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { REAL, settle } from "./session-approval-helpers.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import { FIRST, messagesOf, rowCounts, turn } from "./session-fork-helpers.js";
import {
  openRegenWorld,
  QUESTION,
  type RegenWorld,
  regenWorlds,
  sendPrompt,
  snapshot,
  waitDead,
} from "./session-regenerate-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  getSessionMessages,
} from "./session-rest-helpers.js";
import {
  createSession,
  IDLE_MS,
  OWNER_ID,
  requiredCall,
  resumePath,
  type SpawnCall,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { seedUnboundSession, workspaceOf } from "./support/temporary-workspace.js";

const UNBOUND = "7".repeat(32);
const worlds = regenWorlds();
const probeDirs: string[] = [];

afterEach(() => {
  for (const dir of probeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Workspace {
  id: string;
  root: string;
}

interface BoundWorld {
  world: RegenWorld;
  sandboxRoot: string;
  ownerRoot: string;
  workspace: Workspace;
}

/** A real fake-omp (`branch`) world whose own session is bound to u1's workspace `proj`. */
async function openBound(): Promise<BoundWorld> {
  const world = worlds.track(await openRegenWorld());
  const sandboxRoot = world.rt.runtime.sandboxRoot;
  mkdirSync(sandboxRoot, { recursive: true });
  const workspace = await createWorkspace(world, world.cookie, "proj");
  bind(world.fixture.db, world.session, workspace.id);
  return { world, sandboxRoot, ownerRoot: join(sandboxRoot, OWNER_ID), workspace };
}

async function createWorkspace(world: RegenWorld, cookie: string, name: string) {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({ name, dir: name }),
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Workspace;
}

function bind(db: DatabaseSync, session: string, workspaceId: string): void {
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  const result = db
    .prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?")
    .run(workspaceId, session);
  expect(Number(result.changes)).toBe(1);
}

function boundWorkspace(db: DatabaseSync, session: string): string | null | undefined {
  const row = db.prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?").get(session) as
    | { workspace_id: string | null }
    | undefined;
  return row?.workspace_id;
}

function workspaceRows(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n);
}

/** One REST probe turn to done; returns the child's reported `cwd=` (the report's last field). */
async function probeTurn(world: RegenWorld, session = world.session): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-521-probe-"));
  probeDirs.push(dir);
  const message = `probe:${String(process.pid)}:${join(dir, "out.txt")}`;
  expect((await sendPrompt(world, message, session)).statusCode).toBe(202);
  const tree = await waitForTurn(world.fixture, session, "done");
  await settle();
  const report = tree.messages.at(-1)?.content ?? "";
  const at = report.lastIndexOf(" cwd=");
  expect(at).toBeGreaterThan(0);
  return report.slice(at + " cwd=".length);
}

/** Idle-retires the live child `index` through the injected clock and waits for its exit. */
async function idleRetire(world: RegenWorld, index: number): Promise<void> {
  world.rt.clock.advance(IDLE_MS);
  await waitDead(world, index);
  await settle();
  expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
}

function cwdArg(args: readonly string[]): string | undefined {
  const at = args.indexOf("--cwd");
  return at === -1 ? undefined : args[at + 1];
}

function sessionDirArg(args: readonly string[]): string | undefined {
  const at = args.indexOf("--session-dir");
  return at === -1 ? undefined : args[at + 1];
}

/** The argv with the `--cwd` value masked and a trailing `--resume <file>` pair dropped. */
function argvShape(args: readonly string[]): string[] {
  const cwdAt = args.indexOf("--cwd") + 1;
  const masked = args.map((arg, index) => (index === cwdAt ? "<cwd>" : arg));
  const resumeAt = masked.indexOf("--resume");
  return resumeAt === -1 ? masked : masked.slice(0, resumeAt);
}

/** `--cwd` and the spawn cwd option are the one expected value. */
function expectSpawnCwd(call: SpawnCall, cwd: string): void {
  expect(cwdArg(call.args)).toBe(cwd);
  expect(call.cwd).toBe(cwd);
}

function postFork(world: RegenWorld, messageId: number) {
  return postSessionAction(world.fixture.app, "fork", world.session, world.cookie, {
    name: "fork body",
    payload: JSON.stringify({ messageId }),
    contentType: "application/json",
  });
}

function firstUserId(world: RegenWorld): number {
  const user = messagesOf(world.fixture.db, world.session).find((m) => m.role === "user");
  if (user === undefined) {
    throw new Error("missing user message");
  }
  return user.id;
}

describe("session spawn cwd follows the workspace binding", () => {
  it(
    "spawns a bound session in its workspace root and an unbound one in the owner root",
    REAL,
    async () => {
      const { world, ownerRoot, workspace } = await openBound();
      const { store, db } = world.fixture;
      // REST no longer creates an unbound session (#930): the legacy row is written directly.
      const unbound = seedUnboundSession(db, OWNER_ID, UNBOUND);
      expect(realpathSync(workspace.root)).toBe(realpathSync(join(ownerRoot, "proj")));
      expect(store.runtimeState(world.session)?.workspaceId).toBe(workspace.id);
      expect(store.runtimeState(unbound)?.workspaceId).toBeNull();

      const boundCwd = await probeTurn(world);
      const unboundCwd = await probeTurn(world, unbound);

      const bound = requiredCall(world.rt.calls, 0);
      const legacy = requiredCall(world.rt.calls, 1);
      expect(world.rt.calls).toHaveLength(2);
      expectSpawnCwd(bound, workspace.root);
      expect(boundCwd).toBe(realpathSync(workspace.root));
      expectSpawnCwd(legacy, ownerRoot);
      expect(unboundCwd).toBe(realpathSync(ownerRoot));
      expect(bound.command).toBe(legacy.command);
      expect(argvShape(bound.args)).toEqual(argvShape(legacy.args));
      expect(sessionDirArg(bound.args)).toBe(sessionDirArg(legacy.args));
      expect(bound.args).not.toContain("--resume");
      expect(legacy.args).not.toContain("--resume");
    },
  );

  it.each(["bound", "unbound", "temporary"] as const)(
    "resumes a %s session after idle retirement with the identical --cwd and probe cwd",
    REAL,
    async (kind) => {
      const { world, ownerRoot, workspace } = await openBound();
      const { app, db } = world.fixture;
      // REST no longer creates an unbound session (#930): the legacy row is written directly.
      // A session created without a workspace runs in its own temporary workspace's root.
      const sessions = {
        bound: () => world.session,
        unbound: () => seedUnboundSession(db, OWNER_ID, UNBOUND),
        temporary: () => createSession(app, world.cookie),
      };
      const session = await sessions[kind]();
      const roots = {
        bound: () => workspace.root,
        unbound: () => ownerRoot,
        // The store answers a temporary workspace's root under the sandbox root's real path.
        temporary: () => join(realpathSync(ownerRoot), `tmp-${workspaceOf(db, session)}`),
      };
      const expected = roots[kind]();

      const first = await probeTurn(world, session);
      await idleRetire(world, 0);
      const second = await probeTurn(world, session);

      const [cold, resumed] = [requiredCall(world.rt.calls, 0), requiredCall(world.rt.calls, 1)];
      expect(world.rt.calls).toHaveLength(2);
      expectSpawnCwd(cold, expected);
      expectSpawnCwd(resumed, expected);
      expect(cwdArg(resumed.args)).toBe(cwdArg(cold.args));
      expect(resumePath(cold.args)).toBeUndefined();
      expect(typeof resumePath(resumed.args)).toBe("string");
      expect(sessionDirArg(resumed.args)).toBe(sessionDirArg(cold.args));
      expect(argvShape(resumed.args)).toEqual(argvShape(cold.args));
      expect(first).toBe(realpathSync(expected));
      expect(second).toBe(first);
    },
  );
});

describe("绑定不可改与工作目录 — 三种会话的工作目录 (#930)", () => {
  it(
    "绑定会话的进程工作目录: W's root, the account root for a legacy unbound row, the temporary workspace root for a bodyless create",
    REAL,
    async () => {
      const { world, ownerRoot, workspace } = await openBound();
      const { app, db } = world.fixture;
      const legacy = seedUnboundSession(db, OWNER_ID, UNBOUND);
      const fresh = await createSession(app, world.cookie);
      // The store answers a temporary workspace's root under the sandbox root's real path.
      const temporaryRoot = join(realpathSync(ownerRoot), `tmp-${workspaceOf(db, fresh)}`);
      const rows = workspaceRows(db);
      const entries = readdirSync(ownerRoot).sort();
      expect(entries).toContain(`tmp-${workspaceOf(db, fresh)}`);

      const reported = [
        await probeTurn(world),
        await probeTurn(world, legacy),
        await probeTurn(world, fresh),
      ];

      expect(reported).toEqual([
        realpathSync(workspace.root),
        realpathSync(ownerRoot),
        realpathSync(temporaryRoot),
      ]);
      expect(world.rt.calls).toHaveLength(3);
      expectSpawnCwd(requiredCall(world.rt.calls, 0), workspace.root);
      expectSpawnCwd(requiredCall(world.rt.calls, 1), ownerRoot);
      expectSpawnCwd(requiredCall(world.rt.calls, 2), temporaryRoot);
      // The legacy row is left as it was: still unbound, no workspace row or directory made for it.
      expect(boundWorkspace(db, legacy)).toBeNull();
      expect(workspaceRows(db)).toBe(rows);
      expect(readdirSync(ownerRoot).sort()).toEqual(entries);
    },
  );

  it(
    "存量未绑定会话照常可用: listed unbound, its snapshot readable, the next prompt 202 in the account root, no tmp- directory made",
    REAL,
    async () => {
      const { world, ownerRoot } = await openBound();
      const { app, db, store } = world.fixture;
      const legacy = seedUnboundSession(db, OWNER_ID, UNBOUND);
      for (const text of ["第一轮", "第二轮"]) {
        store.finishTurn(store.acceptPrompt(legacy, OWNER_ID, text).assistantMessageId, "done");
      }
      const rows = workspaceRows(db);
      const entries = readdirSync(ownerRoot).sort();

      const list = await app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: world.cookie },
      });
      expect(list.statusCode).toBe(200);
      const item = (list.json() as { sessions: Array<{ id: string }> }).sessions.find(
        (session) => session.id === legacy,
      );
      expect(item).toMatchObject({ id: legacy, workspaceId: null, temporaryWorkspace: false });
      const snapshot = await getSessionMessages(app, legacy, world.cookie);
      expect(snapshot.statusCode).toBe(200);
      expect(
        (snapshot.json() as { messages: Array<{ role: string }> }).messages.map((m) => m.role),
      ).toEqual(["user", "assistant", "user", "assistant"]);

      // `probeTurn` asserts the prompt's 202 (its `undo` value is task 10.6).
      const reported = await probeTurn(world, legacy);

      expect(reported).toBe(realpathSync(ownerRoot));
      expectSpawnCwd(requiredCall(world.rt.calls, 0), ownerRoot);
      expect(boundWorkspace(db, legacy)).toBeNull();
      expect(workspaceRows(db)).toBe(rows);
      expect(readdirSync(ownerRoot).sort()).toEqual(entries);
    },
  );
});

describe("a bound session whose workspace root is unusable", () => {
  it("returns 502 without spawning or recreating a removed root", REAL, async () => {
    const { world, ownerRoot, workspace } = await openBound();
    const { db, supervisor } = world.fixture;
    await probeTurn(world);
    await idleRetire(world, 0);
    rmSync(workspace.root, { recursive: true });
    const before = snapshot(db, world.session, true);
    const ownerEntries = readdirSync(ownerRoot);

    const response = await sendPrompt(world, "after removal");

    expectEnvelope(response, 502, AGENT_UNAVAILABLE_ENVELOPE);
    expect(world.rt.calls).toHaveLength(1);
    expect(existsSync(workspace.root)).toBe(false);
    expect(readdirSync(ownerRoot)).toEqual(ownerEntries);
    expect(snapshot(db, world.session, true)).toEqual(before);
    expect(supervisor.liveProcessCount()).toBe(0);
    expect(supervisor.controlHeld(world.session)).toBe(false);
  });

  it("returns 502 without spawning when a plain file occupies the root", REAL, async () => {
    const { world, workspace } = await openBound();
    const { db, supervisor } = world.fixture;
    rmSync(workspace.root, { recursive: true });
    writeFileSync(workspace.root, "occupied");
    const before = snapshot(db, world.session, true);

    const response = await sendPrompt(world, "file in the way");

    expectEnvelope(response, 502, AGENT_UNAVAILABLE_ENVELOPE);
    expect(world.rt.calls).toHaveLength(0);
    expect(readFileSync(workspace.root, "utf8")).toBe("occupied");
    expect(snapshot(db, world.session, true)).toEqual(before);
    expect(supervisor.liveProcessCount()).toBe(0);
  });

  it(
    "fails generically (500, not 502) when rootOf answers null for another owner's workspace",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { db, app, supervisor } = world.fixture;
      const sandboxRoot = world.rt.runtime.sandboxRoot;
      mkdirSync(sandboxRoot, { recursive: true });
      const foreign = await createWorkspace(world, await cookieFor(app, "zhaoliu"), "proj");
      expect(realpathSync(foreign.root)).toBe(realpathSync(join(sandboxRoot, "u2", "proj")));
      // The owner root holds what creating the world's session made (#930): the directory of its
      // own temporary workspace, and nothing else.
      const ownerRoot = join(sandboxRoot, OWNER_ID);
      const own = workspaceOf(db, world.session);
      expect(readdirSync(ownerRoot)).toEqual([`tmp-${own}`]);
      bind(db, world.session, foreign.id);
      const before = snapshot(db, world.session, true);

      const response = await sendPrompt(world, "foreign binding");

      expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
      expect(world.rt.calls).toHaveLength(0);
      expect(snapshot(db, world.session, true)).toEqual(before);
      expect(readdirSync(foreign.root)).toEqual([]);
      // No fallback to the owner root: nothing was written into it, and its own temporary
      // workspace directory is still empty.
      expect(readdirSync(ownerRoot)).toEqual([`tmp-${own}`]);
      expect(readdirSync(join(ownerRoot, `tmp-${own}`))).toEqual([]);
      expect(supervisor.liveProcessCount()).toBe(0);
    },
  );
});

describe("regenerate and fork resolve the same cwd", () => {
  it(
    "regenerate's lazy acquisition and fork's temporary process use the workspace root",
    REAL,
    async () => {
      const { world, workspace } = await openBound();
      const { app } = world.fixture;
      await turn(world, FIRST);
      await turn(world, QUESTION);
      await idleRetire(world, 0);

      const regenerated = await postSessionAction(app, "regenerate", world.session, world.cookie);
      expect(regenerated.statusCode).toBe(202);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      const lazy = requiredCall(world.rt.calls, 1);
      expectSpawnCwd(lazy, workspace.root);
      expect(typeof resumePath(lazy.args)).toBe("string");

      const forked = await postFork(world, firstUserId(world));
      expect(forked.statusCode).toBe(201);
      const temporary = requiredCall(world.rt.calls, 2);
      expectSpawnCwd(temporary, workspace.root);
      expect(typeof resumePath(temporary.args)).toBe("string");
      expect(world.rt.calls).toHaveLength(3);
    },
  );

  it(
    "fails a fork of a bound source with a removed root as 502 before any temporary spawn",
    REAL,
    async () => {
      const { world, workspace } = await openBound();
      const { db, supervisor } = world.fixture;
      await turn(world, FIRST);
      rmSync(workspace.root, { recursive: true });
      const rows = rowCounts(db);

      const response = await postFork(world, firstUserId(world));

      expectEnvelope(response, 502, AGENT_UNAVAILABLE_ENVELOPE);
      expect(world.rt.calls).toHaveLength(1);
      expect(rowCounts(db)).toEqual(rows);
      expect(existsSync(workspace.root)).toBe(false);
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(supervisor.controlHeld(world.session)).toBe(false);
    },
  );
});

describe("production createApp shares one workspace store with sessions", () => {
  it("reports the cwd GET /api/workspaces lists as the bound workspace's root", REAL, async () => {
    const { world, workspace } = await openBound();
    const listed = await world.fixture.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: world.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const entries = (listed.json() as { workspaces: Workspace[] }).workspaces;
    expect(entries.map((entry) => entry.id)).toEqual([workspace.id]);
    const listedRoot = entries[0]?.root ?? "";

    const reported = await probeTurn(world);

    expect(listedRoot).toBe(workspace.root);
    expect(reported).toBe(realpathSync(listedRoot));
    expect(cwdArg(requiredCall(world.rt.calls, 0).args)).toBe(listedRoot);
  });
});
