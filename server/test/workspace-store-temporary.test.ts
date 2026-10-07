/**
 * Temporary-workspace store (s1f tasks 3.1 / 3.2): workspaces「列表不含临时空间」「调用方事务与路径边界」,
 * the store-layer half of temporary-workspaces「目录创建失败不留行」, id collision retry and its cap,
 * the compensation exit, and the duplicate-name conflict against a temporary row.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore, type WorkspaceStore } from "../src/workspaces/store.js";
import { removeTempDirs, tempDir, withOpenDb } from "./core-db-helpers.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_T = "0123456789abcdef0123456789abcdef";
const ID_X = "11111111111111111111111111111111";
const ID_Y = "22222222222222222222222222222222";
const SESSION_ID = "55555555555555555555555555555555";
const TMP_T = `tmp-${ID_T}`;
const TMP_X = `tmp-${ID_X}`;
const TMP_Y = `tmp-${ID_Y}`;
const HEX32 = /^[0-9a-f]{32}$/u;
const SHARED_MODE = 0o2770;
/** The retry cap, restated here on purpose: the store's constant is not imported. */
const ID_ATTEMPTS = 8;
const GENERATOR_LIMIT = 64;
const U1 = { id: "u1" };
const U2 = { id: "u2" };
const INSERT_SQL =
  "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)";
const NEEDS_TRANSACTION = "temporary workspace creation needs the caller's transaction";
const INVALID_ROOT = "invalid workspace root path";
const dirFault = new Error("temporary dir fault");

interface World {
  db: DatabaseSync;
  store: WorkspaceStore;
  sandboxRoot: string;
  /** How many ids the injected generator has handed out. */
  idCalls: () => number;
}

interface WorldOptions {
  /** Ids handed out in order; the last one repeats forever. Omitted → the store's own generator. */
  ids?: readonly string[];
  ensure?: (absPath: string, sandboxRoot: string) => void;
}

afterEach(() => {
  removeTempDirs();
});

function withWorld(options: WorldOptions, run: (world: World) => void): void {
  const sandboxRoot = realpathSync(tempDir());
  const { ids, ensure } = options;
  let calls = 0;
  withOpenDb(":memory:", (db) => {
    const store = createWorkspaceStore(db, {
      sandboxRoot,
      ensureSharedDir: ensure === undefined ? ensureSharedDir : (path) => ensure(path, sandboxRoot),
      emit,
      ...(ids === undefined
        ? {}
        : {
            generateId: () => {
              calls += 1;
              // A synchronous retry loop cannot be interrupted by a test timeout: stop it here.
              if (calls > GENERATOR_LIMIT) {
                throw new Error("id generator called without bound");
              }
              return ids[Math.min(calls, ids.length) - 1] ?? "";
            },
          }),
    });
    try {
      run({ db, store, sandboxRoot, idCalls: () => calls });
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    }
  });
}

function insertWorkspace(db: DatabaseSync, id: string, ownerId: string, name: string, dir = name) {
  db.prepare(INSERT_SQL).run(id, ownerId, name, dir, 1);
}

function workspaceRows(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT id, owner_id, name, dir, temporary FROM workspaces ORDER BY created_at, id")
    .all();
}

function count(db: DatabaseSync, table: "workspaces" | "audit_events" | "chat_sessions"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.fail("expected throw");
}

