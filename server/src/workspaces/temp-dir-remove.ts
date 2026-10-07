/**
 * Removal of a temporary workspace's directory after its row was deleted (s1f tasks 5.2, design
 * D8), and the "move into the app-private trash, then remove" step it shares with the session
 * artifact directory (`sessions/session-delete.ts`, #706). A server-internal operation: no sandbox
 * facade, no `sandbox_denied` audit. Nothing here throws; every failure goes to `report`, and the
 * caller's response does not depend on it.
 * This module imports nothing from `sessions/`: the account root, the trash directory and the
 * report function come from the caller.
 */
import { randomBytes } from "node:crypto";
import { lstat, rename, rm, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

type Report = (error: unknown) => void;

/** What `removeDirThroughTrash` reports for its three own findings (the rest are fs errors). */
interface TrashRemovalMessages {
  notADirectory: string;
  replacedBeforeMove: string;
  trashUnavailable: string;
}

const MESSAGES: TrashRemovalMessages = {
  notADirectory: "temporary workspace delete: the directory is not a directory",
  replacedBeforeMove: "temporary workspace delete: the directory was replaced before it was moved",
  trashUnavailable: "temporary workspace delete: trash directory is unavailable",
};
const INVALID_NAME = "temporary workspace delete: not a temporary workspace directory name";
/** `tmp-<workspace id>`: the id is 32 lowercase hex (migration 031), so no separator and no dot. */
const TEMPORARY_DIR_NAME = /^tmp-[0-9a-f]{32}$/u;

/**
 * Removes `<accountRoot>/<name>`. `accountRoot` must be the realpath of `<SANDBOX_ROOT>/<ownerId>`
 * (the caller resolves and checks it) and `name` exactly `tmp-<32 hex>`; anything else is reported
 * and nothing is touched, so the only path ever handled is one fixed entry directly inside the
 * account root. The entry itself then goes through `removeDirThroughTrash`: a symlink or a file
 * standing there is not removed. Only here is the in-place fallback on: a rename failing with
 * `EXDEV` (sandbox root and state dir on two file systems) removes the directory where it stands.
 * `renameImpl` is the test seam for a swap between `lstat` and `rename`; production passes nothing.
 */
export async function removeTemporaryWorkspaceDir(
  target: { accountRoot: string; name: string; trash: string },
  report: Report,
  renameImpl: typeof rename = rename,
): Promise<void> {
  if (!isAbsolute(target.accountRoot) || !TEMPORARY_DIR_NAME.test(target.name)) {
    report(new Error(INVALID_NAME));
    return;
  }
  await removeDirThroughTrash(
    join(target.accountRoot, target.name),
    target.trash,
    MESSAGES,
    report,
    renameImpl,
    true,
  );
}

/**
 * Only a real directory (`lstat`: a symlink planted in its place is not one) is handled; anything
 * else is reported and left alone, a missing one is success.
 * It is first renamed into `trash` (`<state realpath>/trash`, 0700, which the omp uid cannot
 * enter) under a random name: `rename` moves the entry itself and follows no symlink, so the
 * recursive `rm` (which follows none inside either: a link in the tree is unlinked, its target
 * untouched) runs where the omp uid can no longer replace any level by path. What arrives is
 * checked again: an entry swapped for a symlink or a file between `lstat` and `rename` is only
 * unlinked, and reported. A rename failing with ENOENT means the source is gone (success) or the
 * trash is missing, told apart by one more `lstat` of the source; any other rename failure is
 * reported and the source left alone. That includes `EXDEV` unless `inPlaceOnExdev` is set (the
 * temporary workspace directory only): then the source is removed in place, see `removeInPlace`.
 * No `force`: a failed or partial removal is reported, and what could not be removed stays in the
 * trash, not where it was. Residual: an omp-uid process that put its cwd or a directory fd inside
 * this tree before the move can still swap subdirectories through relative paths while `rm` walks
 * it (Node has no `*at` calls).
 */
export async function removeDirThroughTrash(
  dir: string,
  trash: string,
  messages: TrashRemovalMessages,
  report: Report,
  renameImpl: typeof rename,
  inPlaceOnExdev = false,
): Promise<void> {
  const trashed = join(trash, randomBytes(16).toString("hex"));
  if (!(await isRealDirectory(dir, messages, report))) {
    return;
  }
  try {
    await renameImpl(dir, trashed);
  } catch (error) {
    if (inPlaceOnExdev && (error as NodeJS.ErrnoException).code === "EXDEV") {
      await removeInPlace(dir, messages, report);
    } else if (!isMissing(error)) {
      report(error);
    } else if (await stillPresent(dir, report)) {
      report(new Error(messages.trashUnavailable, { cause: error }));
    }
    return;
  }
  try {
    if ((await lstat(trashed)).isDirectory()) {
      await rm(trashed, { recursive: true });
    } else {
      await unlink(trashed);
      report(new Error(messages.replacedBeforeMove));
    }
  } catch (error) {
    report(error);
  }
}

/** `lstat`: a missing entry is silently not one; a symlink or a file is reported. */
async function isRealDirectory(
  dir: string,
  messages: TrashRemovalMessages,
  report: Report,
): Promise<boolean> {
  try {
    if ((await lstat(dir)).isDirectory()) {
      return true;
    }
    report(new Error(messages.notADirectory));
  } catch (error) {
    reportUnlessMissing(error, report);
  }
  return false;
}

/**
 * The `EXDEV` fallback: no trash on this file system, so `dir` is checked once more (gone is
 * success; a symlink or a file put there since the first check is reported and left alone) and
 * removed where it stands. No `force`, and `rm` follows no symlink inside. Unlike the trash path,
 * the tree stays reachable by path for the omp uid while `rm` walks it (design D8 residual), and
 * what a failed removal leaves behind stays in the account root.
 */
async function removeInPlace(
  dir: string,
  messages: TrashRemovalMessages,
  report: Report,
): Promise<void> {
  if (!(await isRealDirectory(dir, messages, report))) {
    return;
  }
  try {
    await rm(dir, { recursive: true });
  } catch (error) {
    report(error);
  }
}

/** After a rename's ENOENT: is the source still there? Another `lstat` failure is reported. */
async function stillPresent(path: string, report: Report): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    reportUnlessMissing(error, report);
    return false;
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function reportUnlessMissing(error: unknown, report: Report): void {
  if (!isMissing(error)) {
    report(error);
  }
}
