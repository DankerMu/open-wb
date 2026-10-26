/**
 * s1b-workspace-mounts group 6 (manager part, #1687): the online state of a mount and its remounts
 * (design D3 / D6 / D8 on remount, D11; workspace-mounts「在线状态与重挂」every scenario,「挂载凭证文件」
 * 「重挂改写主机」, the remount side of「挂载取值与主机规则」「解析失败不启动子进程」and「挂载进程与挂载点」
 * 「挂载点被换掉即拒绝」). Same seam and world as `mounts-manager.test.ts`: `createMountManager` with the
 * real-spawned fake rclone and fake `fusermount3`; the clock, the `stat` probe and the TCP connect are
 * injected (`world.clock` advances only when the test says so). Expected delays are the spec's literals.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostResolver } from "../src/workspaces/mounts/host-policy.js";
import { type TcpConnect, tcpConnect } from "../src/workspaces/mounts/probe.js";
import { type ProbeExec, probeInChild } from "../src/workspaces/mounts/rclone-process.js";
import {
  alive,
  createWorld,
  disposeWorlds,
  entriesOf,
  ID1,
  ID2,
  local,
  nextMounts,
  OWNER,
  quiet,
  registerSource,
  seedMount,
  sftp,
  smb,
  W1,
  W2,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";

const CASE_MS = 30_000;

let world: World;

beforeEach(() => {
  world = createWorld();
});

afterEach(async () => {
  await disposeWorlds();
});

type Manager = ReturnType<World["manager"]>;

const attach = (manager: Manager, body = sftp(), workspaceId = W1) =>
  manager.attach({ workspaceId, ownerId: OWNER, body });

function pidOf(index: number): number {
  return Number(world.mountCalls()[index]?.pid);
}

const pendingIs = (expected: number[]) => () =>
  JSON.stringify(world.clock.pending()) === JSON.stringify(expected);

interface StatCall {
  path: string;
  timeoutMs: number;
  killed: boolean;
}

/**
 * A `stat` probe recorded and answered by the test: `true` at once, or (hanging) never on its own —
 * only the manager's abort ends it, standing for the SIGKILL of the probe child. `readdir` (readiness)
 * goes to the real child probe.
 */
function statProbe(hang = false): { calls: StatCall[]; probeExec: ProbeExec } {
  const calls: StatCall[] = [];
  const probeExec: ProbeExec = (op, path, timeoutMs, signal) => {
    if (op === "readdir") {
      return probeInChild(op, path, timeoutMs, signal);
    }
    const call = { path, timeoutMs, killed: false };
    calls.push(call);
    if (!hang) {
      return Promise.resolve(true);
    }
    return new Promise((settle) => {
      signal?.addEventListener("abort", () => {
        call.killed = true;
        settle(false);
      });
    });
  };
  return { calls, probeExec };
}

/** A connect that neither connects nor fails: only the manager's abort ends it. */
function silentConnect(): { calls: { host: string; port: number }[]; connect: TcpConnect } {
  const calls: { host: string; port: number }[] = [];
  const connect: TcpConnect = (host, port, signal) => {
    calls.push({ host, port });
    return new Promise((settle) => signal.addEventListener("abort", () => settle(false)));
  };
  return { calls, connect };
}

/** Kills the fake rclone of mount call `index` and waits until the crash is handled (remount pending). */
async function crash(manager: Manager, id: string, index: number): Promise<void> {
  process.kill(pidOf(index), "SIGKILL");
  await waitFor(() => manager.statusOf(id) === "offline");
  await waitFor(() => world.clock.pending().includes(5000));
}

