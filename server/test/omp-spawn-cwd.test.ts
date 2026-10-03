/**
 * Issue #513 spawn cwd: argv `--cwd` and the child's working directory are one value (required
 * since #521; the owner root is passed explicitly); only the owner root is created by spawn.
 */
import type { SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SpawnImpl, type SpawnOmpOpts, spawnOmp } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { sudoPrefix } from "./session-supervisor-helpers.js";
import { FakeChild } from "./support/omp-rpc.js";
import { createTokens } from "./support/omp-runtime.js";
import { useSetprivStub } from "./support/setpriv.js";

const OWNER = "u1";
const MODEL = "deepseek-v4.1-flash";
const TOKEN = "b".repeat(64);
const OMP_USER = "omp_user";

interface Roots {
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  ownerRoot: string;
  sessionDir: string;
  home: string;
  agent: string;
}

interface Recorded {
  command: string;
  args: string[];
  options: SpawnOptions;
  /** Directory existence observed at the moment spawnImpl ran. */
  present: Record<string, boolean>;
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoots(): Roots {
  const root = mkdtempSync(join(tmpdir(), "omp-spawn-cwd-"));
  temps.push(root);
  const sandboxRoot = join(root, "sandbox");
  const stateDir = join(root, "state");
  return {
    bin: join(root, "bin", "omp"),
    sandboxRoot,
    stateDir,
    ownerRoot: join(sandboxRoot, OWNER),
    sessionDir: join(stateDir, "sessions", OWNER),
    home: join(stateDir, "home"),
    agent: join(stateDir, "home", ".omp", "agent"),
  };
}

function ownDirs(roots: Roots): string[] {
  return [roots.ownerRoot, roots.sessionDir, roots.home, roots.agent];
}

/** Records command/args/options and never starts a real process. */
function recorder(watch: readonly string[]): { calls: Recorded[]; spawnImpl: SpawnImpl } {
  const calls: Recorded[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const present: Record<string, boolean> = {};
    for (const dir of watch) {
      present[dir] = existsSync(dir);
    }
    calls.push({ command, args: [...args], options, present });
    const fake = new FakeChild();
    return fake.spawnImpl(command, args, options);
  };
  return { calls, spawnImpl };
}

function spawnOpts(roots: Roots, cwd = roots.ownerRoot, ompUser?: string): SpawnOmpOpts {
  return {
    bin: roots.bin,
    sandboxRoot: roots.sandboxRoot,
    stateDir: roots.stateDir,
    ownerId: OWNER,
    modelId: MODEL,
    token: TOKEN,
    resumePath: null,
    cwd,
    ...(ompUser === undefined ? {} : { ompUser }),
  };
}

async function launch(
  roots: Roots,
  cwd?: string,
  watch: readonly string[] = [],
): Promise<Recorded> {
  const { calls, spawnImpl } = recorder([...ownDirs(roots), ...watch]);
  await spawnOmp(spawnOpts(roots, cwd), spawnImpl);
  expect(calls).toHaveLength(1);
  return calls[0] as Recorded;
}

/** The omp contract argv (independent of the implementation's assembly). */
function contractArgs(roots: Roots, cwd: string): string[] {
  return [
    "--mode",
    "rpc",
    "--cwd",
    cwd,
    "--session-dir",
    roots.sessionDir,
    "--model",
    `workbuddy/${MODEL}`,
    "--approval-mode",
    "write",
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
  ];
}

function cwdArg(args: readonly string[]): string | undefined {
  const at = args.indexOf("--cwd");
  return at === -1 ? undefined : args[at + 1];
}

function expectOwnDirsPresent(call: Recorded, roots: Roots): void {
  for (const dir of ownDirs(roots)) {
    expect(call.present[dir], dir).toBe(true);
  }
}

describe("spawnOmp cwd (direct)", () => {
  it("passes an explicit owner root as --cwd and the spawn cwd option with the exact contract argv", async () => {
    const roots = makeRoots();
    const call = await launch(roots, roots.ownerRoot);
    expect(call.command).toBe(roots.bin);
    expect(cwdArg(call.args)).toBe(roots.ownerRoot);
    expect(call.options.cwd).toBe(roots.ownerRoot);
    expect(call.args).toEqual(contractArgs(roots, roots.ownerRoot));
    expect(call.args).not.toContain("--resume");
  });

  it("uses an explicit existing cwd for both --cwd and the spawn cwd option, nothing else changes", async () => {
    const roots = makeRoots();
    const proj = join(roots.ownerRoot, "proj");
    mkdirSync(proj, { recursive: true });
    const base = await launch(roots);
    const call = await launch(roots, proj);
    expect(call.command).toBe(roots.bin);
    expect(cwdArg(call.args)).toBe(proj);
    expect(call.options.cwd).toBe(proj);
    expect(call.args).toEqual(contractArgs(roots, proj));
    const at = base.args.indexOf("--cwd") + 1;
    expect(call.args.filter((_, i) => i !== at)).toEqual(base.args.filter((_, i) => i !== at));
    expect(call.options.env).toEqual(base.options.env);
    expect(call.options.stdio).toEqual(base.options.stdio);
    expect(call.options.shell).toBe(false);
  });

  it("creates a missing owner root and the three state dirs for an explicit owner root cwd", async () => {
    const roots = makeRoots();
    expect(existsSync(roots.ownerRoot)).toBe(false);
    const call = await launch(roots, roots.ownerRoot);
    expectOwnDirsPresent(call, roots);
  });

  it("creates a missing owner root when cwd is the owner root spelled with a trailing slash", async () => {
    const roots = makeRoots();
    const spelled = `${roots.ownerRoot}/`;
    expect(existsSync(roots.ownerRoot)).toBe(false);
    const call = await launch(roots, spelled);
    expectOwnDirsPresent(call, roots);
    expect(cwdArg(call.args)).toBe(spelled);
    expect(call.options.cwd).toBe(spelled);
  });

  it("creates the normalized owner root for `<ownerRoot>/proj/..` without creating proj", async () => {
    const roots = makeRoots();
    const proj = join(roots.ownerRoot, "proj");
    const spelled = `${roots.ownerRoot}/proj/..`;
    expect(existsSync(roots.ownerRoot)).toBe(false);
    const call = await launch(roots, spelled, [proj]);
    expectOwnDirsPresent(call, roots);
    expect(call.present[proj]).toBe(false);
    expect(existsSync(proj)).toBe(false);
    expect(cwdArg(call.args)).toBe(spelled);
    expect(call.options.cwd).toBe(spelled);
  });

  it("never creates a missing non-owner-root cwd nor the absent owner root", async () => {
    const roots = makeRoots();
    const missing = join(roots.ownerRoot, "missing");
    const { calls, spawnImpl } = recorder([...ownDirs(roots), missing]);
    await spawnOmp(spawnOpts(roots, missing), spawnImpl);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Recorded;
    expect(call.options.cwd).toBe(missing);
    expect(cwdArg(call.args)).toBe(missing);
    expect(call.present[missing]).toBe(false);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(roots.ownerRoot)).toBe(false);
    for (const dir of [roots.sessionDir, roots.home, roots.agent]) {
      expect(call.present[dir], dir).toBe(true);
    }
  });
});

