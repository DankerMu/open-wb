/**
 * Issue #706 omp-runtime「OMP_STATE_DIR 托管布局」: the directory table, its correction on every
 * call, refusal of obstructed paths, a symlinked state root, and the env the real child receives.
 * Issue #802 adds the host-owned `home/.env` and the refusal of a state dir containing `:`.
 * Paths and modes below are written out from the spec table, not derived from the source module.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ompAgentDir as processAgentDir,
  ompSessionDir as processSessionDir,
  type SpawnImpl,
  spawnOmp,
} from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import {
  ensureOmpStateLayout,
  ompAgentDir,
  ompHome,
  ompSessionDir,
  ompTrashDir,
  ompXdgHome,
} from "../src/sessions/omp/state-layout.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import {
  expectHomeDotenv,
  expectLayout,
  LAYOUT_TABLE,
  seedLegacyAgentDir,
  sessionRow,
} from "./omp-layout-helpers.js";
import { recordedSpawn, type SpawnCall } from "./session-supervisor-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";
import { collectPrompt } from "./support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const OWNER = "u1";
const MODEL = "deepseek-v4.1-flash";
const SESSION_ROW = sessionRow(OWNER);
const TABLE = LAYOUT_TABLE;

const temps: string[] = [];
const fakeChildren: FakeChild[] = [];
const runtimes: SessionRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const runtime of runtimes.splice(0)) {
    await runtime.shutdown();
  }
  for (const child of fakeChildren.splice(0)) {
    child.destroy();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-layout-"));
  temps.push(root);
  return root;
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** spawnOmp with a recording spawnImpl that never starts a process; `calls` sees every attempt. */
async function spawnRecorded(
  root: string,
  stateDir: string,
  calls: SpawnCall[] = [],
): Promise<SpawnCall[]> {
  const recording: SpawnImpl = (command, args, options) => {
    calls.push(recordedSpawn(command, args, options));
    const child = new FakeChild();
    fakeChildren.push(child);
    return child.spawnImpl(command, args, options) as ChildProcessWithoutNullStreams;
  };
  await spawnOmp(
    {
      bin: join(root, "omp-bin"),
      sandboxRoot: join(root, "sandbox"),
      stateDir,
      ownerId: OWNER,
      cwd: join(root, "sandbox", OWNER),
      modelId: MODEL,
      token: "a".repeat(64),
      resumePath: null,
    },
    recording,
  );
  return calls;
}

describe("managed omp state layout paths", () => {
  it("places the agent dir under HOME/.omp and the XDG homes under xdg/", () => {
    expect(ompHome("/s")).toBe("/s/home");
    expect(ompAgentDir("/s")).toBe("/s/home/.omp/agent");
    expect(ompXdgHome("/s", "data")).toBe("/s/xdg/data");
    expect(ompXdgHome("/s", "state")).toBe("/s/xdg/state");
    expect(ompXdgHome("/s", "cache")).toBe("/s/xdg/cache");
    expect(ompSessionDir("/s", OWNER)).toBe("/s/sessions/u1");
    expect(ompTrashDir("/s")).toBe("/s/trash");
    // chat-sessions names process.ts as the exporter of these two.
    expect(processAgentDir).toBe(ompAgentDir);
    expect(processSessionDir).toBe(ompSessionDir);
  });
});

