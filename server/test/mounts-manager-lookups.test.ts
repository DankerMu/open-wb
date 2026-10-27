/**
 * The host lookup limit through the mount-manager (#1810 mount-lookup-slots-per-account;
 * workspace-mounts「挂载取值与主机规则」, scenario「解析名额按账号分配」): each account at most one
 * lookup in flight, the process at most two, an account's extra lookups waiting in its own queue without
 * holding a process slot; creation and remount count against the mount's owning account; an IP literal
 * never queues. Same seam and world as `mounts-manager.test.ts`: `createMountManager` with the
 * real-spawned fake rclone, the resolver injected and hanging until the test settles a call.
 *
 * Determinism (design「Required evidence」): "a call reached the resolver" is polled (`pending.length ===
 * K`); "no other call came in" is asserted after that, one macrotask later (an attach reaches the
 * limiter through microtasks only, no I/O); submissions go one at a time, each after the previous one is
 * in or held. A remount's lookup comes after the unmount step's I/O: only ever polled. Each attach that
 * waits on another is in a workspace of its own (the workspace chain would hold it before the limiter).
 * Not covered: whether an idle account's limiter is dropped (internal to `createAttempts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { HostResolver } from "../src/workspaces/mounts/host-policy.js";
import {
  createWorld,
  disposeWorlds,
  ID1,
  LISI,
  OWNER,
  seedMount,
  sftp,
  W_LISI,
  W_WANGWU,
  W1,
  W2,
  W3,
  WANGWU,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";

const CASE_MS = 20_000;

let world: World;

beforeEach(() => {
  world = createWorld();
});

afterEach(async () => {
  await disposeWorlds();
});

type Manager = ReturnType<World["manager"]>;

/** The HttpError code an attach rejects with. */
async function codeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).code;
  }
  throw new Error("expected the attach to be refused");
}

/** The account a test host stands for: `lisi.intra`, `wangwu.intra`; every other host is zhangsan's. */
function accountOf(host: string): string {
  return host.startsWith("lisi") ? LISI : host.startsWith("wangwu") ? WANGWU : OWNER;
}

interface Lookup {
  host: string;
  fail(): void;
  answer(address: string): void;
}

/**
 * A resolver whose lookups never settle on their own: each call is recorded in arrival order with its
 * settlers; `peak` is the most calls ever in flight at once, overall and of one account.
 */
function hangingResolver(): {
  pending: Lookup[];
  hosts(): string[];
  peak: { all: number; account: number };
  resolveHost: HostResolver;
} {
  const pending: Lookup[] = [];
  const inFlight = new Set<string>();
  const peak = { all: 0, account: 0 };
  const resolveHost: HostResolver = (host) =>
    new Promise((settle, reject) => {
      inFlight.add(host);
      const mine = [...inFlight].filter((other) => accountOf(other) === accountOf(host));
      peak.all = Math.max(peak.all, inFlight.size);
      peak.account = Math.max(peak.account, mine.length);
      pending.push({
        host,
        fail: () => {
          inFlight.delete(host);
          reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
        },
        answer: (address) => {
          inFlight.delete(host);
          settle([{ address }]);
        },
      });
    });
  return { pending, hosts: () => pending.map((call) => call.host), peak, resolveHost };
}

/** An sftp mount of `ownerId` in `workspaceId` on `host`, named after the host's first label. */
const attachAs = (manager: Manager, ownerId: string, workspaceId: string, host: string) =>
  manager.attach({
    workspaceId,
    ownerId,
    body: sftp("/srv/data", { name: host.split(".")[0] ?? host, host }),
  });

/** Positive: exactly `count` calls have reached the resolver. */
function reached(lookups: { pending: Lookup[] }, count: number): Promise<void> {
  return waitFor(() => lookups.pending.length === count);
}

/** Negative, after the positive condition: one macrotask later still exactly `count` calls. */
async function heldAt(lookups: { pending: Lookup[] }, count: number): Promise<void> {
  await new Promise(setImmediate);
  expect(lookups.pending.length).toBe(count);
}

/** The lookup made for `host`. */
function callOf(lookups: { pending: Lookup[] }, host: string): Lookup {
  const call = lookups.pending.find((each) => each.host === host);
  if (call === undefined) {
    throw new Error(`no lookup of ${host}`);
  }
  return call;
}

