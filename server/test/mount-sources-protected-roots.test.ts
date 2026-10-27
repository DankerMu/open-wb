/**
 * #1786 (owner option A, 2026-10-26; workspace-mounts「挂载源端点」scenario「拒绝的路径」): the protected roots
 * createApp assembles beyond the first five — the repo root, `dirname(BROWSER_BIN)` and `dirname(RCLONE_BIN)`
 * when configured, and the assembly's `extraProtectedRoots` (`PREVIEW_CACHE_DIR`, `OFFICE_SPOOL_DIR` when
 * configured, handed over by `workspaceAssemblyOf`). The seam is createApp building the manager itself (no
 * injected instance), so `POST /api/mount-sources` and the manager's pre-attempt re-check read the one list
 * createApp built. Every root is its own sibling directory of a tmp base outside the repo (the browser and
 * rclone executables live there, the rclone a copy of `fixtures/fake-rclone.mjs`), so each refusal is that
 * root's and no other's. An absent setting is left out of the list: the directory it would have named
 * registers. Oracles: the spec's root list, the tables, the fake rclone's call record.
 */
import { chmodSync, copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type AssemblyDependencies, createApp } from "../src/app.js";
import { appAssemblyOf, resolveServerConfig } from "../src/server.js";
import { BAD_REQUEST, call, expectAnswer } from "./models-rest-helpers.js";
import {
  createWorld,
  disposeWorlds,
  FAKE_RCLONE,
  local,
  SOURCE_ID,
  W1,
  type World,
} from "./mounts-manager-helpers.js";
import { MOUNT_FAILED } from "./mounts-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const CASE_MS = 30_000;
const SOURCES_URL = "/api/mount-sources";
/** The directory holding `server/` and `node_modules` (the same `../../` the app derives from `server/src`). */
const REPO_ROOT = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const CONTROL_ID = "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5";

interface Layout {
  world: World;
  browserBin: string;
  rcloneBin: string;
  previewCache: string;
  spool: string;
}

interface Rest extends Layout {
  app: FastifyInstance;
  cookies: { admin: string; member: string };
}

/** Which of the three optional sources of a root the assembly carries. */
interface Parts {
  browser: boolean;
  rclone: boolean;
  extra: boolean;
}

const FULL: Parts = { browser: true, rclone: true, extra: true };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  await disposeWorlds();
});

function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(`${outer}${sep}`);
}

/**
 * The world (`SANDBOX_ROOT` `<base>/sandbox`, `OMP_STATE_DIR` `<base>/state`, workspace W1 of u1) plus one
 * sibling directory per new root: `browser-bin/chrome`, `rclone-bin/rclone` (the fake, executable),
 * `preview-cache/`, `office-spool/`. The base must lie outside the repo and outside its parent, or the
 * repo-root refusal would cover the rest.
 */
