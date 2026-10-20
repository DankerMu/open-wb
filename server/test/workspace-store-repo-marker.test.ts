/**
 * Issue #1567 (omp-pin-18-12 task 3.2): omp-runtime「会话工作目录的仓库根标记」, Scenario「创建工作
 * 空间即带标记」 — both creation paths of the workspace store plant `<root>/.git` with the real
 * marker function (injected like `ensureSharedDir`); a marker that cannot be made fails the
 * creation and removes what this call made; a rollback after the marker removes the marker first,
 * then the new root. The REST half runs on the production createApp assembly. Oracles: the disk,
 * SQLite rows and the spec's literals (`2770`, a 500 that is not a canonical HTTP error).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { ensureRepoRootMarker } from "../src/sessions/omp/repo-root-marker.js";
import { createWorkspaceStore, type WorkspaceStore } from "../src/workspaces/store.js";
import { openWorld } from "./commands-rest-helpers.js";
import { removeTempDirs, tempDir, withOpenDb } from "./core-db-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE, loginSessionPair } from "./session-db-helpers.js";

const SHARED_MODE = 0o2770;
const IS_ROOT = process.getuid?.() === 0;
const U1 = { id: "u1" };

afterEach(() => {
  removeTempDirs();
});

interface StoreOptions {
  ensureSharedDir?: (absPath: string) => void;
  emit?: typeof emit;
}

function withStore(
  options: StoreOptions,
  run: (db: DatabaseSync, store: WorkspaceStore, sandboxRoot: string) => void,
): void {
  const sandboxRoot = realpathSync(tempDir());
  withOpenDb(":memory:", (db) => {
    const store = createWorkspaceStore(db, {
      sandboxRoot,
      ensureSharedDir: options.ensureSharedDir ?? ensureSharedDir,
      ensureRepoRootMarker,
      emit: options.emit ?? emit,
    });
    run(db, store, sandboxRoot);
  });
}

function count(db: DatabaseSync, table: "workspaces" | "audit_events"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** The root holds exactly the marker: an empty directory at 2770. */
function expectMarkedOnly(root: string): void {
  expect(readdirSync(root)).toEqual([".git"]);
  expect(lstatSync(join(root, ".git")).isDirectory()).toBe(true);
  expect(modeOf(join(root, ".git"))).toBe(SHARED_MODE);
  expect(readdirSync(join(root, ".git"))).toEqual([]);
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.fail("expected throw");
}

/** `ensureSharedDir`, then the workspace root (picked by its base name) made unwritable. */
function lockingEnsure(isWorkspaceRoot: (name: string) => boolean): (absPath: string) => void {
  return (absPath) => {
    ensureSharedDir(absPath);
    if (isWorkspaceRoot(basename(absPath))) {
      chmodSync(absPath, 0o555);
    }
  };
}

describe("both creation paths plant the marker", () => {
  it("create: the new root holds only an empty 2770 .git; the owner root gets none", () => {
    withStore({}, (_db, store, sandboxRoot) => {
      const created = store.create(U1, { name: "proj" });

      expectMarkedOnly(created.root);
      expect(modeOf(created.root)).toBe(SHARED_MODE);
      expect(readdirSync(join(sandboxRoot, "u1"))).toEqual(["proj"]);
    });
  });

  it("createTemporary: the new root holds only an empty 2770 .git", () => {
    withStore({}, (db, store) => {
      db.exec("BEGIN");
      const { workspace } = store.createTemporary(U1);
      db.exec("COMMIT");

      expectMarkedOnly(workspace.root);
    });
  });

  it("adopts an ordinary existing workspace directory without changing bytes or mode, adding the marker", () => {
    withStore({}, (_db, store, sandboxRoot) => {
      const ownerRoot = join(sandboxRoot, "u1");
      const workspaceRoot = join(ownerRoot, "smoke-fixture");
      mkdirSync(workspaceRoot, { recursive: true, mode: 0o755 });
      writeFileSync(join(workspaceRoot, "keep.txt"), "adopt-me");
      chmodSync(ownerRoot, 0o755);
      chmodSync(workspaceRoot, 0o755);

      const created = store.create(U1, { name: "smoke", dir: "smoke-fixture" });

      expect(created.root).toBe(workspaceRoot);
      expect(readFileSync(join(workspaceRoot, "keep.txt"), "utf8")).toBe("adopt-me");
      expect(modeOf(ownerRoot)).toBe(0o755);
      expect(modeOf(workspaceRoot)).toBe(0o755);
      expect(readdirSync(workspaceRoot)).toEqual([".git", "keep.txt"]);
      expect(modeOf(join(workspaceRoot, ".git"))).toBe(SHARED_MODE);
    });
  });

  it("adopts a directory that is already a repository without touching its .git", () => {
    withStore({}, (_db, store, sandboxRoot) => {
      const repo = join(sandboxRoot, "u1", "repo", ".git");
      mkdirSync(repo, { recursive: true, mode: 0o755 });
      chmodSync(repo, 0o755);
      writeFileSync(join(repo, "HEAD"), "ref: refs/heads/main\n");

      store.create(U1, { name: "repo" });

      expect(readdirSync(repo)).toEqual(["HEAD"]);
      expect(modeOf(repo)).toBe(0o755);
    });
  });
});

