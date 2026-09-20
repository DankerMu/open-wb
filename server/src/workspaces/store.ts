/**
 * workspaces/store — owner-scoped workspace persistence and lazy roots.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, rmdirSync } from "node:fs";
import { isAbsolute, resolve as resolveFsPath } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { emit as canonicalEmit } from "../core/audit/index.js";
import { HttpError } from "../core/errors/index.js";
import { resolve as resolveSandboxPath } from "../core/sandbox/resolve.js";

interface WorkspaceRecord {
  id: string;
  name: string;
  dir: string;
  root: string;
  createdAt: number;
}

interface StorePrincipal {
  id: string;
}

interface CreateWorkspaceInput {
  name: string;
  dir?: string;
}

interface WorkspaceStoreOptions {
  sandboxRoot: string;
  ensureSharedDir: (absPath: string) => void;
  emit: typeof canonicalEmit;
}

export interface WorkspaceStore {
  list(ownerId: string): WorkspaceRecord[];
  create(principal: StorePrincipal, input: CreateWorkspaceInput): WorkspaceRecord;
  rootOf(principal: StorePrincipal, workspaceId: string): string | null;
}

type WorkspaceRow = {
  id: string;
  name: string;
  dir: string;
  createdAt: number;
} & Record<string, SQLOutputValue>;

const LIST_SQL =
  "SELECT id, name, dir, created_at AS createdAt FROM workspaces WHERE owner_id = ? ORDER BY created_at ASC, id ASC";
const ROOT_OF_SQL = "SELECT dir FROM workspaces WHERE owner_id = ? AND id = ? LIMIT 1";
const INSERT_SQL =
  "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)";
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const DIR_ALPHABET = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,64}$/;
const DEMO_DIR_REPLACE = /[^\w\u4e00-\u9fa5-]/g;
const MAX_NAME_CODEPOINTS = 64;
const ROLLBACK_FAILURE_MESSAGE = "workspace create rollback failed";
const CLEANUP_FAILURE_MESSAGE = "workspace create compensation failed";

export function createWorkspaceStore(
  db: DatabaseSync,
  options: WorkspaceStoreOptions,
): WorkspaceStore {
  const sandboxRoot = isAbsolute(options.sandboxRoot)
    ? options.sandboxRoot
    : resolveFsPath(options.sandboxRoot);
  const { ensureSharedDir, emit } = options;

  return {
    list(ownerId: string): WorkspaceRecord[] {
      const rows = db.prepare(LIST_SQL).all(ownerId) as WorkspaceRow[];
      const listed: WorkspaceRecord[] = [];
      for (const row of rows) {
        listed.push(toWorkspace(sandboxRoot, ownerId, row));
      }
      return listed;
    },
    create(principal: StorePrincipal, input: CreateWorkspaceInput): WorkspaceRecord {
      const name = validateName(input.name);
      const dir = resolveDir(name, input.dir);
      const ownerRoot = computeSafeRoot(sandboxRoot, principal.id);
      const workspaceRoot = computeSafeRoot(sandboxRoot, principal.id, dir);

      const id = randomBytes(16).toString("hex");
      const createdAt = Date.now();
      const created: WorkspaceRecord = {
        id,
        name,
        dir,
        root: workspaceRoot,
        createdAt,
      };

      const ownerMissingBefore = !pathExists(ownerRoot);
      const workspaceMissingBefore = !pathExists(workspaceRoot);
      const createdPaths: string[] = [];
      if (ownerMissingBefore) {
        createdPaths.push(ownerRoot);
      }
      if (workspaceMissingBefore) {
        createdPaths.push(workspaceRoot);
      }

      db.exec("BEGIN");
      try {
        insertOwnedWorkspace(db, created, principal.id);
        ensureSharedDir(ownerRoot);
        ensureSharedDir(workspaceRoot);
        emit(db, {
          kind: "workspace.create",
          actorId: principal.id,
          workspaceId: created.id,
          title: `创建工作空间 ${name}`,
          detail: { root: workspaceRoot },
        });
        db.exec("COMMIT");
      } catch (error) {
        throw compensateCreateFailure(db, error, createdPaths);
      }
      return created;
    },
    rootOf(principal: StorePrincipal, workspaceId: string): string | null {
      const row = db.prepare(ROOT_OF_SQL).get(principal.id, workspaceId) as
        | { dir: string }
        | undefined;
      if (row === undefined) {
        return null;
      }
      return computeSafeRoot(sandboxRoot, principal.id, row.dir);
    },
  };
}

function toWorkspace(sandboxRoot: string, ownerId: string, row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    dir: row.dir,
    root: computeSafeRoot(sandboxRoot, ownerId, row.dir),
    createdAt: row.createdAt,
  };
}

function validateName(rawName: string): string {
  const name = rawName.trim();
  if (name.length === 0 || codePointCount(name) > MAX_NAME_CODEPOINTS || hasAsciiControl(name)) {
    throw new HttpError("bad_request");
  }
  return name;
}

function resolveDir(name: string, explicitDir: string | undefined): string {
  const dir = explicitDir === undefined ? name.replace(DEMO_DIR_REPLACE, "-") : explicitDir;
  if (
    dir.length === 0 ||
    dir.length > MAX_NAME_CODEPOINTS ||
    dir === "." ||
    dir === ".." ||
    dir.includes("\0") ||
    !DIR_ALPHABET.test(dir)
  ) {
    throw new HttpError("bad_request");
  }
  return dir;
}

function codePointCount(value: string): number {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > MAX_NAME_CODEPOINTS) {
      return count;
    }
  }
  return count;
}

function hasAsciiControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function rejectUnsafeOwnerSegment(ownerId: string): void {
  if (
    ownerId.length === 0 ||
    ownerId === "." ||
    ownerId === ".." ||
    ownerId.includes("\0") ||
    ownerId.includes("/") ||
    ownerId.includes("\\")
  ) {
    throw new Error("invalid workspace owner path");
  }
}

function pathExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function computeSafeRoot(sandboxRoot: string, ownerId: string, dir?: string): string {
  rejectUnsafeOwnerSegment(ownerId);
  const relPath = dir === undefined ? ownerId : `${ownerId}/${dir}`;
  const resolved = resolveSandboxPath(sandboxRoot, relPath, "read");
  if (!resolved.ok) {
    throw new Error("invalid workspace root path");
  }
  const status = lstatSync(resolved.absPath, { throwIfNoEntry: false });
  if (status !== undefined && !status.isDirectory()) {
    throw new Error("invalid workspace root path");
  }
  return resolved.absPath;
}

function insertOwnedWorkspace(db: DatabaseSync, created: WorkspaceRecord, ownerId: string): void {
  try {
    const result = db
      .prepare(INSERT_SQL)
      .run(created.id, ownerId, created.name, created.dir, created.createdAt);
    if (result.changes !== 1 && result.changes !== 1n) {
      throw new Error("workspace insert must change exactly one row");
    }
  } catch (error) {
    if (isOwnerUniqueConflict(error)) {
      throw new HttpError("conflict");
    }
    throw error;
  }
}

function isOwnerUniqueConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) {
    return false;
  }
  if (error.errcode !== SQLITE_CONSTRAINT_UNIQUE) {
    return false;
  }
  const message = error instanceof Error ? error.message : "";
  return (
    message === "UNIQUE constraint failed: workspaces.owner_id, workspaces.name" ||
    message === "UNIQUE constraint failed: workspaces.owner_id, workspaces.dir"
  );
}

function compensateCreateFailure(
  db: DatabaseSync,
  originalError: unknown,
  createdPaths: string[],
): never {
  const errors: unknown[] = [originalError];
  let rollbackFailed = false;
  if (db.isTransaction) {
    try {
      db.exec("ROLLBACK");
    } catch (error) {
      rollbackFailed = true;
      errors.push(error);
    }
  }

  for (let index = createdPaths.length - 1; index >= 0; index -= 1) {
    const path = createdPaths[index];
    if (path === undefined) {
      continue;
    }
    try {
      removeEmptyCreatedDir(path);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw originalError;
  }
  throw new AggregateError(
    errors,
    rollbackFailed ? ROLLBACK_FAILURE_MESSAGE : CLEANUP_FAILURE_MESSAGE,
    { cause: originalError },
  );
}

function removeEmptyCreatedDir(path: string): void {
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status === undefined) {
    return;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`refusing to remove non-empty workspace path ${path}`);
  }
  rmdirSync(path);
}
