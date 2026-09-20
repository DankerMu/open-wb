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
import { constants, type DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore, type WorkspaceStore } from "../src/workspaces/store.js";
import { removeTempDirs, tempDir, withOpenDb } from "./core-db-helpers.js";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_C = "cccccccccccccccccccccccccccccccc";
const ID_D = "dddddddddddddddddddddddddddddddd";
const ID_E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MISSING_ID = "ffffffffffffffffffffffffffffffff";
const INSERT_SQL =
  "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)";
const SHARED_MODE = 0o2770;
const HEX32 = /^[0-9a-f]{32}$/u;
const DISPLAY_NAME = "智能 客服/重构";
const DERIVED_DIR = "智能-客服-重构";
const FIXED_NOW = 1_725_000_000_000;
const ACCOUNT_HASH =
  "scrypt$16384$8$1$b597609e46e3097e0b96fa7204254a63$4cccb4d61b561586fbc223f086dfe899ef43771b43864b0632e8a7e66a5046b8";
const PRINCIPAL_U1 = { id: "u1" };
const PRINCIPAL_U1_ADMIN = { id: "u1", role: "管理员" };
const PRINCIPAL_U2 = { id: "u2" };
const postAuditFault = new Error("post-audit fault");
const auditBoom = new Error("audit boom");
const ownerMkdirFailed = new Error("owner mkdir failed");
const ownerChmodFailed = new Error("owner chmod failed");
const workspaceMkdirDenied = new Error("workspace mkdir denied");
const workspaceChmodFailed = new Error("workspace chmod failed");
const afterFill = new Error("after fill");
const filledWorkspace = new Error("filled workspace");

afterEach(() => {
  vi.useRealTimers();
  removeTempDirs();
});

