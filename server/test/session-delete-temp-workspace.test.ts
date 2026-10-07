/**
 * Issues #928, #929 (s1f-session-list-temp-space tasks 5.1–5.3): a temporary workspace goes with
 * its last session — temporary-workspaces 「共用与随最后一个会话删除」 (five scenarios) and 「临时空间目录的删除」
 * (「经 trash 删除且不跟随链接」「目标被换成符号链接」「跨文件系统退为原地删除」「删除失败不影响响应」), session-metadata
 * 「继承临时空间」 and the directory part of 「删除连同快照与独占的临时空间」.
 * The DELETE cases run the production createApp → registerSessions assembly on a real SQLite and
 * real directories under the runtime's temp sandbox; sharing is built with the REST fork, the
 * promotion with the store's `promote` (its route is task 4.2). The
 * cases that need something to happen between `lstat` and `rename`, or a `rename` that fails, call
 * the exported removal function with their own `rename`. Oracles: SQL rows, `GET /api/audit`, the
 * file system (account root, trash, the tree outside) and the service error channel. Every path
 * touched is a per-test temporary directory.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { removeTemporaryWorkspaceDir } from "../src/workspaces/temp-dir-remove.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import {
  type AuditEventWire,
  auditEvents,
  auditRows,
  deleteEvent,
  deleteWorlds,
  expectDeleted,
  JSON_TYPE,
  openRealWorld,
  ownedDir,
  ownedFile,
  ownerSessionDir,
  presetFile,
  sendDelete,
  sessionState,
  trashDir,
} from "./session-delete-helpers.js";
import { OWNER_ID } from "./session-supervisor-helpers.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";

deleteWorlds();

const SOURCE = "5".repeat(32);
const WORKSPACE_ID = "a".repeat(32);
const NOT_A_DIRECTORY = "temporary workspace delete: the directory is not a directory";
const REPLACED_BEFORE_MOVE =
  "temporary workspace delete: the directory was replaced before it was moved";
const TRASH_UNAVAILABLE = "temporary workspace delete: trash directory is unavailable";
const INVALID_NAME = "temporary workspace delete: not a temporary workspace directory name";
const OUTSIDE_SANDBOX = "temporary workspace delete: account root outside the sandbox root";
const TREE = ["notes.md", "sub", join("sub", "deep.txt")];
const FORK_TIMEOUT = { timeout: 30_000 };

type RealWorld = Awaited<ReturnType<typeof openRealWorld>>;

interface Temporary {
  id: string;
  /** `<SANDBOX_ROOT realpath>/u1/tmp-<id>`, written out here: the audit's `detail.root`. */
  dir: string;
  /** A workspace store over the world's database and sandbox root. */
  store: ReturnType<typeof createWorkspaceStore>;
}

/** Every entry under `dir` with its type and, for files, its bytes: "unchanged" means equal. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .sort()
    .map((entry) => {
      const stats = lstatSync(join(dir, entry));
      const body = stats.isFile() ? readFileSync(join(dir, entry), "utf8") : "";
      const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : "file";
      return `${entry} ${kind} ${body}`;
    });
}

function names(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

/** One file and one nested directory holding one file. */
function fill(dir: string): void {
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "调研笔记\n");
  writeFileSync(join(dir, "sub", "deep.txt"), "nested\n");
}

/** A committed temporary workspace of the owner with `session` bound to it and a filled directory. */
function seedTemporary(world: RealWorld, session = SOURCE): Temporary {
  const { db } = world.fixture;
  const { sandboxRoot, stateDir } = world.rt.runtime;
  // No spawn has run yet, so the runtime's temp sandbox root may not exist.
  mkdirSync(sandboxRoot, { recursive: true });
  const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
  const { id } = seedTemporaryWorkspaceSession(db, store, OWNER_ID, session);
  const dir = join(realpathSync(sandboxRoot), OWNER_ID, `tmp-${id}`);
  expect(lstatSync(dir).isDirectory()).toBe(true);
  fill(dir);
  ownerSessionDir(stateDir);
  return { id, dir, store };
}

function workspaceRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT owner_id, dir, temporary FROM workspaces WHERE id = ?").get(id) as
    | { owner_id: string; dir: string; temporary: number }
    | undefined;
}

