/**
 * Issue #522 workspace ownership of file-change candidates (turn-artifacts「文件变更推导与归属」,
 * supervisor steps 2–6): which raw `files.changed` paths lie inside the bound workspace root,
 * stored relative to it. The only filesystem access of the file-change path, metadata only
 * (`realpath`/`lstat`); nothing is created, read or written. Not `core/sandbox/resolve`: that one
 * rejects absolute paths and every symlink component, this one judges where a path really is.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FileChange } from "./file-changes.js";

const MAX_PATH_BYTES = 1024;
const MAX_FILES = 50;

/**
 * The candidates owned by `root`, as new elements `{path, added, removed, kind}` with `path`
 * relative to it: merged by path (first position and kind win, edit counts summed), then cut to
 * the first 50. `root` must be canonical (its own realpath), else nothing is owned. Never throws
 * for an array of `FileChange` objects (whatever their `path` is) and never mutates its input.
 */
export function ownedChanges(root: string, files: readonly FileChange[]): FileChange[] {
  if (!isCanonical(root)) {
    return [];
  }
  const merged = new Map<string, FileChange>();
  for (const file of files) {
    const path = ownedCandidate(root, file.path);
    if (path === undefined) {
      continue;
    }
    const first = merged.get(path);
    if (first === undefined) {
      merged.set(path, { path, added: file.added, removed: file.removed, kind: file.kind });
    } else if (first.kind === "edit") {
      first.added = (first.added ?? 0) + (file.added ?? 0);
      first.removed = (first.removed ?? 0) + (file.removed ?? 0);
    }
  }
  return [...merged.values()].slice(0, MAX_FILES);
}

/** 纯判断：`real` 严格位于 `realRoot` 之内且相对路径不超过 1024 字节时返回相对路径。 */
export function ownedPath(realRoot: string, real: string): string | undefined {
  const prefix = realRoot + sep;
  if (!real.startsWith(prefix)) {
    return undefined;
  }
  const path = real.slice(prefix.length);
  return Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ? undefined : path;
}

/** A root that was moved away and replaced by a symlink is not its own realpath: own nothing. */
function isCanonical(root: string): boolean {
  try {
    return realpathSync(root) === root;
  } catch {
    return false;
  }
}

/**
 * One raw path → its owned relative path. `resolve` joins a relative path to the root and folds
 * `.`, `..` and repeated or trailing separators; only that normalized target reaches the
 * filesystem (an unnormalized `dangling/` would make lstat follow the dangling link).
 */
function ownedCandidate(root: string, raw: string): string | undefined {
  try {
    const real = resolveReal(resolve(root, raw));
    return real === undefined ? undefined : ownedPath(root, real);
  } catch {
    return undefined;
  }
}

/**
 * The target's realpath (JS `realpathSync`, not `.native`); for a target that truly has no entry
 * (an edit deleted it), its parent's realpath plus its name. An entry without a realpath (dangling
 * symlink, symlink loop) and an lstat failure (ENOTDIR, EACCES, NUL byte, over-long) are dropped.
 * The computed location is checked the same way: lstat resolves `..` in a symlink's target after
 * following the link while JS realpath folds it lexically, so the two can name different places.
 */
function resolveReal(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    /* judged by lstat below */
  }
  try {
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      return undefined;
    }
    const real = join(realpathSync(dirname(target)), basename(target));
    return lstatSync(real, { throwIfNoEntry: false }) === undefined ? real : undefined;
  } catch {
    return undefined;
  }
}
