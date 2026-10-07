/**
 * workspaces/snapshots — per-turn copy of a workspace into the app-private snapshot root
 * (design D9 of s1f-session-list-temp-space; spec workspace-snapshots「快照的存放位置」
 * 「快照内容规则」「快照上限与配置」).
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
 * Deduplication (spec「未变文件的去重」): a file whose `fstat` says what the previous snapshot's
 * manifest says of the same path (inode number, size, both times) is hard-linked from that
 * snapshot's `tree/` instead of being read. Links only ever join two snapshots of this root. Copy-on-write is not used: `copyFile`
 * takes a path, and copying by path would follow a symbolic link put there after classification.
 *
 * Asynchronous on purpose: the snapshot runs as the supervisor's pre-dispatch step, during which
 * a stop must still be answered (spec「受理时做快照」), so the walk must not hold the event loop.
 */
import { constants, promises as fsp, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** A workspace file is only ever opened like this: its last component is not followed, no blocking. */
export const SOURCE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const COPY_CHUNK_BYTES = 64 * 1024;
const WORKSPACE_ID = /^[0-9a-f]{32}$/;

type SkipReason = "special" | "excluded" | "too_large" | "unreadable";

interface SkippedEntry {
  path: string;
  reason: SkipReason;
}

export type ManifestEntry =
  | { path: string; type: "dir"; mode: number }
  | ({ path: string; type: "file" } & FileState & { mode: number })
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
  /**
   * `chat_messages.id` of the workspace's latest successful snapshot, when there is one: a
   * positive integer other than `userMessageId`. Its directory is derived like this one's.
   */
  previousMessageId?: number;
  /** Directory names left out at any depth; a regular file of the same name is not affected. */
  excludeNames: readonly string[];
  /** A regular file larger than this is left out (`skipped`, `too_large`) without being read. */
  maxFileBytes: number;
  /** Most bytes the files of one snapshot may add up to; more makes the result `too_large`. */
  maxTotalBytes: number;
  /** Most `entries` (directories, files, symbolic links) of one snapshot; more is `too_large`. */
  maxEntries: number;
}

export type TakeResult =
  | { outcome: "ok"; skipped: SkippedEntry[] }
  | { outcome: "too_large" }
  | { outcome: "failed"; error: unknown };

/**
 * What a manifest records of a workspace file's identity and state; all four equal means the
 * file did not change. `ino` cannot be left out: another file of the same size and times can be
 * moved under the same path (renaming a parent directory leaves the file's `ctime` alone).
 * An inode number above 2^53 loses precision as a `number`; a collision would also need the
 * other three items equal.
 */
