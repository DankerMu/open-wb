/**
 * s1b-workspace-mounts group 5 (manager part, #1686): unmounting through the mount-manager (design D9 lazy
 * unmount, D10, D15; workspace-mounts「挂载凭证文件」「卸载删除私有目录」,「挂载进程与挂载点」「惰性卸载与残留」
 * and the feature-off unmount rule,「临时空间与删除前卸载」「按空间卸载全部」). Same seam and world as
 * `mounts-manager.test.ts`: the real-spawned fake rclone and fake `fusermount3` over a fake mountinfo.
 * The no-remount-afterwards halves of these scenarios are in `mounts-manager-lifecycle.test.ts` (#1687).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import {
  alive,
  createWorld,
  disposeWorlds,
  entriesOf,
  ID1,
  ID2,
  local,
  OWNER,
  PASS_SENTINEL,
  registerSource,
  sftp,
  USER_SENTINEL,
  W1,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";

const CASE_MS = 20_000;
const USER_ACTOR = { actorId: OWNER, reason: "user" } as const;

let world: World;

beforeEach(() => {
  world = createWorld();
});

afterEach(async () => {
  await disposeWorlds();
});

const attach = (manager: ReturnType<World["manager"]>, body = sftp()) =>
  manager.attach({ workspaceId: W1, ownerId: OWNER, body });

function pidOf(index = 0): number {
  return Number(world.mountCalls()[index]?.pid);
}

describe("挂载凭证文件「卸载删除私有目录」", () => {
  it("detach removes rclone.conf, cache/ and rclone.log with the private directory; mounts/ stays", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    await attach(manager);
    expect(entriesOf(world.privateDir(ID1))).toEqual(["cache", "rclone.conf", "rclone.log"]);

    expect(await manager.detach(ID1, USER_ACTOR)).toMatchObject({ id: ID1, name: "remote" });

    expect(existsSync(world.privateDir(ID1))).toBe(false);
    expect(entriesOf(world.mountsDir)).toEqual([]);
    expect(world.store.get(ID1)).toBeUndefined();
    expect(existsSync(world.mountPoint("remote"))).toBe(false);
    expect(alive(pidOf())).toBe(false);
    expect(world.errors).toEqual([]);
  });
});

describe("挂载进程与挂载点「惰性卸载与残留」", () => {
  it("one -uz on the mount point, rclone gone, a stray file kept in a plain directory, reported once", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    await attach(manager);
    writeFileSync(join(world.mountPoint("remote"), "stray.txt"), "offline write\n");

    await manager.detach(ID1, USER_ACTOR);

    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);
    expect(alive(pidOf())).toBe(false);
    expect(entriesOf(world.mountPoint("remote"))).toEqual(["stray.txt"]);
    expect(world.errors).toHaveLength(1);
    expect(existsSync(world.privateDir(ID1))).toBe(false);
    expect(world.store.get(ID1)).toBeUndefined();
    expect(readFileSync(world.mountinfo, "utf8")).toBe("");
  });

  it("an rclone ignoring SIGTERM is SIGKILLed after the stop timeout", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager({ stopTimeoutMs: 300 });
    await attach(manager, sftp("/srv/data@stubborn"));

    const started = Date.now();
    await manager.detach(ID1, USER_ACTOR);

    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(alive(pidOf())).toBe(false);
    expect(world.store.get(ID1)).toBeUndefined();
  });

  it("the source scan unmounts a mount of this section left elsewhere", {
    timeout: CASE_MS,
  }, async () => {
    const manager = world.manager();
    await attach(manager);
    const stray = join(world.base, "moved here");
    writeFileSync(
      world.mountinfo,
      `${readFileSync(world.mountinfo, "utf8")}99 1 0:9 / ${stray.replaceAll(" ", "\\040")} rw - fuse.rclone m${ID1}{abcde}:/srv/data rw\n`,
    );

    await manager.detach(ID1, USER_ACTOR);

    expect(world.fusermountCalls().map((call) => call.argv)).toEqual([
      ["-uz", world.mountPoint("remote")],
      ["-uz", stray],
    ]);
    expect(readFileSync(world.mountinfo, "utf8")).toBe("");
  });
});

describe("mountinfo octal escapes end to end", () => {
  it("a workspace root and a remote path with spaces mount, match and unmount through \\040", {
    timeout: CASE_MS,
  }, async () => {
    world = createWorld({ spaced: true });
    const manager = world.manager();
    await attach(manager, sftp("/srv/my data"));

    expect(world.root).toContain(" ");
    const line = readFileSync(world.mountinfo, "utf8");
    expect(line).toContain(world.mountPoint("remote").replaceAll(" ", "\\040"));
    expect(line).toContain(`m${ID1}:/srv/my\\040data`);
    expect(manager.statusOf(ID1)).toBe("online");

    await manager.detach(ID1, USER_ACTOR);

    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("remote")], removed: 1 },
    ]);
    expect(readFileSync(world.mountinfo, "utf8")).toBe("");
  });
});

describe("statusOf and namesOf", () => {
  it("online with its name listed after attach; gone after detach; offline once rclone exits", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const manager = world.manager();
    await attach(manager);
    await attach(manager, local());

    expect(manager.statusOf(ID1)).toBe("online");
    expect([...manager.namesOf(W1)].sort()).toEqual(["remote", "本机"]);
    expect([...manager.namesOf("ffffffffffffffffffffffffffffffff")]).toEqual([]);

    process.kill(pidOf(1), "SIGKILL");
    await waitFor(() => manager.statusOf(ID2) === "offline");
    expect(manager.statusOf(ID1)).toBe("online");

    await manager.detach(ID1, USER_ACTOR);
    expect(manager.statusOf(ID1)).toBe("offline");
    expect([...manager.namesOf(W1)]).toEqual(["本机"]);
  });
});

describe("detach whose row delete fails", () => {
  it("the audit emit throwing: rejects, offline with the row kept; a retried detach removes the row", {
    timeout: CASE_MS,
  }, async () => {
    const failure = new Error("audit failed");
    let failing = true;
    const manager = world.manager({
      audit: {
        emit: (event) => {
          if (failing) {
            throw failure;
          }
          return emit(world.db, event);
        },
      },
    });
    await attach(manager);

    await expect(manager.detach(ID1, USER_ACTOR)).rejects.toBe(failure);

    expect(manager.statusOf(ID1)).toBe("offline");
    expect(world.store.get(ID1)).toMatchObject({ id: ID1 });
    expect(alive(pidOf())).toBe(false);
    expect(existsSync(world.privateDir(ID1))).toBe(false);
    expect(world.audits()).toEqual([]);

    failing = false;
    expect(await manager.detach(ID1, USER_ACTOR)).toMatchObject({ id: ID1 });

    expect(world.store.get(ID1)).toBeUndefined();
    expect(manager.statusOf(ID1)).toBe("offline");
    expect([...manager.namesOf(W1)]).toEqual([]);
    expect(world.audits().map((audit) => audit.kind)).toEqual(["mount.detach"]);
    expect(world.errors).toEqual([]);
  });
});

describe("detach refused for want of fusermount3", () => {
  it("an online mount stays online with its row; once fusermount3 is on PATH the detach completes", {
    timeout: CASE_MS,
  }, async () => {
    world = createWorld({ noFusermount: true });
    const { fusermountBin: _fusermount, ...lookedUp } = world.options();
    const manager = world.build(lookedUp);
    await attach(manager);

    await expect(manager.detach(ID1, USER_ACTOR)).rejects.toMatchObject({ code: "mount_disabled" });

    expect(manager.statusOf(ID1)).toBe("online");
    expect(alive(pidOf())).toBe(true);
    expect(world.store.get(ID1)).toMatchObject({ id: ID1 });

    world.installFusermount();
    expect(await manager.detach(ID1, USER_ACTOR)).toMatchObject({ id: ID1 });
    expect(manager.statusOf(ID1)).toBe("offline");
    expect(alive(pidOf())).toBe(false);
    expect(world.store.get(ID1)).toBeUndefined();
  });
});

describe("功能关闭时的卸载", () => {
  /** Rows and private directories as an earlier run with RCLONE_BIN left them. */
  function seedRegistered(): void {
    for (const [id, name] of [
      [ID1, "甲"],
      [ID2, "乙"],
    ] as const) {
      world.store.create({
        id,
        workspaceId: W1,
        ownerId: OWNER,
        body: sftp("/srv/data", { name }),
      });
      const dir = world.privateDir(id);
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, "rclone.conf"), `[m${id}]\nuser = \`${USER_SENTINEL}\`\npass = x\n`, {
        mode: 0o600,
      });
    }
    writeFileSync(
      world.mountinfo,
      `77 1 0:7 / ${world.mountPoint("乙")} rw - fuse.rclone m${ID2}:/srv/data rw\n`,
    );
  }

  it("no fusermount3 needed: deleted; still mounted without one on PATH: mount_disabled, kept, one record", {
    timeout: CASE_MS,
  }, async () => {
    world = createWorld({ noFusermount: true });
    seedRegistered();
    const { rcloneBin: _rclone, fusermountBin: _fusermount, ...disabled } = world.options();
    const manager = world.build(disabled);

    await expect(
      manager.attach({ workspaceId: W1, ownerId: OWNER, body: sftp("/srv/data", { name: "丙" }) }),
    ).rejects.toEqual(new HttpError("mount_disabled"));
    expect(manager.statusOf(ID1)).toBe("offline");

    expect(await manager.detach(ID1, USER_ACTOR)).toMatchObject({ id: ID1 });
    expect(world.store.get(ID1)).toBeUndefined();
    expect(existsSync(world.privateDir(ID1))).toBe(false);

    const refused = manager.detach(ID2, USER_ACTOR);
    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({ code: "mount_disabled" });
    expect(world.store.get(ID2)).toMatchObject({ id: ID2 });
    expect(existsSync(join(world.privateDir(ID2), "rclone.conf"))).toBe(true);
    expect(world.errors).toHaveLength(1);
    const record = `${world.errors[0]?.message} ${String(world.errors[0]?.cause)}`;
    expect(record).toContain("fusermount3");
    expect(record).toContain("mountinfo");
    expect(record).not.toContain(USER_SENTINEL);
    expect(record).not.toContain(PASS_SENTINEL);

    world.installFusermount();
    expect(await manager.detach(ID2, USER_ACTOR)).toMatchObject({ id: ID2 });
    expect(world.fusermountCalls()).toEqual([
      { argv: ["-uz", world.mountPoint("乙")], removed: 1 },
    ]);
    expect(world.store.get(ID2)).toBeUndefined();
    expect(existsSync(world.privateDir(ID2))).toBe(false);
    expect(world.calls()).toEqual([]);
  });
});

