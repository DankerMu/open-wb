/**
 * workspaces/snapshots-restore — puts a workspace back to what a snapshot's manifest describes
 * (design D10 of s1f-session-list-temp-space; spec workspace-snapshots「还原」).
 *
 * The snapshot directory is only read: files under `tree/` may be hard-linked into other
 * snapshots, so nothing there is written, chmod-ed, timed or linked from. The workspace is
 * written by copying.
 *
 * A writer may be in the workspace while this runs (another workspace's omp process shares the
 * omp user, design D10): the workspace cannot be assumed still. What is bound to a handle is
 * safe against a path replaced meanwhile: every read of a workspace file (one handle, last
 * component not followed, no blocking), the content, mode and time of a written-back file (set
 * on the temporary file's handle before it gets its name), and the mode of a new directory.
 * Everything else goes by path. Each entry is first checked by `parentsAreReal` (every parent
 * level a real directory), and so is each single call that creates, deletes or renames
 * (`guard`). The check and the call it guards are still two steps (Node has no `openat`), so a
 * parent replaced by a symbolic link between them is traversed: the residual registered in
 * design D10 and ADR-0010 (task 20.3).
 *
 * Errors: `EACCES` / `EPERM` on one entry puts it in `failed` and the restore goes on; anything
 * else rejects, leaving the workspace partly restored. Calling again continues: what is already
 * as the manifest says is left alone.
 */
