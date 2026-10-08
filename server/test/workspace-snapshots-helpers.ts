/**
 * Fixtures shared by the workspace-snapshots test files (issues #937 to #940): a workspace and a
 * snapshot root on real temporary directories, the `take` and `restore` runners, and the readers
 * the expected manifests are built from. Expected values come from the tests' own lstat of the workspace, not
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
  readlinkSync,
  rmSync,
  type StatOptions,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, vi } from "vitest";
import { type TakeResult, take } from "../src/workspaces/snapshots.js";
import { restore } from "../src/workspaces/snapshots-restore.js";

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

/**
 * `failed` by the walk's second look, which found the directory `dir` (relative to the workspace
 * root, `""` for the root itself) changed: not by a read that failed, and not by a hook of the
 * test that threw. `dir` is the first changed directory in the order the walk listed them.
 */
export function expectChanged(result: TakeResult, dir: string): void {
  expect(result).toMatchObject({
    outcome: "failed",
    error: { message: `workspace changed during the snapshot: directory "${dir}"` },
  });
}

/**
 * `failed` by the look at a file after its copy (#1206): the file `path` (relative to the
 * workspace root) changed between the `fstat` before its content was read and the one after.
 */
export function expectTorn(result: TakeResult, path: string): void {
  expect(result).toMatchObject({
    outcome: "failed",
    error: { message: `workspace file changed while it was copied: "${path}"` },
  });
}

/** One successful `take` of the fixture's workspace: the snapshot the restore tests start from. */
export async function snapshot(f: Fixture, overrides: Partial<TakeOptions> = {}): Promise<void> {
  expect(await run(f, overrides)).toMatchObject({ outcome: "ok" });
}

/** One `restore` of the fixture's workspace from the fixture's snapshot. */
export function restoreRun(f: Fixture): ReturnType<typeof restore> {
  return restore({ workspaceRoot: f.workspace, snapshotDir: f.snapshot });
}

/** Every path under `root` with what it holds: a file's bytes, `dir`, or `-> <link target>`. */
export function contentsOf(root: string, rel = ""): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) {
      seen[path] = "dir";
      Object.assign(seen, contentsOf(root, path));
    } else if (stat.isSymbolicLink()) {
      seen[path] = `-> ${readlinkSync(join(root, path))}`;
    } else {
      seen[path] = stat.isFile() ? readFileSync(join(root, path), "utf8") : "special";
    }
  }
  return seen;
}

/** What a restore must leave alone under `root`, read before it runs and again after. */
export function stateOf(root: string): unknown {
  return { own: lstatSync(root).mtimeMs, tree: describeTree(root), contents: contentsOf(root) };
}

/** The directory O of scenario「父目录被换成符号链接」: beside the workspace, holding `b.txt`. */
export function outsideDir(f: Fixture): string {
  const dir = join(f.workspace, "..", "o");
  mkdirSync(dir);
  writeFileSync(join(dir, "b.txt"), "outside b\n");
  return dir;
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
    ino: s.ino,
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

/** `act` runs once, right before the walk's first `lstat` of `target`: nothing of it is read yet. */
export function beforeLstat(target: string, act: () => void): void {
  const lstat = fs.promises.lstat;
  let done = false;
  vi.spyOn(fs.promises, "lstat").mockImplementation(((path: PathLike, o?: StatOptions) => {
    if (path === target && !done) {
      done = true;
      act();
    }
    return lstat(path, o);
  }) as typeof lstat);
}

/** A whole second long ago: what `setPast` gives, and what a test sets back with `utimes`. */
export const PAST_SECONDS = 1_600_000_000;

/**
 * Sets the `mtime` of each directory or file to `PAST_SECONDS`, so a later change of a
 * directory's entries, or of a file's content, moves its `mtime` whatever the grain of the file
 * system's clock.
 */
export function setPast(...paths: string[]): void {
  for (const path of paths) {
    utimesSync(path, PAST_SECONDS, PAST_SECONDS);
  }
}

/**
 * Returns once the file system stamps a time later than the change time `path` (a directory or a
 * file) has now, so the next change of it moves its `ctime` (Linux stamps from a clock that ticks
 * every 1 to 10 ms). The probe file lies beside the workspace, on the same file system.
 */
export function waitForClock(f: Fixture, path: string): void {
  const probe = join(f.workspace, "..", "clock-probe");
  const seen = lstatSync(path, { bigint: true }).ctimeNs;
  const deadline = Date.now() + 5000;
  do {
    if (Date.now() > deadline) {
      throw new Error("waitForClock: the file system clock did not advance");
    }
    writeFileSync(probe, "");
  } while (lstatSync(probe, { bigint: true }).ctimeNs <= seen);
}

type Listing = (path: PathLike, options: { encoding: "buffer" }) => Promise<Buffer[]>;

/** The module's listing of `dir` goes through `change` (once the real one has returned). */
export function onListing(dir: string, change: (names: Buffer[]) => Buffer[]): void {
  const readdir = fs.promises.readdir as unknown as Listing;
  vi.spyOn(fs.promises, "readdir").mockImplementation((async (path, options) => {
    const names = await readdir(path, options);
    return path === dir ? change(names) : names;
  }) as Listing as unknown as typeof fs.promises.readdir);
}

/** `act` runs once, right after `dir` has been listed and before any of its entries is read. */
export function afterListing(dir: string, act: () => void): void {
  let done = false;
  onListing(dir, (names) => {
    if (!done) {
      done = true;
      act();
    }
    return names;
  });
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

type Handle = Awaited<ReturnType<typeof fs.promises.open>>;

/**
 * Every `fs.promises.open` of the walk is recorded (workspace-relative for a source, `tree/…`
 * for a copy) and passed to `intercept` before the real open; the handle of a source goes to
 * `patch` before the walk gets it.
 */
export function watchOpens(
  f: Fixture,
  intercept: (opened: string) => void,
  patch: (path: string, handle: Handle) => void = () => undefined,
): string[] {
  const opened: string[] = [];
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
    const full = String(args[0]);
    const source = full.startsWith(`${f.workspace}/`);
    const name = source ? full.slice(f.workspace.length + 1) : full.slice(f.snapshot.length + 1);
    opened.push(name);
    intercept(name);
    const handle = await open(...args);
    if (source) {
      patch(name, handle);
    }
    return handle;
  });
  return opened;
}

