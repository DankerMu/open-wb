/**
 * s1b-workspace-mounts tasks 7.2, the mount-source part (#1689): workspace-mounts「挂载源端点」and its
 * scenarios「两种视图」「拒绝的路径」「删除连带卸载」「删除挂载源与并发建出」, the deleting mark of design D14 (held while a cascade
 * is in flight, one hold per overlapping `DELETE`, cleared on failure), the feature-off endpoints, the
 * 403-before-body-and-id matrix and the `POST` / `DELETE /api/mount-sources` cases of
 * http-service-skeleton「挂载的归属路由」— on the whole mount: createApp on the world's migrated `:memory:`
 * database with `assembly.mounts` = a real manager on the fake rclone and fake `fusermount3`
 * (`mounts-manager-helpers.ts`). The referencing `local` mounts are made through the manager, except in
 * 「删除挂载源与并发建出」(#1690) and the delete-failure case's re-attach, which go through
 * `POST /api/workspaces/:id/mounts`. Oracles: spec literals (envelopes, views, audit detail), the tables, the fake
 * mountinfo, the fakes' call records and the file system.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { MountManager, MountManagerOptions } from "../src/workspaces/mounts/manager.js";
import { type ProbeExec, probeInChild } from "../src/workspaces/mounts/rclone-process.js";
import { deletingSources } from "../src/workspaces/mounts/rest.js";
import type { MountBody } from "../src/workspaces/mounts/validate.js";
import {
  BAD_REQUEST,
  CONFLICT,
  call,
  expectAnswer,
  FORBIDDEN,
  GENERIC_500,
  NOT_FOUND,
  type RawBody,
  UNAUTHORIZED,
} from "./models-rest-helpers.js";
import {
  alive,
  createWorld,
  disposeWorlds,
  OWNER,
  quiet,
  W1,
  type World,
  waitFor,
} from "./mounts-manager-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const CASE_MS = 30_000;
const URL = "/api/mount-sources";
/** A workspace of the second account (`zhaoliu`, u2 of the seed). */
const W4 = "4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a";
const ADMIN_ID = "u3";
const KIB16 = 16 * 1024;
const MALFORMED: RawBody = { raw: '{"name": ', type: "application/json" };
const EMPTY_BODY: RawBody = { raw: "", type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };

interface Rest {
  world: World;
  app: FastifyInstance;
  cookies: { admin: string; member: string };
  /** `<base>/web/dist`, the app's `STATIC_ROOT`. */
  staticRoot: string;
  /** `dirname(OMP_BIN)`. */
  ompBinDir: string;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  await disposeWorlds();
});

/**
 * The world plus u2's workspace W4 (`<sandbox>/u2/w4`), the app's static root and omp bin directory, and
 * an app whose `SANDBOX_ROOT` / `OMP_STATE_DIR` are the world's. The manager resolves both accounts'
 * workspaces and guards the same roots as the app; `featureOff` drops `rcloneBin` and `fusermountBin`,
 * `noFusermount` leaves the fake `fusermount3` off the manager's PATH; `wrap` replaces the manager the
 * app is given (`app.mounts`) by a wrapper around it.
 */