describe("rollback after the marker removes the marker, then the new root", () => {
  it("create: an audit write failing after the marker leaves no root and no row", () => {
    const fault = new Error("audit fault");
    withStore(
      {
        emit: () => {
          throw fault;
        },
      },
      (db, store, sandboxRoot) => {
        expect(captureThrown(() => store.create(U1, { name: "proj" }))).toBe(fault);

        expect(readdirSync(sandboxRoot)).toEqual([]);
        expect(count(db, "workspaces")).toBe(0);
      },
    );
  });

  it("createTemporary: the caller's rollback and removeCreatedDirs leave no root", () => {
    withStore({}, (db, store, sandboxRoot) => {
      db.exec("BEGIN");
      const created = store.createTemporary(U1);
      expectMarkedOnly(created.workspace.root);
      db.exec("ROLLBACK");

      created.removeCreatedDirs();

      expect(readdirSync(sandboxRoot)).toEqual([]);
    });
  });
});

describe.skipIf(IS_ROOT)("a marker that cannot be made fails the creation", () => {
  it("create: a generic failure, no row, no audit, the directories this call made removed", () => {
    withStore(
      { ensureSharedDir: lockingEnsure((name) => name === "proj") },
      (db, store, sandboxRoot) => {
        const error = captureThrown(() => store.create(U1, { name: "proj" }));

        expect(error).toMatchObject({ code: "EACCES" });
        expect(error).not.toBeInstanceOf(HttpError);
        expect(count(db, "workspaces")).toBe(0);
        expect(count(db, "audit_events")).toBe(0);
        expect(db.isTransaction).toBe(false);
        expect(readdirSync(sandboxRoot)).toEqual([]);
      },
    );
  });

  it("createTemporary: throws after removing the directories it made; the row is the caller's to roll back", () => {
    const isTemporary = (name: string) => name.startsWith("tmp-");
    withStore({ ensureSharedDir: lockingEnsure(isTemporary) }, (db, store, sandboxRoot) => {
      db.exec("BEGIN");
      const error = captureThrown(() => store.createTemporary(U1));
      db.exec("ROLLBACK");

      expect(error).toMatchObject({ code: "EACCES" });
      expect(error).not.toBeInstanceOf(HttpError);
      expect(readdirSync(sandboxRoot)).toEqual([]);
      expect(count(db, "workspaces")).toBe(0);
    });
  });

  it("POST /api/workspaces over an unwritable existing directory: the generic 500, no row, no audit, the directory untouched", async () => {
    const { app, db, sandboxRoot } = openWorld("workspace-marker-rest-");
    const cookie = await loginSessionPair(app);
    const root = join(sandboxRoot, "u1", "locked");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "keep.txt"), "kept");
    chmodSync(root, 0o555);
    const audits = count(db, "audit_events");
    let response: Awaited<ReturnType<typeof app.inject>>;
    try {
      response = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { cookie, "content-type": "application/json" },
        payload: JSON.stringify({ name: "locked", dir: "locked" }),
      });
    } finally {
      chmodSync(root, 0o755);
    }

    expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
    expect(count(db, "workspaces")).toBe(0);
    expect(count(db, "audit_events")).toBe(audits);
    expect(readdirSync(root)).toEqual(["keep.txt"]);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});
