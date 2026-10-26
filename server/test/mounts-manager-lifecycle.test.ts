/**
 * s1b-workspace-mounts group 6 (manager part, #1687): the mount-manager across service start and stop,
 * and the per-workspace serial chain with cancellation (design D12 manager part, D13 serial part;
 * workspace-mounts「服务启停与挂载」「挂载操作的串行与取消」manager scenarios, and the no-remount half of
 * 「惰性卸载与残留」for unmounting, unmounting a workspace and the mount-source cascade — #1686 hand-off).
 * Same seam and world as `mounts-manager.test.ts`: the real-spawned fake rclone and fake `fusermount3`
 * over a fake mountinfo, on the injected clock. "No remount afterwards" is asserted as no pending timer,
 * the clock pushed past 300 s and no `mount` call within a real absence window. Every rclone an attempt's
 * cancellation must end ignores SIGTERM (`hang`, `stubborn`): only a SIGKILL gets it gone.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { type ProbeExec, probeInChild } from "../src/workspaces/mounts/rclone-process.js";
import {
  alive,
  aliveMounts,
  createWorld,
  disposeWorlds,
  ID1,
  ID2,
  ID3,
  local,
  nextMounts,
  OWNER,
  quiet,
  registerSource,
  SOURCE_ID,
  seedMount,
  sftp,
  W1,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";

const CASE_MS = 30_000;
const USER_ACTOR = { actorId: OWNER, reason: "user" } as const;
/** Far less than the 20 s readiness window: a cancelled attempt is not waited out. */
const CANCEL_BOUND_MS = 5000;
const PAST_CAP_MS = 400_000;

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

function pidOf(index: number): number {
  return Number(world.mountCalls()[index]?.pid);
}

const pendingIs = (expected: number[]) => () =>
  JSON.stringify(world.clock.pending()) === JSON.stringify(expected);

/** No line of these mounts' sections and none at their mount points in the fake mountinfo. */
function expectUnmounted(ids: readonly string[], names: readonly string[]): void {
  const text = readFileSync(world.mountinfo, "utf8");
  for (const id of ids) {
    expect(text).not.toContain(`m${id}`);
  }
  for (const name of names) {
    expect(text).not.toContain(world.mountPoint(name));
  }
}

/** Nothing pending; the clock pushed past the 300 s cap; still exactly `calls` mount calls. */
async function expectNoRemount(calls: number): Promise<void> {
  await quiet();
  expect(world.clock.pending()).toEqual([]);
  world.clock.advance(PAST_CAP_MS);
  await quiet();
  expect(world.mountCalls()).toHaveLength(calls);
}

/**
 * Readiness `readdir` probes: the first `answered` go to the real child, later ones hang (recorded in
 * `hanging`) until aborted (recorded in `aborted`).
 */
function readdirHangingAfter(answered: number): {
  hanging: string[];
  aborted: string[];
  probeExec: ProbeExec;
} {
  const hanging: string[] = [];
  const aborted: string[] = [];
  let seen = 0;
  const probeExec: ProbeExec = (op, path, timeoutMs, signal) => {
    if (op === "readdir") {
      seen += 1;
    }
    if (op !== "readdir" || seen <= answered) {
      return probeInChild(op, path, timeoutMs, signal);
    }
    hanging.push(path);
    return new Promise((settle) => {
      signal?.addEventListener("abort", () => {
        aborted.push(path);
        settle(false);
      });
    });
  };
  return { hanging, aborted, probeExec };
}