describe("在线状态与重挂「崩溃即离线并退避重挂」", () => {
  it("offline at once, one -uz; remounts 5 s, then 10 s, then 20 s later; online; the next crash waits 5 s again", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    await attach(manager);
    expect(world.clock.pending()).toEqual([30_000]);
    nextMounts(world, ["exit1", "exit1", "ok"]);

    process.kill(pidOf(0), "SIGKILL");
    await waitFor(() => manager.statusOf(ID1) === "offline");
    expect(world.clock.now()).toBe(0);
    await waitFor(pendingIs([5000]));
    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);

    world.clock.advance(4999);
    await quiet();
    expect(world.mountCalls()).toHaveLength(1);
    const attemptsAt: number[] = [];
    world.clock.advance(1);
    for (const [index, next] of [
      [1, [10_000]],
      [2, [20_000]],
    ] as const) {
      await waitFor(() => world.mountCalls().length === index + 1);
      attemptsAt.push(world.clock.now());
      await waitFor(pendingIs([...next]));
      expect(manager.statusOf(ID1)).toBe("offline");
      world.clock.fireNext();
    }
    await waitFor(() => world.mountCalls().length === 4);
    attemptsAt.push(world.clock.now());
    await waitFor(() => manager.statusOf(ID1) === "online");
    expect(attemptsAt).toEqual([5000, 15_000, 35_000]);
    expect(world.clock.pending()).toEqual([30_000]);

    nextMounts(world, ["exit1"]);
    const crashedAt = world.clock.now();
    await crash(manager, ID1, 3);
    expect(world.clock.pending()).toEqual([5000]);
    world.clock.fireNext();
    await waitFor(() => world.mountCalls().length === 5);
    expect(world.clock.now() - crashedAt).toBe(5000);
  });
});

describe("在线状态与重挂「退避封顶」", () => {
  it("ten failing attempts in a row are 5, 10, 20, 40, 80, 160, 300, 300, 300 s apart", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    nextMounts(
      world,
      Array.from({ length: 10 }, () => "exit1"),
    );
    const manager = world.manager();

    await manager.restoreAll();
    expect(world.mountCalls()).toHaveLength(1);
    const gaps: number[] = [];
    for (let attempt = 2; attempt <= 10; attempt += 1) {
      await waitFor(() => world.clock.pending().length === 1);
      gaps.push(world.clock.fireNext());
      await waitFor(() => world.mountCalls().length === attempt);
    }

    expect(gaps).toEqual([
      5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ]);
    await waitFor(pendingIs([300_000]));
    expect(manager.statusOf(ID1)).toBe("offline");
  });
});

describe("在线状态与重挂「探测超时」", () => {
  it("every 30 s; a stat probe that never returns is SIGKILLed 5 s later, offline, remount pending", {
    timeout: CASE_MS,
  }, async () => {
    const { calls, probeExec } = statProbe(true);
    const manager = world.manager({ probeExec });
    await attach(manager);

    world.clock.advance(29_999);
    await quiet();
    expect(calls).toEqual([]);
    world.clock.advance(1);
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toMatchObject({ path: world.mountPoint("remote"), timeoutMs: 5000 });
    // The event loop keeps answering while the probe hangs.
    await new Promise((settle) => setImmediate(settle));
    expect(manager.statusOf(ID1)).toBe("online");

    world.clock.advance(4999);
    await quiet();
    expect(calls[0]?.killed).toBe(false);
    expect(manager.statusOf(ID1)).toBe("online");
    world.clock.advance(1);
    await waitFor(() => manager.statusOf(ID1) === "offline");
    expect(calls[0]?.killed).toBe(true);
    await waitFor(pendingIs([5000]));
    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);
    expect(alive(pidOf(0))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("a probe that succeeds keeps the mount online and arms the next round 30 s later", {
    timeout: CASE_MS,
  }, async () => {
    const { calls, probeExec } = statProbe();
    const manager = world.manager({ probeExec });
    await attach(manager);

    world.clock.advance(30_000);
    await waitFor(pendingIs([30_000]));
    expect(calls).toHaveLength(1);
    world.clock.advance(30_000);
    await waitFor(() => calls.length === 2);
    await waitFor(pendingIs([30_000]));
    expect(manager.statusOf(ID1)).toBe("online");
    expect(world.fusermountCalls()).toEqual([]);
  });

  it("the mount point gone from mountinfo is offline at the next round without a stat probe", {
    timeout: CASE_MS,
  }, async () => {
    const { calls, probeExec } = statProbe();
    const manager = world.manager({ probeExec });
    await attach(manager);
    writeFileSync(world.mountinfo, "");

    world.clock.advance(30_000);
    await waitFor(() => manager.statusOf(ID1) === "offline");
    await waitFor(pendingIs([5000]));
    expect(calls).toEqual([]);
    expect(alive(pidOf(0))).toBe(false);
  });
});

describe("在线状态与重挂「远端不可达即离线」", () => {
  it("sftp at 10.0.0.7:22 not answering is offline 5 s later with one -uz; a local mount never connects", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const { calls: stats, probeExec } = statProbe();
    const { calls, connect } = silentConnect();
    const manager = world.manager({ probeExec, connect });
    await attach(manager);
    await attach(manager, local());

    world.clock.advance(30_000);
    await waitFor(() => calls.length === 1 && stats.length === 2);
    expect(calls).toEqual([{ host: "10.0.0.7", port: 22 }]);
    world.clock.advance(4999);
    await quiet();
    expect(manager.statusOf(ID1)).toBe("online");
    world.clock.advance(1);
    await waitFor(() => manager.statusOf(ID1) === "offline");

    await waitFor(pendingIs([5000, 25_000]));
    expect(manager.statusOf(ID2)).toBe("online");
    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("the check dials the given port, else sftp 22 and smb 445", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ probeExec: statProbe().probeExec });
    await attach(manager, sftp("/srv/data", { port: 2222 }));
    await attach(manager, smb());

    world.clock.advance(30_000);
    await waitFor(() => world.connects.length === 2);
    expect([...world.connects].sort((a, b) => a.port - b.port)).toEqual([
      { host: "10.0.0.7", port: 445 },
      { host: "10.0.0.7", port: 2222 },
    ]);
  });
});

