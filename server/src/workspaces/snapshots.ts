/**
 * workspaces/snapshots — per-turn copy of a workspace into the app-private snapshot root
 * (design D9 of s1f-session-list-temp-space; spec workspace-snapshots「快照的存放位置」
 * 「快照内容规则」).
 *
 * `take` writes `<snapshotsRoot>/<workspaceId>/<userMessageId>/{manifest.json,tree/}`. The
 * workspace is only read. The snapshot root is injected by the caller; this module does not know
 * `OMP_STATE_DIR` and does not import from `sessions/`.
 *
 * A writer may be in the workspace while the walk runs (design D9「快照期间可能有写入者」): the
 * previous process of the session has not exited yet, and another session may share the
 * workspace. Every entry is classified by `lstat`. A regular file entry is then read through a
 * handle opened without following its final component and without blocking, so a file replaced
 * after classification is never read through a symbolic link (the open fails and so does the
 * snapshot) and never hangs the walk (a FIFO or device is skipped as `special`). Directories
 * have no such handle (Node has no `openat` / `fdopendir`), which leaves two residuals,
 * registered in design D9 and ADR-0010 (task 20.3):
 *   1. an intermediate path component replaced by a symbolic link after its directory was
 *      listed is traversed by both `lstat` and the open;
 *   2. a directory entry replaced by a symbolic link between its `lstat` and its `readdir` is
 *      listed and copied whole from wherever the link points.
 *
 * Asynchronous on purpose: the snapshot runs as the supervisor's pre-dispatch step, during which
 * a stop must still be answered (spec「受理时做快照」), so the walk must not hold the event loop.
 */
import { constants, promises as fsp, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SOURCE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const COPY_CHUNK_BYTES = 64 * 1024;
const WORKSPACE_ID = /^[0-9a-f]{32}$/;

type SkipReason = "special" | "excluded" | "too_large" | "unreadable";

interface SkippedEntry {
  path: string;
  reason: SkipReason;
}

type ManifestEntry =
  | { path: string; type: "dir"; mode: number }
  | { path: string; type: "file"; size: number; mtimeMs: number; ctimeMs: number; mode: number }
  | { path: string; type: "symlink"; target: string };

interface TakeOptions {
  /** Absolute path of the workspace directory itself (not a symbolic link to it). */
  workspaceRoot: string;
  /** The managed, app-private `snapshots` directory (0700); it must already exist. */
  snapshotsRoot: string;
  /** `workspaces.id`: 32 lowercase hex characters. */
  workspaceId: string;
  /** `chat_messages.id` of the accepted user message: a positive integer. */
  userMessageId: number;
  /** Directory names left out at any depth; a regular file of the same name is not affected. */
  excludeNames: readonly string[];
}

export type TakeResult =
  | { outcome: "ok"; skipped: SkippedEntry[] }
  | { outcome: "too_large" }
  | { outcome: "failed"; error: unknown };

interface Walk {
  workspaceRoot: string;
  treeRoot: string;
  excludeNames: ReadonlySet<string>;
  entries: ManifestEntry[];
  skipped: SkippedEntry[];
}

/**
 * Snapshot the workspace. Resolves to `ok` (with what was left out), `too_large`, or `failed`;
 * unless the result is `ok`, the `<userMessageId>` directory this call created is removed.
 * Rejects only for a caller bug, before touching the disk: a path component that is not a
 * trusted row's id, or a snapshot root that lies inside the workspace.
 */
export async function take(options: TakeOptions): Promise<TakeResult> {
  const snapshotDir = snapshotDirOf(options);
  let created = false;
  let result: TakeResult;
  try {
    await requireDirectory(options.workspaceRoot);
    await ensurePrivateDir(join(options.snapshotsRoot, options.workspaceId));
    await makePrivateDir(snapshotDir);
    created = true;
    result = await write(options, snapshotDir);
  } catch (error) {
    result = { outcome: "failed", error };
  }
  if (result.outcome !== "ok" && created) {
    // A removal that fails leaves the directory to the caller's cleanup of that message.
    await fsp.rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

function snapshotDirOf(options: TakeOptions): string {
  const { workspaceId, userMessageId } = options;
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    throw new TypeError("snapshot workspace id must be 32 lowercase hex characters");
  }
  if (!Number.isSafeInteger(userMessageId) || userMessageId <= 0) {
    throw new TypeError("snapshot message id must be a positive integer");
  }
  const fromWorkspace = relative(resolve(options.workspaceRoot), resolve(options.snapshotsRoot));
  const outside =
    fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace);
  if (!outside) {
    throw new TypeError("snapshot root must not be inside the workspace");
  }
  return join(options.snapshotsRoot, workspaceId, String(userMessageId));
}

async function requireDirectory(workspaceRoot: string): Promise<void> {
  const stat = await fsp.lstat(workspaceRoot);
  if (!stat.isDirectory()) {
    throw new Error("workspace root is not a directory");
  }
}

/** mkdir honours the umask and inherits setgid; the explicit chmod makes the bits exact. */
async function makePrivateDir(path: string): Promise<void> {
  await fsp.mkdir(path, { mode: DIR_MODE });
  await fsp.chmod(path, DIR_MODE);
}

async function ensurePrivateDir(path: string): Promise<void> {
  try {
    await makePrivateDir(path);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw error;
    }
  }
}