describe("服务启停与挂载: construction loads the registry", () => {
  it("every row is in the registry and offline, with or without RCLONE_BIN; nothing spawned or scheduled", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    seedMount(world, { id: ID1, body: sftp(), createdAt: 2 });
    seedMount(world, { id: ID2, body: local(), createdAt: 1 });

    for (const manager of [
      world.manager(),
      world.build(
        (({ rcloneBin: _rclone, fusermountBin: _fusermount, ...off }) => off)(world.options()),
      ),
    ]) {
      expect(manager.statusOf(ID1)).toBe("offline");
      expect(manager.statusOf(ID2)).toBe("offline");
      expect([...manager.namesOf(W1)].sort()).toEqual(["remote", "本机"]);
    }
    await quiet();
    expect(world.calls()).toEqual([]);
    expect(world.clock.pending()).toEqual([]);
  });

  it("feature off: restoreAll mounts nothing and schedules nothing", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    const { rcloneBin: _rclone, fusermountBin: _fusermount, ...off } = world.options();
    const manager = world.build(off);

    await manager.restoreAll();

    expect(world.calls()).toEqual([]);
    expect(world.clock.pending()).toEqual([]);
    expect(manager.statusOf(ID1)).toBe("offline");
  });
});

describe("服务启停与挂载「启动恢复与残留挂载」", () => {
  it("offline until restored; the mount point left in mountinfo gets -uz before its mount; host rewritten; both online", {
    timeout: CASE_MS,
  }, async () => {
    const confFirst = seedMount(world, {
      id: ID1,
      body: sftp("/srv/data", { name: "甲" }),
      createdAt: 1,
    });
    seedMount(world, { id: ID2, body: sftp("/srv/data", { name: "乙" }), createdAt: 2 });
    writeFileSync(
      world.mountinfo,
      `77 1 0:7 / ${world.mountPoint("乙")} rw - fuse.rclone m${ID2}:/srv/data rw\n`,
    );
    const manager = world.manager();

    const restoring = manager.restoreAll();
    expect(manager.statusOf(ID1)).toBe("offline");
    expect(manager.statusOf(ID2)).toBe("offline");
    await restoring;

    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("乙")], removed: 1 },
    ]);
    const calls = world.mountCalls();
    expect(calls.map((call) => call.argv[3])).toEqual([
      world.mountPoint("甲"),
      world.mountPoint("乙"),
    ]);
    expect(calls.map((call) => call.preMounted)).toEqual([false, false]);
    expect(calls.map((call) => call.confHost)).toEqual(["10.0.0.7", "10.0.0.7"]);
    expect(readFileSync(join(world.privateDir(ID1), "rclone.conf"), "utf8")).toBe(
      confFirst.replace("host = 10.0.0.1\n", "host = 10.0.0.7\n"),
    );
    expect(world.calls().map((call) => call.argv[1])).toEqual(["mount", "mount"]);
    expect(manager.statusOf(ID1)).toBe("online");
    expect(manager.statusOf(ID2)).toBe("online");
  });

  it("one restore failing: no throw, no unhandled rejection; it is offline and remounts 5 s later, the other online", {
    timeout: CASE_MS,
  }, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      seedMount(world, { id: ID1, body: sftp("/srv/data", { name: "甲" }), createdAt: 1 });
      seedMount(world, { id: ID2, body: sftp("/srv/data", { name: "乙" }), createdAt: 2 });
      nextMounts(world, ["exit1"]);
      const manager = world.manager();

      await expect(manager.restoreAll()).resolves.toBeUndefined();

      expect(manager.statusOf(ID1)).toBe("offline");
      expect(manager.statusOf(ID2)).toBe("online");
      expect(world.clock.pending()).toEqual([5000, 30_000]);
      world.clock.advance(5000);
      await waitFor(() => manager.statusOf(ID1) === "online");
      expect(world.mountCalls()).toHaveLength(3);
      await quiet();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("服务启停与挂载「关停卸载」", () => {
  it("two online and one with a pending remount: rclones exit, one -uz per mounted point, nothing after, rows and dirs kept", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    let stats = 0;
    const probeExec: ProbeExec = (op, path, timeoutMs, signal) => {
      if (op === "stat") {
        stats += 1;
      }
      return probeInChild(op, path, timeoutMs, signal);
    };
    const manager = world.manager({ probeExec });
    await attach(manager);
    await attach(manager, local());
    await attach(manager, sftp("/srv/third", { name: "third" }));
    process.kill(pidOf(2), "SIGKILL");
    await waitFor(pendingIs([5000, 30_000, 30_000]));
    const before = world.fusermountCalls().length;

    await manager.closeAll();

    expect(alive(pidOf(0))).toBe(false);
    expect(alive(pidOf(1))).toBe(false);
    expect(
      world
        .fusermountCalls()
        .slice(before)
        .map((call) => call.argv)
        .sort(),
    ).toEqual([
      ["-uz", world.mountPoint("remote")],
      ["-uz", world.mountPoint("本机")],
    ]);
    expectUnmounted([ID1, ID2, ID3], ["remote", "本机", "third"]);
    await expectNoRemount(3);
    expect(stats).toBe(0);
    expect(world.store.list(W1).map((mount) => mount.id)).toEqual([ID1, ID2, ID3]);
    for (const id of [ID1, ID2, ID3]) {
      expect(existsSync(join(world.privateDir(id), "rclone.conf"))).toBe(true);
    }
    expect(manager.statusOf(ID1)).toBe("offline");
  });

  it("a restore hanging on the first of three: that rclone is SIGKILLed, the others never mount, nothing left alive", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp("/srv/data", { name: "甲" }), createdAt: 1 });
    seedMount(world, { id: ID2, body: sftp("/srv/data", { name: "乙" }), createdAt: 2 });
    seedMount(world, { id: ID3, body: sftp("/srv/data", { name: "丙" }), createdAt: 3 });
    nextMounts(world, ["hang"]);
    const manager = world.manager();
    const restoring = manager.restoreAll();
    await waitFor(() => world.mountCalls().length === 1);
    expect(alive(pidOf(0))).toBe(true);

    const started = Date.now();
    await manager.closeAll();

    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);
    await expect(restoring).resolves.toBeUndefined();
    expect(alive(pidOf(0))).toBe(false);
    expect(world.mountCalls()).toHaveLength(1);
    expect(aliveMounts(world)).toEqual([]);
    expectUnmounted([ID1, ID2, ID3], ["甲", "乙", "丙"]);
    expect(world.store.list(W1)).toHaveLength(3);
    for (const id of [ID1, ID2, ID3]) {
      expect(existsSync(join(world.privateDir(id), "rclone.conf"))).toBe(true);
    }
    await expectNoRemount(1);
  });
});