function boundTo(db: DatabaseSync, session: string): string | null | undefined {
  const row = db.prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?").get(session) as
    | { workspace_id: string | null }
    | undefined;
  return row?.workspace_id;
}

function workspaceCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n);
}

function temporaryDirs(world: RealWorld): string[] {
  return readdirSync(join(world.rt.runtime.sandboxRoot, OWNER_ID)).filter((name) =>
    name.startsWith("tmp-"),
  );
}

async function workspaceDeletes(world: RealWorld): Promise<AuditEventWire[]> {
  const events = await auditEvents(world.fixture.app, world.cookie);
  return events.filter((event) => event.kind === "workspace.delete");
}

/** The `GET /api/audit` wire form of the `workspace.delete` written for `session`. */
function workspaceDeleteEvent(temporary: Temporary, session: string) {
  return {
    id: expect.any(Number),
    ts: expect.any(Number),
    actorId: OWNER_ID,
    kind: "workspace.delete",
    title: "删除临时空间",
    detail: { root: temporary.dir, sessionId: session },
    workspaceId: temporary.id,
  };
}

function trashOf(world: RealWorld): string[] {
  return readdirSync(trashDir(world.rt.runtime.stateDir));
}

function messages(world: RealWorld): string[] {
  return world.errors.map((error) => error.message);
}

async function deleted(world: RealWorld, session: string): Promise<void> {
  expectDeleted(await sendDelete(world.fixture.app, session, world.cookie));
  expect(sessionState(world.fixture.db, session).row).toBeUndefined();
}

interface SessionWire {
  id: string;
  workspaceId: string | null;
  temporaryWorkspace: boolean;
  archivedAt: number | null;
}

async function listed(world: RealWorld): Promise<SessionWire[]> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { sessions: SessionWire[] }).sessions;
}

