/**
 * The world of `mounts-file-endpoints*.test.ts` (s1b-workspace-mounts tasks 9.2 / 9.2b, #1696): createApp
 * on the `mounts-rest-helpers.ts` world with a real manager (fake rclone, fake `fusermount3`, fake
 * mountinfo, fake clock) injected as `assembly.mounts`. Online mounts are attached over HTTP (`POST
 * …/mounts`, a plain directory standing for the FUSE mount); offline ones are rows the registry loads at
 * construction and nothing brings up. The adapter's file system seam is the manager's `mountFs` option:
 * `createSeam` passes every call through to `fs/promises` and records it, and can make the calls under a
 * path hang for good (the fake FUSE) or report a stale size from `fstat` (#1665 P7).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as promises from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import type { MountFileHandle, MountFsImpl } from "../src/workspaces/mounts/fs.js";
import type { MountManagerOptions } from "../src/workspaces/mounts/manager.js";
import { OWNER, seedMount, sftp, W1, type World } from "./mounts-manager-helpers.js";
import {
  auditRows,
  type MountsRest,
  openMounts,
  postMount,
  send,
  sftpBody,
} from "./mounts-rest-helpers.js";

/** Ids of rows seeded offline: never handed out by the world store (ID1–ID3 are, in attach order). */
const OFFLINE_IDS = ["e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5", "f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6"];

interface SeamCall {
  op: "lstat" | "readdir" | "open" | "fstat" | "read" | "close" | "mkdir" | "rename";
  path: string;
}

export interface Seam {
  impl: MountFsImpl;
  calls: SeamCall[];
  /** From now on every call (or every call of `ops`) whose path is `prefix` or below it never settles. */
  hang(prefix: string, ops?: readonly SeamCall["op"][]): void;
  /** `fstat` of a handle opened at `path` reports `size` (the rest of the stats are the file's). */
  staleSize(path: string, size: number): void;
  /** The recorded calls at `prefix` or below it. */
  under(prefix: string): SeamCall[];
}

export const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

export function createSeam(): Seam {
  const calls: SeamCall[] = [];
  const hung: Array<{ prefix: string; ops: readonly SeamCall["op"][] | undefined }> = [];
  const stale = new Map<string, number>();
  const run = <T>(op: SeamCall["op"], path: string, act: () => Promise<T>): Promise<T> => {
    calls.push({ op, path });
    if (hung.some(({ prefix, ops }) => isUnder(path, prefix) && (ops?.includes(op) ?? true))) {
      return new Promise<T>(() => undefined);
    }
    return act();
  };
  const impl: MountFsImpl = {
    lstat: (path) => run("lstat", path, () => promises.lstat(path)),
    readdir: (path) => run("readdir", path, () => promises.readdir(path)),
    mkdir: (path) => run("mkdir", path, () => promises.mkdir(path)),
    rename: (from, to) => run("rename", from, () => promises.rename(from, to)),
    open: (path, flags) =>
      run("open", path, async () => {
        const handle = await promises.open(path, flags);
        const size = stale.get(path);
        const opened: MountFileHandle = {
          stat: () =>
            run("fstat", path, async () => {
              const stats = await handle.stat();
              return size === undefined ? stats : Object.assign(stats, { size });
            }),
          read: (buffer, offset, length, position) =>
            run("read", path, () => handle.read(buffer, offset, length, position)),
          close: () => run("close", path, () => handle.close()),
        };
        return opened;
      }),
  };
  return {
    impl,
    calls,
    hang: (prefix, ops) => {
      hung.push({ prefix, ops });
    },
    staleSize: (path, size) => {
      stale.set(path, size);
    },
    under: (prefix) => calls.filter((call) => isUnder(call.path, prefix)),
  };
}

interface FileWorldSetup {
  /** Attached over HTTP on W1, in this order (ids ID1, ID2, …). */
  online?: Array<{ name: string; readOnly?: boolean; remotePath?: string }>;
  /** Rows on W1 the registry loads `offline`; each mount point is made with a `sentinel.txt` in it. */
  offline?: string[];
  /** The manager without `rcloneBin` / `fusermountBin`. */
  featureOff?: boolean;
  overrides?: Partial<MountManagerOptions>;
}