describe("服务启停与挂载「关停卸载」: only what this run mounted (#1688)", () => {
  /** A live `fuse.rclone` line of mount `id` at `name`, as another instance on the same DB left it. */
  const foreignLine = (id: string, name: string) =>
    `88 1 0:8 / ${world.mountPoint(name)} rw - fuse.rclone m${id}:/srv/data rw\n`;

  it("a registered mount this run never mounted, live in mountinfo: closeAll runs no fusermount3, the line stays", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    const line = foreignLine(ID1, "remote");
    writeFileSync(world.mountinfo, line);
    const manager = world.manager();

    await manager.closeAll();

    expect(world.fusermountCalls()).toEqual([]);
    expect(readFileSync(world.mountinfo, "utf8")).toBe(line);
    expect(world.calls()).toEqual([]);
    expect(manager.statusOf(ID1)).toBe("offline");
  });

  it("one restored online, one whose restore failed before mounting and is now live elsewhere: one -uz, on the first", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp("/srv/data", { name: "甲" }), createdAt: 1 });
    seedMount(world, { id: ID2, body: sftp("/srv/data", { name: "乙" }), createdAt: 2 });
    nextMounts(world, ["ok", "exit1"]);
    const manager = world.manager();
    await manager.restoreAll();
    expect(manager.statusOf(ID1)).toBe("online");
    expect(manager.statusOf(ID2)).toBe("offline");
    // Another instance on the same DB mounts the second meanwhile.
    const line = foreignLine(ID2, "乙");
    writeFileSync(world.mountinfo, readFileSync(world.mountinfo, "utf8") + line);
    const before = world.fusermountCalls().length;

    await manager.closeAll();

    expect(world.fusermountCalls().slice(before)).toEqual([
      { argv: ["-uz", world.mountPoint("甲")], removed: 1 },
    ]);
    expect(readFileSync(world.mountinfo, "utf8")).toBe(line);
    expect(alive(pidOf(0))).toBe(false);
  });
});