describe("挂载凭证文件「重挂改写主机」", () => {
  it("files.intra resolved to 10.0.0.7, then 10.0.0.8 at the remount: only the host line changes, before the spawn", {
    timeout: CASE_MS,
  }, async () => {
    const answers = ["10.0.0.7", "10.0.0.8"];
    const resolveHost: HostResolver = async () => [{ address: answers.shift() ?? "10.0.0.9" }];
    const manager = world.manager({ resolveHost });
    await attach(manager);
    const conf = join(world.privateDir(ID1), "rclone.conf");
    const created = readFileSync(conf, "utf8");
    expect(created.split("\n")[2]).toBe("host = 10.0.0.7");

    await crash(manager, ID1, 0);
    world.clock.fireNext();
    await waitFor(() => manager.statusOf(ID1) === "online");

    const calls = world.mountCalls();
    expect(calls.map((call) => call.confHost)).toEqual(["10.0.0.7", "10.0.0.8"]);
    expect(readFileSync(conf, "utf8")).toBe(
      created.replace("host = 10.0.0.7\n", "host = 10.0.0.8\n"),
    );
    expect(statSync(conf).mode & 0o777).toBe(0o600);
    for (const call of calls) {
      expect(call.argv.filter((arg) => /^--[a-z]+-host$/u.test(arg))).toEqual([]);
    }
    expect(world.calls().map((call) => call.argv[1])).toEqual(["obscure", "mount", "mount"]);
    expect(world.store.get(ID1)?.host).toBe("files.intra");

    world.clock.advance(30_000);
    await waitFor(() => world.connects.length === 1);
    expect(world.connects).toEqual([{ host: "10.0.0.8", port: 22 }]);
  });
});