async function openRest(
  featureOff = false,
  noFusermount = false,
  wrap: (manager: MountManager) => MountManager = (manager) => manager,
  overrides: Partial<MountManagerOptions> = {},
): Promise<Rest> {
  const world = createWorld({ noFusermount });
  world.db
    .prepare(
      "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, 'u2', 'w4', 'w4', 1)",
    )
    .run(W4);
  const roots = new Map([
    [`${OWNER}/${W1}`, world.rootOf(W1)],
    [`u2/${W4}`, join(world.sandbox, "u2", "w4")],
  ]);
  mkdirSync(join(world.sandbox, "u2", "w4"), { recursive: true });
  const staticRoot = join(world.base, "web", "dist");
  mkdirSync(staticRoot, { recursive: true });
  const ompBinDir = join(world.base, "omp-bin");
  mkdirSync(ompBinDir);
  const options = world.options({
    workspaceRootOf: (ownerId, workspaceId) => roots.get(`${ownerId}/${workspaceId}`) ?? null,
    protectedRoots: [world.sandbox, world.state, staticRoot, ompBinDir],
    ...overrides,
  });
  const { rcloneBin: _rclone, fusermountBin: _fusermount, ...off } = options;
  const manager = world.build(featureOff ? (off as MountManagerOptions) : options);
  const app = createApp({
    db: world.db,
    staticRoot,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: {
        bin: join(ompBinDir, "omp"),
        sandboxRoot: world.sandbox,
        stateDir: world.state,
        modelId: "m1",
        idleMs: 600_000,
      },
      mounts: wrap(manager),
    },
  });
  apps.push(app);
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { world, app, cookies, staticRoot, ompBinDir };
}

