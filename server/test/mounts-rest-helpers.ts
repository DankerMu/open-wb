/**
 * The world of `mounts-rest*.test.ts` (s1b-workspace-mounts tasks 7.2, the mount part, #1690): createApp on
 * the `mounts-manager-helpers.ts` world's migrated `:memory:` database. Two ways to get the manager:
 *
 * - `openMounts` — `assembly.mounts` = a real manager on the fake rclone and fake `fusermount3` (fake
 *   mountinfo, test resolver, fake clock), whose `workspaceRootOf` reads the world DB as the workspace
 *   store does (so a temporary workspace promoted over HTTP is found);
 * - `openBuilt` — the manager createApp builds itself from `workspaceAssemblyOf(…).mountSettings` (the
 *   production wiring: system resolver, process PATH, `/proc/self/mountinfo`); only rejections that
 *   come before any resolution or spawn can be driven through it.
 *
 * Accounts of the seed: zhangsan (`member`, u1 = `OWNER`, owns W1–W3), lisi (`admin`, u3). Oracles: spec
 * literals (envelopes, views, audit titles and detail), the tables, the fake mountinfo, the fakes' call
 * records and the file system.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { workspaceAssemblyOf } from "../src/startup-registry.js";
import type { MountSettings } from "../src/workspaces/mounts/config.js";
import type { MountManagerOptions } from "../src/workspaces/mounts/manager.js";
import type { MountBody } from "../src/workspaces/mounts/validate.js";
import { call, type RawBody, type Who } from "./models-rest-helpers.js";
import {
  createWorld,
  KEY_SENTINEL,
  OWNER,
  obscured,
  PASS_SENTINEL,
  USER_SENTINEL,
  type World,
} from "./mounts-manager-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

export const CASE_MS = 30_000;
export const MOUNT_DISABLED = {
  error: { code: "mount_disabled", message: "服务器未启用远程挂载" },
};
export const MOUNT_FAILED = {
  error: { code: "mount_failed", message: "挂载失败，请检查主机、路径与凭证" },
};
export const MOUNT_LIMIT = {
  error: { code: "mount_limit", message: "挂载数已达上限" },
};
export const MOUNT_HOST_REJECTED = {
  error: { code: "mount_host_rejected", message: "该主机不允许挂载" },
};
/** The `MountView` key set (workspace-mounts「挂载端点」). */
export const VIEW_KEYS = [
  "backend",
  "createdAt",
  "host",
  "id",
  "name",
  "port",
  "readOnly",
  "remotePath",
  "sourceId",
  "sourceName",
  "status",
];
export const DOMAIN_SENTINEL = "domain-sentinel-1690";
/** Every credential string a response, audit row, log line or error must never carry. */
const SECRETS = [
  USER_SENTINEL,
  PASS_SENTINEL,
  KEY_SENTINEL,
  DOMAIN_SENTINEL,
  obscured(PASS_SENTINEL),
];

export interface MountsRest {
  world: World;
  app: FastifyInstance;
  cookies: { admin: string; member: string };
}

interface OpenOptions {
  /** The manager without `rcloneBin` / `fusermountBin` (RCLONE_BIN not configured). */
  featureOff?: boolean;
  /** No fake `fusermount3` on the manager's PATH. */
  noFusermount?: boolean;
  overrides?: Partial<MountManagerOptions>;
  /** `assembly.mountSettings` next to the injected manager (the routes read its three limits). */
  mountSettings?: MountSettings;
  /** Runs on the world before the manager is built (rows the registry loads). */
  seed?: (world: World) => void;
}

const apps: FastifyInstance[] = [];

/** For `afterEach`: closes every app (and so its manager) opened here. */
export async function closeApps(): Promise<void> {
  for (const app of apps.splice(0)) {
    await app.close();
  }
}

function runtimeOf(world: World) {
  return {
    bin: join(world.base, "omp-bin", "omp"),
    sandboxRoot: world.sandbox,
    stateDir: world.state,
    modelId: "m1",
    idleMs: 600_000,
  };
}

async function withCookies(world: World, app: FastifyInstance): Promise<MountsRest> {
  apps.push(app);
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { world, app, cookies };
}

/** The workspace store's `rootOf`, read from the world DB: `<sandbox>/<owner>/<dir>`. */
function rootFromDb(world: World) {
  return (ownerId: string, workspaceId: string): string | null => {
    const row = world.db
      .prepare("SELECT dir FROM workspaces WHERE id = ? AND owner_id = ?")
      .get(workspaceId, ownerId) as { dir: string } | undefined;
    return row === undefined ? null : join(world.sandbox, ownerId, row.dir);
  };
}