describe("挂载操作的串行与取消「启动恢复期间关停」", () => {
  it("the mount already in mountinfo, readiness readdir hanging: shutdown kills it, -uz removes the line, row and dir kept", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    nextMounts(world, ["stubborn"]);
    const { hanging, aborted, probeExec } = readdirHangingAfter(0);
    const manager = world.manager({ probeExec });
    const restoring = manager.restoreAll();
    await waitFor(() => hanging.length === 1);
    expect(readFileSync(world.mountinfo, "utf8")).toContain(`m${ID1}:`);

    const started = Date.now();
    await manager.closeAll();

    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);
    await restoring;
    expect(aborted).toEqual([world.mountPoint("remote")]);
    expect(aliveMounts(world)).toEqual([]);
    expect(world.fusermountCalls().map((call) => call.argv)).toContainEqual([
      "-uz",
      world.mountPoint("remote"),
    ]);
    expect(readFileSync(world.mountinfo, "utf8")).toBe("");
    expect(world.store.get(ID1)).toMatchObject({ id: ID1 });
    expect(existsSync(join(world.privateDir(ID1), "rclone.conf"))).toBe(true);
    expect(manager.statusOf(ID1)).toBe("offline");
  });

  it("after the shutdown flag restoreAll and attach start nothing", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    const manager = world.manager();

    await manager.closeAll();
    await manager.restoreAll();
    await expect(attach(manager, sftp("/srv/data", { name: "later" }))).rejects.toEqual(
      new HttpError("mount_disabled"),
    );

    await quiet();
    expect(world.calls()).toEqual([]);
    expect(world.clock.pending()).toEqual([]);
  });
});

describe("挂载操作的串行与取消「重挂就绪期间卸载」", () => {
  it("rclone hanging before any mountinfo line: detach returns well inside the window, nothing left, no remount", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    await attach(manager);
    nextMounts(world, ["hang"]);
    process.kill(pidOf(0), "SIGKILL");
    await waitFor(pendingIs([5000]));
    world.clock.fireNext();
    await waitFor(() => world.mountCalls().length === 2);
    expect(alive(pidOf(1))).toBe(true);

    const started = Date.now();
    expect(await manager.detach(ID1, USER_ACTOR)).toMatchObject({ id: ID1 });

    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);
    expect(alive(pidOf(1))).toBe(false);
    expect(world.store.get(ID1)).toBeUndefined();
    expect(existsSync(world.privateDir(ID1))).toBe(false);
    expect(existsSync(world.mountPoint("remote"))).toBe(false);
    expectUnmounted([ID1], ["remote"]);
    expect(manager.statusOf(ID1)).toBe("offline");
    await expectNoRemount(2);
  });

  it("the remount's mount already up, its readdir hanging: detach SIGKILLs it, lazily unmounts it, no remount", {
    timeout: CASE_MS,
  }, async () => {
    const { hanging, aborted, probeExec } = readdirHangingAfter(1);
    const manager = world.manager({ probeExec });
    await attach(manager);
    nextMounts(world, ["stubborn"]);
    process.kill(pidOf(0), "SIGKILL");
    await waitFor(pendingIs([5000]));
    world.clock.fireNext();
    await waitFor(() => hanging.length === 1);
    expect(readFileSync(world.mountinfo, "utf8")).toContain(`m${ID1}:`);

    const started = Date.now();
    await manager.detach(ID1, USER_ACTOR);

    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);
    expect(aborted).toEqual([world.mountPoint("remote")]);
    expect(alive(pidOf(1))).toBe(false);
    expect(readFileSync(world.mountinfo, "utf8")).toBe("");
    expect(world.store.get(ID1)).toBeUndefined();
    expect(world.audits().map((audit) => audit.kind)).toEqual(["mount.detach"]);
    await expectNoRemount(2);
  });
});