/** A fresh directory `<base>/<name>` outside every protected root. */
function dirOf(rest: Rest, name: string): string {
  const dir = join(rest.world.base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function register(rest: Rest, name: string, path: string, readOnly = false) {
  const response = await call(rest, "admin", "POST", URL, { name, path, readOnly });
  expectAnswer(response, 201);
  return response.json() as { id: string; name: string; path: string; readOnly: boolean };
}

/**
 * An app whose manager's `detachSource` waits, per call, until the test resolves `gates[n]`, then runs
 * the real cascade: a `DELETE` in flight is held between marking the source and its cascade.
 */
async function openGated(
  overrides: Partial<MountManagerOptions> = {},
): Promise<Rest & { gates: (() => void)[] }> {
  const gates: (() => void)[] = [];
  const rest = await openRest(
    false,
    false,
    (manager) => ({
      ...manager,
      async detachSource(sourceId, actorId) {
        await new Promise<void>((resolve) => gates.push(resolve));
        return manager.detachSource(sourceId, actorId);
      },
    }),
    overrides,
  );
  return { ...rest, gates };
}

/**
 * Readiness `readdir` children wait, per call, until the test resolves `held[n]`, then run for real: a
 * mount request is held after its rclone has mounted and before its row is inserted.
 */
function heldReadiness(): { held: (() => void)[]; probeExec: ProbeExec } {
  const held: (() => void)[] = [];
  const probeExec: ProbeExec = async (op, path, timeoutMs, signal) => {
    if (op === "readdir") {
      await new Promise<void>((release) => held.push(release));
    }
    return probeInChild(op, path, timeoutMs, signal);
  };
  return { held, probeExec };
}

function localOn(sourceId: string, name: string): MountBody {
  return { name, backend: "local", sourceId, readOnly: false };
}

/** u1's `本机` in W1, then u2's `共享` in W4, both `local` on the source, through the manager. */
async function attachBoth(rest: Rest, sourceId: string) {
  const mine = await rest.app.mounts.attach({
    workspaceId: W1,
    ownerId: OWNER,
    body: localOn(sourceId, "本机"),
  });
  const theirs = await rest.app.mounts.attach({
    workspaceId: W4,
    ownerId: "u2",
    body: localOn(sourceId, "共享"),
  });
  return [mine, theirs] as const;
}

function sourceRows(rest: Rest): unknown[] {
  return rest.world.db
    .prepare("SELECT id, name, path FROM mount_sources ORDER BY name")
    .all()
    .map((row) => ({ ...row }));
}

/** Every `mount.*` audit row, oldest first. */
function mountAudits(rest: Rest) {
  return rest.world.db
    .prepare(
      "SELECT kind, actor_id, detail, workspace_id FROM audit_events WHERE kind LIKE 'mount.%' ORDER BY id",
    )
    .all()
    .map((row) => ({
      kind: String(row.kind),
      actorId: String(row.actor_id),
      detail: JSON.parse(String(row.detail)) as unknown,
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    }));
}

function mountinfoLines(world: World): string[] {
  return readFileSync(world.mountinfo, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** A JSON body padded with whitespace to exactly `totalBytes`. */
function padded(totalBytes: number, fields: object): RawBody {
  const json = JSON.stringify(fields);
  const pad = totalBytes - Buffer.byteLength(json);
  return { raw: `${json.slice(0, -1)}${" ".repeat(pad)}}`, type: "application/json" };
}

describe("两种视图", () => {
  it("a symlinked path is stored as its realpath; a member sees exactly {id, name, readOnly}, the admin five keys, by name byte order", async () => {
    const rest = await openRest();
    const link = join(rest.world.base, "nfs-link");
    symlinkSync(rest.world.source, link);
    const created = await call(rest, "admin", "POST", URL, {
      name: "NFS 共享",
      path: link,
      readOnly: true,
    });
    expectAnswer(created, 201);
    const nfs = created.json() as { id: string; createdAt: number };
    expect(nfs).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      name: "NFS 共享",
      path: rest.world.source,
      readOnly: true,
      createdAt: expect.any(Number),
    });
    const cjk = await register(rest, "数据", dirOf(rest, "cjk"));
    const lower = await register(rest, "b", dirOf(rest, "lower"));

    const member = await call(rest, "member", "GET", URL);
    expectAnswer(member, 200, {
      sources: [
        { id: nfs.id, name: "NFS 共享", readOnly: true },
        { id: lower.id, name: "b", readOnly: false },
        { id: cjk.id, name: "数据", readOnly: false },
      ],
    });
    const admin = await call(rest, "admin", "GET", URL);
    expectAnswer(admin, 200);
    const sources = (admin.json() as { sources: Record<string, unknown>[] }).sources;
    expect(sources.map((source) => source.name)).toEqual(["NFS 共享", "b", "数据"]);
    for (const source of sources) {
      expect(Object.keys(source).sort()).toEqual(["createdAt", "id", "name", "path", "readOnly"]);
    }
    expect(sources[0]).toEqual(nfs);
    expect(sources[1]?.path).toBe(join(rest.world.base, "lower"));
    expectAnswer(await call(rest, "anonymous", "GET", URL), 401, UNAUTHORIZED);

    expect(mountAudits(rest)[0]).toEqual({
      kind: "mount.source.create",
      actorId: ADMIN_ID,
      detail: { sourceId: nfs.id, name: "NFS 共享", path: rest.world.source, readOnly: true },
      workspaceId: null,
    });
    expect(mountAudits(rest).map((row) => row.kind)).toEqual(Array(3).fill("mount.source.create"));
  });
});

describe("拒绝的路径", () => {
  it("the nine refused paths, a U+0000 path and an extra key are 400 with no row and no audit; a member's valid body is 403", async () => {
    const rest = await openRest();
    const { world } = rest;
    const file = join(world.base, "plain.txt");
    writeFileSync(file, "x");
    const refused = [
      "relative/dir",
      join(world.base, "missing"),
      file,
      world.sandbox,
      world.root,
      world.base,
      world.mountsDir,
      join(world.base, "web"),
      rest.ompBinDir,
      `${world.source}\u0000x`,
    ];
    for (const path of refused) {
      const response = await call(rest, "admin", "POST", URL, {
        name: "源",
        path,
        readOnly: false,
      });
      expectAnswer(response, 400, BAD_REQUEST);
    }
    const extra = { name: "源", path: world.source, readOnly: false, secretKeyName: 1 };
    const response = await call(rest, "admin", "POST", URL, extra);
    expectAnswer(response, 400, BAD_REQUEST);
    expect(response.body).not.toContain("secretKeyName");
    const member = { name: "源", path: world.source, readOnly: false };
    expectAnswer(await call(rest, "member", "POST", URL, member), 403, FORBIDDEN);
    expect(sourceRows(rest)).toEqual([]);
    expect(mountAudits(rest)).toEqual([]);
  });

  it("the 33rd source is 400; a taken name or realpath is 409 conflict (checked before the cap)", async () => {
    const rest = await openRest();
    const first = dirOf(rest, "many/d00");
    await register(rest, "s00", first);
    for (let index = 1; index < 32; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await register(rest, `s${suffix}`, dirOf(rest, `many/d${suffix}`));
    }
    const alias = join(rest.world.base, "alias");
    symlinkSync(first, alias);
    const sameName = { name: "s00", path: dirOf(rest, "fresh"), readOnly: false };
    expectAnswer(await call(rest, "admin", "POST", URL, sameName), 409, CONFLICT);
    const samePath = { name: "别名", path: alias, readOnly: false };
    expectAnswer(await call(rest, "admin", "POST", URL, samePath), 409, CONFLICT);
    const fresh = { name: "s32", path: dirOf(rest, "fresh"), readOnly: false };
    expectAnswer(await call(rest, "admin", "POST", URL, fresh), 400, BAD_REQUEST);
    expect(sourceRows(rest)).toHaveLength(32);
    expect(mountAudits(rest)).toHaveLength(32);
  });

  it("a source swapped for a symlink to SANDBOX_ROOT after registration: the local mount's due remount makes no mount call and stays offline", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openRest();
    const { world } = rest;
    const path = dirOf(rest, "swap-src");
    const source = await register(rest, "NAS", path);
    const manager = rest.app.mounts;
    const record = await manager.attach({
      workspaceId: W1,
      ownerId: OWNER,
      body: localOn(source.id, "本机"),
    });
    expect(world.mountCalls()).toHaveLength(1);
    process.kill(Number(world.mountCalls()[0]?.pid), "SIGKILL");
    await waitFor(() => manager.statusOf(record.id) === "offline");
    await waitFor(() => world.clock.pending().includes(5000));

    rmSync(path, { recursive: true });
    symlinkSync(world.sandbox, path);
    world.clock.fireNext();
    await waitFor(() => world.clock.pending().includes(10_000));
    await quiet();
    expect(world.mountCalls()).toHaveLength(1);
    expect(manager.statusOf(record.id)).toBe("offline");
  });
});

describe("删除连带卸载", () => {
  it("two accounts' local mounts on S: 204, both unmounted, rows and private dirs gone, two mount.detach and one mount.source.delete", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openRest();
    const { world } = rest;
    const source = await register(rest, "NAS", dirOf(rest, "nas"), true);
    const [mine, theirs] = await attachBoth(rest, source.id);
    const points = [join(world.rootOf(W1), "本机"), join(world.sandbox, "u2", "w4", "共享")];
    expect(mountinfoLines(world)).toHaveLength(2);
    const pids = world.mountCalls().map((entry) => entry.pid);

    const response = await call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    expectAnswer(response, 204);
    expect(response.body).toBe("");
    expect(deletingSources.has(source.id)).toBe(false);
    expectAnswer(await call(rest, "admin", "GET", URL), 200, { sources: [] });
    for (const id of [mine.id, theirs.id]) {
      expect(world.store.get(id)).toBeUndefined();
      expect(existsSync(world.privateDir(id))).toBe(false);
    }
    for (const point of points) {
      expect(existsSync(point)).toBe(false);
    }
    expect(mountinfoLines(world)).toEqual([]);
    expect(
      world
        .fusermountCalls()
        .map((entry) => entry.argv[1])
        .sort(),
    ).toEqual([...points].sort());
    expect(pids.filter(alive)).toEqual([]);

    const audits = mountAudits(rest).slice(1);
    const detaches = audits
      .slice(0, 2)
      .sort((a, b) => (a.workspaceId ?? "").localeCompare(b.workspaceId ?? ""));
    expect(detaches).toEqual([
      {
        kind: "mount.detach",
        actorId: ADMIN_ID,
        detail: { mountId: mine.id, name: "本机", reason: "source_deleted" },
        workspaceId: W1,
      },
      {
        kind: "mount.detach",
        actorId: ADMIN_ID,
        detail: { mountId: theirs.id, name: "共享", reason: "source_deleted" },
        workspaceId: W4,
      },
    ]);
    expect(audits.slice(2)).toEqual([
      {
        kind: "mount.source.delete",
        actorId: ADMIN_ID,
        detail: { sourceId: source.id, name: "NAS", path: join(world.base, "nas"), readOnly: true },
        workspaceId: null,
      },
    ]);
    expectAnswer(await call(rest, "admin", "DELETE", `${URL}/${source.id}`), 404, NOT_FOUND);
  });

  it("删除失败清标记: one cascaded row delete fails → generic 500, the source row stays, the mark is cleared; DELETE again 204", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openRest();
    const { world } = rest;
    const source = await register(rest, "NAS", dirOf(rest, "nas"));
    const [mine, theirs] = await attachBoth(rest, source.id);
    world.db.exec(
      `CREATE TRIGGER refuse_delete BEFORE DELETE ON workspace_mounts WHEN OLD.id = '${theirs.id}' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );

    const failed = await call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    expectAnswer(failed, 500, GENERIC_500);
    expect(deletingSources.has(source.id)).toBe(false);
    expect(sourceRows(rest)).toEqual([
      { id: source.id, name: "NAS", path: join(world.base, "nas") },
    ]);
    expect(world.store.get(mine.id)).toBeUndefined();
    expect(world.store.get(theirs.id)).toMatchObject({ id: theirs.id });
    expect(mountAudits(rest).map((row) => [row.kind, row.workspaceId])).toEqual([
      ["mount.source.create", null],
      ["mount.detach", W1],
    ]);

    world.db.exec("DROP TRIGGER refuse_delete");
    const again = await call(rest, "member", "POST", `/api/workspaces/${W1}/mounts`, {
      ...localOn(source.id, "再挂"),
    });
    expectAnswer(again, 201);
    const remounted = (again.json() as { id: string }).id;
    expectAnswer(await call(rest, "admin", "DELETE", `${URL}/${source.id}`), 204);
    expect(deletingSources.has(source.id)).toBe(false);
    expect(sourceRows(rest)).toEqual([]);
    expect(world.store.get(theirs.id)).toBeUndefined();
    expect(world.store.get(remounted)).toBeUndefined();
    const tail = mountAudits(rest).map((row) => [row.kind, row.workspaceId]);
    expect(tail.slice(0, 3)).toEqual([
      ["mount.source.create", null],
      ["mount.detach", W1],
      ["mount.attach", W1],
    ]);
    // The cascade's two detaches run on two chains at once: their order is not fixed.
    expect(
      tail
        .slice(3, 5)
        .map((pair) => pair.join(" "))
        .sort(),
    ).toEqual([`mount.detach ${W1}`, `mount.detach ${W4}`]);
    expect(tail.slice(5)).toEqual([["mount.source.delete", null]]);
  });
});

describe("删除中标记", () => {
  it("the source is marked before its cascade runs and unmarked once the DELETE ends", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openGated();
    const source = await register(rest, "NAS", dirOf(rest, "nas"));
    const [mine] = await attachBoth(rest, source.id);

    const pending = call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    await waitFor(() => rest.gates.length === 1);
    expect(deletingSources.has(source.id)).toBe(true);
    expect(rest.world.store.get(mine.id)).toMatchObject({ id: mine.id });
    rest.gates[0]?.();
    expectAnswer(await pending, 204);
    expect(deletingSources.has(source.id)).toBe(false);
    expect(sourceRows(rest)).toEqual([]);
  });

  it("two overlapping DELETEs: the first failing keeps the mark while the second still cascades; the second's 204 clears it", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openGated();
    const { world } = rest;
    const source = await register(rest, "NAS", dirOf(rest, "nas"));
    const [, theirs] = await attachBoth(rest, source.id);
    world.db.exec(
      `CREATE TRIGGER refuse_delete BEFORE DELETE ON workspace_mounts WHEN OLD.id = '${theirs.id}' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );

    const first = call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    await waitFor(() => rest.gates.length === 1);
    const second = call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    await waitFor(() => rest.gates.length === 2);
    rest.gates[0]?.();
    expectAnswer(await first, 500, GENERIC_500);
    expect(deletingSources.has(source.id)).toBe(true);

    world.db.exec("DROP TRIGGER refuse_delete");
    rest.gates[1]?.();
    expectAnswer(await second, 204);
    expect(deletingSources.has(source.id)).toBe(false);
    expect(sourceRows(rest)).toEqual([]);
    expect(world.store.get(theirs.id)).toBeUndefined();
  });
});

