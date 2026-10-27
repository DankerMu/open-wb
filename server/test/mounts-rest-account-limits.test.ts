/**
 * #1789 workspace-mounts「挂载端点」scenarios「账号在途上限」「账号总数上限」and the governing invariant of
 * change mount-account-limits: every accepted attach releases its in-flight hold exactly once however it
 * settles (502, a `before` 409, 201, an insert that throws, shutdown) — on the whole mount with the
 * injected world manager (`mounts-rest-helpers.ts`; fake rclone, fake `fusermount3`). zhangsan owns W1–W3
 * (the world's seed); lisi (u3) gets one formal workspace of her own here, row and root.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MountSettings } from "../src/workspaces/mounts/config.js";
import { CONFLICT, expectAnswer, GENERIC_500 } from "./models-rest-helpers.js";
import {
  aliveMounts,
  disposeWorlds,
  nextMounts,
  W1,
  W2,
  W3,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";
import {
  auditRows,
  CASE_MS,
  closeApps,
  MOUNT_DISABLED,
  MOUNT_FAILED,
  MOUNT_LIMIT,
  type MountsRest,
  mountRows,
  mountsUrl,
  openMounts,
  send,
  sftpBody,
} from "./mounts-rest-helpers.js";

const LISI = "u3";
const L1 = "4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b";
/** The spec defaults; each case overrides the limit it is about. */
const LIMITS: MountSettings = {
  mountMaxPerWorkspace: 8,
  mountMaxPerAccount: 32,
  mountMaxAttachingPerAccount: 2,
};

afterEach(async () => {
  await closeApps();
  await disposeWorlds();
});

/** lisi's formal workspace L1: the row and `<sandbox>/u3/l1` (what the world's `rootFromDb` joins). */
function seedLisi(world: World): void {
  world.db
    .prepare("INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, 1)")
    .run(L1, LISI, "l1", "l1");
  mkdirSync(join(world.sandbox, LISI, "l1"), { recursive: true });
}

function open(limits: Partial<MountSettings>): Promise<MountsRest> {
  return openMounts({ mountSettings: { ...LIMITS, ...limits }, seed: seedLisi });
}

function post(rest: MountsRest, who: "member" | "admin", workspaceId: string, name: string) {
  return send(
    rest,
    who,
    "POST",
    mountsUrl(workspaceId),
    sftpBody(name, "files.intra", `/srv/${name}`),
  );
}

/** zhangsan's POST on W1 whose rclone never gets ready; resolves once it has spawned (its pid). */
async function hangingAttach(rest: MountsRest) {
  const { world } = rest;
  nextMounts(world, ["hang"]);
  const response = post(rest, "member", W1, "甲");
  await waitFor(() => world.mountCalls().length === 1);
  return { response, pid: Number(world.mountCalls()[0]?.pid) };
}

function rejects(world: World) {
  return auditRows(world).filter((row) => row.kind === "mount.reject");
}

describe("账号在途上限", () => {
  it("MOUNT_MAX_ATTACHING_PER_ACCOUNT=1: while A waits on readiness B is 409 mount_limit (no child, no mount.reject), lisi 201; A settles 502, then B 201", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await open({ mountMaxAttachingPerAccount: 1 });
    const { world } = rest;
    const a = await hangingAttach(rest);
    const callsBefore = world.calls().length;

    expectAnswer(await post(rest, "member", W2, "乙"), 409, MOUNT_LIMIT);
    expect(world.calls()).toHaveLength(callsBefore);
    expect(rejects(world)).toEqual([]);
    expect(mountRows(world)).toEqual([]);

    expectAnswer(await post(rest, "admin", L1, "丙"), 201);

    process.kill(a.pid, "SIGKILL");
    expectAnswer(await a.response, 502, MOUNT_FAILED);
    expectAnswer(await post(rest, "member", W2, "乙"), 201);
    expect(
      mountRows(world)
        .map((row) => (row as { name: string }).name)
        .sort(),
    ).toEqual(["丙", "乙"]);
  });

  it("A refused in `before` (name taken, 409 conflict) releases its hold: B 201", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await open({ mountMaxAttachingPerAccount: 1 });
    mkdirSync(join(rest.world.rootOf(W1), "报表"));
    expectAnswer(await post(rest, "member", W1, "报表"), 409, CONFLICT);
    expectAnswer(await post(rest, "member", W2, "乙"), 201);
  });

  it("A settles 201 and releases its hold: B 201", { timeout: CASE_MS }, async () => {
    const rest = await open({ mountMaxAttachingPerAccount: 1 });
    expectAnswer(await post(rest, "member", W1, "甲"), 201);
    expectAnswer(await post(rest, "member", W2, "乙"), 201);
  });

  it("A's insert throws after readiness (generic 500) and releases its hold: B 201", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await open({ mountMaxAttachingPerAccount: 1 });
    const { db } = rest.world;
    db.exec(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON workspace_mounts BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expectAnswer(await post(rest, "member", W1, "甲"), 500, GENERIC_500);
    db.exec("DROP TRIGGER refuse_insert");
    expectAnswer(await post(rest, "member", W2, "乙"), 201);
  });

  it("closeAll while A waits on readiness: a later POST is 503 mount_disabled, not 409 mount_limit", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await open({ mountMaxAttachingPerAccount: 1 });
    const a = await hangingAttach(rest);
    await rest.app.mounts.closeAll();
    expect((await a.response).statusCode).not.toBe(201);
    expectAnswer(await post(rest, "member", W2, "乙"), 503, MOUNT_DISABLED);
  });
});

describe("账号总数上限", () => {
  it("MOUNT_MAX_PER_ACCOUNT=2: after A and B, C is 409 mount_limit (no child, no mount.reject); lisi 201; after A is detached C is 201", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await open({ mountMaxPerAccount: 2 });
    const { world } = rest;
    const a = (await post(rest, "member", W1, "甲")).json() as { id: string };
    expectAnswer(await post(rest, "member", W2, "乙"), 201);
    const callsBefore = world.calls().length;

    expectAnswer(await post(rest, "member", W3, "丙"), 409, MOUNT_LIMIT);
    expect(world.calls()).toHaveLength(callsBefore);
    expect(rejects(world)).toEqual([]);

    expectAnswer(await post(rest, "admin", L1, "丁"), 201);
    expectAnswer(await send(rest, "member", "DELETE", mountsUrl(W1, a.id)), 204);
    expectAnswer(await post(rest, "member", W3, "丙"), 201);
    expect(mountRows(world)).toHaveLength(3);
  });

  it("MOUNT_MAX_PER_ACCOUNT=1, MOUNT_MAX_ATTACHING_PER_ACCOUNT=2, two workspaces at once: exactly one 201, one 409 mount_limit, one fake rclone", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await open({ mountMaxPerAccount: 1, mountMaxAttachingPerAccount: 2 });
    const { world } = rest;
    const [a, b] = await Promise.all([
      post(rest, "member", W1, "甲"),
      post(rest, "member", W2, "乙"),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expectAnswer(a.statusCode === 409 ? a : b, 409, MOUNT_LIMIT);
    expect(world.mountCalls()).toHaveLength(1);
    expect(aliveMounts(world)).toHaveLength(1);
    expect(mountRows(world)).toHaveLength(1);
    expect(rejects(world)).toEqual([]);
  });
});