function layout(): Layout {
  const world = createWorld();
  expect(within(world.base, dirname(REPO_ROOT))).toBe(false);
  expect(within(REPO_ROOT, world.base)).toBe(false);
  const browserBin = join(world.base, "browser-bin", "chrome");
  mkdirSync(dirname(browserBin));
  writeFileSync(browserBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const rcloneBin = join(world.base, "rclone-bin", "rclone");
  mkdirSync(dirname(rcloneBin));
  copyFileSync(FAKE_RCLONE, rcloneBin);
  chmodSync(rcloneBin, 0o755);
  const previewCache = join(world.base, "preview-cache");
  const spool = join(world.base, "office-spool");
  mkdirSync(previewCache);
  mkdirSync(spool);
  return { world, browserBin, rcloneBin, previewCache, spool };
}

/** createApp on the layout; the manager is the one it builds from `mountSettings`. */
async function open(parts: Parts, at: Layout = layout()): Promise<Rest> {
  const { world } = at;
  const assembly: AssemblyDependencies = {
    runtime: {
      bin: join(world.base, "omp-bin", "omp"),
      sandboxRoot: world.sandbox,
      stateDir: world.state,
      modelId: "m1",
      idleMs: 600_000,
      ...(parts.browser ? { browserBin: at.browserBin } : {}),
    },
    mountSettings: {
      ...(parts.rclone ? { rcloneBin: at.rcloneBin } : {}),
      mountMaxPerWorkspace: 2,
    },
    ...(parts.extra ? { extraProtectedRoots: [at.previewCache, at.spool] } : {}),
  };
  const app = createApp({ db: world.db, authRuntime: fixedRuntime(() => FIXED_NOW), assembly });
  apps.push(app);
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { ...at, app, cookies };
}

/** A fresh directory `<base>/<name>` outside every protected root. */
function dirOf(rest: Layout, name: string): string {
  const dir = join(rest.world.base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function count(rest: Rest, table: "mount_sources" | "audit_events"): number {
  const row = rest.world.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

async function expectRegistered(rest: Rest, name: string, path: string): Promise<void> {
  const response = await call(rest, "admin", "POST", SOURCES_URL, { name, path, readOnly: false });
  expectAnswer(response, 201);
  expect((response.json() as { path: string }).path).toBe(realpathSync(path));
}

/** A source row as a run before #1786 left it (registration then saw only the first five roots). */
function insertSource(rest: Rest, id: string, name: string, path: string): void {
  rest.world.db
    .prepare(
      "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, ?, ?, 0, 1)",
    )
    .run(id, name, path);
}

const REFUSED: [string, (rest: Rest) => string][] = [
  ["<repo root>/server", () => join(REPO_ROOT, "server")],
  ["the repo root's parent", () => dirname(REPO_ROOT)],
  ["a directory under PREVIEW_CACHE_DIR", (rest) => dirOf(rest, "preview-cache/shared")],
  ["OFFICE_SPOOL_DIR itself", (rest) => rest.spool],
  ["dirname(BROWSER_BIN)", (rest) => dirname(rest.browserBin)],
  ["dirname(RCLONE_BIN)", (rest) => dirname(rest.rcloneBin)],
];

describe("the five roots createApp adds (#1786)", () => {
  it.each(REFUSED)(
    "%s: 400, no row, no audit; a directory clear of every root still registers",
    async (_label, pathOf) => {
      const rest = await open(FULL);
      const response = await call(rest, "admin", "POST", SOURCES_URL, {
        name: "共享",
        path: pathOf(rest),
        readOnly: false,
      });
      expectAnswer(response, 400, BAD_REQUEST);
      expect(count(rest, "mount_sources")).toBe(0);
      expect(count(rest, "audit_events")).toBe(0);
      await expectRegistered(rest, "NAS", dirOf(rest, "sources/nas"));
    },
    CASE_MS,
  );
});

describe("an absent setting adds no root (no undefined, no empty string)", () => {
  it(
    "without BROWSER_BIN the browser's directory registers",
    async () => {
      const rest = await open({ ...FULL, browser: false });
      await expectRegistered(rest, "浏览器目录", dirname(rest.browserBin));
    },
    CASE_MS,
  );

  it(
    "without RCLONE_BIN (feature off) the endpoint works and the rclone directory registers",
    async () => {
      const rest = await open({ ...FULL, rclone: false });
      await expectRegistered(rest, "rclone 目录", dirname(rest.rcloneBin));
    },
    CASE_MS,
  );

  it(
    "without extraProtectedRoots the preview cache and spool directories register",
    async () => {
      const rest = await open({ ...FULL, extra: false });
      await expectRegistered(rest, "预览缓存", dirOf(rest, "preview-cache/shared"));
      await expectRegistered(rest, "spool", rest.spool);
    },
    CASE_MS,
  );
});

describe("appAssemblyOf(config): extraProtectedRoots from PREVIEW_CACHE_DIR and OFFICE_SPOOL_DIR", () => {
  it("is exactly [cache, spool] with OFFICE_SPOOL_DIR and exactly [cache] without", () => {
    const cache = "/srv/workbuddy/preview-cache";
    const spool = "/srv/workbuddy/office-spool";
    const withSpool = resolveServerConfig(
      { PREVIEW_CACHE_DIR: cache, OFFICE_SPOOL_DIR: spool },
      ENTRY,
    );
    expect(appAssemblyOf(withSpool).extraProtectedRoots).toEqual([cache, spool]);
    const without = resolveServerConfig({ PREVIEW_CACHE_DIR: cache }, ENTRY);
    expect(appAssemblyOf(without).extraProtectedRoots).toEqual([cache]);
  });
});

describe("upgrade: a source registered before #1786 inside a new root", () => {
  it(
    "the local mount's attempt fails 502 mount_failed with no rclone spawn; the source stays listed",
    async () => {
      const rest = await open(FULL);
      // `@exit1`: were the re-check to let it through, the fake would be spawned and fail fast.
      const legacy = dirOf(rest, "preview-cache/legacy@exit1");
      insertSource(rest, SOURCE_ID, "旧共享", legacy);
      const refused = await call(rest, "member", "POST", `/api/workspaces/${W1}/mounts`, local());
      expectAnswer(refused, 502, MOUNT_FAILED);
      expect(rest.world.calls()).toEqual([]);
      const listed = await call(rest, "admin", "GET", SOURCES_URL);
      expectAnswer(listed, 200);
      expect((listed.json() as { sources: { id: string; path: string }[] }).sources).toEqual([
        expect.objectContaining({ id: SOURCE_ID, path: legacy }),
      ]);

      // Control, same assembly: a source clear of every root reaches the copied fake rclone.
      insertSource(rest, CONTROL_ID, "对照", dirOf(rest, "sources/control@exit1"));
      const control = await call(rest, "member", "POST", `/api/workspaces/${W1}/mounts`, {
        ...local("对照"),
        sourceId: CONTROL_ID,
      });
      expectAnswer(control, 502, MOUNT_FAILED);
      expect(rest.world.mountCalls()).toHaveLength(1);
    },
    CASE_MS,
  );
});
