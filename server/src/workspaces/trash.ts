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
 * Residual, not closed here (issue #1286 stays open; owner ruling D-23 registers it as a known
 * residual of this change, left to the deployment model of ADR-0010: one dedicated omp uid and
 * trusted accounts). In the sweep: the checks and the `rm` go by path (Node has no `*at` calls).
 * Each level is resolved by path again
 * after its check, and the recursion inside `rm` goes by path too, so nothing here is atomic. The
 * per-level check stops a level from being replaced by a directory the omp uid can write: every
 * level has to be a 0700 directory of this uid, and the app creates none on the workspace side.
 * It does not tie the walk to the real `.trash`. `SANDBOX_ROOT` is group-writable without the
 * sticky bit, so after `.trash` has passed its check the omp uid can put a symlink in its place,
 * and every later path goes through that link. The three levels below then pass wherever the link
 * points at a tree of this uid's 0700 directories — the snapshot store has that shape, with its
 * last level named after a top-level workspace directory, a name the omp uid chooses. Winning that
 * one window lets the sweep remove a directory outside `.trash`, so the batch-name pattern is not a
 * security boundary either. Separately, the content of a batch is not checked: a process that still
 * holds a handle (an open descriptor, a working directory) on a directory that was moved into a
 * batch can swap links inside it under the recursion.
 * The same residual in `moveToTrash`, also not closed and with no re-check (a `realpath` before the
 * rename would not close it). Source side: the caller's sandbox check and its `lstat` are done
 * when `absPath` arrives, and the `rename` goes by path. The workspace root and every directory
 * below it are writable by the omp uid, so an intermediate component of `absPath` can be replaced
 * by a symlink after the check; the rename follows it and takes the entry of that name out of the
 * link's target — another account's workspace, anything on the same file system this uid may
 * move — into the batch, where the sweep later removes it, while the audit row names the path
 * inside the workspace. A replaced last component is only moved as the link it is. Target side:
 * each of the four levels is checked once and not tied to the real `.trash` either. With `.trash`
 * replaced by a symlink after its check, the three levels below are made and chmod'ed under the
 * link's target: the batch then lies outside `.trash`, where no sweep finds it, and with the link
 * pointing at `SANDBOX_ROOT` itself the owner level is the account root `<SANDBOX_ROOT>/<ownerId>`,
 * which `ensureOwnedDir` corrects from 2770 to 0700 — the omp uid is then locked out of all of
 * that account's workspaces until an administrator restores the mode. The `rmdir` after a failed
 * rename goes by path as well.
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
