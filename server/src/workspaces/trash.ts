/**
 * The recycle directory `<SANDBOX_ROOT>/.trash/<ownerId>/<workspaceId>/<batch>/…` (s1f-files-page
 * design D22, file-operations「删除到回收目录」and「回收目录的保留与清理」): `moveToTrash` renames one
 * entry of a workspace into a batch of its own, `sweep` removes the batches whose time is up. Not
 * `<state>/trash` (`temp-dir-remove.ts`), which is "move in, then remove at once" and has no
 * retention.
 * Moving in: the four levels are made and checked one by one with `ensureOwnedDir(…, 0o700)` on
 * every deletion — a real directory (not a symlink) of this process's euid, its mode corrected to
 * exactly 0700 — then one `rename`, never a copy. A level that fails the check throws before
 * anything is renamed. A rename that fails (EXDEV included) leaves the entry where it was; the
 * batch directory just made is removed again and the rename's error is thrown.
 * The sweep looks at the directory structure and the timestamp in the batch name, nothing else: no
 * db, no audit, no log, no mtime. Every level it reads or removes — `.trash`, an owner directory, a
 * workspace directory, a batch — must first pass one `lstat` check: a real directory (not a
 * symlink), owned by this process's euid, with no group or other permission bit. A level that fails
 * is skipped as it is: not read, not removed, not chmod'ed. The sweep touches nothing but expired
 * batch directories, creates nothing, and never rejects: whatever fails is left for the next round.
 * Residual (issue #1286, closed within bounds by change sandbox-boundary-closure, owner B1; what
 * is left stays with the deployment model of ADR-0010: one dedicated omp uid, trusted accounts).
 * `SANDBOX_ROOT` is 3770 since that change (its `sandbox_root` startup stage): the omp uid can add
 * entries there but cannot rename or remove `.trash` or an account root the app made, so neither
 * can it swap `.trash` for a symlink after its check, nor rename an account root to `.trash` (read
 * from the sticky bit's POSIX semantics, not measured on a uid-separated deployment; `OMP_USER`
 * mode does not start unless the root is 3770, and in same-uid mode no uid separates the two).
 * A `.trash` it makes before the app does is its own symlink, file or directory: `ensureOwnedDir`
 * refuses it and the deletion fails (refusal measured on ext4, #1318; the 500 read from the code).
 * In the sweep: the checks and the `rm` go by path. Node gives its callers no
 * `*at` calls, and the one recursion found to use them is not the one used here: `rmSync` walks by
 * descriptor below its top level (Node 24.13.1 on Linux, strace: `openat` with
 * `O_NOFOLLOW|O_DIRECTORY`, then `unlinkat`), while this `rm` is the `fs/promises` one, in that
 * runtime a JavaScript walk doing
 * `lstat`, `readdir`, `rmdir` and `unlink` on a path each (read from the runtime's source, not
 * traced). Each level is resolved by path again after its check,
 * and the recursion inside `rm` goes by path too, so nothing here is atomic. The
 * per-level check stops a level from being replaced by a directory the omp uid can write: every
 * level has to be a 0700 directory of this uid, and the app creates none on the workspace side.
 * The content of a batch is not checked: a process that still
 * holds a handle (an open descriptor, a working directory) on a directory that was moved into a
 * batch can swap links inside it under the recursion.
 * The same residual in `moveToTrash`, source side, also not closed and with no re-check (a
 * `realpath` before the rename would not close it): the caller's sandbox check and its `lstat` are
 * done when `absPath` arrives, and the `rename` goes by path. The workspace root and every directory
 * below it are writable by the omp uid, so an intermediate component of `absPath` can be replaced
 * by a symlink after the check; the rename follows it and takes the entry of that name out of the
 * link's target — another account's workspace, anything on the same file system this uid may
 * move — into the batch, where the sweep later removes it, while the audit row names the path
 * inside the workspace. A replaced last component is only moved as the link it is. Target side:
 * each of the four levels is checked once; with `.trash` held by the sticky root and the levels
 * below it inside 0700 directories, the omp uid has nothing there to swap (read from the code).
 * The `rmdir` after a failed rename goes by path as well.
 */
import { randomBytes } from "node:crypto";
import { renameSync, rmdirSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureOwnedDir } from "../core/sandbox/dirs.js";