describe("临时空间与删除前卸载「按空间卸载全部」", () => {
  it("both online mounts unmounted, rows and private dirs gone, one mount.detach each; then the workspace row deletes", {
    timeout: CASE_MS,
  }, async () => {
    registerSource(world);
    const manager = world.manager();
    await attach(manager);
    await attach(manager, local());
    const deleteWorkspace = () => world.db.prepare("DELETE FROM workspaces WHERE id = ?").run(W1);
    expect(deleteWorkspace).toThrow(/FOREIGN KEY/u);

    await manager.detachWorkspace(W1, OWNER);

    expect(world.store.list(W1)).toEqual([]);
    expect(entriesOf(world.mountsDir)).toEqual([]);
    expect(alive(pidOf(0))).toBe(false);
    expect(alive(pidOf(1))).toBe(false);
    expect(world.fusermountCalls().map((call) => call.argv)).toEqual([
      ["-uz", world.mountPoint("remote")],
      ["-uz", world.mountPoint("本机")],
    ]);
    expect(world.audits()).toEqual([
      {
        kind: "mount.detach",
        title: "卸载挂载点 remote",
        detail: { mountId: ID1, name: "remote", reason: "workspace_deleted" },
        workspace_id: W1,
      },
      {
        kind: "mount.detach",
        title: "卸载挂载点 本机",
        detail: { mountId: ID2, name: "本机", reason: "workspace_deleted" },
        workspace_id: W1,
      },
    ]);
    expect(deleteWorkspace().changes).toBe(1);
  });

  it("detach of an unknown mount id resolves undefined and touches nothing", async () => {
    expect(
      await world.manager().detach("ffffffffffffffffffffffffffffffff", USER_ACTOR),
    ).toBeUndefined();
    expect(world.audits()).toEqual([]);
  });
});