/**
 * A writer that acts once the walk has the first `fstat` of `target`, before it reads any
 * content. `write` runs once: a later `fstat` of the same handle does not repeat it.
 */
export function writeAfterFstat(f: Fixture, target: string, write: () => void): void {
  let written = false;
  watchOpens(
    f,
    () => undefined,
    (path, handle) => {
      if (path !== target) {
        return;
      }
      const stat = handle.stat.bind(handle);
      handle.stat = (async () => {
        const result = await stat();
        if (!written) {
          written = true;
          write();
        }
        return result;
      }) as typeof handle.stat;
    },
  );
}

/** Sets the times of its file whenever the round number moves, then counts itself done. */
const TOUCH_ON_SIGNAL = `
  const { workerData } = require("node:worker_threads");
  const fs = require("node:fs");
  const words = new Int32Array(workerData.shared);
  const fd = fs.openSync(workerData.path, "r+");
  Atomics.add(words, 1, 1);
  for (let seen = 0; ; ) {
    let round = Atomics.load(words, 0);
    while (round === seen) round = Atomics.load(words, 0);
    if (round < 0) break;
    seen = round;
    fs.futimesSync(fd, workerData.seconds, workerData.seconds);
    Atomics.add(words, 1, 1);
  }
  fs.closeSync(fd);
`;
const PAIR_TRIES = 20_000;
const PAIR_ROUND_MS = 10_000;

/**
 * Gives two files the same `mtimeMs` (`seconds`, whole) and the same `ctimeMs`; returns how many
 * rounds that took, and throws when `PAIR_TRIES` were not enough. One `utimes` after the other
 * is not enough where `ctime` is fine-grained (APFS: the two land microseconds apart), so two
 * threads make their calls on the same signal until the two change times come out equal.
 */
export async function sameTimes(first: string, second: string, seconds: number): Promise<number> {
  const shared = new SharedArrayBuffer(8);
  const words = new Int32Array(shared); // [round, threads done with it]
  const workers = [first, second].map(
    (path) => new Worker(TOUCH_ON_SIGNAL, { eval: true, workerData: { shared, path, seconds } }),
  );
  const bothDone = (): void => {
    const deadline = Date.now() + PAIR_ROUND_MS;
    while (Atomics.load(words, 1) < 2) {
      if (Date.now() > deadline) {
        throw new Error("sameTimes: a thread did not answer");
      }
    }
  };
  try {
    bothDone();
    for (let tries = 1; tries <= PAIR_TRIES; tries++) {
      Atomics.store(words, 1, 0);
      Atomics.store(words, 0, tries);
      bothDone();
      if (lstatSync(first).ctimeMs === lstatSync(second).ctimeMs) {
        return tries;
      }
    }
    throw new Error(`sameTimes: no equal ctimeMs in ${PAIR_TRIES} tries`);
  } finally {
    Atomics.store(words, 0, -1);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
