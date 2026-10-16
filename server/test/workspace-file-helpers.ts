import { execFileSync, spawn } from "node:child_process";
import fs, { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { Readable } from "node:stream";
import { afterEach, expect, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";

export const TEXT_MIME = "text/plain; charset=utf-8";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  removeTempDirs();
});

export function workspaceTempDir(): string {
  return tempDir();
}

export function spyBodyIo() {
  const spies = [
    vi.spyOn(fs, "read"),
    vi.spyOn(fs, "readSync"),
    vi.spyOn(fs, "readFile"),
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fs, "open"),
    vi.spyOn(fs, "openSync"),
    vi.spyOn(fs, "createReadStream"),
  ];
  syncBuiltinESMExports();
  return spies;
}

export function spyMetadataIo() {
  const spies = [
    ...spyBodyIo(),
    vi.spyOn(fs, "stat"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "lstat"),
    vi.spyOn(fs, "lstatSync"),
    vi.spyOn(fs, "fstat"),
    vi.spyOn(fs, "fstatSync"),
  ];
  syncBuiltinESMExports();
  return spies;
}

export function expectCanonicalError(
  run: () => unknown,
  code: "preview_unsupported" | "preview_too_large",
): void {
  try {
    run();
    expect.fail(`expected canonical HttpError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      name: "HttpError",
      code,
      message: code === "preview_unsupported" ? "该类型不支持预览" : "文件过大，无法预览",
    });
  }
}

export function expectedTextHeaders(size: number, truncated: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": TEXT_MIME,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "X-Workbuddy-Size": String(size),
  };
  if (truncated) {
    headers["X-Workbuddy-Truncated"] = "1";
  }
  return headers;
}

export async function collectBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function waitForClose(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
  });
}

/** What the requests made of the target `swapOnFirstOpen` replaced. */
export interface SwapRecord {
  swaps: number;
  /** What the synchronous opens of the target returned: the descriptors of whatever was there. */
  descriptors: number[];
  /** Reads (`read`, `readSync`) through those descriptors. */
  reads: number;
  /** Those descriptors as `closeSync` or `close` closed them, in order. */
  closed: number[];
  /** Streams created on the target's path or on one of those descriptors. */
  streams: number;
}

/**
 * The window between a route's lstat and its open, held open: from now on the first open of
 * `target`, synchronous or not, first runs `swap` (which replaces or changes the target and
 * returns its cleanup), then opens as it was asked to. Spies the body I/O as `spyBodyIo` does,
 * and `closeSync` / `close`; fixtures must already be on disk.
 */
export function swapOnFirstOpen(
  target: string,
  swap: (target: string) => (() => void) | undefined,
): { record: () => SwapRecord; cleanup: () => void } {
  if (vi.isMockFunction(fs.openSync) || vi.isMockFunction(fs.open)) {
    throw new Error("swapOnFirstOpen must wrap the real opens: once per test, before other spies");
  }
  const realOpenSync = fs.openSync;
  const realOpen = fs.open as (...args: unknown[]) => void;
  spyBodyIo();
  const closeSync = vi.spyOn(fs, "closeSync");
  const close = vi.spyOn(fs, "close");
  let swaps = 0;
  let cleanup: (() => void) | undefined;
  const swapFirst = (path: unknown): void => {
    if (path === target && swaps === 0) {
      swaps += 1;
      cleanup = swap(target);
    }
  };
  const openSync = vi.mocked(fs.openSync).mockImplementation(((path, flags, mode) => {
    swapFirst(path);
    return realOpenSync(path, flags, mode);
  }) as typeof fs.openSync);
  vi.mocked(fs.open).mockImplementation(((path: unknown, ...rest: unknown[]) => {
    swapFirst(path);
    realOpen(path, ...rest);
  }) as typeof fs.open);
  syncBuiltinESMExports();
  const descriptors = (): number[] =>
    openSync.mock.calls.flatMap(([path], index) => {
      const result = openSync.mock.results[index];
      return path === target && result?.type === "return" ? [result.value as number] : [];
    });
  const through = (spied: unknown): number[] =>
    vi
      .mocked(spied as typeof fs.closeSync)
      .mock.calls.flatMap(([fd]) => (descriptors().includes(fd) ? [fd] : []));
  return {
    record: () => ({
      swaps,
      descriptors: descriptors(),
      reads: through(fs.read).length + through(fs.readSync).length,
      closed: [...through(closeSync), ...through(close)],
      streams: vi
        .mocked(fs.createReadStream)
        .mock.calls.filter(
          ([path, options]) =>
            path === target ||
            (typeof options === "object" && descriptors().includes(options.fd as number)),
        ).length,
    }),
    cleanup: () => cleanup?.(),
  };
}

export type SwapKind = "pipe" | "symlink" | "directory";

/**
 * For `swapOnFirstOpen`: replaces the regular file `target` by a named pipe nobody writes to, a
 * symlink to `linkTo`, or a directory, and returns the cleanup. A blocking open of the pipe would
 * stop the event loop and the test's own timer with it; the writer that opens it three seconds
 * later makes that failure a slow answer instead of a run that never ends.
 */
export function swapIn(kind: SwapKind, target: string, linkTo: string): (() => void) | undefined {
  rmSync(target);
  if (kind === "symlink") {
    symlinkSync(linkTo, target);
    return undefined;
  }
  if (kind === "directory") {
    mkdirSync(target);
    return undefined;
  }
  execFileSync("mkfifo", [target]);
  const writer = spawn("sh", ["-c", 'sleep 3; exec 3>"$0"', target], { stdio: "ignore" });
  return () => {
    writer.kill("SIGKILL");
  };
}

/**
 * The specs' 「换入」 outcome as far as the I/O shows it: the swap happened once; a pipe or a
 * directory was opened once and closed, a symlink never opened; nothing was streamed or read; a
 * pipe did not hold the answer up.
 */
export function expectSwappedUnread(record: SwapRecord, kind: SwapKind, elapsedMs: number): void {
  expect(record.swaps, kind).toBe(1);
  expect(record.descriptors, kind).toHaveLength(kind === "symlink" ? 0 : 1);
  expect(record.closed, kind).toEqual(record.descriptors);
  expect(record.streams, kind).toBe(0);
  expect(record.reads, kind).toBe(0);
  if (kind === "pipe") {
    expect(elapsedMs, kind).toBeLessThan(1500);
  }
}

/**
 * A read failure of a file the route has opened, before any byte of it went out: the first
 * `fs.read` through a descriptor `openSync` returned for `target` calls back with EIO. Must come
 * before any other spy on `fs.read`. Returns how many reads it has failed.
 */
export function failFirstReadOf(target: string): () => number {
  if (vi.isMockFunction(fs.read)) {
    throw new Error("failFirstReadOf must wrap the real read: before any other spy on fs.read");
  }
  const open = vi.spyOn(fs, "openSync");
  const realRead = fs.read as (...args: unknown[]) => void;
  let failed = 0;
  vi.spyOn(fs, "read").mockImplementation(((fd: number, ...rest: unknown[]) => {
    const ofTarget = open.mock.calls.some(
      ([path], index) => path === target && open.mock.results[index]?.value === fd,
    );
    if (failed > 0 || !ofTarget) {
      realRead(fd, ...rest);
      return;
    }
    failed += 1;
    const callback = rest.at(-1) as (error: NodeJS.ErrnoException, bytesRead: number) => void;
    const error = Object.assign(new Error("EIO: i/o error, read"), {
      code: "EIO",
      errno: -5,
      syscall: "read",
    });
    process.nextTick(() => callback(error, 0));
  }) as typeof fs.read);
  syncBuiltinESMExports();
  return () => failed;
}

/** The stream `createReadStream` made on `fd`, after `spyBodyIo()`. */
export function streamOn(fd: number): (fs.ReadStream & { fd: number | null }) | undefined {
  const spied = vi.mocked(fs.createReadStream);
  const index = spied.mock.calls.findIndex(
    ([, options]) => typeof options === "object" && options.fd === fd,
  );
  return spied.mock.results[index]?.value;
}

/** What `openSync` returned for `path`, in order, after `spyBodyIo()`. */
export function descriptorsOf(path: string): number[] {
  const open = vi.mocked(fs.openSync);
  return open.mock.calls.flatMap(([opened], index) => {
    const result = open.mock.results[index];
    return opened === path && result?.type === "return" ? [result.value as number] : [];
  });
}
