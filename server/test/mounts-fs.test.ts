/**
 * s1b-workspace-mounts group 9 (adapter part, #1695): the asynchronous adapter every file system call
 * inside an online mount goes through (design D16 / D21; workspace-mounts「宿主不同步进入挂载」the
 * adapter paragraph and「闸门排队与期限」). Seam: `createMountFs` with an injected file system and clock.
 * The hung mount is a file system whose calls never settle until the test settles them (the fake FUSE);
 * the clock fires its timers only when the test advances it. The pass-through cases run on the default
 * `fs/promises` against a temporary directory, so the expected values come from the real file system.
 */

import { constants, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import {
  createMountFs,
  type MountFileHandle,
  type MountFsImpl,
} from "../src/workspaces/mounts/fs.js";
import type { MountClock } from "../src/workspaces/mounts/probe.js";

const DEADLINE_MS = 100;

interface FakeClock extends MountClock {
  pending(): number[];
  advance(ms: number): void;
}

/** Timers fire only from `advance`, in due order; `pending()` is each timer's delay from now. */
function createFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { due: number; fire: () => void }>();
  return {
    setTimeout(fire, ms) {
      seq += 1;
      timers.set(seq, { due: now + ms, fire });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    pending: () => [...timers.values()].map((timer) => timer.due - now).sort((a, b) => a - b),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort(([, x], [, y]) => x.due - y.due)[0];
        if (next === undefined || next[1].due > target) {
          break;
        }
        timers.delete(next[0]);
        now = next[1].due;
        next[1].fire();
      }
      now = target;
    },
  };
}