describe("workspaces store list and rootOf", () => {
  it("returns only the owner's five-field rows in created_at,id order and never creates directories", () => {
    const sandboxRoot = openSandbox();
    withStore(sandboxRoot, (db, store) => {
      insertWorkspace(db, ID_B, "u1", "later-b", "later-b", 10);
      insertWorkspace(db, ID_A, "u1", "later-a", "later-a", 10);
      insertWorkspace(db, ID_C, "u1", "oldest", "oldest", -5);
      insertWorkspace(db, ID_D, "u1", "zero", "zero", 0);
      insertWorkspace(db, ID_E, "u2", "other", "other", -100);

      expect(store.list("u1")).toEqual([
        listed(sandboxRoot, ID_C, "oldest", "oldest", -5),
        listed(sandboxRoot, ID_D, "zero", "zero", 0),
        listed(sandboxRoot, ID_A, "later-a", "later-a", 10),
        listed(sandboxRoot, ID_B, "later-b", "later-b", 10),
      ]);
      expect(store.list("u2")).toEqual([listed(sandboxRoot, ID_E, "other", "other", -100, "u2")]);
      expect(store.list("u3")).toEqual([]);
      expect(store.rootOf(PRINCIPAL_U1, ID_A)).toBe(join(sandboxRoot, "u1", "later-a"));
      expect(store.rootOf(PRINCIPAL_U1_ADMIN, ID_E)).toBeNull();
      expect(store.rootOf(PRINCIPAL_U2, ID_A)).toBeNull();
      expect(store.rootOf(PRINCIPAL_U1, MISSING_ID)).toBeNull();
      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });

  it("does not create directories for foreign or missing rootOf and rejects unsafe persisted owner roots", () => {
    const sandboxRoot = openSandbox();
    withStore(sandboxRoot, (db, store) => {
      insertUnsafeOwnerAccount(db);
      insertWorkspace(db, ID_A, "bad/id", "escape", "escape", 1);
      expectGenericRejection(() => store.list("bad/id"));
      expectGenericRejection(() => store.rootOf({ id: "bad/id" }, ID_A));
      expect(store.rootOf(PRINCIPAL_U1, ID_A)).toBeNull();
      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });

  it("returns null for foreign rootOf before inspecting an unsafe existing path", () => {
    const sandboxRoot = openSandbox();
    const ownerRoot = join(sandboxRoot, "u2");
    const outside = join(sandboxRoot, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, ownerRoot);
    withStore(sandboxRoot, (db, store) => {
      insertWorkspace(db, ID_A, "u2", "linked", "linked", 1);
      expect(store.rootOf(PRINCIPAL_U1, ID_A)).toBeNull();
      expect(lstatSync(ownerRoot).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
    });
  });

  it("rejects owned list and rootOf when the persisted workspace path is a symlink or file", () => {
    const { sandboxRoot, ownerRoot, outside } = linkedOwnerLayout();
    writeFileSync(join(ownerRoot, "file-root"), "not-a-dir");
    withStore(sandboxRoot, (db, store) => {
      insertWorkspace(db, ID_A, "u1", "linked", "linked", 1);
      insertWorkspace(db, ID_B, "u1", "file-root", "file-root", 2);
      expectGenericRejection(() => store.list("u1"));
      expectGenericRejection(() => store.rootOf(PRINCIPAL_U1, ID_A));
      expectGenericRejection(() => store.rootOf(PRINCIPAL_U1, ID_B));
      expect(lstatSync(join(ownerRoot, "linked")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(ownerRoot, "file-root"), "utf8")).toBe("not-a-dir");
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
    });
  });
});

describe("workspaces store create", () => {
  it("creates a derived workspace with 2770 roots, same-db audit, and five-field result", () => {
    const sandboxRoot = openSandbox();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    withStore(sandboxRoot, (db, store) => {
      const created = store.create(PRINCIPAL_U1, { name: `  ${DISPLAY_NAME}  ` });
      expect(created.id).toMatch(HEX32);
      expect(created).toEqual({
        id: created.id,
        name: DISPLAY_NAME,
        dir: DERIVED_DIR,
        root: join(sandboxRoot, "u1", DERIVED_DIR),
        createdAt: FIXED_NOW,
      });
      expect(store.list("u1")).toEqual([created]);
      expect(store.list("u2")).toEqual([]);
      expect(store.rootOf(PRINCIPAL_U1, created.id)).toBe(created.root);
      expect(store.rootOf(PRINCIPAL_U2, created.id)).toBeNull();
      const ownerRoot = join(sandboxRoot, "u1");
      expect(lstatSync(ownerRoot).mode & 0o7777).toBe(SHARED_MODE);
      expect(lstatSync(created.root).mode & 0o7777).toBe(SHARED_MODE);
      expect(readdirSync(ownerRoot)).toEqual([DERIVED_DIR]);
      expect(readdirSync(created.root)).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT actor_id, kind, title, detail, workspace_id FROM audit_events WHERE workspace_id = ?",
          )
          .all(created.id),
      ).toEqual([
        {
          actor_id: "u1",
          kind: "workspace.create",
          title: `创建工作空间 ${DISPLAY_NAME}`,
          detail: JSON.stringify({ root: created.root }),
          workspace_id: created.id,
        },
      ]);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("rejects invalid names and dirs before row, directory, or audit mutation", () => {
    const sandboxRoot = openSandbox();
    withStore(sandboxRoot, (db, store) => {
      const emoji64 = "😀".repeat(64);
      const explicit64 = "d".repeat(64);
      expectCanonical(store, { name: "   " }, "bad_request");
      expectCanonical(store, { name: "n".repeat(65) }, "bad_request");
      expectCanonical(store, { name: "ok\nname" }, "bad_request");
      expectCanonical(store, { name: "ok\u007fname" }, "bad_request");
      expectCanonical(store, { name: "ok", dir: "valid\n" }, "bad_request");
      expectCanonical(store, { name: "ok", dir: "d".repeat(65) }, "bad_request");
      expectCanonical(store, { name: "ok", dir: "has/slash" }, "bad_request");
      expectCanonical(store, { name: "ok", dir: "bad\u9fa6" }, "bad_request");
      expectCanonical(store, { name: emoji64 }, "bad_request");

      const fromEmoji = store.create(PRINCIPAL_U1, { name: emoji64, dir: explicit64 });
      expect(fromEmoji.name).toBe(emoji64);
      expect(fromEmoji.dir).toBe(explicit64);
      expect(store.create(PRINCIPAL_U1, { name: "😀", dir: "emoji-ok" }).name).toBe("😀");
      expect(store.create(PRINCIPAL_U1, { name: "ok-emoji", dir: "--" }).dir).toBe("--");
      const fromDot = store.create(PRINCIPAL_U1, { name: "." });
      expect(fromDot.name).toBe(".");
      expect(fromDot.dir).toBe("-");
      expect(store.create(PRINCIPAL_U1, { name: "范围\u4e00\u9fa5\u9fa6" }).dir).toBe(
        "范围\u4e00\u9fa5-",
      );
      expectUnchangedStore(db, sandboxRoot, 5, ["u1"]);
    });
  });

  it("maps only same-owner name or dir uniqueness to conflict and leaves other owners independent", () => {
    const sandboxRoot = openSandbox();
    withOpenDb(":memory:", (db) => {
      let helperCalls = 0;
      let emitCalls = 0;
      const store = createWorkspaceStore(db, {
        sandboxRoot,
        ensureSharedDir: (absPath) => {
          helperCalls += 1;
          ensureSharedDir(absPath);
        },
        emit: (handle, event) => {
          emitCalls += 1;
          return emit(handle, event);
        },
      });
      const first = store.create(PRINCIPAL_U1, { name: "alpha", dir: "dir-a" });
      const afterFirstHelpers = helperCalls;
      const afterFirstEmits = emitCalls;
      expectCanonical(store, { name: "alpha", dir: "dir-b" }, "conflict");
      expectCanonical(store, { name: "beta", dir: "dir-a" }, "conflict");
      expect(helperCalls).toBe(afterFirstHelpers);
      expect(emitCalls).toBe(afterFirstEmits);
      expect(countWorkspaces(db)).toBe(1);
      expect(countAudits(db)).toBe(1);
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual(["dir-a"]);
      const other = store.create(PRINCIPAL_U2, { name: "alpha", dir: "dir-a" });
      expect(other.root).toBe(join(sandboxRoot, "u2", "dir-a"));
      expect(store.list("u1")).toEqual([first]);
      expect(store.list("u2")).toEqual([other]);
    });
  });

  it("adopts an ordinary existing workspace directory without changing bytes or mode", () => {
    const sandboxRoot = openSandbox();
    const ownerRoot = join(sandboxRoot, "u1");
    const workspaceRoot = join(ownerRoot, "smoke-fixture");
    mkdirSync(ownerRoot, { mode: 0o755 });
    mkdirSync(workspaceRoot, { mode: 0o755 });
    writeFileSync(join(workspaceRoot, "keep.txt"), "adopt-me");
    chmodSync(ownerRoot, 0o755);
    chmodSync(workspaceRoot, 0o755);
    withStore(sandboxRoot, (_db, store) => {
      const created = store.create(PRINCIPAL_U1, { name: "smoke", dir: "smoke-fixture" });
      expect(created.root).toBe(workspaceRoot);
      expect(readFileSync(join(workspaceRoot, "keep.txt"), "utf8")).toBe("adopt-me");
      expect(lstatSync(ownerRoot).mode & 0o7777).toBe(0o755);
      expect(lstatSync(workspaceRoot).mode & 0o7777).toBe(0o755);
      expect(readdirSync(workspaceRoot)).toEqual(["keep.txt"]);
    });
  });

  it("refuses to adopt an existing workspace symlink and does not emit", () => {
    const { sandboxRoot, ownerRoot, outside } = linkedOwnerLayout();
    withStore(sandboxRoot, (db, store) => {
      expectGenericRejection(() => store.create(PRINCIPAL_U1, { name: "linked" }));
      expectUnchangedStore(db, sandboxRoot, 0, ["outside-ws", "u1"]);
      expect(lstatSync(join(ownerRoot, "linked")).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
    });
  });

  it("propagates native FK and primary-key failures instead of conflict", () => {
    const sandboxRoot = openSandbox();
    withStore(sandboxRoot, (db, store) => {
      expectNativeCreateFailure(store, db, sandboxRoot, { id: "missing-owner" }, 787);
    });
  });

  it("propagates native primary-key failure instead of conflict", () => {
    const sandboxRoot = openSandbox();
    withStore(sandboxRoot, (db, store) => {
      db.exec(`
        CREATE TRIGGER workspace_pk_collision
        BEFORE INSERT ON workspaces
        BEGIN
          INSERT INTO workspaces(id, owner_id, name, dir, created_at)
          VALUES (new.id, 'u2', 'pk-' || new.id, 'pk-' || new.id, 0);
        END;
      `);
      expectNativeCreateFailure(store, db, sandboxRoot, PRINCIPAL_U1, 1555);
    });
  });

  it("propagates a native audit UNIQUE failure instead of conflict and rolls back dirs", () => {
    const sandboxRoot = openSandbox();
    withOpenDb(":memory:", (db) => {
      db.exec(`
        CREATE TEMP TRIGGER audit_workspace_name_collision
        BEFORE INSERT ON audit_events
        BEGIN
          INSERT INTO workspaces(id, owner_id, name, dir, created_at)
          SELECT CASE WHEN workspace.id = '${ID_A}' THEN '${ID_B}' ELSE '${ID_A}' END,
                 workspace.owner_id, workspace.name, workspace.dir, workspace.created_at
          FROM workspaces AS workspace
          WHERE workspace.id = NEW.workspace_id;
        END;
      `);
      let nativeError: unknown;
      const store = createWorkspaceStore(db, {
        sandboxRoot,
        ensureSharedDir,
        emit: (handle, event) => {
          try {
            return emit(handle, event);
          } catch (error) {
            nativeError = error;
            throw error;
          }
        },
      });
      const error = captureThrown(() => store.create(PRINCIPAL_U1, { name: "alpha" }));
      expect(error).toBe(nativeError);
      expect(error).not.toBeInstanceOf(HttpError);
      expectSqliteError(error, 2067);
      expectUnchangedStore(db, sandboxRoot, 0, []);
    });
  });

  it("fails generically when workspace insert writes zero rows", () => {
    const sandboxRoot = openSandbox();
    withOpenDb(":memory:", (db) => {
      let ensureCalls = 0;
      const store = createWorkspaceStore(db, {
        sandboxRoot,
        ensureSharedDir: (absPath) => {
          ensureCalls += 1;
          ensureSharedDir(absPath);
        },
        emit,
      });
      db.exec(`
        CREATE TEMP TRIGGER workspace_insert_ignore
        BEFORE INSERT ON workspaces
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      const error = captureThrown(() => store.create(PRINCIPAL_U1, { name: "alpha" }));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(HttpError);
      expect(ensureCalls).toBe(0);
      expectUnchangedStore(db, sandboxRoot, 0, []);
    });
  });
});

describe("workspaces store failure compensation", () => {
  it("rolls back the row and newly created empty dirs when the first helper throws", () => {
    expectCreateCompensates(
      ownerMkdirFailed,
      () => {
        throw ownerMkdirFailed;
      },
      { expectIdleTransaction: true },
    );
  });

  it("compensates a first helper that creates the owner dir then throws", () => {
    expectCreateCompensates(ownerChmodFailed, (absPath) => {
      ensureSharedDir(absPath);
      throw ownerChmodFailed;
    });
  });

  it("rolls back when the second helper throws before creating the workspace dir", () => {
    expectCreateCompensates(workspaceMkdirDenied, (absPath, sandboxRoot) => {
      if (absPath === join(sandboxRoot, "u1", "alpha")) {
        throw workspaceMkdirDenied;
      }
      ensureSharedDir(absPath);
    });
  });

  it("removes a newly created owner dir when the workspace helper creates then throws", () => {
    expectCreateCompensates(workspaceChmodFailed, (absPath, sandboxRoot) => {
      ensureSharedDir(absPath);
      if (absPath === join(sandboxRoot, "u1", "alpha")) {
        throw workspaceChmodFailed;
      }
    });
  });

  it("rolls back a real workspace.create event and new empty dirs after emit then fault", () => {
    const sandboxRoot = openSandbox();
    withOpenDb(":memory:", (db) => {
      const store = createWorkspaceStore(db, {
        sandboxRoot,
        ensureSharedDir,
        emit: (handle, event) => {
          emit(handle, event);
          throw postAuditFault;
        },
      });
      expectCreateIdentity(store, postAuditFault);
      expectUnchangedStore(db, sandboxRoot, 0, []);
    });
  });

  it("preserves adopted roots when audit fails after insert", () => {
    const sandboxRoot = openSandbox();
    const ownerRoot = join(sandboxRoot, "u1");
    const workspaceRoot = join(ownerRoot, "kept");
    mkdirSync(ownerRoot, { mode: 0o755 });
    mkdirSync(workspaceRoot, { mode: 0o755 });
    writeFileSync(join(workspaceRoot, "keep.txt"), "stay");
    chmodSync(ownerRoot, 0o755);
    chmodSync(workspaceRoot, 0o755);
    withOpenDb(":memory:", (db) => {
      const store = createWorkspaceStore(db, {
        sandboxRoot,
        ensureSharedDir,
        emit: () => {
          throw auditBoom;
        },
      });
      expectCreateIdentity(store, auditBoom, "kept");
      expect(countWorkspaces(db)).toBe(0);
      expect(countAudits(db)).toBe(0);
      expect(readFileSync(join(workspaceRoot, "keep.txt"), "utf8")).toBe("stay");
      expect(lstatSync(ownerRoot).mode & 0o7777).toBe(0o755);
      expect(lstatSync(workspaceRoot).mode & 0o7777).toBe(0o755);
    });
  });

  it("does not label COMMIT failure as conflict and still compensates new empty dirs", () => {
    const sandboxRoot = openSandbox();
    withDeniedTransactions(sandboxRoot, { denyCommit: true }, (db, store) => {
      try {
        store.create(PRINCIPAL_U1, { name: "alpha" });
        expect.fail("expected COMMIT denial");
      } catch (error) {
        expect(error).not.toBeInstanceOf(HttpError);
        expectSqliteError(error, 23);
      }
      expectUnchangedStore(db, sandboxRoot, 0, []);
    });
  });

  it("keeps rollback failure, still compensates dirs, and may leave uncommitted rows", () => {
    const sandboxRoot = openSandbox();
    withDeniedTransactions(sandboxRoot, { denyCommit: true, denyRollback: true }, (db, store) => {
      const aggregate = captureCreateAggregate(store);
      expect(aggregate.errors.length).toBeGreaterThanOrEqual(2);
      expectSqliteError(aggregate.errors[0], 23);
      expectSqliteError(aggregate.errors[1], 23);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(readdirSync(sandboxRoot)).toEqual([]);
      expect(db.isTransaction).toBe(true);
      expect(countWorkspaces(db)).toBeGreaterThanOrEqual(0);
    });
  });

  it("keeps an undefined authorizer rollback throw as a present failure after a real audit insert", () => {
    const sandboxRoot = openSandbox();
    const original = new Error("audit fault");
    withOpenDb(":memory:", (db) => {
      const store = createWorkspaceStore(db, {
        sandboxRoot,
        ensureSharedDir,
        emit: (handle, event) => {
          emit(handle, event);
          db.setAuthorizer((actionCode, arg1) => {
            if (actionCode === constants.SQLITE_TRANSACTION && arg1 === "ROLLBACK") {
              throw undefined;
            }
            return constants.SQLITE_OK;
          });
          throw original;
        },
      });
      try {
        const aggregate = captureCreateAggregate(store);
        expect(aggregate.errors).toHaveLength(2);
        expect(aggregate.errors[0]).toBe(original);
        expect(aggregate.errors[1]).toBeUndefined();
        expect(aggregate.cause).toBe(original);
        expect(db.isTransaction).toBe(true);
        expect(countWorkspaces(db)).toBe(1);
        expect(countAudits(db)).toBe(1);
        expect(readdirSync(sandboxRoot)).toEqual([]);
      } finally {
        db.setAuthorizer(null);
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
        expect(db.isTransaction).toBe(false);
      }
    });
  });

  it("keeps rollback failure and later cleanup errors with original cause", () => {
    const sandboxRoot = openSandbox();
    withDeniedTransactions(
      sandboxRoot,
      {
        denyCommit: true,
        denyRollback: true,
        ensureSharedDir: (absPath) => {
          ensureSharedDir(absPath);
          if (absPath === join(sandboxRoot, "u1", "alpha")) {
            writeFileSync(join(absPath, "stay.txt"), "keep");
          }
        },
      },
      (db, store) => {
        const aggregate = captureCreateAggregate(store);
        expect(aggregate.errors.length).toBeGreaterThanOrEqual(3);
        expectSqliteError(aggregate.errors[0], 23);
        expectSqliteError(aggregate.errors[1], 23);
        expectNativeErrno(aggregate.errors[2], "ENOTEMPTY");
        expect(aggregate.cause).toBe(aggregate.errors[0]);
        expect(readFileSync(join(sandboxRoot, "u1", "alpha", "stay.txt"), "utf8")).toBe("keep");
        expect(db.isTransaction).toBe(true);
      },
    );
  });

  it("fails before mutation when the caller already owns a transaction", () => {
    const sandboxRoot = openSandbox();
    withStore(sandboxRoot, (db, store) => {
      db.exec("BEGIN");
      try {
        db.prepare(INSERT_SQL).run(ID_A, "u3", "caller", "caller", 1);
        const error = captureThrown(() => store.create(PRINCIPAL_U1, { name: "alpha" }));
        expect(error).not.toBeInstanceOf(HttpError);
        expectSqliteError(error, 1);
        expect(db.isTransaction).toBe(true);
        expect(db.prepare("SELECT id, owner_id, name FROM workspaces ORDER BY id").all()).toEqual([
          { id: ID_A, owner_id: "u3", name: "caller" },
        ]);
        expect(readdirSync(sandboxRoot)).toEqual([]);
      } finally {
        db.exec("ROLLBACK");
      }
      expect(countWorkspaces(db)).toBe(0);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("aggregates nonempty cleanup refusal without deleting adopted content", () => {
    expectFilledWorkspaceCleanup(afterFill, "no-delete");
  });

  it("aggregates cleanup refusal for a leftover file or symlink without deleting it", () => {
    expectFilledWorkspaceCleanup(filledWorkspace, "keep");
  });

  it("rejects unsafe owner segments and existing symlink or file roots without mutation", () => {
    const sandboxRoot = openSandbox();
    const outside = join(sandboxRoot, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    withStore(sandboxRoot, (db, store) => {
      insertUnsafeOwnerAccount(db);
      expectGenericRejection(() => store.create({ id: "bad/id" }, { name: "alpha" }));
      expect(countWorkspaces(db)).toBe(0);
      expect(countAudits(db)).toBe(0);
      symlinkSync(outside, join(sandboxRoot, "u1"));
      expectGenericRejection(() => store.create(PRINCIPAL_U1, { name: "alpha" }));
      expect(lstatSync(join(sandboxRoot, "u1")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(sandboxRoot, "u1", "alpha"))).toBe(false);
      const fileOwnerRoot = join(sandboxRoot, "u2");
      writeFileSync(fileOwnerRoot, "not-a-dir");
      expectGenericRejection(() => store.create(PRINCIPAL_U2, { name: "alpha" }));
      expect(readFileSync(fileOwnerRoot, "utf8")).toBe("not-a-dir");
      expect(countWorkspaces(db)).toBe(0);
      expect(countAudits(db)).toBe(0);
    });
  });
});

function openSandbox(): string {
  return realpathSync(tempDir());
}

function withStore(
  sandboxRoot: string,
  run: (db: DatabaseSync, store: WorkspaceStore) => void,
): void {
  withOpenDb(":memory:", (db) => {
    run(db, createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit }));
  });
}

function listed(
  sandboxRoot: string,
  id: string,
  name: string,
  dir: string,
  createdAt: number,
  ownerId = "u1",
) {
  return { id, name, dir, root: join(sandboxRoot, ownerId, dir), createdAt };
}

function insertWorkspace(
  db: DatabaseSync,
  id: string,
  ownerId: string,
  name: string,
  dir: string,
  createdAt: number,
): void {
  db.prepare(INSERT_SQL).run(id, ownerId, name, dir, createdAt);
}

function insertUnsafeOwnerAccount(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES (?, ?, ?, ?, ?)",
  ).run("bad/id", "badslash", "成员", 0, ACCOUNT_HASH);
}

function linkedOwnerLayout(): { sandboxRoot: string; ownerRoot: string; outside: string } {
  const sandboxRoot = openSandbox();
  const ownerRoot = join(sandboxRoot, "u1");
  const outside = join(sandboxRoot, "outside-ws");
  mkdirSync(ownerRoot);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(ownerRoot, "linked"));
  return { sandboxRoot, ownerRoot, outside };
}

function countWorkspaces(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number };
  return row.count;
}

function countAudits(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
  return row.count;
}

function expectUnchangedStore(
  db: DatabaseSync,
  sandboxRoot: string,
  expectedRows: number,
  expectedRootEntries: string[],
): void {
  expect(countWorkspaces(db)).toBe(expectedRows);
  expect(countAudits(db)).toBe(expectedRows);
  expect(readdirSync(sandboxRoot).toSorted()).toEqual(expectedRootEntries.toSorted());
}

function expectCanonical(
  store: WorkspaceStore,
  input: { name: string; dir?: string },
  code: "bad_request" | "conflict",
): void {
  const error = captureThrown(() => store.create(PRINCIPAL_U1, input));
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ name: "HttpError", code });
}

function expectNativeCreateFailure(
  store: WorkspaceStore,
  db: DatabaseSync,
  sandboxRoot: string,
  principal: { id: string },
  errcode: number,
): void {
  const error = captureThrown(() => store.create(principal, { name: "alpha" }));
  expect(error).not.toBeInstanceOf(HttpError);
  expectSqliteError(error, errcode);
  expectUnchangedStore(db, sandboxRoot, 0, []);
}

function expectCreateCompensates(
  sentinel: Error,
  helper: (absPath: string, sandboxRoot: string) => void,
  options?: { expectIdleTransaction?: boolean },
): void {
  const sandboxRoot = openSandbox();
  withOpenDb(":memory:", (db) => {
    const store = createWorkspaceStore(db, {
      sandboxRoot,
      ensureSharedDir: (absPath) => helper(absPath, sandboxRoot),
      emit,
    });
    expectCreateIdentity(store, sentinel);
    expectUnchangedStore(db, sandboxRoot, 0, []);
    if (options?.expectIdleTransaction) {
      expect(db.isTransaction).toBe(false);
    }
  });
}

function captureCreateAggregate(store: WorkspaceStore): AggregateError {
  const error = captureThrown(() => store.create(PRINCIPAL_U1, { name: "alpha" }));
  expect(error).toBeInstanceOf(AggregateError);
  return error as AggregateError;
}

function expectFilledWorkspaceCleanup(sentinel: Error, contents: string): void {
  const sandboxRoot = openSandbox();
  const workspaceRoot = join(sandboxRoot, "u1", "alpha");
  withOpenDb(":memory:", (db) => {
    const store = createWorkspaceStore(db, {
      sandboxRoot,
      ensureSharedDir: (absPath) => {
        ensureSharedDir(absPath);
        if (absPath === workspaceRoot) {
          writeFileSync(join(workspaceRoot, "stay.txt"), contents);
          throw sentinel;
        }
      },
      emit,
    });
    const aggregate = captureCreateAggregate(store);
    expect(aggregate.errors[0]).toBe(sentinel);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(countWorkspaces(db)).toBe(0);
    expect(readFileSync(join(workspaceRoot, "stay.txt"), "utf8")).toBe(contents);
  });
}

function withDeniedTransactions(
  sandboxRoot: string,
  options: {
    denyCommit?: boolean;
    denyRollback?: boolean;
    ensureSharedDir?: (absPath: string) => void;
  },
  run: (db: DatabaseSync, store: WorkspaceStore) => void,
): void {
  withOpenDb(":memory:", (db) => {
    db.setAuthorizer((actionCode, arg1) => {
      if (
        options.denyRollback &&
        actionCode === constants.SQLITE_TRANSACTION &&
        arg1 === "ROLLBACK"
      ) {
        return constants.SQLITE_DENY;
      }
      if (options.denyCommit && actionCode === constants.SQLITE_TRANSACTION && arg1 === "COMMIT") {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      run(
        db,
        createWorkspaceStore(db, {
          sandboxRoot,
          ensureSharedDir: options.ensureSharedDir ?? ensureSharedDir,
          emit,
        }),
      );
    } finally {
      db.setAuthorizer(null);
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      if (options.denyRollback) {
        expect(db.isTransaction).toBe(false);
      }
    }
  });
}

function captureThrown(run: () => unknown): unknown {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    expect.fail("expected throw");
  }
  return caught;
}

function expectGenericRejection(run: () => unknown): void {
  const error = captureThrown(run);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(HttpError);
}

function expectCreateIdentity(store: WorkspaceStore, sentinel: Error, name = "alpha"): void {
  expect(captureThrown(() => store.create(PRINCIPAL_U1, { name }))).toBe(sentinel);
}

function expectSqliteError(error: unknown, errcode: number): void {
  expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode });
}

function expectNativeErrno(error: unknown, code: string): void {
  expect(error).toMatchObject({ code });
}