/** A plain failure: not a canonical HTTP error, so the REST layer answers a generic 5xx. */
function expectGeneric(error: unknown, message?: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(HttpError);
  if (message !== undefined) {
    expect((error as Error).message).toBe(message);
  }
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

describe("temporary workspace: list and shape", () => {
  it("列表不含临时空间: list returns the two ordinary rows, rootOf serves all three to the owner only", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot }) => {
      db.prepare(INSERT_SQL).run(ID_B, "u1", "later", "later", 10);
      db.prepare(INSERT_SQL).run(ID_A, "u1", "earlier", "earlier", 5);
      const temporary = seedTemporaryWorkspaceSession(db, store, "u1", SESSION_ID);

      expect(store.list("u1")).toEqual([
        {
          id: ID_A,
          name: "earlier",
          dir: "earlier",
          root: join(sandboxRoot, "u1", "earlier"),
          createdAt: 5,
        },
        {
          id: ID_B,
          name: "later",
          dir: "later",
          root: join(sandboxRoot, "u1", "later"),
          createdAt: 10,
        },
      ]);
      expect(temporary.id).toBe(ID_T);
      for (const [id, dir] of [
        [ID_A, "earlier"],
        [ID_B, "later"],
        [ID_T, TMP_T],
      ] as const) {
        expect(store.rootOf(U1, id)).toBe(join(sandboxRoot, "u1", dir));
        expect(store.rootOf(U2, id)).toBeNull();
      }
    });
  });

  it("creates the row as tmp-<id> with temporary = 1, a 2770 directory, no audit, and a bound session via the helper", () => {
    withWorld({}, ({ db, store, sandboxRoot }) => {
      const temporary = seedTemporaryWorkspaceSession(db, store, "u1", SESSION_ID);

      expect(temporary.id).toMatch(HEX32);
      const dir = `tmp-${temporary.id}`;
      expect(temporary).toEqual({
        id: temporary.id,
        name: dir,
        dir,
        root: join(sandboxRoot, "u1", dir),
        createdAt: temporary.createdAt,
      });
      expect(workspaceRows(db)).toEqual([
        { id: temporary.id, owner_id: "u1", name: dir, dir, temporary: 1 },
      ]);
      expect(
        db.prepare("SELECT id, owner_id, workspace_id, status FROM chat_sessions").all(),
      ).toEqual([{ id: SESSION_ID, owner_id: "u1", workspace_id: temporary.id, status: "idle" }]);
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual([dir]);
      expect(mode(join(sandboxRoot, "u1"))).toBe(SHARED_MODE);
      expect(mode(temporary.root)).toBe(SHARED_MODE);
      expect(count(db, "audit_events")).toBe(0);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("gives two calls two different ids and directories", () => {
    withWorld({}, ({ db, store, sandboxRoot }) => {
      db.exec("BEGIN");
      const first = store.createTemporary(U1).workspace;
      const second = store.createTemporary(U1).workspace;
      db.exec("COMMIT");
      expect(first.id).not.toBe(second.id);
      expect(readdirSync(join(sandboxRoot, "u1")).toSorted()).toEqual(
        [first.dir, second.dir].toSorted(),
      );
    });
  });

  it("POST /api/workspaces 与临时空间重名: store.create with a temporary's name or dir is a conflict, no directory", () => {
    withWorld({ ids: [ID_T, ID_Y] }, ({ db, store, sandboxRoot }) => {
      seedTemporaryWorkspaceSession(db, store, "u1", SESSION_ID);
      for (const input of [{ name: TMP_T }, { name: "other", dir: TMP_T }]) {
        const error = captureThrown(() => store.create(U1, input));
        expect(error).toBeInstanceOf(HttpError);
        expect(error).toMatchObject({ code: "conflict" });
      }
      expect(count(db, "workspaces")).toBe(1);
      expect(count(db, "audit_events")).toBe(0);
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual([TMP_T]);
      expect(db.isTransaction).toBe(false);
    });
  });
});

describe("temporary workspace: the caller's transaction", () => {
  it("issues no transaction statement on success: the caller's transaction stays open and its rollback removes the row", () => {
    withWorld({ ids: [ID_T] }, ({ db, store }) => {
      db.exec("BEGIN");
      insertWorkspace(db, ID_A, "u3", "caller");
      const { workspace } = store.createTemporary(U1);
      expect(db.isTransaction).toBe(true);
      expect(workspaceRows(db)).toHaveLength(2);
      expect(existsSync(workspace.root)).toBe(true);
      db.exec("ROLLBACK");
      expect(count(db, "workspaces")).toBe(0);
    });
  });

  it("issues no transaction statement on failure: the caller's earlier write is still there and still the caller's to roll back", () => {
    withWorld(
      {
        ids: [ID_T],
        ensure: () => {
          throw dirFault;
        },
      },
      ({ db, store, sandboxRoot }) => {
        db.exec("BEGIN");
        insertWorkspace(db, ID_A, "u3", "caller");
        expect(captureThrown(() => store.createTemporary(U1))).toBe(dirFault);
        expect(db.isTransaction).toBe(true);
        expect(db.prepare("SELECT name FROM workspaces WHERE id = ?").get(ID_A)).toEqual({
          name: "caller",
        });
        db.exec("ROLLBACK");
        expect(count(db, "workspaces")).toBe(0);
        expect(readdirSync(sandboxRoot)).toEqual([]);
      },
    );
  });

  it("refuses to run outside a transaction, before any row, id or directory", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot, idCalls }) => {
      expectGeneric(
        captureThrown(() => store.createTemporary(U1)),
        NEEDS_TRANSACTION,
      );
      expect(db.isTransaction).toBe(false);
      expect(count(db, "workspaces")).toBe(0);
      expect(idCalls()).toBe(0);
      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });
});