interface FileState {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface Walk {
  workspaceRoot: string;
  treeRoot: string;
  /** `tree/` of the previous snapshot, when the caller named one. */
  previousTree: string | undefined;
  /** The previous manifest's file entries by path; empty when there is no usable one. */
  previous: ReadonlyMap<string, FileState>;
  excludeNames: ReadonlySet<string>;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  entries: ManifestEntry[];
  skipped: SkippedEntry[];
  /** Sum of `size` over the file entries. */
  totalBytes: number;
}

/** Thrown by `claim` to end the walk where it stands; `take` turns it into `too_large`. */
class LimitExceeded extends Error {}

/**
 * Snapshot the workspace. Resolves to `ok` (with what was left out), `too_large`, or `failed`;
 * unless the result is `ok`, the `<userMessageId>` directory this call created is removed.
 * Rejects only for a caller bug, before touching the disk: a path component that is not a
 * trusted row's id, a snapshot root that lies inside the workspace, or a limit that is not a
 * positive integer. A previous snapshot that is missing or damaged never fails this one.
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
    result =
      error instanceof LimitExceeded ? { outcome: "too_large" } : { outcome: "failed", error };
  }
  if (result.outcome !== "ok" && created) {
    // A removal that fails leaves the directory to the caller's cleanup of that message.
    await fsp.rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

function snapshotDirOf(options: TakeOptions): string {
  const { workspaceId, userMessageId, previousMessageId } = options;
  for (const limit of [options.maxFileBytes, options.maxTotalBytes, options.maxEntries]) {
    // Anything else (NaN, a missing value) would compare false and switch the limit off.
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("snapshot limits must be positive integers");
    }
  }
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) {
    throw new TypeError("snapshot workspace id must be 32 lowercase hex characters");
  }
  if (!Number.isSafeInteger(userMessageId) || userMessageId <= 0) {
    throw new TypeError("snapshot message id must be a positive integer");
  }
  if (
    previousMessageId !== undefined &&
    (!Number.isSafeInteger(previousMessageId) ||
      previousMessageId <= 0 ||
      previousMessageId === userMessageId)
  ) {
    throw new TypeError("previous snapshot message id must be another positive integer");
  }
  if (isWithin(options.workspaceRoot, options.snapshotsRoot)) {
    throw new TypeError("snapshot root must not be inside the workspace");
  }
  return join(options.snapshotsRoot, workspaceId, String(userMessageId));
}

/** Whether `path` is `directory` itself or lies under it, by name: links are not resolved. */
export function isWithin(directory: string, path: string): boolean {
  const from = relative(resolve(directory), resolve(path));
  return !(from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from));
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
  const previousDir =
    options.previousMessageId === undefined
      ? undefined
      : join(options.snapshotsRoot, options.workspaceId, String(options.previousMessageId));
  const walk: Walk = {
    workspaceRoot: options.workspaceRoot,
    treeRoot: join(snapshotDir, "tree"),
    previousTree: previousDir === undefined ? undefined : join(previousDir, "tree"),
    previous: previousDir === undefined ? new Map() : await previousFiles(previousDir),
    excludeNames: new Set(options.excludeNames),
    maxFileBytes: options.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes,
    maxEntries: options.maxEntries,
    entries: [],
    skipped: [],
    totalBytes: 0,
  };
  await makePrivateDir(walk.treeRoot);
  await visitChildren(walk, "", await fsp.readdir(options.workspaceRoot));

  const manifest = join(snapshotDir, "manifest.json");
  const body = JSON.stringify({ entries: walk.entries, skipped: walk.skipped });
  await fsp.writeFile(manifest, body, { mode: FILE_MODE, flag: "wx" });
  await fsp.chmod(manifest, FILE_MODE);
  return { outcome: "ok", skipped: walk.skipped };
}

/**
 * The file entries of the previous snapshot's manifest. Whatever goes wrong (no directory, no
 * manifest, not JSON, not a manifest) yields no entries: this snapshot then copies everything.
 */
async function previousFiles(previousDir: string): Promise<Map<string, FileState>> {
  const files = new Map<string, FileState>();
  try {
    const manifest: unknown = JSON.parse(
      await fsp.readFile(join(previousDir, "manifest.json"), "utf8"),
    );
    for (const entry of (manifest as { entries: unknown[] }).entries) {
      const file = entry as { path: string; type: unknown } & FileState;
      if (file.type === "file") {
        const { size, mtimeMs, ctimeMs, ino } = file;
        files.set(file.path, { size, mtimeMs, ctimeMs, ino });
      }
    }
    return files;
  } catch {
    return new Map();
  }
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
      claim(walk, 0);
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
  claim(walk, 0);
  walk.entries.push({ path, type: "dir", mode: stat.mode & 0o7777 });
  await makePrivateDir(join(walk.treeRoot, path));
  await visitChildren(walk, path, names);
}

/**
 * Room for one more entry of `bytes` bytes, or the walk ends here: called before the entry is
 * recorded and before any of its content is read or anything of it is created under `tree/`.
 * A count or a total exactly at its limit is within it.
 */
function claim(walk: Walk, bytes: number): void {
  if (walk.entries.length + 1 > walk.maxEntries || walk.totalBytes + bytes > walk.maxTotalBytes) {
    throw new LimitExceeded();
  }
}

