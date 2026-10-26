/**
 * s1b-workspace-mounts #1795 review (F1, and the adapter / detach / shutdown interplay): the offline
 * transition SIGKILLs rclone before its lazy unmount (#1665 P9's order) and never waits on the libuv
 * pool, which calls stuck in the mount may fill (design D21; workspace-mounts「宿主不同步进入挂载」);
 * an adapter expiry while a detach is queued, or after `closeAll`, only changes the status. Same world
 * as `mounts-manager*.test.ts`: the real manager on the real-spawned fake rclone and fake
 * `fusermount3`, a fake clock, and an injected adapter file system whose calls never return.
 *
 * The pool case runs in a child node process with `UV_THREADPOOL_SIZE=1` (`fixtures/threadpool-
 * recovery.mjs`): a FIFO with no writer holds its one pool thread the way a hung FUSE request does.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MountFsImpl } from "../src/workspaces/mounts/fs.js";
import {
  alive,
  createWorld,
  disposeWorlds,
  FAKE_RCLONE,
  fusermountHeld,
  holdFusermount,
  ID1,
  ID2,
  nextMounts,
  OWNER,
  quiet,
  releaseFusermount,
  seedMount,
  sftp,
  W1,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";

const CASE_MS = 30_000;
const DEADLINE_MS = 1000;
const USER_ACTOR = { actorId: OWNER, reason: "user" } as const;

let world: World;

beforeEach(() => {
  world = createWorld();
});

afterEach(async () => {
  await disposeWorlds();
});

type Manager = ReturnType<World["manager"]>;

const attach = (manager: Manager, body = sftp()) =>
  manager.attach({ workspaceId: W1, ownerId: OWNER, body });

const pidOf = (index: number): number => Number(world.mountCalls()[index]?.pid);

/** The fake FUSE of a remote gone silent: no call ever returns. */
const hungFs: MountFsImpl = {
  lstat: () => new Promise(() => undefined),
  readdir: () => new Promise(() => undefined),
  open: () => new Promise(() => undefined),
  mkdir: () => new Promise(() => undefined),
  rename: () => new Promise(() => undefined),
};

/** An adapter call that never returns, its rejection observed (`mount_offline` at the deadline). */
function hang(manager: Manager, id: string, name: string): Promise<unknown> {
  return manager.fs.lstat(id, join(world.mountPoint(name), "a.md")).catch((error) => error);
}

describe("在线状态与重挂: the offline transition kills first, then unmounts", () => {
  it("an adapter expiry: rclone is already gone when its -uz runs; then one -uz, remount 5 s later", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ mountFs: hungFs, mountFsDeadlineMs: DEADLINE_MS });
    await attach(manager);
    holdFusermount(world);
    const refused = hang(manager, ID1, "remote");
    world.clock.advance(DEADLINE_MS);
    expect(await refused).toMatchObject({ code: "mount_offline" });
    expect(manager.statusOf(ID1)).toBe("offline");

    await waitFor(() => fusermountHeld(world));
    expect(alive(pidOf(0))).toBe(false);
    releaseFusermount(world);
    await waitFor(() => world.clock.pending().includes(5000));
    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);
    expect(world.clock.pending()).toEqual([5000]);
    expect(world.errors).toEqual([]);
  });
});

describe("宿主不同步进入挂载: recovery with the libuv pool full", () => {
  const hasMkfifo =
    process.platform !== "win32" && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;

  it.skipIf(!hasMkfifo)(
    "UV_THREADPOOL_SIZE=1 held by a blocked open: an adapter expiry still SIGKILLs rclone and runs -uz",
    { timeout: CASE_MS },
    async () => {
      seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
      const fifo = join(world.base, "pool.fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const input = {
        managerPath: fileURLToPath(new URL("../src/workspaces/mounts/manager.ts", import.meta.url)),
        record: world.store.get(ID1),
        mountsDir: world.mountsDir,
        state: world.state,
        root: world.root,
        bin: world.bin,
        mountinfo: world.mountinfo,
        rcloneBin: FAKE_RCLONE,
        fusermountBin: join(world.bin, "fusermount3"),
        fifo,
      };
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./fixtures/threadpool-recovery.mjs", import.meta.url)),
          JSON.stringify(input),
        ],
        {
          env: { ...process.env, UV_THREADPOOL_SIZE: "1", NODE_NO_WARNINGS: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((settle) => child.once("exit", settle));
      expect([code, stderr]).toEqual([0, ""]);

      const result = JSON.parse(stdout) as Record<string, unknown>;
      expect(result).toEqual({
        online: true,
        poolBlocked: true,
        refused: "mount_offline",
        offline: true,
        rcloneDead: true,
        unmounted: [{ argv: ["-uz", world.mountPoint("remote")], removed: 1 }],
        // The pool stayed blocked throughout: the recovery never needed it.
        stillBlocked: true,
        errors: [],
      });
      expect(readFileSync(world.mountinfo, "utf8")).toBe("");
    },
  );
});

describe("在线状态与重挂: an adapter expiry next to a detach or shutdown", () => {
  it("expiry while a detach waits on the chain: only the status changes — no SIGKILL, no -uz, no timer; the detach then unmounts once, no remount of it", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({
      readyTimeoutMs: 3000,
      mountFs: hungFs,
      mountFsDeadlineMs: DEADLINE_MS,
    });
    await attach(manager);
    await attach(manager, sftp("/srv/other", { name: "other" }));
    // The first mount's remount hangs in readiness: the workspace chain is busy behind it.
    nextMounts(world, ["hang"]);
    process.kill(pidOf(0), "SIGKILL");
    await waitFor(() => world.clock.pending().includes(5000));
    world.clock.advance(5000);
    await waitFor(() => world.mountCalls().length === 3);
    const uzBefore = world.fusermountCalls().length;
    const detaching = manager.detach(ID2, USER_ACTOR);

    const refused = hang(manager, ID2, "other");
    world.clock.advance(DEADLINE_MS);
    expect(await refused).toMatchObject({ code: "mount_offline" });
    expect(manager.statusOf(ID2)).toBe("offline");
    await quiet();
    expect(alive(pidOf(1))).toBe(true);
    expect(world.fusermountCalls()).toHaveLength(uzBefore);
    expect(world.clock.pending()).toEqual([]);

    await detaching;
    expect(world.store.get(ID2)).toBeUndefined();
    expect(alive(pidOf(1))).toBe(false);
    expect(world.fusermountCalls().slice(uzBefore)).toEqual([
      { argv: ["-uz", world.mountPoint("other")], removed: 1 },
    ]);
    // Only the first mount's remount (its hanging attempt failed: 10 s) is pending.
    await waitFor(() => world.clock.pending().includes(10_000));
    expect(world.clock.pending()).toEqual([10_000]);
    expect(world.errors).toEqual([]);
  });

  it("expiry after closeAll: no remount scheduled, no second -uz", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ mountFs: hungFs, mountFsDeadlineMs: DEADLINE_MS });
    await attach(manager);
    const refused = hang(manager, ID1, "remote");
    await manager.closeAll();
    expect(world.fusermountCalls()).toHaveLength(1);
    expect(alive(pidOf(0))).toBe(false);

    world.clock.advance(DEADLINE_MS);
    expect(await refused).toMatchObject({ code: "mount_offline" });
    await quiet();
    expect(manager.statusOf(ID1)).toBe("offline");
    expect(world.clock.pending()).toEqual([]);
    expect(world.fusermountCalls()).toHaveLength(1);
    expect(world.mountCalls()).toHaveLength(1);
    expect(world.errors).toEqual([]);
  });
});