describe("解析名额按账号分配 (manager layer)", () => {
  it("one account's two creations in two workspaces: one lookup at a time, the second after the first fails", {
    timeout: CASE_MS,
  }, async () => {
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const first = codeOf(attachAs(manager, OWNER, W1, "z1.intra"));
    await reached(lookups, 1);
    const second = codeOf(attachAs(manager, OWNER, W2, "z2.intra"));
    await heldAt(lookups, 1);
    expect(lookups.hosts()).toEqual(["z1.intra"]);

    callOf(lookups, "z1.intra").fail();
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["z1.intra", "z2.intra"]);
    callOf(lookups, "z2.intra").fail();

    expect(await Promise.all([first, second])).toEqual(["mount_failed", "mount_failed"]);
    expect(lookups.peak).toEqual({ all: 1, account: 1 });
    expect(world.calls()).toEqual([]);
  });

  it("three accounts: two lookups in flight, the third account waits for a process slot", {
    timeout: CASE_MS,
  }, async () => {
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const settled = [codeOf(attachAs(manager, OWNER, W1, "z1.intra"))];
    await reached(lookups, 1);
    settled.push(codeOf(attachAs(manager, LISI, W_LISI, "lisi.intra")));
    await reached(lookups, 2);
    settled.push(codeOf(attachAs(manager, WANGWU, W_WANGWU, "wangwu.intra")));
    await heldAt(lookups, 2);
    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra"]);

    callOf(lookups, "lisi.intra").fail();
    await reached(lookups, 3);
    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra", "wangwu.intra"]);
    callOf(lookups, "z1.intra").fail();
    callOf(lookups, "wangwu.intra").fail();

    expect(await Promise.all(settled)).toEqual(["mount_failed", "mount_failed", "mount_failed"]);
    expect(lookups.peak).toEqual({ all: 2, account: 1 });
    expect(world.calls()).toEqual([]);
  });

  it("zhangsan, zhangsan, lisi, wangwu in turn: zhangsan's waiter holds no process slot; wangwu enters before it", {
    timeout: CASE_MS,
  }, async () => {
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const settled = [codeOf(attachAs(manager, OWNER, W1, "z1.intra"))];
    await reached(lookups, 1);
    settled.push(codeOf(attachAs(manager, OWNER, W2, "z2.intra")));
    await heldAt(lookups, 1);
    settled.push(codeOf(attachAs(manager, LISI, W_LISI, "lisi.intra")));
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra"]);
    settled.push(codeOf(attachAs(manager, WANGWU, W_WANGWU, "wangwu.intra")));
    await heldAt(lookups, 2);

    // z1's process slot goes to wangwu, queued for one first; z2 then queues for a process slot.
    callOf(lookups, "z1.intra").fail();
    await reached(lookups, 3);
    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra", "wangwu.intra"]);
    await heldAt(lookups, 3);

    callOf(lookups, "lisi.intra").fail();
    await reached(lookups, 4);
    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra", "wangwu.intra", "z2.intra"]);
    callOf(lookups, "wangwu.intra").fail();
    callOf(lookups, "z2.intra").fail();

    expect(await Promise.all(settled)).toEqual([
      "mount_failed",
      "mount_failed",
      "mount_failed",
      "mount_failed",
    ]);
    expect(lookups.peak).toEqual({ all: 2, account: 1 });
    expect(world.calls()).toEqual([]);
  });

  it("the account's slot handed from z1 to z2 is still taken: z3 in a third workspace waits for z2", {
    timeout: CASE_MS,
  }, async () => {
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const settled = [codeOf(attachAs(manager, OWNER, W1, "z1.intra"))];
    await reached(lookups, 1);
    settled.push(codeOf(attachAs(manager, OWNER, W2, "z2.intra")));
    await heldAt(lookups, 1);
    callOf(lookups, "z1.intra").fail();
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["z1.intra", "z2.intra"]);

    settled.push(codeOf(attachAs(manager, OWNER, W3, "z3.intra")));
    await heldAt(lookups, 2);
    callOf(lookups, "z2.intra").fail();
    await reached(lookups, 3);
    expect(lookups.hosts()).toEqual(["z1.intra", "z2.intra", "z3.intra"]);
    callOf(lookups, "z3.intra").fail();

    expect(await Promise.all(settled)).toEqual(["mount_failed", "mount_failed", "mount_failed"]);
    expect(lookups.peak).toEqual({ all: 1, account: 1 });
  });

  it("a lookup that answers or ends in a loopback rejection frees the account's slot for its next lookup", {
    timeout: CASE_MS,
  }, async () => {
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const online = attachAs(manager, OWNER, W1, "z1.intra");
    online.catch(() => undefined); // awaited below; a failing case must not leave it unhandled
    await reached(lookups, 1);
    const rejected = codeOf(attachAs(manager, OWNER, W2, "z2.intra"));
    await heldAt(lookups, 1);

    callOf(lookups, "z1.intra").answer("10.0.0.7");
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["z1.intra", "z2.intra"]);
    const record = await online;
    expect(record).toMatchObject({ id: ID1, host: "z1.intra" });
    expect(manager.statusOf(ID1)).toBe("online");

    const third = codeOf(attachAs(manager, OWNER, W3, "z3.intra"));
    await heldAt(lookups, 2);
    callOf(lookups, "z2.intra").answer("127.0.0.1");
    expect(await rejected).toBe("mount_host_rejected");
    await reached(lookups, 3);
    callOf(lookups, "z3.intra").fail();

    expect(await third).toBe("mount_failed");
    expect(world.mountCalls()).toHaveLength(1);
    expect(lookups.peak).toEqual({ all: 1, account: 1 });
  });

  it("a remount's lookup counts against its owner: zhangsan's creation in another workspace waits, lisi's goes ahead", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const restored = manager.restoreAll();
    await reached(lookups, 1);
    expect(lookups.hosts()).toEqual(["files.intra"]);
    const zhangsan = codeOf(attachAs(manager, OWNER, W2, "z2.intra"));
    await heldAt(lookups, 1);
    const lisi = codeOf(attachAs(manager, LISI, W_LISI, "lisi.intra"));
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["files.intra", "lisi.intra"]);

    callOf(lookups, "files.intra").fail();
    await restored;
    expect(manager.statusOf(ID1)).toBe("offline");
    await reached(lookups, 3);
    expect(lookups.hosts()).toEqual(["files.intra", "lisi.intra", "z2.intra"]);
    callOf(lookups, "lisi.intra").fail();
    callOf(lookups, "z2.intra").fail();

    expect(await Promise.all([zhangsan, lisi])).toEqual(["mount_failed", "mount_failed"]);
    expect(world.mountCalls()).toEqual([]);
    expect(lookups.peak).toEqual({ all: 2, account: 1 });
  });

  it("a remount detached while its lookup hangs: the lookup keeps the account's slot until it returns", {
    timeout: CASE_MS,
  }, async () => {
    seedMount(world, { id: ID1, body: sftp(), createdAt: 1 });
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });

    const restored = manager.restoreAll();
    await reached(lookups, 1);
    expect(await manager.detach(ID1, { actorId: OWNER, reason: "user" })).toMatchObject({
      id: ID1,
    });
    await restored;
    expect(world.store.get(ID1)).toBeUndefined();
    expect(world.clock.pending()).toEqual([]);

    const zhangsan = codeOf(attachAs(manager, OWNER, W2, "z2.intra"));
    await heldAt(lookups, 1);
    callOf(lookups, "files.intra").fail();
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["files.intra", "z2.intra"]);
    callOf(lookups, "z2.intra").fail();

    expect(await zhangsan).toBe("mount_failed");
    expect(world.mountCalls()).toEqual([]);
  });

  it("an IP literal host of a waiting account or of a third account is not queued behind two hanging lookups", {
    timeout: CASE_MS,
  }, async () => {
    const lookups = hangingResolver();
    const manager = world.manager({ resolveHost: lookups.resolveHost });
    const hanging = [codeOf(attachAs(manager, OWNER, W1, "z1.intra"))];
    await reached(lookups, 1);
    hanging.push(codeOf(attachAs(manager, LISI, W_LISI, "lisi.intra")));
    await reached(lookups, 2);
    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra"]);

    const literals: [string, string, string][] = [
      [OWNER, W2, "10.0.0.7"],
      [WANGWU, W_WANGWU, "10.0.0.8"],
    ];
    for (const [ownerId, workspaceId, host] of literals) {
      const stuck = new AbortController();
      const record = await Promise.race([
        manager.attach({
          workspaceId,
          ownerId,
          body: sftp("/srv/data", { name: "literal", host }),
        }),
        delay(5000, undefined, { signal: stuck.signal }).then(() => {
          throw new Error("the literal's attach waited behind the lookups");
        }),
      ]);
      stuck.abort();

      expect(record).toMatchObject({ name: "literal", host, ownerId, workspaceId });
      expect(manager.statusOf(record.id)).toBe("online");
      expect(readFileSync(join(world.privateDir(record.id), "rclone.conf"), "utf8")).toContain(
        `\nhost = ${host}\n`,
      );
    }

    expect(lookups.hosts()).toEqual(["z1.intra", "lisi.intra"]);
    for (const call of lookups.pending) {
      call.fail();
    }
    expect(await Promise.all(hanging)).toEqual(["mount_failed", "mount_failed"]);
  });
});
