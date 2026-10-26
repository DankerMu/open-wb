/**
 * workspaces/mounts/fs — the asynchronous adapter every file system call inside an online mount goes
 * through (s1b-workspace-mounts design D16 / D21; workspace-mounts「宿主不同步进入挂载」): `lstat`,
 * `readdir`, `open`, `fstat` / `read` / `close` on an opened handle, `mkdir` and `rename`, on
 * `fs/promises` only — no worker thread, nothing synchronous. With the remote gone and rclone alive a
 * call can hang on its FUSE request; here it only holds one libuv thread, never the event loop.
 *
 * Each mount has a first-in, first-out gate admitting one call at a time; a call's deadline (10 s by
 * default) runs from taking the gate, not from queueing. Past it the call ends `mount_offline`, every
 * call queued on that mount ends `mount_offline`, and `onOffline(mountId)` is called once — the
 * manager then SIGKILLs rclone and lazily unmounts, which makes the stuck request return (#1665 P9).
 * Until the expired call has returned, a new call on that mount ends `mount_offline` at once without
 * reaching the file system, so a hung mount never has more than one call in it; once it has returned
 * the gate is free again. A late result is dropped (a late rejection is swallowed); a handle from an
 * `open` that returns late is closed before the gate frees. Other mounts are never affected.
 *
 * `mkdir` makes the one level whose parent exists (not recursive) and nothing here `chmod`s: inside a
 * mount the mode comes from rclone's `--umask` (D7 / D16). Arguments and the file system's own errors
 * pass through unchanged; the callers map them. The file system, the deadline and the clock are
 * constructor options (the manager's, D12), so a test can inject a hung file system and a short deadline.
 */
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { HttpError } from "../../core/errors/index.js";
import { type MountClock, systemClock } from "./probe.js";

/** Each call inside a mount has this long from taking its mount's gate (design D21). */
const MOUNT_FS_DEADLINE_MS = 10_000;

/** What the adapter uses of an opened file (`fs/promises` `FileHandle` is one). */
export interface MountFileHandle {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The file system seam (`fs/promises` by default). */
export interface MountFsImpl {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number): Promise<MountFileHandle>;
  mkdir(path: string): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface MountFsOptions {
  fs?: MountFsImpl;
  deadlineMs?: number;
  clock?: MountClock;
  /** Called once each time a call on `mountId` passes its deadline; a throw from it is swallowed. */
  onOffline(mountId: string): void;
}

export interface MountFs {
  lstat(mountId: string, path: string): Promise<Stats>;
  readdir(mountId: string, path: string): Promise<string[]>;
  open(mountId: string, path: string, flags: number): Promise<MountFileHandle>;
  fstat(mountId: string, handle: MountFileHandle): Promise<Stats>;
  /** The number of bytes read into `buffer`. */
  read(
    mountId: string,
    handle: MountFileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<number>;
  close(mountId: string, handle: MountFileHandle): Promise<void>;
  mkdir(mountId: string, path: string): Promise<void>;
  rename(mountId: string, oldPath: string, newPath: string): Promise<void>;
}

const promisesFs: MountFsImpl = {
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path),
  open: (path, flags) => open(path, flags),
  mkdir: (path) => mkdir(path),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
};

interface Waiter {
  start(): void;
  fail(error: HttpError): void;
}

/** A mount's gate exists while a call holds it; `stuck` once that call has passed its deadline. */
interface Gate {
  queue: Waiter[];
  stuck: boolean;
}

export function createMountFs(options: MountFsOptions): MountFs {
  const fs = options.fs ?? promisesFs;
  const deadlineMs = options.deadlineMs ?? MOUNT_FS_DEADLINE_MS;
  const clock = options.clock ?? systemClock;
  const gates = new Map<string, Gate>();

  /**
   * Runs `call` when `mountId`'s gate admits it. `abandon` disposes of a value that arrives after the
   * deadline; the gate frees only once it has settled.
   */
  function through<T>(
    mountId: string,
    call: () => Promise<T>,
    abandon?: (late: T) => Promise<unknown>,
  ): Promise<T> {
    const held = gates.get(mountId);
    if (held?.stuck === true) {
      return Promise.reject(new HttpError("mount_offline"));
    }
    const gate: Gate = held ?? { queue: [], stuck: false };
    return new Promise<T>((resolve, reject) => {
      const release = () => {
        const next = gate.queue.shift();
        if (next === undefined) {
          gates.delete(mountId);
        } else {
          next.start();
        }
      };
      const unstick = () => {
        gates.delete(mountId);
      };
      const start = () => {
        let expired = false;
        const timer = clock.setTimeout(() => {
          expired = true;
          gate.stuck = true;
          reject(new HttpError("mount_offline"));
          for (const waiter of gate.queue.splice(0)) {
            waiter.fail(new HttpError("mount_offline"));
          }
          try {
            options.onOffline(mountId);
          } catch {
            // The gate is already settled; a failing callback must not escape the timer.
          }
        }, deadlineMs);
        let pending: Promise<T>;
        try {
          pending = call();
        } catch (error) {
          pending = Promise.reject(error);
        }
        pending.then(
          (value) => {
            if (!expired) {
              clock.clearTimeout(timer);
              resolve(value);
              release();
            } else if (abandon === undefined) {
              unstick();
            } else {
              new Promise((settle) => {
                settle(abandon(value));
              }).then(unstick, unstick);
            }
          },
          (error: unknown) => {
            if (!expired) {
              clock.clearTimeout(timer);
              reject(error);
              release();
            } else {
              unstick();
            }
          },
        );
      };
      if (held === undefined) {
        gates.set(mountId, gate);
        start();
      } else {
        gate.queue.push({ start, fail: reject });
      }
    });
  }

  return {
    lstat: (mountId, path) => through(mountId, () => fs.lstat(path)),
    readdir: (mountId, path) => through(mountId, () => fs.readdir(path)),
    open: (mountId, path, flags) =>
      through(
        mountId,
        () => fs.open(path, flags),
        (late) => late.close(),
      ),
    fstat: (mountId, handle) => through(mountId, () => handle.stat()),
    read: (mountId, handle, buffer, offset, length, position) =>
      through(mountId, async () => (await handle.read(buffer, offset, length, position)).bytesRead),
    close: (mountId, handle) => through(mountId, () => handle.close()),
    mkdir: async (mountId, path) => {
      await through(mountId, () => fs.mkdir(path));
    },
    rename: (mountId, oldPath, newPath) => through(mountId, () => fs.rename(oldPath, newPath)),
  };
}