/** The attach's outcome, its rejection caught at once (it lands while the test awaits `closeAll`). */
const outcomeOf = (attaching: Promise<unknown>) =>
  attaching.then(
    () => "attached",
    (error: unknown) => error,
  );

/** Shutdown ended the attach: refused, no row, no audit, no private directory, nothing mounted or alive. */
function expectAttachVoided(): void {
  expect(world.store.list(W1)).toEqual([]);
  expect(world.audits()).toEqual([]);
  expect(existsSync(world.privateDir(ID1))).toBe(false);
  expect(existsSync(world.mountPoint("remote"))).toBe(false);
  expect(aliveMounts(world)).toEqual([]);
  expectUnmounted([ID1], ["remote"]);
}

describe("挂载操作的串行与取消: shutdown during an attach", () => {
  it("rclone hanging before any mountinfo line: closeAll returns well inside the window, the attach is mount_failed and leaves nothing", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    const outcome = outcomeOf(attach(manager, sftp("/srv/data@hang")));
    await waitFor(() => world.mountCalls().length === 1);
    expect(alive(pidOf(0))).toBe(true);

    const started = Date.now();
    await manager.closeAll();

    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);
    expect(await outcome).toEqual(new HttpError("mount_failed"));
    expect(alive(pidOf(0))).toBe(false);
    expectAttachVoided();
  });

  it("the mount already in mountinfo, readiness readdir hanging: closeAll SIGKILLs it, -uz removes the line, the attach leaves nothing", {
    timeout: CASE_MS,
  }, async () => {
    const { hanging, aborted, probeExec } = readdirHangingAfter(0);
    const manager = world.manager({ probeExec });
    const outcome = outcomeOf(attach(manager, sftp("/srv/data@stubborn")));
    await waitFor(() => hanging.length === 1);
    expect(readFileSync(world.mountinfo, "utf8")).toContain(`m${ID1}:`);

    const started = Date.now();
    await manager.closeAll();

    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);
    expect(await outcome).toEqual(new HttpError("mount_failed"));
    expect(aborted).toEqual([world.mountPoint("remote")]);
    expect(alive(pidOf(0))).toBe(false);
    expect(world.fusermountCalls().map((call) => call.argv)).toEqual([
      ["-uz", world.mountPoint("remote")],
    ]);
    expectAttachVoided();
  });
});