describe("ensureOmpStateLayout", () => {
  it("builds the cold layout at the table's exact modes, idempotently, without touching parents", async () => {
    const root = tempRoot();
    const state = join(root, "missing", "parents", "state");
    const parentMode = 0o777 & ~process.umask();

    expect(ensureOmpStateLayout(state)).toBe(realpathSync(state));
    expectLayout(state, TABLE);
    expect(modeOf(join(root, "missing"))).toBe(parentMode);
    expect(modeOf(join(root, "missing", "parents"))).toBe(parentMode);
    expect(readdirSync(state).toSorted()).toEqual(["home", "sessions", "trash", "xdg"]);
    expect(readdirSync(join(state, "home")).toSorted()).toEqual([".env", ".omp"]);
    expectHomeDotenv(state);
    expect(readdirSync(join(state, "sessions"))).toEqual([]);
    expect(readdirSync(join(state, "trash"))).toEqual([]);

    const calls = await spawnRecorded(root, state);
    expect(calls).toHaveLength(1);
    expectLayout(state, [...TABLE, SESSION_ROW]);

    ensureOmpStateLayout(state);
    await spawnRecorded(root, state);
    expectLayout(state, [...TABLE, SESSION_ROW]);
  });

  it("keeps a cold home closed to group and other until .omp and agent stand in it", () => {
    const state = join(tempRoot(), "state");
    const mkdir = fs.mkdirSync;
    const homeModeAt: Record<string, number> = {};
    vi.spyOn(fs, "mkdirSync").mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
      const path = String(args[0]);
      if (path.endsWith(join("home", ".omp")) || path.endsWith(join("home", ".omp", "agent"))) {
        homeModeAt[path.slice(path.indexOf(".omp"))] = modeOf(join(realpathSync(state), "home"));
      }
      return mkdir(...args);
    });
    syncBuiltinESMExports();

    ensureOmpStateLayout(state);

    expect(Object.keys(homeModeAt)).toEqual([".omp", join(".omp", "agent")]);
    for (const [created, mode] of Object.entries(homeModeAt)) {
      expect((mode & 0o077).toString(8), created).toBe("0");
    }
    expect(modeOf(join(state, "home"))).toBe(0o3770);
    expect(modeOf(join(state, "trash"))).toBe(0o700);
    expect(lstatSync(join(state, "trash")).uid).toBe(process.geteuid?.());
  });

  it("does not narrow an existing 3770 home on a repeated call: no chmod at all", () => {
    const state = join(tempRoot(), "state");
    ensureOmpStateLayout(state);
    const chmodSpy = vi.spyOn(fs, "chmodSync");
    syncBuiltinESMExports();

    ensureOmpStateLayout(state);

    expect(chmodSpy).not.toHaveBeenCalled();
    expectLayout(state, TABLE);
  });

  it("opens an existing home whose .omp is still missing without narrowing it first", () => {
    const state = join(tempRoot(), "state");
    ensureOmpStateLayout(state);
    rmSync(join(state, "home", ".omp"), { recursive: true });
    const chmodSpy = vi.spyOn(fs, "chmodSync");
    syncBuiltinESMExports();

    ensureOmpStateLayout(state);

    expect(chmodSpy.mock.calls.map(([path]) => path)).not.toContain(
      join(realpathSync(state), "home"),
    );
    expectLayout(state, TABLE);
  });

  it("corrects directories that were widened from outside", () => {
    const state = join(tempRoot(), "state");
    ensureOmpStateLayout(state);
    for (const widened of ["", "home/.omp/agent", "sessions", "home"]) {
      chmodSync(join(state, widened), 0o2770);
    }
    expect(modeOf(join(state, "home"))).toBe(0o2770);

    ensureOmpStateLayout(state);

    expectLayout(state, TABLE);
  });

  it("corrects a widened owner session dir on the next spawn", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    await spawnRecorded(root, state);
    chmodSync(join(state, "sessions", OWNER), 0o2777);
    chmodSync(join(state, "xdg", "data", "omp"), 0o777);

    await spawnRecorded(root, state);

    expectLayout(state, [...TABLE, SESSION_ROW]);
  });

  it("refuses a symlink at home/.omp and leaves its target alone", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(join(state, "home"), { recursive: true });
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o755);
    writeFileSync(join(elsewhere, "keep.txt"), "outside");
    symlinkSync(elsewhere, join(state, "home", ".omp"));
    const calls: SpawnCall[] = [];

    expect(() => ensureOmpStateLayout(state)).toThrow(join(realpathSync(state), "home", ".omp"));
    await expect(spawnRecorded(root, state, calls)).rejects.toThrow();

    expect(calls).toEqual([]);
    expect(modeOf(elsewhere)).toBe(0o755);
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
    expect(lstatSync(join(state, "home", ".omp")).isSymbolicLink()).toBe(true);
  });

  it("refuses a regular file at xdg and spawns nothing", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "xdg"), "not-a-directory");
    const calls: SpawnCall[] = [];

    expect(() => ensureOmpStateLayout(state)).toThrow(join(realpathSync(state), "xdg"));
    await expect(spawnRecorded(root, state, calls)).rejects.toThrow(
      join(realpathSync(state), "xdg"),
    );

    expect(calls).toEqual([]);
    expect(readFileSync(join(state, "xdg"), "utf8")).toBe("not-a-directory");
  });

  it("refuses a symlink at sessions/<ownerId> during spawn preparation and spawns nothing", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    const elsewhere = join(root, "elsewhere");
    ensureOmpStateLayout(state);
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(state, "sessions", OWNER));
    const calls: SpawnCall[] = [];

    await expect(spawnRecorded(root, state, calls)).rejects.toThrow(
      join(realpathSync(state), "sessions", OWNER),
    );

    expect(calls).toEqual([]);
    expect(modeOf(elsewhere)).toBe(0o755);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("applies the layout under the target of a symlinked state root and keeps the configured path in argv and env", async () => {
    const root = tempRoot();
    const target = join(root, "real state");
    const link = join(root, "state-link");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, link);

    expect(ensureOmpStateLayout(link)).toBe(realpathSync(target));
    const calls = await spawnRecorded(root, link);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expectLayout(target, [...TABLE, SESSION_ROW]);
    const call = calls[0];
    expect(call?.env.HOME).toBe(join(link, "home"));
    expect(call?.env.XDG_DATA_HOME).toBe(join(link, "xdg", "data"));
    expect(call?.args[call.args.indexOf("--session-dir") + 1]).toBe(join(link, "sessions", OWNER));
  });

  // #802 omp-runtime「状态目录路径含冒号」: PI_CONFIG_FILES is `:`-separated.
  it("refuses a state dir whose path contains a colon and creates nothing", async () => {
    const root = tempRoot();
    const state = join(root, "absent", "state:dir");
    const calls: SpawnCall[] = [];

    expect(() => ensureOmpStateLayout(state)).toThrow("OMP_STATE_DIR");
    await expect(spawnRecorded(root, state, calls)).rejects.toThrow("OMP_STATE_DIR");

    expect(calls).toEqual([]);
    expect(existsSync(join(root, "absent"))).toBe(false);
  });

  // #802 omp-runtime「home/.env 由宿主持有」.
  it("creates home/.env while a cold home is still closed to group and other", () => {
    const state = join(tempRoot(), "state");
    const open = fs.openSync;
    const homeModeAt: number[] = [];
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]).endsWith(join("home", ".env"))) {
        expect(existsSync(String(args[0]))).toBe(true);
        homeModeAt.push(modeOf(join(realpathSync(state), "home")));
      }
      return fd;
    });
    syncBuiltinESMExports();

    ensureOmpStateLayout(state);

    expect(homeModeAt.map((mode) => (mode & 0o077).toString(8))).toEqual(["0"]);
    expect(modeOf(join(state, "home"))).toBe(0o3770);
    expectHomeDotenv(state);
  });

  it("keeps the bytes of an existing home/.env and corrects its mode", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    ensureOmpStateLayout(state);
    const dotenv = join(state, "home", ".env");
    writeFileSync(dotenv, "OPERATOR_VAR=1\n");
    chmodSync(dotenv, 0o666);

    ensureOmpStateLayout(state);
    expectHomeDotenv(state, "OPERATOR_VAR=1\n");

    chmodSync(dotenv, 0o600);
    await spawnRecorded(root, state);
    expectHomeDotenv(state, "OPERATOR_VAR=1\n");
  });

  it("refuses a symlink at home/.env, leaves its target alone and spawns nothing", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    const target = join(root, "elsewhere.env");
    mkdirSync(join(state, "home"), { recursive: true });
    writeFileSync(target, "OUTSIDE=1\n");
    chmodSync(target, 0o644);
    symlinkSync(target, join(state, "home", ".env"));
    const calls: SpawnCall[] = [];

    expect(() => ensureOmpStateLayout(state)).toThrow(join(realpathSync(state), "home", ".env"));
    await expect(spawnRecorded(root, state, calls)).rejects.toThrow();

    expect(calls).toEqual([]);
    expect(modeOf(target)).toBe(0o644);
    expect(readFileSync(target, "utf8")).toBe("OUTSIDE=1\n");
    expect(lstatSync(join(state, "home", ".env")).isSymbolicLink()).toBe(true);
  });

  it("refuses a directory at home/.env and spawns nothing", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    mkdirSync(join(state, "home", ".env"), { recursive: true });
    chmodSync(join(state, "home", ".env"), 0o755);
    const calls: SpawnCall[] = [];

    expect(() => ensureOmpStateLayout(state)).toThrow(join(realpathSync(state), "home", ".env"));
    await expect(spawnRecorded(root, state, calls)).rejects.toThrow(
      join(realpathSync(state), "home", ".env"),
    );

    expect(calls).toEqual([]);
    expect(lstatSync(join(state, "home", ".env")).isDirectory()).toBe(true);
    expect(modeOf(join(state, "home", ".env"))).toBe(0o755);
  });

  it("neither reads nor writes a legacy <state>/agent directory", async () => {
    const root = tempRoot();
    const state = join(root, "state");
    const legacy = seedLegacyAgentDir(state);
    chmodSync(join(legacy, "models.yml"), 0o664);
    const before = {
      dir: lstatSync(legacy),
      models: lstatSync(join(legacy, "models.yml")),
      skill: lstatSync(join(legacy, "skills", "x", "SKILL.md")),
    };

    ensureOmpStateLayout(state);
    const calls = await spawnRecorded(root, state);

    expect(JSON.stringify(calls)).not.toContain(legacy);
    expect(readdirSync(legacy).toSorted()).toEqual(["models.yml", "skills"]);
    expect(readFileSync(join(legacy, "models.yml"), "utf8")).toBe("legacy-models");
    expect(lstatSync(legacy).mode).toBe(before.dir.mode);
    expect(lstatSync(join(legacy, "models.yml")).mode).toBe(before.models.mode);
    expect(lstatSync(join(legacy, "models.yml")).mtimeMs).toBe(before.models.mtimeMs);
    expect(lstatSync(join(legacy, "skills", "x", "SKILL.md")).mtimeMs).toBe(before.skill.mtimeMs);
    expect(readdirSync(join(state, "home", ".omp", "agent"))).toEqual([]);
  });
});

