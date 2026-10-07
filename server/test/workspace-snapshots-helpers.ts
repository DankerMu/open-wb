/**
 * Fixtures shared by the workspace-snapshots test files (issues #937, #938): a workspace and a
 * snapshot root on real temporary directories, the `take` runner, and the readers the expected
 * manifests are built from. Expected values come from the tests' own lstat of the workspace, not
 * from the module under test.
 */
import fs, {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  type PathLike,
  readdirSync,
  readFileSync,
  rmSync,
  type StatOptions,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { type TakeResult, take } from "../src/workspaces/snapshots.js";

export const W = "0123456789abcdef0123456789abcdef";
export const MESSAGE_ID = 42;
const EXCLUDE = ["node_modules"];
export const OUTSIDE_BYTES = "outside the workspace\n";

type TakeOptions = Parameters<typeof take>[0];

const temps: string[] = [];
const locked: string[] = [];
const fifos: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const fifo of fifos.splice(0)) {
    releaseReader(fifo);
  }
  for (const path of locked.splice(0)) {
    chmodSync(path, 0o700);
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export interface Fixture {
  workspace: string;
  snapshots: string;
  snapshot: string;
  outside: string;
}

/** Workspace, snapshot root (the state layout's 0700 directory) and an outside file, all apart. */
export function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "snapshot-take-"));
  temps.push(base);
  const workspace = join(base, "workspace");
  const snapshots = join(base, "state", "snapshots");
  const outside = join(base, "outside.txt");
  mkdirSync(workspace, { mode: 0o755 });
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  chmodSync(snapshots, 0o700);
  writeFileSync(outside, OUTSIDE_BYTES);
  return { workspace, snapshots, snapshot: join(snapshots, W, String(MESSAGE_ID)), outside };
}

export function put(root: string, path: string, bytes: string, mode = 0o644): void {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o755 });
  writeFileSync(file, bytes);
  chmodSync(file, mode);
}

/** Changes the mode of `path` for one test; it is made removable again afterwards. */
export function lock(path: string, mode: number): void {
  chmodSync(path, mode);
  locked.push(path);
}

/** `fifo` gets a writer after the test, so a reader stuck opening it returns. */
export function releaseAfterTest(fifo: string): void {
  fifos.push(fifo);
}

/**
 * One `take` on the fixture. The three limits are out of reach unless a test sets them, so a
 * test of anything else never meets a limit.
 */
export function run(f: Fixture, overrides: Partial<TakeOptions> = {}): Promise<TakeResult> {
  return take({
    workspaceRoot: f.workspace,
    snapshotsRoot: f.snapshots,
    workspaceId: W,
    userMessageId: MESSAGE_ID,
    excludeNames: EXCLUDE,
    maxFileBytes: Number.MAX_SAFE_INTEGER,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
    maxEntries: Number.MAX_SAFE_INTEGER,
    ...overrides,
  });
}

/** Every path under `root` (relative, POSIX) with what would change if the entry were touched. */
export function describeTree(root: string, rel = ""): Record<string, string> {
  const seen: Record<string, string> = {};
  let names: string[];
  try {
    names = readdirSync(join(root, rel));
  } catch {
    return seen;
  }
  for (const name of names.sort()) {
    const path = rel === "" ? name : `${rel}/${name}`;
    try {
      const s = lstatSync(join(root, path));
      seen[path] = [s.mode, s.size, s.mtimeMs, s.ctimeMs, s.ino].join(":");
      if (s.isDirectory()) {
        Object.assign(seen, describeTree(root, path));
      }
    } catch {
      seen[path] = "unreadable";
    }
  }
  return seen;
}

export function manifestOf(f: Fixture): { entries: unknown[]; skipped: unknown[] } {
  return JSON.parse(readFileSync(join(f.snapshot, "manifest.json"), "utf8"));
}

export function fileEntry(f: Fixture, path: string): Record<string, unknown> {
  const s = lstatSync(join(f.workspace, path));
  return {
    path,
    type: "file",
    size: s.size,
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    mode: s.mode & 0o7777,
  };
}

export function dirEntry(f: Fixture, path: string): Record<string, unknown> {
  return { path, type: "dir", mode: lstatSync(join(f.workspace, path)).mode & 0o7777 };
}

export function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

/**
 * A writer between classification and reading: once the real `lstat` of `target` has returned,
 * `swap` runs (once) before the walk sees the result.
 */
export function swapAfterLstat(target: string, swap: () => void): void {
  const lstat = fs.promises.lstat;
  let swapped = false;
  vi.spyOn(fs.promises, "lstat").mockImplementation((async (path: PathLike, o?: StatOptions) => {
    const stat = await lstat(path, o);
    if (path === target && !swapped) {
      swapped = true;
      swap();
    }
    return stat;
  }) as typeof lstat);
}

/** A reader stuck opening `fifo` returns once a writer shows up; without a reader this is ENXIO. */
function releaseReader(fifo: string): void {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // Nobody is blocked on it.
  }
}

/** Calls of `fs.promises.open` that create a file under `tree/` (flag `wx`) get `intercept`. */
export function onCopyCreate(intercept: (path: string) => void): void {
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    if (args[1] === "wx") {
      intercept(String(args[0]));
    }
    return open(...args);
  });
}
