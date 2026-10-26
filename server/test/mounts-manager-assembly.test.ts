/**
 * s1b-workspace-mounts tasks 6.4 (#1688): where `createApp` gets its mount-manager (design D12 construction
 * priority) — the injected instance, one built from `mountSettings`, or a feature-off one — and that the
 * built one is wired as production needs: `mountsDir` = `<OMP_STATE_DIR>/mounts`, `workspaceRootOf` the
 * workspace root's realpath (a `SANDBOX_ROOT` reached through a symlink still mounts at the kernel path,
 * #1687 hand-off), `closeAll` on the app's close hook. The seam is `createApp` with the real-spawned fake
 * rclone (`fixtures/fake-rclone.mjs`, marker `@hang`: never ready); feature on/off is observed through
 * `attach` (`mount_disabled` vs. the owner check / a spawn). No `/dev/fuse` needed: readiness reads the
 * system mountinfo, which never names the fake's mount point, so the attempt waits until the close hook
 * cancels it. The settings' path from config through `workspaceAssemblyOf` and createApp into the manager
 * is pinned for `mountHostAllow` and `ompUid`; `fusermountBin` is not observable here (no mount this
 * run made ever shows up in the system mountinfo, so nothing is unmounted).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssemblyDependencies, createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { workspaceAssemblyOf } from "../src/startup-registry.js";
import {
  alive,
  createWorld,
  disposeWorlds,
  FAKE_RCLONE,
  local,
  OWNER,
  SOURCE_ID,
  sftp,
  W1,
  waitFor,
} from "./mounts-manager-helpers.js";

const CASE_MS = 20_000;
/** Feature on: the fake rclone (no `fusermount3` is needed — nothing this run mounted is in mountinfo). */
const SETTINGS = { rcloneBin: FAKE_RCLONE, mountMaxPerWorkspace: 2 };
const apps: FastifyInstance[] = [];
const dbs: DatabaseSync[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
  await disposeWorlds();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

interface Layout {
  db: DatabaseSync;
  /** The sandbox's real directory; `SANDBOX_ROOT` is a symlink to it. */
  sandboxReal: string;
  sandboxLink: string;
  state: string;
  runtime: NonNullable<AssemblyDependencies["runtime"]>;
}

/**
 * A file-system layout like the entry's after its layout stages: `<state>/mounts` (0700), the fake's
 * `<state>/fake-mountinfo`, workspace W1 of u1 on disk at `<sandbox>/u1/w1`, and a registered `local`
 * source `…/src@hang` outside every protected root.
 */
function layout(): Layout {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mounts-assembly-")));
  scratch.push(base);
  const sandboxReal = join(base, "sandbox-real");
  const sandboxLink = join(base, "sandbox");
  mkdirSync(join(sandboxReal, OWNER, "w1"), { recursive: true });
  symlinkSync(sandboxReal, sandboxLink);
  const state = join(base, "state");
  mkdirSync(join(state, "mounts"), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "fake-mountinfo"), "");
  const source = join(base, "sources", "src@hang");
  mkdirSync(source, { recursive: true });
  const db = openDb(":memory:");
  dbs.push(db);
  db.prepare(
    "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, 'w1', 'w1', 1)",
  ).run(W1, OWNER);
  db.prepare(
    "INSERT INTO mount_sources(id, name, path, read_only, created_at) VALUES (?, 'NAS', ?, 0, 1)",
  ).run(SOURCE_ID, source);
  const runtime = {
    bin: join(base, "omp-bin", "omp"),
    sandboxRoot: sandboxLink,
    stateDir: state,
    modelId: "m",
    idleMs: 60_000,
  };
  return { db, sandboxReal, sandboxLink, state, runtime };
}

/** Closes once: a second `close()` of a Fastify instance is not a no-op. */
async function closeApp(app: FastifyInstance): Promise<void> {
  const index = apps.indexOf(app);
  if (index !== -1) {
    apps.splice(index, 1);
  }
  await app.close();
}

function appOf(db: DatabaseSync, assembly: AssemblyDependencies): FastifyInstance {
  const app = createApp({ db, assembly });
  apps.push(app);
  return app;
}

