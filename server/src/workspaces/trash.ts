/**
 * The recycle directory `<SANDBOX_ROOT>/.trash/<ownerId>/<workspaceId>/<batch>/…` (s1f-files-page
 * design D22, file-operations「回收目录的保留与清理」): this half only sweeps expired batches; moving
 * entries in comes with the delete route. Not `<state>/trash` (`temp-dir-remove.ts`), which is
 * "move in, then remove at once" and has no retention.
 * The sweep looks at the directory structure and the timestamp in the batch name, nothing else: no
 * db, no audit, no log, no mtime. Every level it reads or removes — `.trash`, an owner directory, a
 * workspace directory, a batch — must first pass one `lstat` check: a real directory (not a
 * symlink), owned by this process's euid, with no group or other permission bit. A level that fails
 * is skipped as it is: not read, not removed, not chmod'ed. The sweep touches nothing but expired
 * batch directories, creates nothing, and never rejects: whatever fails is left for the next round.
 * Residual: the checks and the `rm` go by path (Node has no `*at` calls). Each level is resolved by
 * path again after its check, for the `readdir` or the `rm`, and the recursion inside `rm` goes by
 * path too, so nothing here is atomic. What closes the practical attack is that every level has to
 * be a 0700 directory of this uid: the app creates none on the workspace side, and the omp uid can
 * neither create one nor write into one, so it has nothing to rename into place of a level and
 * cannot reach below one by path. What remains is a process that can already write inside a 0700
 * directory owned by the app uid — another process of this uid, or one that still holds a handle
 * (an open descriptor, a working directory) on a directory that was moved into a batch. The
 * content of a batch is not checked, and against such a process the sweep guarantees nothing.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** `<milliseconds at deletion>-<16 lowercase hex>`; anything else under a workspace is not a batch. */
const BATCH_NAME = /^(\d+)-[0-9a-f]{16}$/u;
const DAY_MS = 86_400_000;

export function createTrash(options: { sandboxRoot: string; retentionDays: number }): {
  sweep(now: number): Promise<void>;
} {
  const trashDir = join(options.sandboxRoot, ".trash");
  return {
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