export interface FileWorld {
  rest: MountsRest;
  world: World;
  /** W1's root. */
  root: string;
  point(name: string): string;
  idOf(name: string): string;
}

export const SENTINEL = "sentinel.txt";

export async function openFileWorld(setup: FileWorldSetup): Promise<FileWorld> {
  const offline = setup.offline ?? [];
  const ids = new Map<string, string>();
  const rest = await openMounts({
    ...(setup.featureOff === undefined ? {} : { featureOff: setup.featureOff }),
    ...(setup.overrides === undefined ? {} : { overrides: setup.overrides }),
    seed: (world) => {
      offline.forEach((name, index) => {
        const id = OFFLINE_IDS[index] as string;
        seedMount(world, { id, body: sftp("/srv/data", { name }), createdAt: 1 });
        ids.set(name, id);
        put(world.root, `${name}/${SENTINEL}`, "behind an offline mount\n");
      });
    },
  });
  for (const mount of setup.online ?? []) {
    const body = {
      ...sftpBody(mount.name, "files.intra", mount.remotePath ?? "/srv/data"),
      readOnly: mount.readOnly ?? false,
    };
    const created = await postMount(rest, W1, body);
    ids.set(mount.name, String(created.id));
  }
  const { world } = rest;
  return {
    rest,
    world,
    root: world.root,
    point: (name) => join(world.root, name),
    idOf: (name) => {
      const id = ids.get(name);
      if (id === undefined) {
        throw new Error(`no mount ${name}`);
      }
      return id;
    },
  };
}

/** Writes `bytes` at `path` under `dir`, making its parents. */
export function put(dir: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
}

export const q = (path: string): string => `path=${encodeURIComponent(path)}`;

/** zhangsan's request below `/api/workspaces/<workspace>/`. */
export function ask(
  fw: FileWorld,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  workspace = W1,
): Promise<LightMyRequestResponse> {
  return send(fw.rest, "member", method, `/api/workspaces/${workspace}/${url}`, body);
}

/** Status and error code (`""` below 400). */
export function outcome(response: LightMyRequestResponse): [number, string] {
  return [
    response.statusCode,
    response.statusCode >= 400 ? String(response.json().error.code) : "",
  ];
}

export const move = (from: string, to: string) => ({ from, to });
export const BOUNDARY: [number, string] = [409, "mount_boundary"];
export const OFFLINE: [number, string] = [409, "mount_offline"];
export const READ_ONLY: [number, string] = [403, "mount_read_only"];

/** The audit rows of the file operations (and the sandbox's), as `[kind, title]`. */
export function fileAudits(fw: FileWorld): Array<[string, string]> {
  const kinds = new Set([
    "file.delete",
    "file.move",
    "dir.create",
    "file.download",
    "sandbox.reject",
  ]);
  return auditRows(fw.world)
    .filter((row) => kinds.has(row.kind))
    .map((row) => [row.kind, row.title]);
}

/** The recycle batches of W1. */
export async function trashBatches(fw: FileWorld): Promise<string[]> {
  return promises
    .readdir(join(fw.world.sandbox, ".trash", OWNER, W1))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
}

/** `expect` on several requests in a row: their outcomes, labelled for the failure message. */
export async function expectOutcomes(
  fw: FileWorld,
  requests: Array<["GET" | "POST" | "DELETE", string, unknown?]>,
  expected: Array<[number, string]>,
): Promise<string[]> {
  const bodies: string[] = [];
  const got: Array<[string, number, string]> = [];
  for (const [method, url, body] of requests) {
    const response = await ask(fw, method, url, body);
    bodies.push(response.body);
    got.push([`${method} ${url} ${JSON.stringify(body ?? null)}`, ...outcome(response)]);
  }
  expect(got).toEqual(
    requests.map(([method, url, body], index) => [
      `${method} ${url} ${JSON.stringify(body ?? null)}`,
      ...(expected[index] as [number, string]),
    ]),
  );
  return bodies;
}