/** The fake rclone's `mount` calls, recorded under `<state>` (its `HOME` is `<state>/mounts/<id>`). */
function mountCalls(state: string): { argv: string[]; pid: number }[] {
  const file = join(state, "fake-rclone-calls.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
        .filter((call) => call.argv[1] === "mount")
    : [];
}

describe("createApp mount-manager sources (design D12)", () => {
  it(
    "uses a given mounts instance, builds one from mountSettings alone, and is feature-off with neither",
    async () => {
      // Instance given: that object is `app.mounts` (mountSettings is then ignored), and closing the
      // app runs its closeAll.
      const world = createWorld();
      const instance = world.manager();
      const closeAll = vi.spyOn(instance, "closeAll");
      const given = layout();
      const injected = appOf(given.db, {
        runtime: given.runtime,
        mounts: instance,
        mountSettings: SETTINGS,
      });
      expect(injected.mounts).toBe(instance);
      await closeApp(injected);
      expect(closeAll).toHaveBeenCalledTimes(1);

      // Neither: a feature-off manager. Attach refuses before any owner check, restore spawns nothing.
      const off = layout();
      const bare = appOf(off.db, { runtime: off.runtime });
      await bare.mounts.restoreAll();
      expect(
        await codeOf(bare.mounts.attach({ workspaceId: W1, ownerId: OWNER, body: local() })),
      ).toBe("mount_disabled");
      expect(mountCalls(off.state)).toEqual([]);

      // mountSettings alone: enabled per the settings. A foreign workspace reaches the owner check
      // (404, not 503); a real attach spawns the configured rclone with `HOME` under
      // `<OMP_STATE_DIR>/mounts` and the mount point under the sandbox's REALPATH, never the symlink.
      const on = layout();
      const built = appOf(on.db, {
        runtime: on.runtime,
        mountSettings: SETTINGS,
      });
      expect(
        await codeOf(built.mounts.attach({ workspaceId: W1, ownerId: "u2", body: local() })),
      ).toBe("not_found");
      const attaching = built.mounts.attach({ workspaceId: W1, ownerId: OWNER, body: local() });
      const refused = codeOf(attaching);
      await waitFor(() => mountCalls(on.state).length === 1);
      const [call] = mountCalls(on.state);
      expect(call?.argv[3]).toBe(join(on.sandboxReal, OWNER, "w1", "本机"));
      expect(call?.argv).not.toContain(join(on.sandboxLink, OWNER, "w1", "本机"));
      expect(alive(call?.pid ?? 0)).toBe(true);
      // The close hook's closeAll cancels the attempt still waiting for readiness: rclone is gone.
      await closeApp(built);
      expect(await refused).toBe("mount_failed");
      expect(alive(call?.pid ?? 0)).toBe(false);
      expect(on.db.prepare("SELECT count(*) AS n FROM workspace_mounts").get()).toEqual({ n: 0 });
    },
    CASE_MS,
  );
});

describe("config → workspaceAssemblyOf → createApp: the manager's settings arrive (#1688)", () => {
  it(
    "MOUNT_HOST_ALLOW refuses an off-list host with no spawn; the omp uid reaches rclone's --uid",
    async () => {
      const at = layout();
      const ompUid = 4242;
      const { mountSettings } = workspaceAssemblyOf({
        sandboxRoot: at.sandboxLink,
        trashRetentionDays: 30,
        rcloneBin: FAKE_RCLONE,
        ompUid,
        mountHostAllow: ["files.intra"],
        mountMaxPerWorkspace: 2,
      });
      const app = appOf(at.db, { runtime: at.runtime, mountSettings });

      // An IP literal off the allow-list: refused before any lookup or spawn. Were the list lost on the
      // way, the literal would be allowed and the fake's `@exit1` would make it a fast mount_failed.
      const offList = sftp("/srv/data@exit1", { host: "10.0.0.9" });
      expect(
        await codeOf(app.mounts.attach({ workspaceId: W1, ownerId: OWNER, body: offList })),
      ).toBe("mount_host_rejected");
      expect(mountCalls(at.state)).toEqual([]);
      expect(existsSync(join(at.state, "fake-rclone-calls.jsonl"))).toBe(false);

      // OMP_USER mode: the sharing flags carry the configured uid.
      const refused = codeOf(app.mounts.attach({ workspaceId: W1, ownerId: OWNER, body: local() }));
      await waitFor(() => mountCalls(at.state).length === 1);
      const argv = mountCalls(at.state)[0]?.argv ?? [];
      expect(argv.slice(argv.indexOf("--uid"), argv.indexOf("--uid") + 2)).toEqual([
        "--uid",
        String(ompUid),
      ]);
      await closeApp(app);
      expect(await refused).toBe("mount_failed");
    },
    CASE_MS,
  );
});