/** `<milliseconds at deletion>-<16 lowercase hex>`; anything else under a workspace is not a batch. */
const BATCH_NAME = /^(\d+)-[0-9a-f]{16}$/u;
/** Every level of the recycle directory: this uid alone. */
const TRASH_DIR_MODE = 0o700;
const DAY_MS = 86_400_000;

export function createTrash(options: {
  sandboxRoot: string;
  retentionDays: number;
  /** The one rename of a deletion; omitted means `renameSync`. Tests make it fail. */
  rename?: (from: string, to: string) => void;
}): {
  moveToTrash(ownerId: string, workspaceId: string, absPath: string): string;
  sweep(now: number): Promise<void>;
} {
  const trashDir = join(options.sandboxRoot, ".trash");
  const rename = options.rename ?? renameSync;
  return {
    /**
     * Renames `absPath` — an entry the caller has resolved inside the workspace and found to be a
     * file or a directory — to its own name inside a new batch, and returns the batch name. The
     * two segments are not checked here: the owner id has passed the store's owner-segment rule
     * and the workspace id is the id of a row. Throws with the entry still at `absPath` and no
     * batch left; emptied owner and workspace directories stay.
     */
    moveToTrash(ownerId: string, workspaceId: string, absPath: string): string {
      const trashId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
      const ownerDir = join(trashDir, ownerId);
      const workspaceDir = join(ownerDir, workspaceId);
      const batchDir = join(workspaceDir, trashId);
      for (const level of [trashDir, ownerDir, workspaceDir, batchDir]) {
        ensureOwnedDir(level, TRASH_DIR_MODE);
      }
      try {
        rename(absPath, join(batchDir, basename(absPath)));
      } catch (error) {
        try {
          // Not recursive: only the batch made above, and only while it is still empty.
          rmdirSync(batchDir);
        } catch {
          // The rename's error is the one to report.
        }
        throw error;
      }
      return trashId;
    },
    /**
     * Removes every batch whose name carries a time earlier than `now` minus the retention; one
     * stamped exactly at that limit stays. Emptied owner and workspace directories stay too.
     */
    async sweep(now: number): Promise<void> {
      if (!(await isPrivateOwnDirectory(trashDir))) {
        return;
      }
      const limit = now - options.retentionDays * DAY_MS;
      for (const ownerDir of await subdirectories(trashDir)) {
        await sweepOwner(ownerDir, limit);
      }
    },
  };
}

async function sweepOwner(ownerDir: string, limit: number): Promise<void> {
  if (!(await isPrivateOwnDirectory(ownerDir))) {
    return;
  }
  for (const workspaceDir of await subdirectories(ownerDir)) {
    await sweepWorkspace(workspaceDir, limit);
  }
}

async function sweepWorkspace(workspaceDir: string, limit: number): Promise<void> {
  if (!(await isPrivateOwnDirectory(workspaceDir))) {
    return;
  }
  for (const batchDir of await subdirectories(workspaceDir, (name) => isExpired(name, limit))) {
    await removeBatch(batchDir);
  }
}

/**
 * `lstat`: only a real directory of this uid that nobody else can enter, list or write is ours to
 * walk or remove. Missing, a symlink, a file, another uid, or any group/other bit: not ours.
 */
async function isPrivateOwnDirectory(dir: string): Promise<boolean> {
  try {
    const status = await lstat(dir);
    return (
      status.isDirectory() && status.uid === process.geteuid?.() && (status.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

/**
 * The real directories directly inside `dir` whose name passes `accept`, as paths. `Dirent` types
 * come from the entry itself, so a symlink to a directory is not one. A level that cannot be read
 * yields nothing.
 */
async function subdirectories(
  dir: string,
  accept: (name: string) => boolean = () => true,
): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && accept(entry.name))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * The batch passes the same `lstat` check as the levels above it, right before the `rm`. No
 * `force`, and `rm` follows no symlink inside: a link in the batch is unlinked, not walked.
 */
async function removeBatch(batchDir: string): Promise<void> {
  if (!(await isPrivateOwnDirectory(batchDir))) {
    return;
  }
  try {
    await rm(batchDir, { recursive: true });
  } catch {
    // What could not be removed stays in the batch; the next round tries again.
  }
}

/** A stamp with more digits than a number holds exactly is far in the future or infinite: kept. */
function isExpired(name: string, limit: number): boolean {
  const match = BATCH_NAME.exec(name);
  return match !== null && Number(match[1]) < limit;
}