/** Two settled turns on SOURCE and a real resume file, then `POST …/fork` at the second question. */
async function forkSource(world: RealWorld): Promise<SessionWire> {
  const { app, db, store } = world.fixture;
  const first = store.acceptPrompt(SOURCE, OWNER_ID, "first question");
  store.finishTurn(first.assistantMessageId, "done");
  const second = store.acceptPrompt(SOURCE, OWNER_ID, "second question");
  store.finishTurn(second.assistantMessageId, "done");
  presetFile(db, SOURCE, ownedFile(ownerSessionDir(world.rt.runtime.stateDir), "source.jsonl"));
  const response = await postSessionAction(app, "fork", SOURCE, world.cookie, {
    name: "fork body",
    payload: JSON.stringify({ messageId: second.userMessageId }),
    contentType: JSON_TYPE,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { session: SessionWire }).session;
}

describe("fork 继承会话元数据 — 继承临时空间 (#928)", () => {
  it(
    "the fork is bound to the same temporary workspace: no new row, no new directory",
    FORK_TIMEOUT,
    async () => {
      const world = await openRealWorld("branch");
      const temporary = seedTemporary(world);
      const rows = workspaceCount(world.fixture.db);
      const dirs = temporaryDirs(world);

      const fork = await forkSource(world);

      expect([fork.workspaceId, fork.temporaryWorkspace, fork.archivedAt]).toEqual([
        temporary.id,
        true,
        null,
      ]);
      const views = (await listed(world)).filter((view) => [SOURCE, fork.id].includes(view.id));
      expect(views.map((view) => [view.workspaceId, view.temporaryWorkspace])).toEqual([
        [temporary.id, true],
        [temporary.id, true],
      ]);
      expect(workspaceCount(world.fixture.db)).toBe(rows);
      expect(temporaryDirs(world)).toEqual(dirs);
      expect(dirs).toEqual([`tmp-${temporary.id}`]);
    },
  );
});

describe("共用与随最后一个会话删除 (#928)", () => {
  it("独占的临时空间随会话删除: row and directory gone, both audits written", async () => {
    const world = await openRealWorld();
    const { app, db } = world.fixture;
    const temporary = seedTemporary(world);
    expect(names(temporary.dir)).toEqual(TREE);
    const audits = auditRows(db);

    await deleted(world, SOURCE);

    expect(workspaceRow(db, temporary.id)).toBeUndefined();
    expect(existsSync(temporary.dir)).toBe(false);
    expect(temporaryDirs(world)).toEqual([]);
    expect(trashOf(world)).toEqual([]);
    expect(auditRows(db)).toBe(audits + 2);
    expect(await auditEvents(app, world.cookie, 2)).toEqual([
      workspaceDeleteEvent(temporary, SOURCE),
      deleteEvent(SOURCE, null, 0, temporary.id),
    ]);
    // The unbound session the world opened with is no user of anything.
    expect(sessionState(db, world.session).row).toBeDefined();
    expect(world.errors).toEqual([]);
  });

  it(
    "共用时保留到最后一个会话: kept while the fork uses it, gone with the fork",
    FORK_TIMEOUT,
    async () => {
      const world = await openRealWorld("branch");
      const { db } = world.fixture;
      const temporary = seedTemporary(world);
      const fork = await forkSource(world);
      const before = snapshot(temporary.dir);

      await deleted(world, SOURCE);

      expect(workspaceRow(db, temporary.id)).toEqual({
        owner_id: OWNER_ID,
        dir: `tmp-${temporary.id}`,
        temporary: 1,
      });
      expect(snapshot(temporary.dir)).toEqual(before);
      expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
      expect(boundTo(db, fork.id)).toBe(temporary.id);
      expect((await listed(world)).find((view) => view.id === fork.id)).toMatchObject({
        workspaceId: temporary.id,
        temporaryWorkspace: true,
      });
      expect(await workspaceDeletes(world)).toEqual([]);

      await deleted(world, fork.id);

      expect(workspaceRow(db, temporary.id)).toBeUndefined();
      expect(existsSync(temporary.dir)).toBe(false);
      expect(trashOf(world)).toEqual([]);
      expect(await workspaceDeletes(world)).toEqual([workspaceDeleteEvent(temporary, fork.id)]);
      expect(world.errors).toEqual([]);
    },
  );

  it("归档的会话仍算使用者: an archived fork keeps the workspace", FORK_TIMEOUT, async () => {
    const world = await openRealWorld("branch");
    const { app, db } = world.fixture;
    const temporary = seedTemporary(world);
    const fork = await forkSource(world);
    const archived = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${fork.id}`,
      headers: { cookie: world.cookie, "content-type": JSON_TYPE },
      payload: JSON.stringify({ archived: true }),
    });
    expect(archived.statusCode).toBe(200);
    expect((archived.json() as SessionWire).archivedAt).toEqual(expect.any(Number));
    const before = snapshot(temporary.dir);

    await deleted(world, SOURCE);

    expect(workspaceRow(db, temporary.id)?.temporary).toBe(1);
    expect(snapshot(temporary.dir)).toEqual(before);
    expect(boundTo(db, fork.id)).toBe(temporary.id);
    expect(await workspaceDeletes(world)).toEqual([]);
    expect(world.errors).toEqual([]);
  });

  it("转正后不再随会话删除: the promoted workspace, its directory and files stay", async () => {
    const world = await openRealWorld();
    const { db } = world.fixture;
    const temporary = seedTemporary(world);
    // No promote route exists yet (task 4.2); the store method is what it will call.
    expect(temporary.store.promote({ id: OWNER_ID }, temporary.id, "调研资料")).toMatchObject({
      id: temporary.id,
      name: "调研资料",
    });
    const before = snapshot(temporary.dir);

    await deleted(world, SOURCE);

    expect(workspaceRow(db, temporary.id)).toEqual({
      owner_id: OWNER_ID,
      dir: `tmp-${temporary.id}`,
      temporary: 0,
    });
    expect(snapshot(temporary.dir)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
    expect(await workspaceDeletes(world)).toEqual([]);
    expect(world.errors).toEqual([]);
  });

  it("审计失败时什么都不删: a failing workspace.delete audit keeps session, workspace and directory", async () => {
    const world = await openRealWorld();
    const { app, db } = world.fixture;
    const temporary = seedTemporary(world);
    const before = snapshot(temporary.dir);
    const session = sessionState(db, SOURCE);
    const audits = auditRows(db);
    db.exec(`CREATE TEMP TRIGGER reject_workspace_delete_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'workspace.delete' BEGIN SELECT RAISE(ABORT, 'x'); END`);

    expectEnvelope(await sendDelete(app, SOURCE, world.cookie), 500, INTERNAL_ERROR_ENVELOPE);

    expect(sessionState(db, SOURCE)).toEqual(session);
    expect(session.row).toBeDefined();
    expect(workspaceRow(db, temporary.id)?.temporary).toBe(1);
    expect(snapshot(temporary.dir)).toEqual(before);
    expect(trashOf(world)).toEqual([]);
    expect(auditRows(db)).toBe(audits);
    db.exec("DROP TRIGGER reject_workspace_delete_audit");

    await deleted(world, SOURCE);
    expect(existsSync(temporary.dir)).toBe(false);
  });

  it("a session on an ordinary workspace or on none leaves every workspace and directory alone", async () => {
    const world = await openRealWorld();
    const { app, db } = world.fixture;
    const temporary = seedTemporary(world);
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: world.cookie, "content-type": JSON_TYPE },
      payload: JSON.stringify({ name: "项目A", dir: "project-a" }),
    });
    expect(created.statusCode).toBe(201);
    const normal = created.json() as { id: string };
    const normalDir = join(realpathSync(world.rt.runtime.sandboxRoot), OWNER_ID, "project-a");
    fill(normalDir);
    const bound = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: world.cookie, "content-type": JSON_TYPE },
      payload: JSON.stringify({ workspaceId: normal.id }),
    });
    expect(bound.statusCode).toBe(201);
    const rows = workspaceCount(db);

    await deleted(world, (bound.json() as { id: string }).id);
    await deleted(world, world.session);

    expect(workspaceCount(db)).toBe(rows);
    expect(workspaceRow(db, normal.id)?.temporary).toBe(0);
    expect(names(normalDir)).toEqual(TREE);
    expect(workspaceRow(db, temporary.id)?.temporary).toBe(1);
    expect(names(temporary.dir)).toEqual(TREE);
    expect(boundTo(db, SOURCE)).toBe(temporary.id);
    expect(await workspaceDeletes(world)).toEqual([]);
    expect(world.errors).toEqual([]);
  });
});

describe("会话删除 — 删除连同独占的临时空间（目录部分） (#928)", () => {
  it("a done session with two user messages: session, messages, workspace row and directory are gone", async () => {
    const world = await openRealWorld();
    const { db, store } = world.fixture;
    const temporary = seedTemporary(world);
    for (const text of ["first question", "second question"]) {
      store.finishTurn(store.acceptPrompt(SOURCE, OWNER_ID, text).assistantMessageId, "done");
    }
    expect(sessionState(db, SOURCE)).toMatchObject({ messages: 4, row: { status: "done" } });
    const audits = await auditEvents(world.fixture.app, world.cookie);

    await deleted(world, SOURCE);

    expect(sessionState(db, SOURCE)).toEqual({
      row: undefined,
      messages: 0,
      steps: 0,
      approvals: 0,
    });
    expect(workspaceRow(db, temporary.id)).toBeUndefined();
    expect(existsSync(temporary.dir)).toBe(false);
    const added = (await auditEvents(world.fixture.app, world.cookie)).slice(
      0,
      -audits.length || undefined,
    );
    expect(added.map((event) => event.kind).sort()).toEqual(["session.delete", "workspace.delete"]);
    expect(world.errors).toEqual([]);
  });
});

describe("临时空间目录的删除 — DELETE (#928)", () => {
  it("经 trash 删除且不跟随链接: links inside are removed, what they point at is untouched", async () => {
    const world = await openRealWorld();
    const temporary = seedTemporary(world);
    const outsideFile = ownedFile();
    const outsideDir = ownedDir();
    fill(outsideDir);
    const fileBytes = readFileSync(outsideFile, "utf8");
    const dirBefore = snapshot(outsideDir);
    symlinkSync(outsideFile, join(temporary.dir, "sub", "file-link"));
    symlinkSync(outsideDir, join(temporary.dir, "dir-link"));

    await deleted(world, SOURCE);

    expect(existsSync(temporary.dir)).toBe(false);
    expect(temporaryDirs(world)).toEqual([]);
    expect(trashOf(world)).toEqual([]);
    expect(readFileSync(outsideFile, "utf8")).toBe(fileBytes);
    expect(snapshot(outsideDir)).toEqual(dirBefore);
    expect(dirBefore.map((line) => line.split(" ")[0])).toEqual(TREE);
    expect(world.errors).toEqual([]);
  });

  it("目标被换成符号链接: the link and its target stay, one report, still 204", async () => {
    const world = await openRealWorld();
    const { db } = world.fixture;
    const temporary = seedTemporary(world);
    const target = ownedDir();
    fill(target);
    const before = snapshot(target);
    rmSync(temporary.dir, { recursive: true });
    symlinkSync(target, temporary.dir);

    await deleted(world, SOURCE);

    expect(workspaceRow(db, temporary.id)).toBeUndefined();
    expect(lstatSync(temporary.dir).isSymbolicLink()).toBe(true);
    expect(snapshot(target)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
    expect(trashOf(world)).toEqual([]);
    expect(messages(world)).toEqual([NOT_A_DIRECTORY]);
  });

  it("the account root swapped for a symlink: nothing behind the link is removed, one report", async () => {
    const world = await openRealWorld();
    const temporary = seedTemporary(world);
    const account = join(world.rt.runtime.sandboxRoot, OWNER_ID);
    const moved = join(ownedDir(), "moved");
    renameSync(account, moved);
    symlinkSync(moved, account);
    const before = snapshot(moved);

    await deleted(world, SOURCE);

    expect(lstatSync(account).isSymbolicLink()).toBe(true);
    expect(snapshot(moved)).toEqual(before);
    expect(names(join(moved, `tmp-${temporary.id}`))).toEqual(TREE);
    expect(trashOf(world)).toEqual([]);
    expect(messages(world)).toEqual([OUTSIDE_SANDBOX]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "删除失败不影响响应: 204, rows gone, one report, the residue is under the trash",
    async () => {
      const world = await openRealWorld();
      const { db } = world.fixture;
      const temporary = seedTemporary(world);
      const trash = trashDir(world.rt.runtime.stateDir);
      // A read-only (0500) directory: its entry cannot be unlinked, so the removal is partial.
      chmodSync(join(temporary.dir, "sub"), 0o500);
      let residue: string[] = [];
      try {
        await deleted(world, SOURCE);
        residue = readdirSync(trash);
        expect(residue).toHaveLength(1);
        expect(residue[0]).toMatch(/^[0-9a-f]{32}$/u);
        expect(names(join(trash, residue[0] ?? ""))).toEqual(["sub", join("sub", "deep.txt")]);
      } finally {
        // Wherever the locked directory ended up, teardown must be able to empty it.
        for (const holder of [temporary.dir, ...readdirSync(trash).map((n) => join(trash, n))]) {
          if (existsSync(join(holder, "sub"))) {
            chmodSync(join(holder, "sub"), 0o700);
          }
        }
      }

      expect(workspaceRow(db, temporary.id)).toBeUndefined();
      expect(existsSync(temporary.dir)).toBe(false);
      expect(world.errors).toHaveLength(1);
      expect((world.errors[0] as NodeJS.ErrnoException).code).toBe("EACCES");
    },
  );
});

/** An account root holding a filled `tmp-<id>`, and a 0700 trash, both under one test-owned dir. */
function seededRoots() {
  const base = realpathSync(ownedDir());
  const accountRoot = join(base, "sandbox", OWNER_ID);
  const trash = join(base, "state", "trash");
  const name = `tmp-${WORKSPACE_ID}`;
  const dir = join(accountRoot, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  fill(dir);
  return { accountRoot, trash, name, dir };
}

/** A `rename` that fails the way a move between two file systems does. */
function failing(code: string): typeof rename {
  return () => Promise.reject(Object.assign(new Error(`rename ${code}`), { code }));
}

/** The removal with `before` run at the rename call site, then `move` (the real rename if none). */
async function removeWith(
  target: { accountRoot: string; trash: string; name: string },
  before: () => void = () => {},
  move: typeof rename = rename,
): Promise<{ reports: Error[]; renames: string[][] }> {
  const reports: Error[] = [];
  const renames: string[][] = [];
  await removeTemporaryWorkspaceDir(
    target,
    (error) => {
      reports.push(error as Error);
    },
    (from, to) => {
      renames.push([String(from), String(to)]);
      before();
      return move(from, to);
    },
  );
  return { reports, renames };
}

describe("临时空间目录的删除 — removal function (#928)", () => {
  it("moves the directory to `<trash>/<32 hex>` and removes it there", async () => {
    const seeded = seededRoots();

    const { reports, renames } = await removeWith(seeded);

    expect(reports).toEqual([]);
    expect(renames).toHaveLength(1);
    expect(renames[0]?.[0]).toBe(seeded.dir);
    expect(renames[0]?.[1]).toMatch(new RegExp(`^${seeded.trash}/[0-9a-f]{32}$`, "u"));
    expect(readdirSync(seeded.accountRoot)).toEqual([]);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("目标被换成符号链接 before the check: no rename, link and target untouched, one report", async () => {
    const seeded = seededRoots();
    const target = ownedDir();
    fill(target);
    const before = snapshot(target);
    rmSync(seeded.dir, { recursive: true });
    symlinkSync(target, seeded.dir);

    const { reports, renames } = await removeWith(seeded);

    expect(renames).toEqual([]);
    expect(reports.map((error) => error.message)).toEqual([NOT_A_DIRECTORY]);
    expect(lstatSync(seeded.dir).isSymbolicLink()).toBe(true);
    expect(snapshot(target)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
  });

  it("目标被换成符号链接 between the check and the rename: only the link is unlinked, one report", async () => {
    const seeded = seededRoots();
    const target = ownedDir();
    fill(target);
    const before = snapshot(target);

    const { reports, renames } = await removeWith(seeded, () => {
      rmSync(seeded.dir, { recursive: true });
      symlinkSync(target, seeded.dir);
    });

    expect(renames).toHaveLength(1);
    expect(reports.map((error) => error.message)).toEqual([REPLACED_BEFORE_MOVE]);
    expect(snapshot(target)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
    expect(readdirSync(seeded.accountRoot)).toEqual([]);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("a regular file in its place is left alone and reported once", async () => {
    const seeded = seededRoots();
    rmSync(seeded.dir, { recursive: true });
    writeFileSync(seeded.dir, "planted");

    const { reports, renames } = await removeWith(seeded);

    expect(renames).toEqual([]);
    expect(reports.map((error) => error.message)).toEqual([NOT_A_DIRECTORY]);
    expect(readFileSync(seeded.dir, "utf8")).toBe("planted");
  });

  it("already gone, before the check or before the rename: nothing reported", async () => {
    const gone = seededRoots();
    rmSync(gone.dir, { recursive: true });
    expect(await removeWith(gone)).toEqual({ reports: [], renames: [] });

    const racing = seededRoots();
    const { reports, renames } = await removeWith(racing, () => {
      rmSync(racing.dir, { recursive: true });
    });
    expect(renames).toHaveLength(1);
    expect(reports).toEqual([]);
    expect(readdirSync(racing.trash)).toEqual([]);
  });

  it("a name that is not exactly `tmp-<32 hex>` touches nothing and is reported once", async () => {
    const seeded = seededRoots();
    fill(join(seeded.accountRoot, "project-a"));
    const before = snapshot(seeded.accountRoot);
    const bad = [
      "project-a",
      `${seeded.name}/../project-a`,
      `../${OWNER_ID}/${seeded.name}`,
      `tmp-${"A".repeat(32)}`,
      `${seeded.name}0`,
      "tmp-",
      "..",
      "",
    ];

    for (const name of bad) {
      const { reports, renames } = await removeWith({ ...seeded, name });
      expect([name, renames, reports.map((error) => error.message)]).toEqual([
        name,
        [],
        [INVALID_NAME],
      ]);
    }
    const relative = await removeWith({ ...seeded, accountRoot: "sandbox/u1" });
    expect([relative.renames, relative.reports.map((error) => error.message)]).toEqual([
      [],
      [INVALID_NAME],
    ]);

    expect(snapshot(seeded.accountRoot)).toEqual(before);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("跨文件系统退为原地删除: EXDEV removes it in place, what its links point at stays, no report", async () => {
    const seeded = seededRoots();
    const sibling = join(seeded.accountRoot, `tmp-${"b".repeat(32)}`);
    const outsideFile = ownedFile();
    const outsideDir = ownedDir();
    fill(sibling);
    fill(outsideDir);
    const outside = [readFileSync(outsideFile, "utf8"), ...snapshot(outsideDir)];
    symlinkSync(outsideFile, join(seeded.dir, "sub", "file-link"));
    symlinkSync(outsideDir, join(seeded.dir, "dir-link"));

    const { reports, renames } = await removeWith(seeded, undefined, failing("EXDEV"));

    expect(reports).toEqual([]);
    expect(renames).toHaveLength(1);
    expect(readdirSync(seeded.accountRoot)).toEqual([`tmp-${"b".repeat(32)}`]);
    expect(names(sibling)).toEqual(TREE);
    expect([readFileSync(outsideFile, "utf8"), ...snapshot(outsideDir)]).toEqual(outside);
    expect(names(outsideDir)).toEqual(TREE);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("EXDEV, then a symlink stands there: the link and its target stay, one report", async () => {
    const seeded = seededRoots();
    const target = ownedDir();
    fill(target);
    const before = snapshot(target);
    const swap = () => {
      rmSync(seeded.dir, { recursive: true });
      symlinkSync(target, seeded.dir);
    };

    const { reports } = await removeWith(seeded, swap, failing("EXDEV"));

    expect(reports.map((error) => error.message)).toEqual([NOT_A_DIRECTORY]);
    expect(lstatSync(seeded.dir).isSymbolicLink()).toBe(true);
    expect(snapshot(target)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
  });

  it("EXDEV, then the directory is gone: nothing reported", async () => {
    const seeded = seededRoots();
    const vanish = () => rmSync(seeded.dir, { recursive: true });

    const { reports, renames } = await removeWith(seeded, vanish, failing("EXDEV"));

    expect([reports, renames.length]).toEqual([[], 1]);
    expect(readdirSync(seeded.accountRoot)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "EXDEV, then the in-place removal fails: reported once, nothing thrown, the residue stays put",
    async () => {
      const seeded = seededRoots();
      // A read-only (0500) directory: its entry cannot be unlinked, so the removal is partial.
      chmodSync(join(seeded.dir, "sub"), 0o500);
      try {
        const { reports } = await removeWith(seeded, undefined, failing("EXDEV"));

        expect(reports.map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["EACCES"]);
        expect(readFileSync(join(seeded.dir, "sub", "deep.txt"), "utf8")).toBe("nested\n");
        expect(readdirSync(seeded.trash)).toEqual([]);
      } finally {
        chmodSync(join(seeded.dir, "sub"), 0o700);
      }
    },
  );

  it("a rename failing with another errno is reported and the directory stays where it was", async () => {
    const seeded = seededRoots();
    const before = snapshot(seeded.dir);

    const { reports } = await removeWith(seeded, undefined, failing("EACCES"));

    expect(reports.map((error) => (error as NodeJS.ErrnoException).code)).toEqual(["EACCES"]);
    expect(snapshot(seeded.dir)).toEqual(before);
    expect(before.map((line) => line.split(" ")[0])).toEqual(TREE);
    expect(readdirSync(seeded.trash)).toEqual([]);
  });

  it("a missing trash is told apart from a missing directory: reported, the directory stays", async () => {
    const seeded = seededRoots();
    const before = snapshot(seeded.dir);
    rmSync(seeded.trash, { recursive: true });

    const { reports } = await removeWith(seeded);

    expect(reports.map((error) => error.message)).toEqual([TRASH_UNAVAILABLE]);
    expect(reports.map((error) => (error.cause as NodeJS.ErrnoException).code)).toEqual(["ENOENT"]);
    expect(snapshot(seeded.dir)).toEqual(before);
  });
});
