/**
 * Issue #522 workspace ownership of file-change candidates (turn-artifacts「文件变更推导与归属」,
 * supervisor steps 2–6): which raw `files.changed` paths lie inside the bound workspace root,
 * stored relative to it. The only filesystem access of the file-change path, metadata only
 * (`realpath`/`lstat`); nothing is created, read or written. Not `core/sandbox/resolve`: that one
 * rejects absolute paths and every symlink component, this one judges where a path really is.
 * Issue #740: that access is synchronous and the event is sized by a low-trust child, so one
 * event judges at most 100 distinct paths (the first 100 raw candidates, each normalized path once),
 * none of them over 4096 bytes or 128 components.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FileChange } from "./file-changes.js";

const MAX_PATH_BYTES = 1024;
const MAX_FILES = 50;
const MAX_CANDIDATES = 100;
/**
 * Lexical limits on one normalized candidate, checked before any filesystem call. JS `realpathSync`
 * walks a path component by component and starts over after each symlink, so its cost grows with
 * the square of the component count: `l/l/…/f.txt` with `l -> .` takes hundreds of milliseconds at
 * 8000 components. Such a path resolves to a short one, so the 1024-byte rule of `ownedPath` never
 * sees its length.
 */
const MAX_TARGET_BYTES = 4096;
const MAX_TARGET_COMPONENTS = 128;

/** The verdicts of one event, keyed by normalized path; `undefined` is a remembered drop. */
type Verdicts = Map<string, string | undefined>;

/**
 * The candidates owned by `root`, as new elements `{path, added, removed, kind}` with `path`
 * relative to it: merged by path (first position and kind win, edit counts summed), then cut to
 * the first 50. Only the first 100 raw candidates are judged, by position (a dropped candidate
 * uses its place too); the rest reach no filesystem call, nor does a candidate whose normalized
 * path is over 4096 bytes or 128 components. `root` must be canonical (its own
 * realpath), else nothing is owned. Never throws for an array of `FileChange` objects (whatever
 * their `path` is) and never mutates its input.
 */
export function ownedChanges(root: string, files: readonly FileChange[]): FileChange[] {
  if (!isCanonical(root)) {
    return [];
  }
  const merged = new Map<string, FileChange>();
  const verdicts: Verdicts = new Map();
  for (const file of files.slice(0, MAX_CANDIDATES)) {
    const path = ownedCandidate(root, file.path, verdicts);
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
 * filesystem (an unnormalized `dangling/` would make lstat follow the dangling link). A target
 * over the lexical limits is dropped before that, unremembered. A target already in `verdicts` is
 * not judged again. `resolve` throws for a raw path that is not a string, so the key is computed
 * inside the try and such a candidate is dropped unremembered.
 */
function ownedCandidate(root: string, raw: string, verdicts: Verdicts): string | undefined {
  try {
    const target = resolve(root, raw);
    if (isOversized(target)) {
      return undefined;
    }
    if (verdicts.has(target)) {
      return verdicts.get(target);
    }
    const real = resolveReal(target);
    const owned = real === undefined ? undefined : ownedPath(root, real);
    verdicts.set(target, owned);
    return owned;
  } catch {
    return undefined;
  }
}

/** Bytes first: the split then runs on at most 4096 bytes. The empty leading component is none. */
function isOversized(target: string): boolean {
  if (Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES) {
    return true;
  }
  return target.split(sep).filter((part) => part !== "").length > MAX_TARGET_COMPONENTS;
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