describe("挂载操作的串行与取消: detach runs on the workspace chain", () => {
  it("a detach waits behind another mount's remount attempt in the same workspace", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ readyTimeoutMs: 1500 });
    await attach(manager);
    await attach(manager, sftp("/srv/other", { name: "other" }));
    nextMounts(world, ["hang"]);
    process.kill(pidOf(0), "SIGKILL");
    await waitFor(() => world.clock.pending().includes(5000));
    world.clock.advance(5000);
    await waitFor(() => world.mountCalls().length === 3);

    let done = false;
    const detaching = manager.detach(ID2, USER_ACTOR).then(() => {
      done = true;
    });
    await quiet();
    expect(done).toBe(false);
    expect(alive(pidOf(1))).toBe(true);

    await detaching;
    expect(alive(pidOf(2))).toBe(false);
    expect(world.store.get(ID2)).toBeUndefined();
    expect(world.store.get(ID1)).toMatchObject({ id: ID1 });
    await waitFor(() => world.clock.pending().includes(10_000));
    expect(manager.statusOf(ID1)).toBe("offline");
  });

  it("rclone exiting while its detach waits on the chain: offline at once, before the detach runs; no remount", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ readyTimeoutMs: 3000 });
    await attach(manager);
    await attach(manager, sftp("/srv/other", { name: "other" }));
    nextMounts(world, ["hang"]);
    process.kill(pidOf(0), "SIGKILL");
    await waitFor(() => world.clock.pending().includes(5000));
    world.clock.advance(5000);
    await waitFor(() => world.mountCalls().length === 3);
    const detaching = manager.detach(ID2, USER_ACTOR);

    process.kill(pidOf(1), "SIGKILL");
    await waitFor(() => manager.statusOf(ID2) === "offline");

    // The remount of the first is still waiting for readiness: the detach has not run yet.
    expect(alive(pidOf(2))).toBe(true);
    expect(world.clock.pending()).toEqual([]);
    await detaching;
    expect(world.store.get(ID2)).toBeUndefined();
    expectUnmounted([ID2], ["other"]);
    await waitFor(() => world.clock.pending().includes(10_000));
    expect(world.clock.pending()).toEqual([10_000]);
  });

  it("two overlapping detaches both refused (no fusermount3): still online; killing rclone then makes it offline", {
    timeout: CASE_MS,
  }, async () => {
    world = createWorld({ noFusermount: true });
    const { fusermountBin: _fusermount, ...lookedUp } = world.options();
    const manager = world.build(lookedUp);
    await attach(manager);

    const first = manager.detach(ID1, USER_ACTOR);
    const second = manager.detach(ID1, USER_ACTOR);
    await expect(first).rejects.toMatchObject({ code: "mount_disabled" });
    await expect(second).rejects.toMatchObject({ code: "mount_disabled" });

    expect(manager.statusOf(ID1)).toBe("online");
    expect(world.store.get(ID1)).toMatchObject({ id: ID1 });
    expect(world.clock.pending()).toEqual([30_000]);
    process.kill(pidOf(0), "SIGKILL");
    await waitFor(() => manager.statusOf(ID1) === "offline");
    await waitFor(pendingIs([5000]));
  });
});

describe("挂载进程与挂载点「惰性卸载与残留」: no remount after unmounting (#1686 hand-off)", () => {
  it("unmounting an online mount", { timeout: CASE_MS }, async () => {
    const manager = world.manager();
    await attach(manager);

    await manager.detach(ID1, USER_ACTOR);

    expect(world.store.get(ID1)).toBeUndefined();
    await expectNoRemount(1);
  });

  it("unmounting every mount of a workspace", { timeout: CASE_MS }, async () => {
    registerSource(world);
    const manager = world.manager();
    await attach(manager);
    await attach(manager, local());

    await manager.detachWorkspace(W1, OWNER);

    expect(world.store.list(W1)).toEqual([]);
    await expectNoRemount(2);
  });

  it("the mount-source cascade: each mount of the source detached with reason source_deleted", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const manager = world.manager();
    await attach(manager, local("本机"));
    await attach(manager, local("本机二"));
    await attach(manager);

    await manager.detachSource(SOURCE_ID, OWNER);

    expect(world.store.list(W1).map((mount) => mount.id)).toEqual([ID3]);
    expect(world.audits()).toEqual([
      {
        kind: "mount.detach",
        title: "卸载挂载点 本机",
        detail: { mountId: ID1, name: "本机", reason: "source_deleted" },
        workspace_id: W1,
      },
      {
        kind: "mount.detach",
        title: "卸载挂载点 本机二",
        detail: { mountId: ID2, name: "本机二", reason: "source_deleted" },
        workspace_id: W1,
      },
    ]);
    expect(alive(pidOf(0))).toBe(false);
    expect(alive(pidOf(1))).toBe(false);
    expect(manager.statusOf(ID3)).toBe("online");
    await quiet();
    expect(world.clock.pending()).toEqual([30_000]);
    world.clock.advance(PAST_CAP_MS);
    await quiet();
    expect(world.mountCalls()).toHaveLength(3);
  });
});
