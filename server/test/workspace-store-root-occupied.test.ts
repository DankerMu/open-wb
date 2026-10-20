/**
 * Issue #1244 (s1-followups-batch task 3.1): what the workspace store does when the path of an
 * owned root exists and is not a directory — design D3, workspaces「工作空间 HTTP 集成边界」.
 * `rootOf` and `promote` throw the store's own `WorkspaceRootOccupiedError`; `list` yields the row
 * as it does for a missing root. A root that is a symbolic link and an unsafe owner segment keep
 * failing with a plain `Error` (D14-1), so the HTTP boundary cannot take them for the 404 case.
 * The occupant is a regular file, in one case a FIFO. Real SQLite, real directories; expected
 * values are literals and the answers read while the root was still missing.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { ensureRepoRootMarker } from "../src/sessions/omp/repo-root-marker.js";
import {
  createWorkspaceStore,
  WorkspaceRootOccupiedError,
  type WorkspaceStore,
} from "../src/workspaces/store.js";
import { removeTempDirs, tempDir, withOpenDb } from "./core-db-helpers.js";
import { insertWorkspace } from "./workspaces-http-helpers.js";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const U1 = { id: "u1" };
const OCCUPANT = "occupant-bytes";
const FIVE_KEYS = ["id", "name", "dir", "root", "createdAt"];

interface World {
  db: DatabaseSync;
  store: WorkspaceStore;
  sandboxRoot: string;
  /** `<sandboxRoot>/u1`, made here. */
  ownerRoot: string;
}

afterEach(() => {
  removeTempDirs();
});

function withWorld(run: (world: World) => void): void {
  const sandboxRoot = realpathSync(tempDir());
  const ownerRoot = join(sandboxRoot, "u1");
  mkdirSync(ownerRoot);
  withOpenDb(":memory:", (db) => {
    const store = createWorkspaceStore(db, {
      sandboxRoot,
      ensureSharedDir,
      ensureRepoRootMarker,
      emit,
    });
    run({ db, store, sandboxRoot, ownerRoot });
  });
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.fail("expected throw");
}

/**
 * The store's generic failure: an `Error` and no subclass of it, so not the occupied-root class
 * (nor a canonical HTTP error) — stated without naming that class, so it holds before #1244 too.
 */
function expectPlainError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
}

function auditKinds(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT kind FROM audit_events ORDER BY id")
    .all()
    .map((row) => row.kind);
}

function rowOf(db: DatabaseSync, id: string): unknown {
  const row = db.prepare("SELECT name, dir, temporary FROM workspaces WHERE id = ?").get(id);
  return row === undefined ? undefined : { ...row };
}

/** The owner's temporary workspace, committed; its directory exists. */
function createTemporary({ db, store }: World) {
  db.exec("BEGIN");
  const { workspace } = store.createTemporary(U1);
  db.exec("COMMIT");
  return workspace;
}

describe("workspace store: rootOf 对被非目录占据的根", () => {
  it("throws WorkspaceRootOccupiedError carrying the resolved path when a regular file occupies the root", () => {
    withWorld(({ db, store, ownerRoot }) => {
      const root = join(ownerRoot, "occupied");
      writeFileSync(root, OCCUPANT);
      insertWorkspace(db, ID_A, "u1", "occupied", "occupied", 1);

      const error = thrownBy(() => store.rootOf(U1, ID_A));

      expect(error).toBeInstanceOf(WorkspaceRootOccupiedError);
      expect((error as WorkspaceRootOccupiedError).root).toBe(root);
      expect(readFileSync(root, "utf8")).toBe(OCCUPANT);
      expect(readdirSync(ownerRoot)).toEqual(["occupied"]);
    });
  });

  it("keeps the plain Error for a root that is a symbolic link, to a directory or to a file", () => {
    withWorld(({ db, store, ownerRoot }) => {
      mkdirSync(join(ownerRoot, "real-dir"));
      writeFileSync(join(ownerRoot, "real-file"), OCCUPANT);
      symlinkSync(join(ownerRoot, "real-dir"), join(ownerRoot, "to-dir"));
      symlinkSync(join(ownerRoot, "real-file"), join(ownerRoot, "to-file"));
      insertWorkspace(db, ID_A, "u1", "to-dir", "to-dir", 1);
      insertWorkspace(db, ID_B, "u1", "to-file", "to-file", 2);

      for (const id of [ID_A, ID_B]) {
        expectPlainError(thrownBy(() => store.rootOf(U1, id)));
      }
      expect(lstatSync(join(ownerRoot, "to-dir")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(ownerRoot, "to-file")).isSymbolicLink()).toBe(true);
    });
  });

  it("keeps the plain Error for an unsafe owner segment and for an owner directory that is a symbolic link", () => {
    withWorld(({ db, store, sandboxRoot }) => {
      // An account whose id is not a safe path segment; the hash is copied from a seeded row.
      db.prepare(
        "INSERT INTO accounts(id, account, role, disabled, password_hash) SELECT 'bad/id', 'badslash', role, 0, password_hash FROM accounts WHERE id = 'u1'",
      ).run();
      insertWorkspace(db, ID_A, "bad/id", "escape", "escape", 1);
      mkdirSync(join(sandboxRoot, "elsewhere"));
      symlinkSync(join(sandboxRoot, "elsewhere"), join(sandboxRoot, "u2"));
      insertWorkspace(db, ID_B, "u2", "proj", "proj", 2);

      for (const [ownerId, id] of [
        ["bad/id", ID_A],
        ["u2", ID_B],
      ] as const) {
        expectPlainError(thrownBy(() => store.rootOf({ id: ownerId }, id)));
      }
      expect(readdirSync(join(sandboxRoot, "elsewhere"))).toEqual([]);
    });
  });

  it("returns the path of a missing root without throwing or creating it", () => {
    withWorld(({ db, store, ownerRoot }) => {
      insertWorkspace(db, ID_A, "u1", "missing", "missing", 1);

      expect(store.rootOf(U1, ID_A)).toBe(join(ownerRoot, "missing"));
      expect(readdirSync(ownerRoot)).toEqual([]);
    });
  });
});