import { randomBytes } from "node:crypto";
import { constants, promises as fsp, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { codeOf, isWithin, type ManifestEntry, SOURCE_FLAGS } from "./snapshots.js";

/** New directories: shared with the omp user's group, setgid so the group is inherited. */
const SHARED_DIR_MODE = 0o2770;
/** What `mkdir` is asked for; the handle then sets `SHARED_DIR_MODE` whatever the umask. */
const NEW_DIR_MODE = 0o770;
/** A written-back file is readable and writable by owner and group, whatever the manifest says. */
const SHARED_RW = 0o660;
/** A temporary file is private until its content, mode and time are complete. */
const TEMP_MODE = 0o600;
const TREE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const NEW_DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const CHUNK_BYTES = 64 * 1024;
/** What opening a path with `SOURCE_FLAGS` fails with when no regular file can be there. */
const NO_REGULAR_FILE: ReadonlySet<unknown> = new Set(["ENOENT", "ELOOP", "ENXIO", "EOPNOTSUPP"]);

/** A manifest written before inode numbers were recorded has file entries without `ino`. */
type FileEntry = Omit<Extract<ManifestEntry, { type: "file" }>, "ino"> & {
  ino: number | undefined;
};
type Entry = Exclude<ManifestEntry, { type: "file" }> | FileEntry;

interface SkippedPath {
  path: string;
  reason: string;
}

interface RestoreOptions {
  /** Absolute path of the workspace directory itself (not a symbolic link to it). */
  workspaceRoot: string;
  /** One snapshot's directory (`manifest.json` and `tree/`), outside the workspace. */
  snapshotDir: string;
}

interface RestoreResult {
  /** Files whose content was written back, plus symbolic links created again. */
  restored: number;
  /** Deleted entries the manifest does not have; a directory with all below it counts once. */
  removed: number;
  /** The manifest's `skipped`: neither these paths nor anything under them was touched. */
  skipped: SkippedPath[];
  /** Entries left as they were: a parent level is not a real directory, or permission denied. */
  failed: { path: string }[];
}

interface Run {
  root: string;
  tree: string;
  /** The manifest's entries by path, without those under a skipped path. */
  entries: ReadonlyMap<string, Entry>;
  skipped: ReadonlySet<string>;
  restored: number;
  removed: number;
  failed: Set<string>;
}

/**
 * Restore the workspace from one snapshot. Rejects before touching the workspace when the
 * snapshot directory lies inside the workspace, the manifest is not a well-formed one, `tree/`
 * is missing or the workspace root is not a real directory. Order: delete what the manifest does not have, then directories from the top down,
 * then files, then symbolic links. An entry of another type under a manifest path is replaced
 * by its phase and does not count toward `removed`.
 */
export async function restore(options: RestoreOptions): Promise<RestoreResult> {
  if (isWithin(options.workspaceRoot, options.snapshotDir)) {
    // A caller bug: the first phase would delete the snapshot as something the manifest lacks.
    throw new TypeError("snapshot directory must not be inside the workspace");
  }
  const manifest = await readManifest(options.snapshotDir);
  const tree = join(options.snapshotDir, "tree");
  await requireDirectory(tree, "snapshot tree");
  await requireDirectory(options.workspaceRoot, "workspace root");
  const run: Run = {
    root: options.workspaceRoot,
    tree,
    entries: manifest.entries,
    skipped: new Set(manifest.skipped.map((item) => item.path)),
    restored: 0,
    removed: 0,
    failed: new Set(),
  };

  await removeExtras(run, "");
  // A parent's path is a prefix of its children's, so it sorts ahead of them.
  const entries = [...run.entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const entry of entries) {
    if (entry.type === "dir") {
      await attempt(run, entry.path, () => ensureDirectory(run, entry.path));
    }
  }
  for (const entry of entries) {
    if (entry.type === "file") {
      await attempt(run, entry.path, () => restoreFile(run, entry));
    }
  }
  for (const entry of entries) {
    if (entry.type === "symlink") {
      await attempt(run, entry.path, () => restoreSymlink(run, entry.path, entry.target));
    }
  }
  return {
    restored: run.restored,
    removed: run.removed,
    skipped: manifest.skipped,
    failed: [...run.failed].map((path) => ({ path })),
  };
}

/**
 * Whether every level above `path`, from the workspace root down, is a real directory right now
 * (by `lstat`: a symbolic link, another type or a missing level is not). The last component of
 * `path` is the entry itself and is not looked at. `restore` asks this before each write or
 * delete and puts the entry in `failed` on `false`; exported as the seam the tests call.
 */
export async function parentsAreReal(workspaceRoot: string, path: string): Promise<boolean> {
  let level = workspaceRoot;
  for (const name of ["", ...path.split("/").slice(0, -1)]) {
    level = join(level, name);
    if (!(await present(level))?.isDirectory()) {
      return false;
    }
  }
  return true;
}

/** Thrown by `guard`; `attempt` turns it into a `failed` entry. */
class ParentNotReal extends Error {}

/** Called right ahead of every call that creates, deletes or renames something at `path`. */
async function guard(run: Run, path: string): Promise<void> {
  if (!(await parentsAreReal(run.root, path))) {
    throw new ParentNotReal();
  }
}

/**
 * Runs what restores one entry, after checking its parents (so its reads are not led elsewhere
 * either). The entry goes to `failed` when a parent level is not a real directory, then or at a
 * later `guard`, or when the work is refused (`EACCES` / `EPERM`); any other error propagates
 * and ends the restore.
 */
async function attempt(run: Run, path: string, work: () => Promise<void>): Promise<void> {
  try {
    await guard(run, path);
    await work();
  } catch (error) {
    const code = codeOf(error);
    if (!(error instanceof ParentNotReal) && code !== "EACCES" && code !== "EPERM") {
      throw error;
    }
    run.failed.add(path);
  }
}

async function requireDirectory(path: string, what: string): Promise<void> {
  if (!(await fsp.lstat(path)).isDirectory()) {
    throw new Error(`${what} is not a directory`);
  }
}

/** `lstat`, or `undefined` when nothing is there. */
async function present(path: string): Promise<Stats | undefined> {
  try {
    return await fsp.lstat(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Deletes the workspace entry `path`, which `stat` (its `lstat`) found there. Anything but a
 * directory goes by `unlink`, which never follows a link and never deletes a directory. A
 * directory goes with all below it: `rm` classifies each level by `lstat` and unlinks links.
 * An entry replaced after its `lstat` is deleted as whatever it is by then.
 */
async function remove(run: Run, path: string, stat: Stats): Promise<void> {
  await guard(run, path);
  if (stat.isDirectory()) {
    await fsp.rm(join(run.root, path), { recursive: true });
  } else {
    await fsp.unlink(join(run.root, path));
  }
}

function underSkipped(skipped: ReadonlySet<string>, path: string): boolean {
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    if (skipped.has(path.slice(0, end))) {
      return true;
    }
  }
  return skipped.has(path);
}

/**
 * Deletes every entry under `parent` that the manifest does not have, going down only into real
 * directories the manifest has as directories. A skipped path is neither looked at nor entered.
 * An entry the manifest has as something else than it is now is left to that entry's phase.
 */
async function removeExtras(run: Run, parent: string): Promise<void> {
  const names = await fsp.readdir(join(run.root, parent));
  for (const name of names.sort()) {
    const path = parent === "" ? name : `${parent}/${name}`;
    if (underSkipped(run.skipped, path)) {
      continue;
    }
    await attempt(run, path, async () => {
      const stat = await fsp.lstat(join(run.root, path));
      const entry = run.entries.get(path);
      if (entry === undefined) {
        await remove(run, path, stat);
        run.removed += 1;
      } else if (entry.type === "dir" && stat.isDirectory()) {
        await removeExtras(run, path);
      }
    });
  }
}

/**
 * A manifest directory must be a real directory; its mode is left alone when it is. Anything
 * else of that name is deleted first (a link: the link itself). The new directory's mode is set
 * through a handle that does not follow a link, so a path replaced after `mkdir` gets no mode.
 */
async function ensureDirectory(run: Run, path: string): Promise<void> {
  const dir = join(run.root, path);
  const stat = await present(dir);
  if (stat?.isDirectory()) {
    return;
  }
  if (stat !== undefined) {
    await remove(run, path, stat);
  }
  await guard(run, path);
  await fsp.mkdir(dir, { mode: NEW_DIR_MODE });
  await guard(run, path);
  const handle = await fsp.open(dir, NEW_DIR_FLAGS);
  try {
    await handle.chmod(SHARED_DIR_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * The three steps of spec「还原」, the first that holds wins:
 *   1. the file there is the recorded inode with the recorded size and times: left, unread;
 *   2. a regular file of the recorded size whose bytes equal the copy in `tree/`: left;
 *   3. anything else (nothing, another type, other size or bytes): written back.
 * The copy in `tree/` is opened and checked before step 2, so a damaged snapshot rejects with
 * the workspace file untouched.
 */
async function restoreFile(run: Run, entry: FileEntry): Promise<void> {
  const current = await openRegular(join(run.root, entry.path));
  try {
    if (current !== undefined && isRecorded(entry, current.stat)) {
      return;
    }
    const copy = await openCopy(run, entry);
    try {
      if (
        current !== undefined &&
        current.stat.size === entry.size &&
        (await sameBytes(current.handle, copy, entry.size))
      ) {
        return;
      }
      await writeBack(run, entry, copy);
      run.restored += 1;
    } finally {
      await copy.close();
    }
  } finally {
    await current?.handle.close();
  }
}

/**
 * The workspace file at `path`, opened without following its last component and without
 * blocking, with the `fstat` of that handle; `undefined` when no regular file is there (nothing,
 * a link, a socket, or what the handle turned out to be: a FIFO, a device, a directory).
 */
async function openRegular(
  path: string,
): Promise<{ handle: fsp.FileHandle; stat: Stats } | undefined> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path, SOURCE_FLAGS);
  } catch (error) {
    if (NO_REGULAR_FILE.has(codeOf(error))) {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (stat.isFile()) {
      return { handle, stat };
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return undefined;
}

/** `undefined !== stat.ino`: an entry without an inode number is never the recorded file. */
function isRecorded(entry: FileEntry, stat: Stats): boolean {
  return (
    entry.ino === stat.ino &&
    entry.size === stat.size &&
    entry.mtimeMs === stat.mtimeMs &&
    entry.ctimeMs === stat.ctimeMs
  );
}

/** The entry's copy under `tree/`: it must be a regular file itself, of the recorded length. */
async function openCopy(run: Run, entry: FileEntry): Promise<fsp.FileHandle> {
  const handle = await fsp.open(join(run.tree, entry.path), TREE_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== entry.size) {
      throw new Error(`snapshot is damaged: tree/${entry.path} is not the recorded file`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Reads `want` bytes at `position`, or fewer when the file ends first; returns how many. */
async function readAt(
  handle: fsp.FileHandle,
  buffer: Buffer,
  want: number,
  position: number,
): Promise<number> {
  let got = 0;
  while (got < want) {
    const { bytesRead } = await handle.read(buffer, got, want - got, position + got);
    if (bytesRead === 0) {
      break;
    }
    got += bytesRead;
  }
  return got;
}

/** Whether the first `size` bytes of both are equal; a file that ends earlier is not equal. */
async function sameBytes(
  current: fsp.FileHandle,
  copy: fsp.FileHandle,
  size: number,
): Promise<boolean> {
  const ours = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size));
  const theirs = Buffer.allocUnsafe(ours.length);
  for (let done = 0; done < size; ) {
    const want = Math.min(ours.length, size - done);
    const [got, kept] = await Promise.all([
      readAt(current, ours, want, done),
      readAt(copy, theirs, want, done),
    ]);
    if (got !== want || kept !== want || !ours.subarray(0, want).equals(theirs.subarray(0, want))) {
      return false;
    }
    done += want;
  }
  return true;
}

/**
 * Step 3. A new file beside the final name (exclusive create, a name nobody can predict) gets
 * the copy's bytes, then on its own handle the mode `(recorded & 0o777) | 0o660` (explicit: no
 * umask applies, no setuid / setgid / sticky bit is carried) and the recorded `mtime` (`atime`
 * too: the manifest records none). Only then is it renamed over the final name, and nothing is
 * done to that name afterwards: it may be a link by then. A current entry that is not a regular
 * file is deleted first. The temporary file does not outlive a failure; that clean-up is the one
 * unguarded call by path, and can only hit the name made up here.
 */
async function writeBack(run: Run, entry: FileEntry, copy: fsp.FileHandle): Promise<void> {
  const final = join(run.root, entry.path);
  const temp = join(dirname(final), `.restore-${randomBytes(16).toString("hex")}.tmp`);
  await guard(run, entry.path);
  const target = await fsp.open(temp, "wx", TEMP_MODE);
  try {
    try {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, entry.size));
      for (let done = 0; done < entry.size; ) {
        const want = Math.min(chunk.length, entry.size - done);
        if ((await readAt(copy, chunk, want, done)) !== want) {
          throw new Error(`snapshot is damaged: tree/${entry.path} ended early`);
        }
        // writeFile on a handle writes the whole buffer at the current position.
        await target.writeFile(chunk.subarray(0, want));
        done += want;
      }
      await target.chmod((entry.mode & 0o777) | SHARED_RW);
      await target.utimes(entry.mtimeMs / 1000, entry.mtimeMs / 1000);
    } finally {
      await target.close();
    }
    const occupant = await present(final);
    if (occupant !== undefined && !occupant.isFile()) {
      await remove(run, entry.path, occupant);
    }
    await guard(run, entry.path);
    await fsp.rename(temp, final);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A link is left when it is one with the recorded target; anything else is replaced. */
async function restoreSymlink(run: Run, path: string, target: string): Promise<void> {
  const link = join(run.root, path);
  const stat = await present(link);
  if (stat?.isSymbolicLink() && (await fsp.readlink(link)) === target) {
    return;
  }
  if (stat !== undefined) {
    await remove(run, path, stat);
  }
  await guard(run, path);
  await fsp.symlink(target, link);
  run.restored += 1;
}

/**
 * Reads and checks the manifest. Beyond each item's shape: no path is listed twice, and the
 * parent of every entry and of every skipped path is a directory entry (or under a skipped
 * path), so no phase can be led to write below a file or delete above something skipped.
 * Entries under a skipped path are dropped here: they are skipped too.
 */
async function readManifest(
  snapshotDir: string,
): Promise<{ entries: Map<string, Entry>; skipped: SkippedPath[] }> {
  const manifest: unknown = JSON.parse(
    await fsp.readFile(join(snapshotDir, "manifest.json"), "utf8"),
  );
  if (!isRecord(manifest) || !Array.isArray(manifest.entries) || !Array.isArray(manifest.skipped)) {
    throw new Error("snapshot manifest has no entries or no skipped list");
  }
  const skipped = manifest.skipped.map(parseSkipped);
  const skippedPaths = new Set(skipped.map((item) => item.path));
  const entries = new Map<string, Entry>();
  for (const entry of manifest.entries.map(parseEntry)) {
    if (underSkipped(skippedPaths, entry.path)) {
      continue;
    }
    if (entries.has(entry.path)) {
      throw new Error("snapshot manifest lists a path twice");
    }
    entries.set(entry.path, entry);
  }
  for (const path of [...entries.keys(), ...skippedPaths]) {
    const cut = path.lastIndexOf("/");
    const parent = path.slice(0, Math.max(cut, 0));
    if (cut !== -1 && entries.get(parent)?.type !== "dir" && !underSkipped(skippedPaths, parent)) {
      throw new Error("snapshot manifest has a path whose parent is not a directory entry");
    }
  }
  return { entries, skipped };
}

function parseSkipped(raw: unknown): SkippedPath {
  if (isRecord(raw)) {
    const { path, reason } = raw;
    if (isRelativePath(path) && typeof reason === "string") {
      return { path, reason };
    }
  }
  throw new Error("snapshot manifest has a malformed skipped item");
}

function parseEntry(raw: unknown): Entry {
  const entry = isRecord(raw) && isRelativePath(raw.path) ? shapeOf(raw.path, raw) : undefined;
  if (entry === undefined) {
    throw new Error("snapshot manifest has a malformed entry");
  }
  return entry;
}

function shapeOf(path: string, raw: Record<string, unknown>): Entry | undefined {
  const { type, mode, target } = raw;
  if (type === "dir" && isMode(mode)) {
    return { path, type, mode };
  }
  if (type === "symlink" && isLinkTarget(target)) {
    return { path, type, target };
  }
  return type === "file" ? fileShapeOf(path, raw) : undefined;
}

function fileShapeOf(path: string, raw: Record<string, unknown>): FileEntry | undefined {
  const { mode, size, mtimeMs, ctimeMs, ino } = raw;
  if (
    isMode(mode) &&
    isSize(size) &&
    isTime(mtimeMs) &&
    isTime(ctimeMs) &&
    (ino === undefined || typeof ino === "number")
  ) {
    return { path, type: "file", size, mtimeMs, ctimeMs, ino, mode };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A relative POSIX path: no empty component (so no leading `/`), no `.` or `..`, no NUL. */
function isRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.split("/").every((name) => name !== "" && name !== "." && name !== "..")
  );
}

function isMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o7777;
}

function isSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLinkTarget(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("\0");
}