interface FakeCall {
  op: string;
  args: unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * The fake FUSE: every call (handle calls included) is recorded and stays in flight until the test
 * settles it; `inFlight` / `maxInFlight` count calls entered and not yet settled.
 */
function createHungFs() {
  const calls: FakeCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const enter = (op: string, args: unknown[]) =>
    new Promise<never>((resolve, reject) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const leave = () => {
        inFlight -= 1;
      };
      calls.push({
        op,
        args,
        resolve: (value) => {
          leave();
          resolve(value as never);
        },
        reject: (error) => {
          leave();
          reject(error);
        },
      });
    });
  const handle = (id: string): MountFileHandle => ({
    stat: () => enter(`${id}.stat`, []),
    read: (...args) => enter(`${id}.read`, args),
    close: () => enter(`${id}.close`, []),
  });
  const impl: MountFsImpl = {
    lstat: (...args) => enter("lstat", args),
    readdir: (...args) => enter("readdir", args),
    open: (...args) => enter("open", args),
    mkdir: (...args) => enter("mkdir", args),
    rename: (...args) => enter("rename", args),
  };
  return {
    impl,
    calls,
    handle,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

type Outcome = { settled: false } | { settled: true; value?: unknown; error?: unknown };

/** Observes a promise without leaving its rejection unhandled; `current()` is how it ended so far. */
function watch(promise: Promise<unknown>) {
  let outcome: Outcome = { settled: false };
  promise.then(
    (value) => {
      outcome = { settled: true, value };
    },
    (error: unknown) => {
      outcome = { settled: true, error };
    },
  );
  return { current: () => outcome };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function expectOffline(outcome: Outcome): void {
  expect(outcome.settled).toBe(true);
  const error = (outcome as { error?: unknown }).error;
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).code).toBe("mount_offline");
}

function setup() {
  const fake = createHungFs();
  const clock = createFakeClock();
  const offline: string[] = [];
  const mountFs = createMountFs({
    fs: fake.impl,
    deadlineMs: DEADLINE_MS,
    clock,
    onOffline: (mountId) => {
      offline.push(mountId);
    },
  });
  return { fake, clock, offline, mountFs };
}

describe("闸门排队与期限", () => {
  it("a hung call ends mount_offline at the deadline, onOffline once, the two queued calls end mount_offline, one call in flight", async () => {
    const { fake, clock, offline, mountFs } = setup();
    const first = watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    const second = watch(mountFs.readdir("m1", "/ws/远端"));
    const third = watch(mountFs.mkdir("m1", "/ws/远端/新"));
    await flush();
    expect(fake.calls.map((call) => call.op)).toEqual(["lstat"]);
    expect(fake.calls[0]?.args).toEqual(["/ws/远端/a.md"]);
    expect(clock.pending()).toEqual([DEADLINE_MS]);

    clock.advance(DEADLINE_MS - 1);
    await flush();
    expect([first, second, third].map((call) => call.current().settled)).toEqual([
      false,
      false,
      false,
    ]);
    expect(offline).toEqual([]);

    clock.advance(1);
    await flush();
    expectOffline(first.current());
    expectOffline(second.current());
    expectOffline(third.current());
    expect(offline).toEqual(["m1"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.maxInFlight).toBe(1);
    expect(clock.pending()).toEqual([]);
  });

  it("while the expired call is still stuck a new call ends mount_offline at once and never reaches the mount; once it returns the gate is free again", async () => {
    const { fake, clock, offline, mountFs } = setup();
    void watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    await flush();
    clock.advance(DEADLINE_MS);
    await flush();
    expect(offline).toEqual(["m1"]);

    const late = watch(mountFs.rename("m1", "/ws/远端/a.md", "/ws/远端/b.md"));
    await flush();
    expectOffline(late.current());
    expect(fake.calls).toHaveLength(1);
    expect(offline).toEqual(["m1"]);
    expect(clock.pending()).toEqual([]);

    // The stuck call returns (the manager killed rclone and lazily unmounted): a late rejection is
    // swallowed (vitest fails the run on an unhandled one) and the next call reaches the mount.
    fake.calls[0]?.reject(Object.assign(new Error("ENOTCONN"), { code: "ENOTCONN" }));
    await flush();
    const next = watch(mountFs.readdir("m1", "/ws/远端"));
    await flush();
    expect(fake.calls.map((call) => call.op)).toEqual(["lstat", "readdir"]);
    fake.calls[1]?.resolve(["a.md"]);
    await flush();
    expect(next.current()).toEqual({ settled: true, value: ["a.md"] });

    // A second hang is a second episode: onOffline again.
    void watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    await flush();
    clock.advance(DEADLINE_MS);
    await flush();
    expect(offline).toEqual(["m1", "m1"]);
    expect(fake.maxInFlight).toBe(1);
  });

  it("the deadline runs from taking the gate, not from queueing", async () => {
    const { fake, clock, offline, mountFs } = setup();
    const first = watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    const second = watch(mountFs.lstat("m1", "/ws/远端/b.md"));
    await flush();
    clock.advance(60);
    fake.calls[0]?.resolve("first-status");
    await flush();
    expect(first.current()).toEqual({ settled: true, value: "first-status" });
    expect(fake.calls.map((call) => call.args[0])).toEqual(["/ws/远端/a.md", "/ws/远端/b.md"]);
    expect(clock.pending()).toEqual([DEADLINE_MS]);

    clock.advance(DEADLINE_MS - 1);
    await flush();
    expect(second.current().settled).toBe(false);
    clock.advance(1);
    await flush();
    expectOffline(second.current());
    expect(offline).toEqual(["m1"]);
  });

  it("queued calls run first in, first out, one at a time, and every timer is cleared", async () => {
    const { fake, clock, mountFs } = setup();
    const results = [
      watch(mountFs.lstat("m1", "/ws/远端/1")),
      watch(mountFs.lstat("m1", "/ws/远端/2")),
      watch(mountFs.lstat("m1", "/ws/远端/3")),
    ];
    for (let i = 0; i < 3; i += 1) {
      await flush();
      expect(fake.calls).toHaveLength(i + 1);
      expect(fake.inFlight).toBe(1);
      fake.calls[i]?.resolve(`status-${i + 1}`);
    }
    await flush();
    expect(fake.calls.map((call) => call.args[0])).toEqual([
      "/ws/远端/1",
      "/ws/远端/2",
      "/ws/远端/3",
    ]);
    expect(results.map((result) => result.current())).toEqual([
      { settled: true, value: "status-1" },
      { settled: true, value: "status-2" },
      { settled: true, value: "status-3" },
    ]);
    expect(fake.maxInFlight).toBe(1);
    expect(clock.pending()).toEqual([]);
  });

  it("another mount answers while one mount is hung and after it went offline", async () => {
    const { fake, clock, offline, mountFs } = setup();
    const hung = watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    const other = watch(mountFs.readdir("m2", "/ws/参考"));
    await flush();
    expect(fake.calls.map((call) => call.args[0])).toEqual(["/ws/远端/a.md", "/ws/参考"]);
    fake.calls[1]?.resolve(["x.md"]);
    await flush();
    expect(other.current()).toEqual({ settled: true, value: ["x.md"] });
    expect(hung.current().settled).toBe(false);

    clock.advance(DEADLINE_MS);
    await flush();
    expectOffline(hung.current());
    expect(offline).toEqual(["m1"]);

    const after = watch(mountFs.lstat("m2", "/ws/参考/x.md"));
    await flush();
    fake.calls[2]?.resolve("x-status");
    await flush();
    expect(after.current()).toEqual({ settled: true, value: "x-status" });
    expect(offline).toEqual(["m1"]);
  });

  it("fstat, read and close on an opened handle go through the same gate", async () => {
    const { fake, clock, offline, mountFs } = setup();
    const opened = watch(mountFs.open("m1", "/ws/远端/a.bin", constants.O_RDONLY));
    await flush();
    expect(fake.calls[0]?.args).toEqual(["/ws/远端/a.bin", constants.O_RDONLY]);
    fake.calls[0]?.resolve(fake.handle("h1"));
    await flush();
    const handle = (opened.current() as { value: Parameters<typeof mountFs.fstat>[1] }).value;

    const status = watch(mountFs.fstat("m1", handle));
    const buffer = Buffer.alloc(8);
    const read = watch(mountFs.read("m1", handle, buffer, 0, 8, 0));
    const close = watch(mountFs.close("m1", handle));
    await flush();
    expect(fake.calls.map((call) => call.op)).toEqual(["open", "h1.stat"]);

    clock.advance(DEADLINE_MS);
    await flush();
    expectOffline(status.current());
    expectOffline(read.current());
    expectOffline(close.current());
    expect(offline).toEqual(["m1"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.maxInFlight).toBe(1);
  });

  it("an open that returns after its deadline has its handle closed, and the gate frees after that close", async () => {
    const { fake, clock, offline, mountFs } = setup();
    const opened = watch(mountFs.open("m1", "/ws/远端/a.bin", constants.O_RDONLY));
    await flush();
    clock.advance(DEADLINE_MS);
    await flush();
    expectOffline(opened.current());
    expect(offline).toEqual(["m1"]);

    fake.calls[0]?.resolve(fake.handle("late"));
    await flush();
    expect(fake.calls.map((call) => call.op)).toEqual(["open", "late.close"]);
    expect(fake.inFlight).toBe(1);
    const blocked = watch(mountFs.lstat("m1", "/ws/远端/a.bin"));
    await flush();
    expectOffline(blocked.current());

    fake.calls[1]?.reject(new Error("EIO"));
    await flush();
    void watch(mountFs.lstat("m1", "/ws/远端/a.bin"));
    await flush();
    expect(fake.calls.map((call) => call.op)).toEqual(["open", "late.close", "lstat"]);
    expect(fake.maxInFlight).toBe(1);
    expect(offline).toEqual(["m1"]);
  });

  it("a call that succeeds after its deadline has its result dropped and frees the gate", async () => {
    const { fake, clock, offline, mountFs } = setup();
    const hung = watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    await flush();
    clock.advance(DEADLINE_MS);
    await flush();
    expectOffline(hung.current());
    expect(offline).toEqual(["m1"]);

    fake.calls[0]?.resolve("late-status");
    await flush();
    expectOffline(hung.current());
    const next = watch(mountFs.lstat("m1", "/ws/远端/b.md"));
    await flush();
    expect(fake.calls.map((call) => call.args[0])).toEqual(["/ws/远端/a.md", "/ws/远端/b.md"]);
    fake.calls[1]?.resolve("b-status");
    await flush();
    expect(next.current()).toEqual({ settled: true, value: "b-status" });
    expect(clock.pending()).toEqual([]);
    expect(fake.maxInFlight).toBe(1);
    expect(offline).toEqual(["m1"]);
  });

  it("an onOffline that throws escapes nothing and leaves the gate behaving", async () => {
    const fake = createHungFs();
    const clock = createFakeClock();
    const offline: string[] = [];
    const mountFs = createMountFs({
      fs: fake.impl,
      deadlineMs: DEADLINE_MS,
      clock,
      onOffline: (mountId) => {
        offline.push(mountId);
        throw new Error("manager failed");
      },
    });
    const first = watch(mountFs.lstat("m1", "/ws/远端/a.md"));
    const queued = watch(mountFs.readdir("m1", "/ws/远端"));
    await flush();
    expect(() => clock.advance(DEADLINE_MS)).not.toThrow();
    await flush();
    expectOffline(first.current());
    expectOffline(queued.current());
    expect(offline).toEqual(["m1"]);

    const blocked = watch(mountFs.lstat("m1", "/ws/远端/b.md"));
    await flush();
    expectOffline(blocked.current());
    expect(fake.calls).toHaveLength(1);

    fake.calls[0]?.reject(new Error("ENOTCONN"));
    await flush();
    const next = watch(mountFs.readdir("m1", "/ws/远端"));
    await flush();
    expect(fake.calls.map((call) => call.op)).toEqual(["lstat", "readdir"]);
    fake.calls[1]?.resolve(["a.md"]);
    await flush();
    expect(next.current()).toEqual({ settled: true, value: ["a.md"] });
    expect(fake.maxInFlight).toBe(1);
    expect(offline).toEqual(["m1"]);
  });
});

describe("pass-through on fs/promises", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mounts-fs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function realSetup() {
    const clock = createFakeClock();
    const offline: string[] = [];
    const mountFs = createMountFs({ clock, onOffline: (mountId) => offline.push(mountId) });
    return { clock, offline, mountFs };
  }

  it("each of the eight operations returns what the file system gives, with no timer left", async () => {
    const { clock, offline, mountFs } = realSetup();
    writeFileSync(join(dir, "a.txt"), "hello mount");

    const status = await mountFs.lstat("m1", join(dir, "a.txt"));
    expect(status.isFile()).toBe(true);
    expect(status.size).toBe(statSync(join(dir, "a.txt")).size);
    expect(clock.pending()).toEqual([]);

    expect(await mountFs.readdir("m1", dir)).toEqual(readdirSync(dir));

    const handle = await mountFs.open(
      "m1",
      join(dir, "a.txt"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const handleStatus = await mountFs.fstat("m1", handle);
    expect(handleStatus.isFile()).toBe(true);
    expect(handleStatus.size).toBe(11);
    const buffer = Buffer.alloc(5);
    expect(await mountFs.read("m1", handle, buffer, 0, 5, 6)).toBe(5);
    expect(buffer.toString()).toBe("mount");
    await mountFs.close("m1", handle);
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });

    await mountFs.mkdir("m1", join(dir, "新"));
    expect(statSync(join(dir, "新")).isDirectory()).toBe(true);

    await mountFs.rename("m1", join(dir, "a.txt"), join(dir, "新", "b.txt"));
    expect(readdirSync(join(dir, "新"))).toEqual(["b.txt"]);
    expect(readdirSync(dir)).toEqual(["新"]);

    expect(clock.pending()).toEqual([]);
    expect(offline).toEqual([]);
  });

  it("errors pass through unchanged and mkdir makes only the one level whose parent exists", async () => {
    const { clock, offline, mountFs } = realSetup();
    await expect(mountFs.lstat("m1", join(dir, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(mountFs.mkdir("m1", join(dir, "x", "y"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(readdirSync(dir)).toEqual([]);
    expect(clock.pending()).toEqual([]);
    expect(offline).toEqual([]);
    // The gate is free after a rejection.
    expect(await mountFs.readdir("m1", dir)).toEqual([]);
  });
});