describe("workspace store: list 对被非目录占据的根", () => {
  it("lists both workspaces, the occupied one value for value as while its root was missing", () => {
    withWorld(({ db, store, ownerRoot }) => {
      const root = join(ownerRoot, "occupied");
      mkdirSync(join(ownerRoot, "fine"));
      insertWorkspace(db, ID_A, "u1", "被占据", "occupied", 1);
      insertWorkspace(db, ID_B, "u1", "fine", "fine", 2);
      const whileMissing = store.list("u1");
      writeFileSync(root, OCCUPANT);

      const listed = store.list("u1");

      expect(listed).toEqual([
        { id: ID_A, name: "被占据", dir: "occupied", root, createdAt: 1 },
        { id: ID_B, name: "fine", dir: "fine", root: join(ownerRoot, "fine"), createdAt: 2 },
      ]);
      expect(listed).toEqual(whileMissing);
      expect(Object.keys(listed[0] ?? {})).toEqual(FIVE_KEYS);
      expect(readFileSync(root, "utf8")).toBe(OCCUPANT);
    });
  });

  it("still fails with the plain Error when a workspace root is a symbolic link (D14-1)", () => {
    withWorld(({ db, store, ownerRoot }) => {
      mkdirSync(join(ownerRoot, "real-dir"));
      symlinkSync(join(ownerRoot, "real-dir"), join(ownerRoot, "linked"));
      writeFileSync(join(ownerRoot, "occupied"), OCCUPANT);
      insertWorkspace(db, ID_A, "u1", "occupied", "occupied", 1);
      insertWorkspace(db, ID_B, "u1", "linked", "linked", 2);

      expectPlainError(thrownBy(() => store.list("u1")));
    });
  });
});

describe("workspace store: promote 对被非目录占据的根", () => {
  it("throws WorkspaceRootOccupiedError, leaves the row temporary under its name and writes no workspace.promote", () => {
    withWorld((world) => {
      const { db, store } = world;
      const temporary = createTemporary(world);
      rmSync(temporary.root, { recursive: true });
      writeFileSync(temporary.root, OCCUPANT);
      const before = rowOf(db, temporary.id);
      expect(before).toEqual({ name: temporary.name, dir: temporary.dir, temporary: 1 });

      const error = thrownBy(() => store.promote(U1, temporary.id, "调研资料"));

      expect(error).toBeInstanceOf(WorkspaceRootOccupiedError);
      expect((error as WorkspaceRootOccupiedError).root).toBe(temporary.root);
      expect(db.isTransaction).toBe(false);
      expect(rowOf(db, temporary.id)).toEqual(before);
      expect(auditKinds(db)).toEqual([]);
      expect(readFileSync(temporary.root, "utf8")).toBe(OCCUPANT);
    });
  });

  it("throws WorkspaceRootOccupiedError from rootOf and from promote when a FIFO occupies the root", () => {
    withWorld((world) => {
      const { db, store } = world;
      const temporary = createTemporary(world);
      rmSync(temporary.root, { recursive: true });
      execFileSync("mkfifo", [temporary.root]);
      const before = rowOf(db, temporary.id);

      for (const run of [
        () => store.rootOf(U1, temporary.id),
        () => store.promote(U1, temporary.id, "调研资料"),
      ]) {
        const error = thrownBy(run);
        expect(error).toBeInstanceOf(WorkspaceRootOccupiedError);
        expect((error as WorkspaceRootOccupiedError).root).toBe(temporary.root);
      }

      expect(before).toEqual({ name: temporary.name, dir: temporary.dir, temporary: 1 });
      expect(db.isTransaction).toBe(false);
      expect(rowOf(db, temporary.id)).toEqual(before);
      expect(auditKinds(db)).toEqual([]);
      expect(lstatSync(temporary.root).isFIFO()).toBe(true);
    });
  });

  it("promotes as before when the root is only missing", () => {
    withWorld((world) => {
      const { db, store } = world;
      const temporary = createTemporary(world);
      rmSync(temporary.root, { recursive: true });

      const promoted = store.promote(U1, temporary.id, "调研资料");

      expect(promoted).toEqual({
        id: temporary.id,
        name: "调研资料",
        dir: temporary.dir,
        root: temporary.root,
        createdAt: temporary.createdAt,
      });
      expect(rowOf(db, temporary.id)).toEqual({
        name: "调研资料",
        dir: temporary.dir,
        temporary: 0,
      });
      expect(auditKinds(db)).toEqual(["workspace.promote"]);
      expect(existsSync(temporary.root)).toBe(false);
    });
  });
});
