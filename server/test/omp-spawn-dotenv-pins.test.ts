/**
 * Issue #802 omp-runtime「子进程 spawn 契约」/「工作目录 dotenv 钉住」: the five variables that decide
 * where omp reads its managed configuration are set explicitly on every spawn, so a `.env` that omp
 * loads cannot supply them. Key set, literal values and the sudo prefix are written out from the
 * spec, not derived from `src/sessions/omp/process.ts`.
 */
import type { SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SpawnImpl, spawnOmp } from "../src/sessions/omp/process.js";
import { ompHostOverlayPath } from "../src/sessions/omp/state-layout.js";
import { FakeChild } from "./support/omp-rpc.js";
import { useSetprivStub } from "./support/setpriv.js";

const OWNER = "u1";
const TOKEN = "c".repeat(64);
/** What a parent environment (or an inherited dotenv) could carry; none of it may reach the child. */
const PARENT: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TMPDIR: "/tmp/pins tmp",
  PI_CODING_AGENT_DIR: "/tmp/parent-agent-sentinel",
  PI_CONFIG_FILES: "/tmp/parent-overlay-sentinel.yml",
  OMP_CONFIG_FILES: "/tmp/parent-omp-overlay-sentinel.yml",
  PI_CONFIG_DIR: "parent-config-dir-sentinel",
  OMP_PROFILE: "parentprofile",
  PI_PROFILE: "parentlegacyprofile",
};

interface Captured {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stateDir: string;
  bin: string;
}

const temps: string[] = [];
useSetprivStub();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function capture(ompUser?: string): Promise<Captured> {
  const root = mkdtempSync(join(tmpdir(), "omp-dotenv-pins-"));
  temps.push(root);
  const stateDir = join(root, "state dir");
  const bin = join(root, "bin", "omp");
  for (const [key, value] of Object.entries(PARENT)) {
    vi.stubEnv(key, value);
  }
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return new FakeChild().spawnImpl(command, args, options);
  };
  await spawnOmp(
    {
      bin,
      sandboxRoot: join(root, "sandbox"),
      stateDir,
      ownerId: OWNER,
      cwd: join(root, "sandbox", OWNER),
      modelId: "deepseek-v4.1-flash",
      approvalMode: "write",
      token: TOKEN,
      resumePath: null,
      ...(ompUser === undefined ? {} : { ompUser }),
    },
    spawnImpl,
  );
  expect(calls).toHaveLength(1);
  const call = calls[0];
  return {
    command: String(call?.command),
    args: call?.args ?? [],
    env: call?.options.env ?? {},
    stateDir,
    bin,
  };
}

describe("spawnOmp dotenv pins", () => {
  it.each([undefined, "omp_user"])(
    "sets the closed env key set with the five pinned variables (ompUser %s)",
    async (ompUser) => {
      const { env, args, stateDir } = await capture(ompUser);

      expect(Object.keys(env).toSorted()).toEqual([
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
      expect(env.PI_CONFIG_DIR).toBe(".omp");
      expect(env.OMP_PROFILE).toBe("default");
      expect(env.PI_PROFILE).toBe("default");
      // omp compares the agent dir with `$HOME/.omp/agent` as strings; only equality keeps XDG on.
      expect(env.HOME).toBe(join(stateDir, "home"));
      expect(env.PI_CODING_AGENT_DIR).toBe(join(String(env.HOME), ".omp", "agent"));
      expect(env.PI_CODING_AGENT_DIR).toBe(`${stateDir}/home/.omp/agent`);
      expect(env.PI_CONFIG_FILES).toBe(`${stateDir}/home/.omp/agent/host-overlay.yml`);
      expect(env.PI_CONFIG_FILES).toBe(ompHostOverlayPath(stateDir));
      expect(env.PI_CONFIG_FILES).toBe(args[args.indexOf("--config") + 1]);
      expect(env.XDG_DATA_HOME).toBe(join(stateDir, "xdg", "data"));
      expect(env.WORKBUDDY_MODEL_TOKEN).toBe(TOKEN);
      for (const sentinel of Object.values(PARENT).filter((value) => value.includes("sentinel"))) {
        expect(JSON.stringify([env, args])).not.toContain(sentinel);
      }
      expect(JSON.stringify([env, args])).not.toContain("parentprofile");
      expect(JSON.stringify([env, args])).not.toContain("parentlegacyprofile");
    },
  );

  it("names the five variables in the sudo --preserve-env list, in the contract's order", async () => {
    const { command, args, bin } = await capture("omp_user");

    expect(command).toBe("sudo");
    expect(args.slice(0, args.indexOf(bin) + 1)).toEqual([
      "-n",
      "-u",
      "omp_user",
      "--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN",
      "TMPDIR=/tmp/pins tmp",
      "--",
      "/usr/bin/setpriv",
      "--pdeathsig",
      "KILL",
      "--",
      bin,
    ]);
  });

  it("leaves argv untouched: --config stays the last option of a cold spawn", async () => {
    const { command, args, stateDir, bin } = await capture();

    expect(command).toBe(bin);
    expect(args.slice(-3)).toEqual([
      "--no-title",
      "--config",
      `${stateDir}/home/.omp/agent/host-overlay.yml`,
    ]);
    expect(args.some((arg) => arg.startsWith("PI_") || arg.startsWith("OMP_"))).toBe(false);
  });
});