describe("删除挂载源与并发建出", () => {
  it("a local POST held at readiness, then the source's DELETE marks it: the POST is 404 (recheck in the insert transaction), DELETE 204, nothing left", {
    timeout: CASE_MS,
  }, async () => {
    const { held, probeExec } = heldReadiness();
    const rest = await openGated({ probeExec });
    const { world } = rest;
    const source = await register(rest, "NAS", dirOf(rest, "nas"));

    const posting = call(rest, "member", "POST", `/api/workspaces/${W1}/mounts`, {
      ...localOn(source.id, "本机"),
    });
    await waitFor(() => held.length === 1);
    expect(mountinfoLines(world)).toHaveLength(1);
    const deleting = call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    await waitFor(() => rest.gates.length === 1);
    expect(deletingSources.has(source.id)).toBe(true);

    held[0]?.();
    expectAnswer(await posting, 404, NOT_FOUND);
    rest.gates[0]?.();
    expectAnswer(await deleting, 204);

    expect(
      world.db.prepare("SELECT id FROM workspace_mounts WHERE source_id = ?").all(source.id),
    ).toEqual([]);
    expect(world.mountCalls()).toHaveLength(1);
    expect(
      world
        .mountCalls()
        .map((entry) => entry.pid)
        .filter(alive),
    ).toEqual([]);
    expect(mountinfoLines(world)).toEqual([]);
    expect(existsSync(join(world.rootOf(W1), "本机"))).toBe(false);
    expect(mountAudits(rest).map((row) => row.kind)).toEqual([
      "mount.source.create",
      "mount.source.delete",
    ]);
  });

  it("a local POST while the source is marked deleting is 404 at the sourceId step: no child", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openGated();
    const source = await register(rest, "NAS", dirOf(rest, "nas"));
    const deleting = call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    await waitFor(() => rest.gates.length === 1);
    const refused = await call(rest, "member", "POST", `/api/workspaces/${W1}/mounts`, {
      ...localOn(source.id, "本机"),
    });
    expectAnswer(refused, 404, NOT_FOUND);
    expect(rest.world.calls()).toEqual([]);
    rest.gates[0]?.();
    expectAnswer(await deleting, 204);
    expect(mountAudits(rest).map((row) => row.kind)).toEqual([
      "mount.source.create",
      "mount.source.delete",
    ]);
  });
});