describe("spawnOmp cwd (sudo)", () => {
  useSetprivStub();
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
  });

  it("keeps --cwd in the omp argument segment after bin and sets the spawn cwd to the same value", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const roots = makeRoots();
    const proj = join(roots.ownerRoot, "proj");
    mkdirSync(proj, { recursive: true });
    const { calls, spawnImpl } = recorder(ownDirs(roots));
    await spawnOmp(spawnOpts(roots, proj, OMP_USER), spawnImpl);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Recorded;
    expect(call.command).toBe("sudo");
    const at = call.args.indexOf(roots.bin);
    expect(at).toBeGreaterThan(0);
    expect(call.args.slice(0, at + 1)).toEqual(sudoPrefix(OMP_USER, roots.bin, process.env.TMPDIR));
    expect(call.args.slice(at + 1)).toEqual(contractArgs(roots, proj));
    expect(call.options.cwd).toBe(proj);
  });
});

describe("SessionRuntime cwd wiring", () => {
  async function firstSpawn(roots: Roots, cwd = roots.ownerRoot): Promise<Recorded> {
    const calls: Recorded[] = [];
    let recorded: (call: Recorded) => void = () => {};
    const first = new Promise<Recorded>((resolve) => {
      recorded = resolve;
    });
    const fake = new FakeChild();
    const spawnImpl: SpawnImpl = (c, a, o) => {
      const call = { command: c, args: [...a], options: o, present: {} };
      calls.push(call);
      recorded(call);
      const child = fake.spawnImpl(c, a, o);
      fake.stdin.once("finish", () => {
        fake.destroy();
      });
      return child;
    };
    const runtime = new SessionRuntime({
      sessionId: "s-cwd",
      bin: roots.bin,
      sandboxRoot: roots.sandboxRoot,
      stateDir: roots.stateDir,
      ownerId: OWNER,
      modelId: MODEL,
      tokens: createTokens("cwd"),
      spawnImpl,
      handshakeTimeoutMs: 60_000,
      cwd,
    });
    const stream = runtime.prompt("hello");
    stream.dispatched.catch(() => {});
    const call = await first;
    await runtime.shutdown();
    expect(calls).toHaveLength(1);
    return call;
  }

  it("passes an explicit cwd through to the spawned omp", async () => {
    const roots = makeRoots();
    const proj = join(roots.ownerRoot, "proj");
    mkdirSync(proj, { recursive: true });
    const call = await firstSpawn(roots, proj);
    expect(cwdArg(call.args)).toBe(proj);
    expect(call.options.cwd).toBe(proj);
  });
});