/**
 * The handle, not the earlier `lstat`, decides what the entry is and what the manifest says of
 * it: the entry may have been replaced since it was classified. A file over the per-file limit
 * is left out before the other two limits are looked at, so it counts toward neither. A file
 * linked from the previous snapshot counts toward both like a copied one.
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
      return;
    }
    if (stat.size > walk.maxFileBytes) {
      walk.skipped.push({ path, reason: "too_large" });
      return;
    }
    claim(walk, stat.size);
    const size = (await linkUnchanged(walk, path, stat))
      ? stat.size
      : await copyContent(walk, path, source, stat.size);
    if (size !== undefined) {
      walk.totalBytes += size;
      walk.entries.push({
        path,
        type: "file",
        size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        mode: stat.mode & 0o7777,
      });
    }
  } finally {
    await source.close();
  }
}

/**
 * Hard-links the previous snapshot's copy of `path` into this `tree/` when the previous manifest
 * records the `ino`, `size`, `mtimeMs` and `ctimeMs` that `stat` (the `fstat` of the opened
 * workspace file) has; nothing of the file is read. `false` when it did not: no such entry, an
 * item that differs or is not a number (a manifest written before `ino` was recorded, a damaged
 * one: strict comparison with the `fstat` number rules both out), or any failure (the previous
 * snapshot is being removed, the link count is at its limit, …). The caller then copies through
 * its handle.
 *
 * The link's source is a path under the previous `tree/`, never one in the workspace. `link`
 * follows a symbolic link on some systems, so the source must be a regular file itself, of the
 * recorded length, and not the inode of the workspace file: a damaged previous tree is copied
 * over, not trusted. The linked inode keeps its 0600; `mode` in the manifest is the workspace's.
 */
async function linkUnchanged(walk: Walk, path: string, stat: Stats): Promise<boolean> {
  const before = walk.previous.get(path);
  if (
    walk.previousTree === undefined ||
    before?.ino !== stat.ino ||
    before.size !== stat.size ||
    before.mtimeMs !== stat.mtimeMs ||
    before.ctimeMs !== stat.ctimeMs
  ) {
    return false;
  }
  const previousCopy = join(walk.previousTree, path);
  try {
    const kept = await fsp.lstat(previousCopy);
    if (
      !kept.isFile() ||
      kept.size !== stat.size ||
      (kept.ino === stat.ino && kept.dev === stat.dev)
    ) {
      return false;
    }
    await fsp.link(previousCopy, join(walk.treeRoot, path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies at most the first `limit` bytes `source` reads into a new private file under `tree/`
 * and returns how many that was. `limit` is the size the handle reported when it was opened:
 * what a writer appends meanwhile stays out, so the copy is never longer than what the limits
 * were checked against; a file truncated meanwhile ends early and the count says so.
 * `undefined` when a read was refused: the entry is then recorded as `unreadable` and its
 * partial copy removed. Errors of the copy's own side are not read errors and fail the snapshot.
 */
async function copyContent(
  walk: Walk,
  path: string,
  source: fsp.FileHandle,
  limit: number,
): Promise<number | undefined> {
  const copy = join(walk.treeRoot, path);
  const target = await fsp.open(copy, "wx", FILE_MODE);
  try {
    // The creation mode honours the umask; the explicit chmod makes the bits exact.
    await target.chmod(FILE_MODE);
    const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, limit));
    let copied = 0;
    while (copied < limit) {
      const want = Math.min(chunk.length, limit - copied);
      const read = await readable(walk, path, () => source.read(chunk, 0, want, null));
      if (read === undefined) {
        await fsp.rm(copy, { force: true });
        return undefined;
      }
      if (read.bytesRead === 0) {
        break;
      }
      // writeFile on a handle writes the whole buffer at the current position.
      await target.writeFile(chunk.subarray(0, read.bytesRead));
      copied += read.bytesRead;
    }
    return copied;
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

export function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
