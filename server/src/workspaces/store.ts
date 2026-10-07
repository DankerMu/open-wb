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
  /** Row ids of temporary workspaces; tests inject collisions. Default: 16 random bytes as hex. */
  generateId?: () => string;
}

/** A temporary workspace whose row is still uncommitted in the caller's transaction. */
interface CreatedTemporaryWorkspace {
  workspace: WorkspaceRecord;
  /**
   * For a caller whose transaction fails after `createTemporary` returned: removes, in reverse
   * order, the directories that call created, only while they are empty directories. Throws an
   * AggregateError naming what it had to leave; safe to call again.
   */
  removeCreatedDirs(): void;
}

export interface WorkspaceStore {
  list(ownerId: string): WorkspaceRecord[];
  create(principal: StorePrincipal, input: CreateWorkspaceInput): WorkspaceRecord;
  /**
   * Inserts a `temporary = 1` row (`dir = name = tmp-<id>`) and ensures its directory inside the
   * transaction the caller already opened. Issues no BEGIN / COMMIT / ROLLBACK and writes no
   * audit event: on failure it removes the directories it created and rethrows, the rollback is
   * the caller's. Outside a transaction it throws before any mutation.
   */
  createTemporary(principal: StorePrincipal): CreatedTemporaryWorkspace;
  rootOf(principal: StorePrincipal, workspaceId: string): string | null;
}

type WorkspaceRow = {
  id: string;
  name: string;
  dir: string;
  createdAt: number;
} & Record<string, SQLOutputValue>;

const LIST_SQL =
  "SELECT id, name, dir, created_at AS createdAt FROM workspaces WHERE owner_id = ? AND temporary = 0 ORDER BY created_at ASC, id ASC";
const ROOT_OF_SQL = "SELECT dir FROM workspaces WHERE owner_id = ? AND id = ? LIMIT 1";
const INSERT_SQL =
  "INSERT INTO workspaces(id, owner_id, name, dir, created_at, temporary) VALUES (?, ?, ?, ?, ?, ?)";
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const ID_CONFLICT_MESSAGE = "UNIQUE constraint failed: workspaces.id";
/** How many generated ids a temporary workspace may try before giving up. */
const TEMPORARY_ID_ATTEMPTS = 8;
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
  const generateId = options.generateId ?? (() => randomBytes(16).toString("hex"));

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

      const roots = [ownerRoot, workspaceRoot];
      const createdPaths = missingPaths(roots);

      db.exec("BEGIN");
      try {
        insertOwnedWorkspace(db, created, principal.id);
        ensureRoots(roots, ensureSharedDir);
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
    createTemporary(principal: StorePrincipal): CreatedTemporaryWorkspace {
      if (!db.isTransaction) {
        throw new Error("temporary workspace creation needs the caller's transaction");
      }
      const ownerRoot = computeSafeRoot(sandboxRoot, principal.id);
      const row = insertTemporaryWorkspace(db, principal.id, generateId);
      // The only path component is `tmp-<id>`, and the row's CHECKs already accepted that id.
      const workspaceRoot = computeSafeRoot(sandboxRoot, principal.id, row.dir);
      const roots = [ownerRoot, workspaceRoot];
      const createdPaths = missingPaths(roots);
      try {
        ensureRoots(roots, ensureSharedDir);
      } catch (error) {
        throw failAfterCleanup(error, [], createdPaths);
      }
      return {
        workspace: { ...row, root: workspaceRoot },
        removeCreatedDirs(): void {
          const errors = removeCreatedDirs(createdPaths);
          if (errors.length > 0) {
            throw new AggregateError(errors, CLEANUP_FAILURE_MESSAGE);
          }
        },
      };
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
  if (
    name.length === 0 ||
    codePointCount(name) > MAX_NAME_CODEPOINTS ||
    hasForbiddenNameCodePoint(name)
  ) {
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

function hasForbiddenNameCodePoint(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (
      code !== undefined &&
      (code <= 0x1f || code === 0x7f || (code >= 0xd800 && code <= 0xdfff))
    ) {
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

/** The paths among `roots` that do not exist yet — the ones the ensure step is about to create. */
function missingPaths(roots: string[]): string[] {
  return roots.filter((root) => !pathExists(root));
}

/** Owner root first, then the workspace root: each parent exists before its child is made. */
function ensureRoots(roots: string[], ensureSharedDir: (absPath: string) => void): void {
  for (const root of roots) {
    ensureSharedDir(root);
  }
}

type InsertableWorkspace = Omit<WorkspaceRecord, "root">;

function insertWorkspaceRow(
  db: DatabaseSync,
  row: InsertableWorkspace,
  ownerId: string,
  temporary: 0 | 1,
): void {
  const result = db
    .prepare(INSERT_SQL)
    .run(row.id, ownerId, row.name, row.dir, row.createdAt, temporary);
  if (result.changes !== 1 && result.changes !== 1n) {
    throw new Error("workspace insert must change exactly one row");
  }
}

/**
 * Inserts the `temporary = 1` row under a generated id, trying again while that id (global primary
 * key) or its `tmp-<id>` name / dir (unique per owner) is taken. A failed INSERT undoes only
 * itself, so the caller's transaction stays usable. Any other failure propagates at once.
 */
function insertTemporaryWorkspace(
  db: DatabaseSync,
  ownerId: string,
  generateId: () => string,
): InsertableWorkspace {
  for (let attempt = 0; attempt < TEMPORARY_ID_ATTEMPTS; attempt += 1) {
    const id = generateId();
    const dir = `tmp-${id}`;
    const row = { id, name: dir, dir, createdAt: Date.now() };
    try {
      insertWorkspaceRow(db, row, ownerId, 1);
      return row;
    } catch (error) {
      if (!isOwnerUniqueConflict(error) && !isIdConflict(error)) {
        throw error;
      }
    }
  }
  throw new Error("temporary workspace id generation exhausted");
}

function insertOwnedWorkspace(db: DatabaseSync, created: WorkspaceRecord, ownerId: string): void {
  try {
    insertWorkspaceRow(db, created, ownerId, 0);
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

function isIdConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    error.errcode === SQLITE_CONSTRAINT_PRIMARYKEY &&
    error.message === ID_CONFLICT_MESSAGE
  );
}

function compensateCreateFailure(
  db: DatabaseSync,
  originalError: unknown,
  createdPaths: string[],
): never {
  const rollbackErrors: unknown[] = [];
  if (db.isTransaction) {
    try {
      db.exec("ROLLBACK");
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  failAfterCleanup(originalError, rollbackErrors, createdPaths);
}

/**
 * The transaction-free half of create's compensation: removes the empty directories this call
 * created, then throws the original failure — alone when nothing else went wrong, otherwise as
 * the first entry and cause of an AggregateError [original, ...rollbackErrors, ...cleanupErrors].
 */
function failAfterCleanup(
  originalError: unknown,
  rollbackErrors: unknown[],
  createdPaths: string[],
): never {
  const errors = [originalError, ...rollbackErrors, ...removeCreatedDirs(createdPaths)];
  if (errors.length === 1) {
    throw originalError;
  }
  throw new AggregateError(
    errors,
    rollbackErrors.length > 0 ? ROLLBACK_FAILURE_MESSAGE : CLEANUP_FAILURE_MESSAGE,
    { cause: originalError },
  );
}

/** Reverse-order removal of the still-empty directories in `createdPaths`; returns what failed. */
function removeCreatedDirs(createdPaths: string[]): unknown[] {
  const errors: unknown[] = [];
  for (const path of createdPaths.toReversed()) {
    try {
      removeEmptyCreatedDir(path);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
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
