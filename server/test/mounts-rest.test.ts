/**
 * s1b-workspace-mounts tasks 7.2, the mount part (#1690): workspace-mounts「挂载端点」scenarios「建出、列举与
 * 卸载」「次序与拒绝」「插行失败先卸载」「并发建出受上限约束」, 临时空间「转正之后可以挂载」, http-service-skeleton
 * 「挂载的归属路由」(the mount routes) and「干净启动与一致命令面」's mount item (缺省配置即挂载关闭) — on the
 * whole mount (`mounts-rest-helpers.ts`). Host rules, key sets and credentials are in
 * `mounts-rest-hosts.test.ts`; feature-off and remount-window cases in `mounts-rest-lifecycle.test.ts`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resolveMountSettings } from "../src/workspaces/mounts/config.js";
import {
  BAD_REQUEST,
  CONFLICT,
  expectAnswer,
  GENERIC_500,
  NOT_FOUND,
  type RawBody,
  UNAUTHORIZED,
} from "./models-rest-helpers.js";
import {
  alive,
  aliveMounts,
  createWorld,
  disposeWorlds,
  OWNER,
  SOURCE_ID,
  sftp,
  W1,
  W2,
} from "./mounts-manager-helpers.js";
import {
  addSource,
  addTemporary,
  auditRows,
  CASE_MS,
  closeApps,
  MOUNT_DISABLED,
  MOUNT_LIMIT,
  mountRows,
  mountsUrl,
  openMounts,
  padded,
  postMount,
  privateDirs,
  send,
  sftpBody,
  VIEW_KEYS,
} from "./mounts-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const TEMP = "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e";
const KIB64 = 64 * 1024;
const MALFORMED: RawBody = { raw: '{"name": ', type: "application/json" };
const EMPTY_BODY: RawBody = { raw: "", type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };

afterEach(async () => {
  await closeApps();
  await disposeWorlds();
});

describe("建出、列举与卸载", () => {
  it("201 online → GET the same view (no username / password) → 204; mount.attach and mount.detach (user); then empty and no mount point", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const { world } = rest;
    const created = await postMount(rest, W1, sftpBody("数据仓库导出"));
    expect(Object.keys(created).sort()).toEqual(VIEW_KEYS);
    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      name: "数据仓库导出",
      backend: "sftp",
      host: "files.intra",
      port: null,
      remotePath: "/srv/data",
      sourceId: null,
      sourceName: null,
      readOnly: false,
      status: "online",
      createdAt: expect.any(Number),
    });
    const id = String(created.id);
    const point = join(world.rootOf(W1), "数据仓库导出");
    expect(existsSync(point)).toBe(true);

    const listed = await send(rest, "member", "GET", mountsUrl(W1));
    expectAnswer(listed, 200, { enabled: true, mounts: [created] });
    expect(listed.body).not.toContain("username");
    expect(listed.body).not.toContain("password");

    const removed = await send(rest, "member", "DELETE", mountsUrl(W1, id));
    expectAnswer(removed, 204);
    expect(removed.body).toBe("");
    expectAnswer(await send(rest, "member", "GET", mountsUrl(W1)), 200, {
      enabled: true,
      mounts: [],
    });
    expect(existsSync(point)).toBe(false);
    expect(existsSync(world.privateDir(id))).toBe(false);
    expect(aliveMounts(world)).toEqual([]);

    expect(auditRows(world).filter((row) => row.kind.startsWith("mount."))).toEqual([
      {
        kind: "mount.attach",
        actorId: OWNER,
        workspaceId: W1,
        title: "挂载目录 数据仓库导出",
        detail: {
          mountId: id,
          name: "数据仓库导出",
          backend: "sftp",
          host: "files.intra",
          port: null,
          remotePath: "/srv/data",
          sourceId: null,
          readOnly: false,
        },
      },
      {
        kind: "mount.detach",
        actorId: OWNER,
        workspaceId: W1,
        title: "卸载挂载点 数据仓库导出",
        detail: { mountId: id, name: "数据仓库导出", reason: "user" },
      },
    ]);
  });

  it("a local mount's view names its source, host / port / remotePath null; GET is by created_at, id", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const { world } = rest;
    addSource(world, SOURCE_ID, world.source, false);
    const first = await postMount(rest, W1, { ...sftpBody("远端"), port: 2222 });
    const second = await postMount(rest, W1, {
      name: "本机",
      backend: "local",
      sourceId: SOURCE_ID,
      readOnly: true,
    });
    expect(second).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      name: "本机",
      backend: "local",
      host: null,
      port: null,
      remotePath: null,
      sourceId: SOURCE_ID,
      sourceName: "NAS",
      readOnly: true,
      status: "online",
      createdAt: expect.any(Number),
    });
    expect(first.port).toBe(2222);
    const listed = await send(rest, "member", "GET", mountsUrl(W1));
    const { mounts } = listed.json() as { mounts: Record<string, unknown>[] };
    const expected = [first, second].sort(
      (a, b) =>
        Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)),
    );
    expect(mounts).toEqual(expected);
    const attach = auditRows(world).find(
      (row) => row.kind === "mount.attach" && row.title === "挂载目录 本机",
    );
    expect(attach?.detail).toEqual({
      mountId: second.id,
      name: "本机",
      backend: "local",
      host: null,
      port: null,
      remotePath: null,
      sourceId: SOURCE_ID,
      readOnly: true,
    });
  });

  it("DELETE: a mount of another workspace, another owner's workspace or an unknown id is 404 and deletes nothing", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const created = await postMount(rest, W1, sftpBody("远端"));
    const id = String(created.id);
    expectAnswer(await send(rest, "member", "DELETE", mountsUrl(W2, id)), 404, NOT_FOUND);
    expectAnswer(await send(rest, "admin", "DELETE", mountsUrl(W1, id)), 404, NOT_FOUND);
    expectAnswer(
      await send(rest, "member", "DELETE", mountsUrl(W1, "0".repeat(32))),
      404,
      NOT_FOUND,
    );
    expectAnswer(await send(rest, "anonymous", "DELETE", mountsUrl(W1, id)), 401, UNAUTHORIZED);
    expect(rest.world.store.get(id)).toMatchObject({ id });
    expect(rest.app.mounts.statusOf(id)).toBe("online");
    expectAnswer(await send(rest, "admin", "GET", mountsUrl(W1)), 404, NOT_FOUND);
  });
});

describe("次序与拒绝", () => {
  it("401, 404, 503 mount_disabled, 400, 409 mount_limit, 404, 400, 409 conflict — no child, no row, no audit", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts({
      seed: (world) => {
        for (let index = 0; index < 8; index += 1) {
          world.store.create({
            id: `${String(index).repeat(2)}${"e".repeat(30)}`,
            workspaceId: W2,
            ownerId: OWNER,
            body: sftp("/srv/data", { name: `seed${index}` }),
          });
        }
      },
    });
    const { world } = rest;
    addTemporary(world, TEMP);
    const readOnlySource = "f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5";
    addSource(world, readOnlySource, world.source, true);
    mkdirSync(join(world.rootOf(W1), "报表"));
    const rowsBefore = mountRows(world);
    const valid = sftpBody("远端");

    expectAnswer(await send(rest, "anonymous", "POST", mountsUrl(W1), valid), 401, UNAUTHORIZED);
    expectAnswer(await send(rest, "admin", "POST", mountsUrl(W1), valid), 404, NOT_FOUND);
    const off = await openMounts({ featureOff: true });
    expectAnswer(await send(off, "member", "POST", mountsUrl(W1), valid), 503, MOUNT_DISABLED);
    expectAnswer(await send(rest, "member", "POST", mountsUrl(TEMP), valid), 400, BAD_REQUEST);
    expectAnswer(await send(rest, "member", "POST", mountsUrl(W2), valid), 409, MOUNT_LIMIT);
    const unknownSource = {
      name: "本机",
      backend: "local",
      sourceId: "0".repeat(32),
      readOnly: true,
    };
    expectAnswer(await send(rest, "member", "POST", mountsUrl(W1), unknownSource), 404, NOT_FOUND);
    const writable = { name: "本机", backend: "local", sourceId: readOnlySource, readOnly: false };
    expectAnswer(await send(rest, "member", "POST", mountsUrl(W1), writable), 400, BAD_REQUEST);
    expectAnswer(
      await send(rest, "member", "POST", mountsUrl(W1), sftpBody("报表")),
      409,
      CONFLICT,
    );

    for (const world of [rest.world, off.world]) {
      expect(world.calls()).toEqual([]);
      expect(privateDirs(world)).toEqual([]);
      expect(auditRows(world)).toEqual([]);
    }
    expect(mountRows(world)).toEqual(rowsBefore);
    expect(mountRows(off.world)).toEqual([]);
    expect(existsSync(join(world.rootOf(W1), "远端"))).toBe(false);
  });

  it("a mount name already registered in the workspace is 409 conflict before any child", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    await postMount(rest, W1, sftpBody("远端"));
    const calls = rest.world.calls().length;
    expectAnswer(
      await send(rest, "member", "POST", mountsUrl(W1), sftpBody("远端", "files.intra", "/srv/b")),
      409,
      CONFLICT,
    );
    expect(rest.world.calls()).toHaveLength(calls);
    expect(auditRows(rest.world).map((row) => row.kind)).toEqual(["mount.attach"]);
  });
});

describe("插行失败先卸载", () => {
  it("the insert fails after readiness: generic 500, one -uz, rclone gone, no private dir or mount point, no audit", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const { world } = rest;
    world.db.exec(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON workspace_mounts BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const response = await send(rest, "member", "POST", mountsUrl(W1), sftpBody("远端"));
    expectAnswer(response, 500, GENERIC_500);
    const point = join(world.rootOf(W1), "远端");
    expect(world.fusermountCalls().map((entry) => entry.argv)).toEqual([["-uz", point]]);
    const [mount] = world.mountCalls();
    expect(world.mountCalls()).toHaveLength(1);
    expect(alive(Number(mount?.pid))).toBe(false);
    expect(privateDirs(world)).toEqual([]);
    expect(existsSync(point)).toBe(false);
    expect(mountRows(world)).toEqual([]);
    expect(auditRows(world)).toEqual([]);
  });
});

describe("并发建出受上限约束", () => {
  it("MOUNT_MAX_PER_WORKSPACE=1, two valid POSTs at once: exactly one 201, one 409 mount_limit, one fake rclone", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts({
      mountSettings: {
        mountMaxPerWorkspace: 1,
        mountMaxPerAccount: 32,
        mountMaxAttachingPerAccount: 2,
      },
    });
    const [a, b] = await Promise.all([
      send(rest, "member", "POST", mountsUrl(W1), sftpBody("甲", "files.intra", "/srv/a")),
      send(rest, "member", "POST", mountsUrl(W1), sftpBody("乙", "files.intra", "/srv/b")),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expectAnswer(refused, 409, MOUNT_LIMIT);
    expect(rest.world.mountCalls()).toHaveLength(1);
    expect(aliveMounts(rest.world)).toHaveLength(1);
    expect(mountRows(rest.world)).toHaveLength(1);
  });
});

describe("转正之后可以挂载", () => {
  it("POST on temporary T → 400 and no child; promote T to 调研资料; POST again → 201", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const { world } = rest;
    const root = addTemporary(world, TEMP);
    expectAnswer(await send(rest, "member", "GET", mountsUrl(TEMP)), 200, {
      enabled: true,
      mounts: [],
    });
    expectAnswer(
      await send(rest, "member", "POST", mountsUrl(TEMP), sftpBody("远端")),
      400,
      BAD_REQUEST,
    );
    expect(world.calls()).toEqual([]);
    const promoted = await send(rest, "member", "POST", `/api/workspaces/${TEMP}/promote`, {
      name: "调研资料",
    });
    expect(promoted.statusCode).toBe(200);
    const created = await postMount(rest, TEMP, sftpBody("远端"));
    expect(created.status).toBe("online");
    expect(existsSync(join(root, "远端"))).toBe(true);
  });
});

describe("缺省配置即挂载关闭", () => {
  it("resolveMountSettings({}) through createApp: GET …/mounts is 200 {enabled:false, mounts:[]}", async () => {
    const world = createWorld();
    const app = createApp({
      db: world.db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: {
        runtime: {
          bin: join(world.base, "omp-bin", "omp"),
          sandboxRoot: world.sandbox,
          stateDir: world.state,
          modelId: "m1",
          idleMs: 600_000,
        },
        mountSettings: resolveMountSettings({}),
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: mountsUrl(W1),
        headers: { cookie: await cookieFor(app, "zhangsan") },
      });
      expectAnswer(response, 200, { enabled: false, mounts: [] });
    } finally {
      await app.close();
    }
  });
});

describe("挂载的归属路由", () => {
  const BODIES: Array<[string, RawBody]> = [
    ["malformed JSON", MALFORMED],
    ["an empty JSON body", EMPTY_BODY],
    ["text/plain", TEXT],
    ["an otherwise valid body over 64 KiB", padded(KIB64 + 1, sftpBody("远端"))],
  ];

  it.each(BODIES)(
    "own formal workspace, %s → exact 400, nothing built or written",
    async (_label, body) => {
      const rest = await openMounts();
      const { world } = rest;
      expectAnswer(await send(rest, "member", "POST", mountsUrl(W1), body), 400, BAD_REQUEST);
      expect(privateDirs(world)).toEqual([]);
      expect(existsSync(join(world.rootOf(W1), "远端"))).toBe(false);
      expect(world.calls()).toEqual([]);
      expect(mountRows(world)).toEqual([]);
      expect(auditRows(world)).toEqual([]);
    },
  );

  it("a valid body of exactly 64 KiB is parsed (the limit is the route's)", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const response = await send(
      rest,
      "member",
      "POST",
      mountsUrl(W1),
      padded(KIB64, sftpBody("远端")),
    );
    expectAnswer(response, 201);
  });

  it("before the body: another owner's workspace 404, feature off 503, anonymous 401 (malformed JSON each)", async () => {
    const rest = await openMounts();
    expectAnswer(await send(rest, "admin", "POST", mountsUrl(W1), MALFORMED), 404, NOT_FOUND);
    expectAnswer(
      await send(rest, "member", "POST", mountsUrl("0".repeat(32)), MALFORMED),
      404,
      NOT_FOUND,
    );
    expectAnswer(
      await send(rest, "anonymous", "POST", mountsUrl(W1), MALFORMED),
      401,
      UNAUTHORIZED,
    );
    const off = await openMounts({ featureOff: true });
    expectAnswer(await send(off, "member", "POST", mountsUrl(W1), MALFORMED), 503, MOUNT_DISABLED);
    expect(auditRows(rest.world)).toEqual([]);
    expect(auditRows(off.world)).toEqual([]);
  });

  it("DELETE own mount with a malformed JSON body stays the generic 500 and the mount is not deleted", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const created = await postMount(rest, W1, sftpBody("远端"));
    const id = String(created.id);
    expectAnswer(
      await send(rest, "member", "DELETE", mountsUrl(W1, id), MALFORMED),
      500,
      GENERIC_500,
    );
    expect(rest.world.store.get(id)).toMatchObject({ id });
    expect(rest.app.mounts.statusOf(id)).toBe("online");
    expect(rest.world.fusermountCalls()).toEqual([]);
    expect(auditRows(rest.world).map((row) => row.kind)).toEqual(["mount.attach"]);
  });
});
