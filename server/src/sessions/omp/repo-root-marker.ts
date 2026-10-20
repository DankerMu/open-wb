/**
 * `<cwd>/.git` repo-root marker (omp-runtime「会话工作目录的仓库根标记」, design D5): an existing entry
 * is left alone; else an empty directory, made non-recursively (a missing cwd is not rebuilt) and set
 * to exact 2770 through a no-follow fd (never a path `chmod`: the omp uid may swap in a link).
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";

const { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } = nodeFs;
/** The calls the marker makes, injectable so a test can act between two of them. */
export const markerFs = { lstatSync, mkdirSync, openSync, fstatSync, fchmodSync, closeSync };

/** Throws on any failure but `EEXIST` from `mkdir`. */
export function ensureRepoRootMarker(cwd: string, fs: typeof markerFs = markerFs): void {
  const marker = join(cwd, ".git");
  if (fs.lstatSync(marker, { throwIfNoEntry: false }) !== undefined) {
    return;
  }
  try {
    fs.mkdirSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
  const fd = fs.openSync(marker, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isDirectory()) {
      throw new Error("repo-root marker is not a directory");
    }
    fs.fchmodSync(fd, 0o2770);
  } finally {
    fs.closeSync(fd);
  }
}