export async function openMounts(options: OpenOptions = {}): Promise<MountsRest> {
  const world = createWorld({ noFusermount: options.noFusermount ?? false });
  options.seed?.(world);
  const full = world.options({ workspaceRootOf: rootFromDb(world), ...options.overrides });
  const { rcloneBin: _rclone, fusermountBin: _fusermount, ...off } = full;
  const manager = world.build(options.featureOff ? (off as MountManagerOptions) : full);
  const app = createApp({
    db: world.db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: runtimeOf(world),
      mounts: manager,
      ...(options.mountSettings === undefined ? {} : { mountSettings: options.mountSettings }),
    },
  });
  return withCookies(world, app);
}

/** createApp builds the manager from `workspaceAssemblyOf`'s `mountSettings` (no injected instance). */
export async function openBuilt(settings: MountSettings): Promise<MountsRest> {
  const world = createWorld();
  const app = createApp({
    db: world.db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: runtimeOf(world),
      ...workspaceAssemblyOf({
        ...settings,
        sandboxRoot: world.sandbox,
        trashRetentionDays: 30,
        previewCacheDir: join(world.base, "preview-cache"),
      }),
    },
  });
  return withCookies(world, app);
}

export function mountsUrl(workspaceId: string, mountId?: string): string {
  return `/api/workspaces/${workspaceId}/mounts${mountId === undefined ? "" : `/${mountId}`}`;
}

export function send(
  rest: MountsRest,
  who: Who,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown | RawBody,
): Promise<LightMyRequestResponse> {
  return call(rest, who, method, url, body);
}

/** zhangsan's POST to `workspaceId`, expected `status`; returns the parsed body. */
export async function postMount(
  rest: MountsRest,
  workspaceId: string,
  body: unknown,
  status = 201,
): Promise<Record<string, unknown>> {
  const response = await send(rest, "member", "POST", mountsUrl(workspaceId), body);
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  return response.json() as Record<string, unknown>;
}

/** A temporary workspace of u1 (`tmp-<id>`), its root on disk. */
export function addTemporary(world: World, id: string): string {
  world.db
    .prepare(
      "INSERT INTO workspaces(id, owner_id, name, dir, created_at, temporary) VALUES (?, ?, ?, ?, 1, 1)",
    )
    .run(id, OWNER, `tmp-${id}`, `tmp-${id}`);
  const root = join(world.sandbox, OWNER, `tmp-${id}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** A mount-source row; returns its id. */
export function addSource(world: World, id: string, path: string, readOnly: boolean): string {
  world.db
    .prepare(
      "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, 'NAS', ?, ?, 1)",
    )
    .run(id, path, readOnly ? 1 : 0);
  return id;
}

export function mountRows(world: World): unknown[] {
  return world.db
    .prepare("SELECT id, workspace_id, name, source_id FROM workspace_mounts ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
}

/** Every audit row (any kind), oldest first. */
export function auditRows(world: World) {
  return world.db
    .prepare("SELECT kind, actor_id, workspace_id, title, detail FROM audit_events ORDER BY id")
    .all()
    .map((row) => ({
      kind: String(row.kind),
      actorId: String(row.actor_id),
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      title: Buffer.from(row.title as Uint8Array).toString("utf8"),
      detail: JSON.parse(String(row.detail)) as unknown,
    }));
}

export function mountinfoLines(world: World): string[] {
  return readFileSync(world.mountinfo, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** The private directories under `<state>/mounts`. */
export function privateDirs(world: World): string[] {
  return readdirSync(world.mountsDir);
}

/** A JSON body padded with whitespace to exactly `totalBytes`. */
export function padded(totalBytes: number, fields: object): RawBody {
  const json = JSON.stringify(fields);
  const pad = totalBytes - Buffer.byteLength(json);
  return { raw: `${json.slice(0, -1)}${" ".repeat(pad)}}`, type: "application/json" };
}

/** An `sftp` body with the user and password sentinels. */
export function sftpBody(name: string, host = "files.intra", remotePath = "/srv/data"): MountBody {
  return {
    name,
    backend: "sftp",
    host,
    remotePath,
    readOnly: false,
    username: USER_SENTINEL,
    password: PASS_SENTINEL,
  };
}

/** A fake mountinfo line for `mountPoint` of mount `mountId` (kernel format, no escapes needed). */
export function plantMountinfo(world: World, mountPoint: string, mountId: string): void {
  writeFileSync(
    world.mountinfo,
    `77 1 0:7 / ${mountPoint} rw - fuse.rclone m${mountId}:/srv/data rw\n`,
  );
}

export function expectNoSecret(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
}
