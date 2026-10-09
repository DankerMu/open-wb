/**
 * The recycle directory `<SANDBOX_ROOT>/.trash/<ownerId>/<workspaceId>/<batch>/…` (s1f-files-page
 * design D22, file-operations「回收目录的保留与清理」): this half only sweeps expired batches; moving
 * entries in comes with the delete route. Not `<state>/trash` (`temp-dir-remove.ts`), which is
 * "move in, then remove at once" and has no retention.
 * The sweep looks at the directory structure and the timestamp in the batch name, nothing else: no
 * db, no audit, no log, no mtime. It follows no symlink (`lstat` on `.trash`, `Dirent` types
 * below it, and `rm` unlinks a link inside a batch instead of walking it), touches nothing but
 * expired batch directories, creates nothing, and never rejects: whatever fails is left for the
 * next round.
 * Residual: the checks and the `rm` go by path (Node has no `*at` calls). `.trash` and its levels
 * are 0700 and owned by the app uid, so the omp uid cannot enter them; but `SANDBOX_ROOT` itself is
 * group-writable, and a process that renames `.trash` away between the `lstat` and a `readdir` can
 * put a link in its place. What the sweep then removes is still only a real directory named like
 * an expired batch, exactly three real directory levels below the link's target.
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
      if (!(await isOwnDirectory(trashDir))) {
        return;
      }
      const limit = now - options.retentionDays * DAY_MS;
      for (const ownerDir of await subdirectories(trashDir)) {
        for (const workspaceDir of await subdirectories(ownerDir)) {
          for (const batchDir of await subdirectories(workspaceDir, (name) =>
            isExpired(name, limit),
          )) {
            await removeBatch(batchDir);
          }
        }
      }
    },
  };
}

/** `lstat`: missing, a symlink, a file, or a directory of another uid is not ours to walk. */
async function isOwnDirectory(dir: string): Promise<boolean> {
  try {
    const status = await lstat(dir);
    return status.isDirectory() && status.uid === process.geteuid?.();
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

/** No `force`, and `rm` follows no symlink inside: a link in the batch is unlinked, not walked. */
async function removeBatch(batchDir: string): Promise<void> {
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