describe("功能关闭", () => {
  it("GET, POST and DELETE work without RCLONE_BIN; the cascade follows the feature-off unmount rule", async () => {
    const rest = await openRest(true);
    const { world } = rest;
    const source = await register(rest, "NAS", dirOf(rest, "nas"));
    const mountId = world.store.newId();
    world.store.create({
      id: mountId,
      workspaceId: W1,
      ownerId: OWNER,
      body: localOn(source.id, "本机"),
    });
    mkdirSync(world.privateDir(mountId), { mode: 0o700 });
    expectAnswer(await call(rest, "member", "GET", URL), 200, {
      sources: [{ id: source.id, name: "NAS", readOnly: false }],
    });

    expectAnswer(await call(rest, "admin", "DELETE", `${URL}/${source.id}`), 204);
    expect(world.store.get(mountId)).toBeUndefined();
    expect(existsSync(world.privateDir(mountId))).toBe(false);
    expect(sourceRows(rest)).toEqual([]);
    expect(mountAudits(rest).map((row) => row.kind)).toEqual([
      "mount.source.create",
      "mount.detach",
      "mount.source.delete",
    ]);
    expect(world.calls()).toEqual([]);
  });

  it("an orphan still in mountinfo and no fusermount3 on PATH: 503 mount_disabled, mount and source kept, mark cleared", async () => {
    const rest = await openRest(true, true);
    const { world } = rest;
    const source = await register(rest, "NAS", dirOf(rest, "nas"));
    const mountId = world.store.newId();
    world.store.create({
      id: mountId,
      workspaceId: W1,
      ownerId: OWNER,
      body: localOn(source.id, "本机"),
    });
    writeFileSync(
      world.mountinfo,
      `77 1 0:7 / ${join(world.rootOf(W1), "本机")} rw - fuse.rclone m${mountId}:${source.path} rw\n`,
    );

    const refused = await call(rest, "admin", "DELETE", `${URL}/${source.id}`);
    expectAnswer(refused, 503, {
      error: { code: "mount_disabled", message: "服务器未启用远程挂载" },
    });
    expect(deletingSources.has(source.id)).toBe(false);
    expect(world.store.get(mountId)).toMatchObject({ id: mountId });
    expect(sourceRows(rest)).toHaveLength(1);
    expect(mountAudits(rest).map((row) => row.kind)).toEqual(["mount.source.create"]);
  });
});

