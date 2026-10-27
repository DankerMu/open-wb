/**
 * s1b-workspace-mounts tasks 7.2, the mount part (#1690): workspace-mounts「挂载端点」「功能关闭时的已登记挂载」
 * and「挂载操作的串行与取消」「重挂就绪期间卸载」's HTTP layer — on the whole mount with the injected world
 * manager (`mounts-rest-helpers.ts`; fake clock, fake rclone, fake `fusermount3`).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectAnswer } from "./models-rest-helpers.js";
import {
  aliveMounts,
  disposeWorlds,
  ID1,
  ID2,
  nextMounts,
  quiet,
  seedMount,
  sftp,
  W1,
  waitFor,
} from "./mounts-manager-helpers.js";
import {
  CASE_MS,
  closeApps,
  expectNoSecret,
  MOUNT_DISABLED,
  mountinfoLines,
  mountsUrl,
  openMounts,
  plantMountinfo,
  postMount,
  send,
  sftpBody,
} from "./mounts-rest-helpers.js";

/**
 * How long a cancelled readiness wait may take: strictly below the 20 s window. The manager gets the SIGTERM
 * grace injected above it, so a cancellation sent through the grace instead of a SIGKILL also overruns it.
 * The timed span includes real process spawns, hence the slack (#1804).
 */
const CANCEL_BOUND_MS = 15_000;
const STOP_GRACE_BEYOND_BOUND_MS = 20_000;

afterEach(async () => {
  await closeApps();
  await disposeWorlds();
});

describe("功能关闭时的已登记挂载", () => {
  it("GET lists both offline with enabled false; POST 503; 甲 204; 乙 503 (one error naming fusermount3) then 204 with exactly one -uz; no rclone call", {
    timeout: CASE_MS,
  }, async () => {
    let second = "";
    const rest = await openMounts({
      featureOff: true,
      noFusermount: true,
      seed: (world) => {
        seedMount(world, { id: ID1, body: sftp("/srv/a", { name: "甲" }), createdAt: 1 });
        seedMount(world, { id: ID2, body: sftp("/srv/b", { name: "乙" }), createdAt: 2 });
        second = join(world.rootOf(W1), "乙");
        mkdirSync(second);
        plantMountinfo(world, second, ID2);
      },
    });
    const { world } = rest;

    const listed = await send(rest, "member", "GET", mountsUrl(W1));
    expectAnswer(listed, 200);
    const view = listed.json() as { enabled: boolean; mounts: Record<string, unknown>[] };
    expect(view.enabled).toBe(false);
    expect(view.mounts.map((mount) => [mount.id, mount.name, mount.status])).toEqual([
      [ID1, "甲", "offline"],
      [ID2, "乙", "offline"],
    ]);
    expectNoSecret(listed.body);

    expectAnswer(
      await send(rest, "member", "POST", mountsUrl(W1), sftpBody("丙")),
      503,
      MOUNT_DISABLED,
    );
    expectAnswer(await send(rest, "member", "DELETE", mountsUrl(W1, ID1)), 204);
    expect(world.store.get(ID1)).toBeUndefined();
    expect(existsSync(world.privateDir(ID1))).toBe(false);

    const refused = await send(rest, "member", "DELETE", mountsUrl(W1, ID2));
    expectAnswer(refused, 503, MOUNT_DISABLED);
    expect(world.store.get(ID2)).toMatchObject({ id: ID2 });
    expect(existsSync(world.privateDir(ID2))).toBe(true);
    expect(world.errors).toHaveLength(1);
    expect(world.errors[0]?.message).toContain("fusermount3");
    for (const error of world.errors) {
      expectNoSecret(`${error.message}\n${error.stack ?? ""}`);
    }

    world.installFusermount();
    expectAnswer(await send(rest, "member", "DELETE", mountsUrl(W1, ID2)), 204);
    expect(world.fusermountCalls().map((entry) => entry.argv)).toEqual([["-uz", second]]);
    expect(world.store.get(ID2)).toBeUndefined();
    expect(existsSync(world.privateDir(ID2))).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(mountinfoLines(world)).toEqual([]);
    expect(world.calls()).toEqual([]);
  });
});

describe("挂载操作的串行与取消「重挂就绪期间卸载」(HTTP)", () => {
  it("the remount's rclone hangs before readiness: DELETE is 204 well inside the window, GET no longer lists it, no rclone or mountinfo line left, no remount after 300 s", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts({ overrides: { stopTimeoutMs: STOP_GRACE_BEYOND_BOUND_MS } });
    const { world } = rest;
    const created = await postMount(rest, W1, sftpBody("远端"));
    const id = String(created.id);
    nextMounts(world, ["hang"]);
    process.kill(Number(world.mountCalls()[0]?.pid), "SIGKILL");
    await waitFor(() => JSON.stringify(world.clock.pending()) === "[5000]");
    world.clock.fireNext();
    await waitFor(() => world.mountCalls().length === 2);
    expect(aliveMounts(world)).toHaveLength(1);

    const started = Date.now();
    expectAnswer(await send(rest, "member", "DELETE", mountsUrl(W1, id)), 204);
    expect(Date.now() - started).toBeLessThan(CANCEL_BOUND_MS);

    expectAnswer(await send(rest, "member", "GET", mountsUrl(W1)), 200, {
      enabled: true,
      mounts: [],
    });
    expect(aliveMounts(world)).toEqual([]);
    expect(mountinfoLines(world).filter((line) => line.includes(`m${id}:`))).toEqual([]);
    expect(world.store.get(id)).toBeUndefined();
    expect(existsSync(world.privateDir(id))).toBe(false);
    expect(existsSync(join(world.rootOf(W1), "远端"))).toBe(false);
    world.clock.advance(301_000);
    await quiet();
    expect(world.mountCalls()).toHaveLength(2);
  });
});