async function write(options: TakeOptions, snapshotDir: string): Promise<TakeResult> {
  const walk: Walk = {
    workspaceRoot: options.workspaceRoot,
    treeRoot: join(snapshotDir, "tree"),
    excludeNames: new Set(options.excludeNames),
    entries: [],
    skipped: [],
  };
  await makePrivateDir(walk.treeRoot);
  await visitChildren(walk, "", await fsp.readdir(options.workspaceRoot));

  const manifest = join(snapshotDir, "manifest.json");
  const body = JSON.stringify({ entries: walk.entries, skipped: walk.skipped });
  await fsp.writeFile(manifest, body, { mode: FILE_MODE, flag: "wx" });
  await fsp.chmod(manifest, FILE_MODE);
  return { outcome: "ok", skipped: walk.skipped };
}

/** Names come from `readdir`, so none is empty, `.`, `..` or contains a separator. */
async function visitChildren(walk: Walk, parent: string, names: string[]): Promise<void> {
  for (const name of names.sort()) {
    await visit(walk, parent === "" ? name : `${parent}/${name}`, name);
  }
}

async function visit(walk: Walk, path: string, name: string): Promise<void> {
  const source = join(walk.workspaceRoot, path);
  const stat = await readable(walk, path, () => fsp.lstat(source));
  if (stat === undefined) {
    return;
  }
  if (stat.isDirectory()) {
    await visitDirectory(walk, path, name, stat);
  } else if (stat.isFile()) {
    await visitFile(walk, path);
  } else if (stat.isSymbolicLink()) {
    const target = await readable(walk, path, () => fsp.readlink(source));
    if (target !== undefined) {
      walk.entries.push({ path, type: "symlink", target });
    }
  } else {
    walk.skipped.push({ path, reason: "special" });
  }
}

async function visitDirectory(walk: Walk, path: string, name: string, stat: Stats): Promise<void> {
  if (walk.excludeNames.has(name)) {
    walk.skipped.push({ path, reason: "excluded" });
    return;
  }
  // Listed before anything is recorded: a directory that cannot be listed is skipped whole.
  const names = await readable(walk, path, () => fsp.readdir(join(walk.workspaceRoot, path)));
  if (names === undefined) {
    return;
  }
  walk.entries.push({ path, type: "dir", mode: stat.mode & 0o7777 });
  await makePrivateDir(join(walk.treeRoot, path));
  await visitChildren(walk, path, names);
}

/**
 * The handle, not the earlier `lstat`, decides what the entry is and what the manifest says of
 * it: the entry may have been replaced since it was classified.
 */
async function visitFile(walk: Walk, path: string): Promise<void> {
  const source = await readable(walk, path, () =>
    fsp.open(join(walk.workspaceRoot, path), SOURCE_FLAGS),
  );
  if (source === undefined) {
    return;
  }
  try {
    const stat = await source.stat();
    if (!stat.isFile()) {
      walk.skipped.push({ path, reason: "special" });
    } else if (await copyContent(walk, path, source)) {
      walk.entries.push({
        path,
        type: "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        mode: stat.mode & 0o7777,
      });
    }
  } finally {
    await source.close();
  }
}

/**
 * Copies what `source` reads into a new private file under `tree/`. False when a read was
 * refused: the entry is then recorded as `unreadable` and its partial copy removed. Errors of
 * the copy's own side are not read errors and fail the snapshot.
 */
async function copyContent(walk: Walk, path: string, source: fsp.FileHandle): Promise<boolean> {
  const copy = join(walk.treeRoot, path);
  const target = await fsp.open(copy, "wx", FILE_MODE);
  try {
    // The creation mode honours the umask; the explicit chmod makes the bits exact.
    await target.chmod(FILE_MODE);
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (;;) {
      const read = await readable(walk, path, () => source.read(chunk, 0, chunk.length, null));
      if (read === undefined) {
        await fsp.rm(copy, { force: true });
        return false;
      }
      if (read.bytesRead === 0) {
        return true;
      }
      // writeFile on a handle writes the whole buffer at the current position.
      await target.writeFile(chunk.subarray(0, read.bytesRead));
    }
  } finally {
    await target.close();
  }
}

/**
 * Runs one read of a workspace entry. `EACCES` / `EPERM` records the entry as `unreadable` and
 * yields `undefined`; every other error propagates and fails the snapshot.
 */
async function readable<T>(
  walk: Walk,
  path: string,
  read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    const code = codeOf(error);
    if (code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
    walk.skipped.push({ path, reason: "unreadable" });
    return undefined;
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