describe("重挂时主机规则与挂载点检查复判", () => {
  it("the host no longer resolving: no mount call, offline, the next attempt 10 s later", {
    timeout: CASE_MS,
  }, async () => {
    let lookups = 0;
    const resolveHost: HostResolver = async (host) => {
      lookups += 1;
      if (lookups > 1) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      }
      return [{ address: "10.0.0.7" }];
    };
    const manager = world.manager({ resolveHost });
    await attach(manager);

    await crash(manager, ID1, 0);
    world.clock.fireNext();
    await waitFor(pendingIs([10_000]));
    expect(lookups).toBe(2);
    expect(world.mountCalls()).toHaveLength(1);
    expect(manager.statusOf(ID1)).toBe("offline");
  });

  it("restarted with an allow-list that no longer names the host: never mounted, offline, backoff", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    let lookups = 0;
    const manager = world.manager({
      mountHostAllow: ["other.intra"],
      resolveHost: async () => {
        lookups += 1;
        return [{ address: "10.0.0.8" }];
      },
    });

    await manager.restoreAll();
    expect(world.clock.pending()).toEqual([5000]);
    world.clock.fireNext();
    await waitFor(pendingIs([10_000]));

    expect(world.mountCalls()).toEqual([]);
    expect(lookups).toBe(0);
    expect(manager.statusOf(ID1)).toBe("offline");
    expect(world.store.get(ID1)).toMatchObject({ id: ID1 });
  });

  for (const swap of ["symlink", "file"] as const) {
    it(`挂载点被换掉即拒绝: the mount point of an offline mount replaced by a ${swap}: no mount call, offline, backoff`, {
      timeout: CASE_MS,
    }, async () => {
      const outside = join(world.base, "outside");
      mkdirSync(outside);
      const manager = world.manager();
      await attach(manager);
      await crash(manager, ID1, 0);

      rmSync(world.mountPoint("remote"), { recursive: true });
      if (swap === "symlink") {
        symlinkSync(outside, world.mountPoint("remote"));
      } else {
        writeFileSync(world.mountPoint("remote"), "kept\n");
      }
      world.clock.fireNext();
      await waitFor(pendingIs([10_000]));

      expect(world.mountCalls()).toHaveLength(1);
      expect(manager.statusOf(ID1)).toBe("offline");
      expect(entriesOf(outside)).toEqual([]);
      if (swap === "symlink") {
        expect(readlinkSync(world.mountPoint("remote"))).toBe(outside);
      } else {
        expect(readFileSync(world.mountPoint("remote"), "utf8")).toBe("kept\n");
      }
      expect(existsSync(join(world.privateDir(ID1), "rclone.conf"))).toBe(true);
    });
  }

  it("a local mount whose source now resolves elsewhere: no mount call, offline, backoff", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const manager = world.manager();
    await attach(manager, local());
    await crash(manager, ID1, 0);

    const other = join(world.base, "other source");
    mkdirSync(other);
    rmSync(world.source, { recursive: true });
    symlinkSync(other, world.source);
    world.clock.fireNext();
    await waitFor(pendingIs([10_000]));

    expect(world.mountCalls()).toHaveLength(1);
    expect(entriesOf(other)).toEqual([]);
    expect(manager.statusOf(ID1)).toBe("offline");
  });

  it("a mount in another workspace remounts on its own chain", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    await attach(manager, sftp(), W2);
    await crash(manager, ID1, 0);
    world.clock.fireNext();
    await waitFor(() => manager.statusOf(ID1) === "online");
    expect(world.mountCalls()[1]?.argv[3]).toBe(join(world.rootOf(W2), "remote"));
  });
});

describe("probe children and the TCP connect check", () => {
  it("the stat probe child succeeds on a directory, fails on a missing path, and ends at once when aborted", {
    timeout: CASE_MS,
  }, async () => {
    expect(await probeInChild("stat", world.root, 5000)).toBe(true);
    expect(await probeInChild("stat", join(world.root, "missing"), 5000)).toBe(false);
    const controller = new AbortController();
    const probing = probeInChild("stat", world.root, 60_000, controller.signal);
    controller.abort();
    expect(await probing).toBe(false);
    expect(await probeInChild("stat", world.root, 60_000, controller.signal)).toBe(false);
  });

  it("tcpConnect: true for a listener (and closes), false for a closed port and for an aborted check", {
    timeout: CASE_MS,
  }, async () => {
    const closed: boolean[] = [];
    const server: Server = createServer((socket) => {
      socket.on("close", () => closed.push(true));
    });
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      expect(await tcpConnect("127.0.0.1", port, new AbortController().signal)).toBe(true);
      await waitFor(() => closed.length === 1);
      const aborted = new AbortController();
      aborted.abort();
      expect(await tcpConnect("127.0.0.1", port, aborted.signal)).toBe(false);
    } finally {
      await new Promise((settle) => server.close(settle));
    }
    expect(await tcpConnect("127.0.0.1", port, new AbortController().signal)).toBe(false);
    expect(closed).toHaveLength(1);
  });
});