describe("temporary workspace: 目录创建失败不留行 (store layer)", () => {
  it("a regular file occupying tmp-<id>: generic failure, file untouched, no row after the caller rolls back", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot }) => {
      const ownerRoot = join(sandboxRoot, "u1");
      mkdirSync(ownerRoot, { mode: 0o755 });
      chmodSync(ownerRoot, 0o755);
      writeFileSync(join(ownerRoot, TMP_T), "occupied");

      db.exec("BEGIN");
      expectGeneric(
        captureThrown(() => store.createTemporary(U1)),
        INVALID_ROOT,
      );
      expect(db.isTransaction).toBe(true);
      db.exec("ROLLBACK");

      expect(count(db, "workspaces")).toBe(0);
      expect(readdirSync(ownerRoot)).toEqual([TMP_T]);
      expect(readFileSync(join(ownerRoot, TMP_T), "utf8")).toBe("occupied");
      expect(mode(ownerRoot)).toBe(0o755);
    });
  });

  it.each([
    ["the owner directory is created, then the workspace directory fails", false],
    ["both directories are created, then the workspace step fails", true],
  ])("removes the empty directories this call created when %s", (_name, createWorkspaceDir) => {
    withWorld(
      {
        ids: [ID_T],
        ensure: (absPath, sandboxRoot) => {
          const isWorkspace = absPath === join(sandboxRoot, "u1", TMP_T);
          if (!isWorkspace || createWorkspaceDir) {
            ensureSharedDir(absPath);
          }
          if (isWorkspace) {
            throw dirFault;
          }
        },
      },
      ({ db, store, sandboxRoot }) => {
        db.exec("BEGIN");
        expect(captureThrown(() => store.createTemporary(U1))).toBe(dirFault);
        expect(readdirSync(sandboxRoot)).toEqual([]);
        expect(db.isTransaction).toBe(true);
        db.exec("ROLLBACK");
        expect(count(db, "workspaces")).toBe(0);
      },
    );
  });

  it("keeps an adopted owner directory and reports a directory it could not remove, with the original as cause", () => {
    withWorld(
      {
        ids: [ID_T],
        ensure: (absPath, sandboxRoot) => {
          ensureSharedDir(absPath);
          if (absPath === join(sandboxRoot, "u1", TMP_T)) {
            writeFileSync(join(absPath, "stay.txt"), "stay");
            throw dirFault;
          }
        },
      },
      ({ db, store, sandboxRoot }) => {
        const ownerRoot = join(sandboxRoot, "u1");
        mkdirSync(ownerRoot);
        chmodSync(ownerRoot, 0o755);
        db.exec("BEGIN");
        const error = captureThrown(() => store.createTemporary(U1));
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors[0]).toBe(dirFault);
        expect((error as AggregateError).errors).toHaveLength(2);
        expect((error as AggregateError).cause).toBe(dirFault);
        expect(db.isTransaction).toBe(true);
        expect(readFileSync(join(ownerRoot, TMP_T, "stay.txt"), "utf8")).toBe("stay");
        expect(mode(ownerRoot)).toBe(0o755);
      },
    );
  });

  it("rejects an owner root that is a symlink before writing a row or touching the target", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot }) => {
      const outside = join(sandboxRoot, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(sandboxRoot, "u1"));
      db.exec("BEGIN");
      expectGeneric(
        captureThrown(() => store.createTemporary(U1)),
        INVALID_ROOT,
      );
      expect(workspaceRows(db)).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
      expect(lstatSync(join(sandboxRoot, "u1")).isSymbolicLink()).toBe(true);
    });
  });
});