describe("spawned child environment under the managed layout", () => {
  it("gives the real child exactly the allowlist with HOME and the three XDG homes", async () => {
    const root = tempRoot();
    const state = join(root, "state dir");
    const sandbox = join(root, "sandbox");
    const writePath = join(root, "probe out.txt");
    const saved: Record<string, string | undefined> = {};
    const parent: Record<string, string> = {
      PI_CODING_AGENT_DIR: "/tmp/parent-agent-sentinel",
      XDG_DATA_HOME: "/tmp/parent-xdg-data-sentinel",
      XDG_CONFIG_HOME: "/tmp/parent-xdg-config-sentinel",
      MODEL_UPSTREAM_API_KEY: "upstream-api-key-sentinel",
      LANG: "C.UTF-8",
      TMPDIR: tmpdir(),
    };
    for (const [key, value] of Object.entries(parent)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    let report: string;
    try {
      const runtime = new SessionRuntime({
        sessionId: "sess-layout-env",
        bin: FAKE,
        sandboxRoot: sandbox,
        stateDir: state,
        ownerId: OWNER,
        cwd: join(sandbox, OWNER),
        modelId: MODEL,
        tokens: new TokenRegistry(),
      });
      runtimes.push(runtime);
      const frames = await collectPrompt(
        runtime.prompt(`probe:${String(process.pid)}:${writePath}`),
      );
      const update = frames.find((frame) => frame.type === "message_update");
      report = String((update?.assistantMessageEvent as { delta?: unknown } | undefined)?.delta);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    const keys = /(?:^| )env=(\S*) home=/u.exec(report)?.[1]?.split(",") ?? [];
    // macOS injects this key into every Node child; it is not part of the spawn env.
    expect(keys.filter((key) => key !== "__CF_USER_TEXT_ENCODING")).toEqual([
      "HOME",
      "LANG",
      "OMP_PROFILE",
      "PATH",
      "PI_CODING_AGENT_DIR",
      "PI_CONFIG_DIR",
      "PI_CONFIG_FILES",
      "PI_PROFILE",
      "TMPDIR",
      "WORKBUDDY_MODEL_TOKEN",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    expect(report).toContain(
      ` home=${join(state, "home")} xdgdata=${join(state, "xdg", "data")} xdgstate=${join(state, "xdg", "state")} xdgcache=${join(state, "xdg", "cache")} environ=`,
    );
    expect(report).toContain(" wrote=ok ");
    expect(existsSync(writePath)).toBe(true);
    expectLayout(state, [...TABLE, SESSION_ROW]);
  });
});