describe("非管理员与未认证先于 body 与 id", () => {
  it("a member's POST and DELETE (unknown id, malformed body) are 403; anonymous 401; an admin's unknown id is 404", async () => {
    const rest = await openRest();
    const unknown = `${URL}/${"0".repeat(32)}`;
    for (const [method, url] of [
      ["POST", URL],
      ["DELETE", unknown],
    ] as const) {
      expectAnswer(await call(rest, "member", method, url, MALFORMED), 403, FORBIDDEN);
      expectAnswer(await call(rest, "member", method, url), 403, FORBIDDEN);
      expectAnswer(await call(rest, "anonymous", method, url, MALFORMED), 401, UNAUTHORIZED);
    }
    expectAnswer(await call(rest, "admin", "DELETE", unknown), 404, NOT_FOUND);
  });
});

describe("挂载的归属路由", () => {
  const BODIES: Array<[string, RawBody]> = [
    ["malformed JSON", MALFORMED],
    ["an empty JSON body", EMPTY_BODY],
    ["text/plain", TEXT],
  ];

  it.each(BODIES)("admin POST with %s → exact 400, no row and no audit", async (_label, body) => {
    const rest = await openRest();
    expectAnswer(await call(rest, "admin", "POST", URL, body), 400, BAD_REQUEST);
    expect(sourceRows(rest)).toEqual([]);
    expect(mountAudits(rest)).toEqual([]);
  });

  it("an otherwise valid body over 16 KiB → exact 400, no row and no audit (the route's limit, not the path rule)", async () => {
    const rest = await openRest();
    const fields = { name: "源", path: rest.world.source, readOnly: false };
    expectAnswer(
      await call(rest, "admin", "POST", URL, padded(KIB16 + 1, fields)),
      400,
      BAD_REQUEST,
    );
    expect(sourceRows(rest)).toEqual([]);
    expect(mountAudits(rest)).toEqual([]);
  });

  it("a body of exactly 16 KiB is parsed (the limit is the route's)", async () => {
    const rest = await openRest();
    const fields = { name: "源", path: rest.world.source, readOnly: false };
    expectAnswer(await call(rest, "admin", "POST", URL, padded(KIB16, fields)), 201);
  });

  it("admin DELETE with a malformed JSON body stays the generic 500 and deletes nothing", async () => {
    const rest = await openRest();
    const source = await register(rest, "NAS", rest.world.source);
    const url = `${URL}/${source.id}`;
    expectAnswer(await call(rest, "admin", "DELETE", url, MALFORMED), 500, GENERIC_500);
    expect(sourceRows(rest)).toHaveLength(1);
    expect(mountAudits(rest).map((row) => row.kind)).toEqual(["mount.source.create"]);
  });
});