describe("temporary workspace: compensation exit", () => {
  it("removes the owner and workspace directories this call created, and is safe to call twice", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot }) => {
      db.exec("BEGIN");
      const created = store.createTemporary(U1);
      db.exec("ROLLBACK");
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual([TMP_T]);

      created.removeCreatedDirs();
      expect(readdirSync(sandboxRoot)).toEqual([]);
      created.removeCreatedDirs();
      expect(readdirSync(sandboxRoot)).toEqual([]);
      expect(count(db, "workspaces")).toBe(0);
    });
  });

  it("leaves an owner directory it did not create, with its mode and other entries", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot }) => {
      const ownerRoot = join(sandboxRoot, "u1");
      mkdirSync(join(ownerRoot, "kept"), { recursive: true });
      chmodSync(ownerRoot, 0o755);
      db.exec("BEGIN");
      const created = store.createTemporary(U1);
      db.exec("ROLLBACK");

      created.removeCreatedDirs();
      expect(readdirSync(ownerRoot)).toEqual(["kept"]);
      expect(mode(ownerRoot)).toBe(0o755);
    });
  });

  it("never removes a directory that is no longer empty: it throws and the content stays", () => {
    withWorld({ ids: [ID_T] }, ({ db, store, sandboxRoot }) => {
      db.exec("BEGIN");
      const created = store.createTemporary(U1);
      db.exec("ROLLBACK");
      const file = join(created.workspace.root, "stay.txt");
      writeFileSync(file, "stay");

      const error = captureThrown(() => created.removeCreatedDirs());
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect((error as AggregateError).errors[0]).toMatchObject({ code: "ENOTEMPTY" });
      expect(readFileSync(file, "utf8")).toBe("stay");
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual([TMP_T]);
    });
  });
});

describe("temporary workspace: id collisions", () => {
  it("retries when the generated id is already another owner's primary key", () => {
    withWorld({ ids: [ID_X, ID_X, ID_Y] }, ({ db, store, sandboxRoot, idCalls }) => {
      insertWorkspace(db, ID_X, "u2", "theirs");
      db.exec("BEGIN");
      expect(store.createTemporary(U1).workspace.id).toBe(ID_Y);
      db.exec("COMMIT");
      expect(idCalls()).toBe(3);
      expect(workspaceRows(db)).toEqual([
        { id: ID_X, owner_id: "u2", name: "theirs", dir: "theirs", temporary: 0 },
        { id: ID_Y, owner_id: "u1", name: TMP_Y, dir: TMP_Y, temporary: 1 },
      ]);
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual([TMP_Y]);
    });
  });

  it.each([
    ["name", TMP_X, "plain"],
    ["dir", "plain", TMP_X],
  ])("retries when the owner already uses tmp-<id> as a %s", (_kind, name, dir) => {
    withWorld({ ids: [ID_X, ID_Y] }, ({ db, store, sandboxRoot, idCalls }) => {
      insertWorkspace(db, ID_A, "u1", name, dir);
      db.exec("BEGIN");
      expect(store.createTemporary(U1).workspace).toMatchObject({
        id: ID_Y,
        name: TMP_Y,
        dir: TMP_Y,
      });
      db.exec("COMMIT");
      expect(idCalls()).toBe(2);
      expect(count(db, "workspaces")).toBe(2);
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual([TMP_Y]);
    });
  });

  it("gives up after the cap when the generator keeps returning a taken id", {
    timeout: 2000,
  }, () => {
    withWorld({ ids: [ID_X] }, ({ db, store, sandboxRoot, idCalls }) => {
      insertWorkspace(db, ID_X, "u2", "theirs");
      db.exec("BEGIN");
      expectGeneric(captureThrown(() => store.createTemporary(U1)));
      expect(idCalls()).toBe(ID_ATTEMPTS);
      expect(db.isTransaction).toBe(true);
      expect(count(db, "workspaces")).toBe(1);
      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });

  it.each([
    ["an id outside the schema alphabet", "../../escape", U1, 275],
    ["an owner without an account", ID_T, { id: "missing-owner" }, 787],
  ])("does not retry or touch the filesystem for %s", (_name, id, principal, errcode) => {
    withWorld({ ids: [id] }, ({ db, store, sandboxRoot, idCalls }) => {
      db.exec("BEGIN");
      const error = captureThrown(() => store.createTemporary(principal));
      expectGeneric(error);
      expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode });
      expect(idCalls()).toBe(1);
      expect(count(db, "workspaces")).toBe(0);
      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });
});
