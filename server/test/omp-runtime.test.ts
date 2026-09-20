/**
 * Issue #96 SessionRuntime real-child lifecycle.
 * Independent oracles: Node child_process exit/signal vs injected clock, frozen rpc.md.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentUnavailableError,
  type OmpExit,
  type SpawnImpl,
} from "../src/sessions/omp/process.js";
import {
  SessionBusyError,
  SessionRuntime,
  type SessionRuntimeOpts,
} from "../src/sessions/omp/runtime.js";
import { createRpcHarness, DEFAULT_SESSION, hasTerminated } from "./support/omp-rpc.js";
import {
  collectPrompt,
  collectUntilError,
  createClock,
  createTokens,
  type TestClock,
  type TokenBook,
} from "./support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const SESSION_ID = "sess-runtime-96";
const TOKEN_PREFIX = "wb-issue96-secret-token";
const IDLE_MS = 10_000;
const harness = createRpcHarness();

describe("SessionRuntime lazy reuse and resume", () => {
  it("does not spawn or issue a token until the first prompt", async () => {
    const world = openWorld();
    expect(world.tokens.issued).toEqual([]);
    expect(world.spawns).toBe(0);
    await world.runtime.shutdown();
    expect(world.spawns).toBe(0);
    expect(world.tokens.issued).toEqual([]);
    expect(world.tokens.revoked).toEqual([]);
  });

  it("reuses one child for two completed prompts and yields the ordered terminal stream", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld();
    const first = await collectPrompt(world.runtime.prompt("first"));
    const second = await collectPrompt(world.runtime.prompt("second"));
    expect(world.spawns).toBe(1);
    expect(world.tokens.issued).toHaveLength(1);
    expect(world.tokens.revoked).toEqual([]);
    expect(world.runtime.sessionFile).toBe(DEFAULT_SESSION);
    expect(resumeOf(world.calls[0]?.args)).toBeUndefined();
    expect(first.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
      true,
    );
    expect(second.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
      true,
    );
    expect(
      first.findIndex((frame) => frame.type === "response" && frame.command === "prompt"),
    ).toBeLessThan(first.findIndex((frame) => frame.type === "agent_end"));
    expect(world.exits).toEqual([]);
  });

  it("resets idle on a new prompt and resumes with the last sessionFile after expiry", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld();
    await collectPrompt(world.runtime.prompt("keep-alive"));
    const child = world.children[0];
    if (child === undefined) {
      throw new Error("missing child");
    }
    world.clock.advance(IDLE_MS - 1);
    await waitImmediate();
    expect(hasTerminated(child)).toBe(false);
    await collectPrompt(world.runtime.prompt("reset-idle"));
    expect(world.spawns).toBe(1);
    world.clock.advance(IDLE_MS);
    await world.observed[0]?.exit;
    expect(hasTerminated(child)).toBe(true);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(world.tokens.revoked).toEqual(world.tokens.issued);
    const next = await collectPrompt(world.runtime.prompt("after-idle"));
    expect(world.spawns).toBe(2);
    expect(resumeOf(world.calls[1]?.args)).toBe(DEFAULT_SESSION);
    expect(world.tokens.issued).toHaveLength(2);
    expect(next.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
      true,
    );
  });

  it("uses the constructor resume path on first spawn and keeps it after a failed start", {
    timeout: 15_000,
  }, async () => {
    const persisted = "/tmp/open-wb-persisted-session.jsonl";
    const world = openWorld({ resumePath: persisted, scenario: "missing-session" });
    const failed = await collectUntilError(world.runtime.prompt("boot"));
    expect(failed.error).toBeInstanceOf(AgentUnavailableError);
    expect(world.spawns).toBe(1);
    expect(resumeOf(world.calls[0]?.args)).toBe(persisted);
    expect(world.runtime.sessionFile).toBe(persisted);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    world.scenario = "new-session";
    const recovered = await collectPrompt(world.runtime.prompt("retry"));
    expect(world.spawns).toBe(2);
    expect(resumeOf(world.calls[1]?.args)).toBe(persisted);
    expect(recovered.some((frame) => frame.type === "agent_end")).toBe(true);
    expect(world.runtime.sessionFile).toBe("/tmp/open-wb-new-session.jsonl");
  });

  it("omits --resume for a cold start and after omitted or null resumePath", {
    timeout: 15_000,
  }, async () => {
    for (const resumePath of [undefined, null] as const) {
      const world = openWorld(resumePath === undefined ? {} : { resumePath });
      await collectPrompt(world.runtime.prompt("cold"));
      expect(resumeOf(world.calls[0]?.args)).toBeUndefined();
      await world.runtime.shutdown();
    }
  });
});

describe("SessionRuntime crash, overlap and shutdown", () => {
  it("fails the active turn on crash, reports the original exit once, then resumes", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ scenario: "crash" });
    const crashed = await collectUntilError(world.runtime.prompt("crash"));
    expect(crashed.frames.length).toBeGreaterThan(0);
    expect(crashed.error).toBeInstanceOf(AgentUnavailableError);
    expect(world.exits).toEqual([{ code: 2, signal: null }]);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    const observed = world.observed[0];
    if (observed === undefined) {
      throw new Error("missing crash observer");
    }
    await observed.exit;
    expect(observed.exits).toEqual([{ code: 2, signal: null }]);
    world.scenario = undefined;
    const recovered = await collectPrompt(world.runtime.prompt("resume"));
    expect(world.spawns).toBe(2);
    expect(resumeOf(world.calls[1]?.args)).toBe(DEFAULT_SESSION);
    expect(
      recovered.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false),
    ).toBe(true);
    expect(world.exits).toHaveLength(1);
  });

  it("rejects overlapping prompts without a second child and reclaims on abandon", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ scenario: "hang-prompt" });
    const first = world.runtime.prompt("busy");
    await world.waitSpawn();
    await first[Symbol.asyncIterator]().next();
    expect(() => world.runtime.prompt("overlap")).toThrow(SessionBusyError);
    expect(world.spawns).toBe(1);

    const iterator = first[Symbol.asyncIterator]();
    const cancel = iterator.return;
    if (cancel === undefined) {
      throw new Error("async iterator return is required for cancellation");
    }
    await cancel.call(iterator);
    const child = world.children[0];
    if (child === undefined) {
      throw new Error("missing abandoned child");
    }
    world.clock.advance(8_000);
    await world.observed[0]?.exit;
    expect(hasTerminated(child)).toBe(true);
    world.scenario = undefined;
    const next = await collectPrompt(world.runtime.prompt("after-abandon"));
    expect(world.spawns).toBe(2);
    expect(next.some((frame) => frame.type === "agent_end")).toBe(true);
  });

  it("closes stdin on shutdown and observes EOF exit without signaling", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld();
    await collectPrompt(world.runtime.prompt("idle-exit"));
    const observed = world.observed[0];
    if (observed === undefined) {
      throw new Error("missing eof observer");
    }
    const shutting = world.runtime.shutdown();
    await observed.exit;
    await shutting;
    expect(observed.signals).toEqual([]);
    expect(observed.exits[0]?.code).toBe(0);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(() => world.runtime.prompt("after-shutdown")).toThrow(AgentUnavailableError);
    await world.runtime.shutdown();
  });

  it("sends TERM at 5000ms when EOF is ignored and not before", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ scenario: "hang-eof" });
    await collectPrompt(world.runtime.prompt("hang-eof"));
    const observed = world.observed[0];
    const child = world.children[0];
    if (observed === undefined || child === undefined) {
      throw new Error("missing hang-eof child");
    }
    const shutting = world.runtime.shutdown();
    world.clock.advance(4_999);
    await waitImmediate();
    expect(observed.signals).toEqual([]);
    expect(hasTerminated(child)).toBe(false);
    world.clock.advance(1);
    await observed.exit;
    await shutting;
    expect(observed.signals).toEqual(["SIGTERM"]);
    expect(observed.exits[0]?.signal).toBe("SIGTERM");
  });

  it("sends KILL at 8000ms when EOF and TERM are ignored and not before", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ scenario: "hang-term" });
    await collectPrompt(world.runtime.prompt("hang-term"));
    const observed = world.observed[0];
    const child = world.children[0];
    if (observed === undefined || child === undefined) {
      throw new Error("missing hang-term child");
    }
    const shutting = world.runtime.shutdown();
    world.clock.advance(4_999);
    await waitImmediate();
    expect(observed.signals).toEqual([]);
    world.clock.advance(1);
    await waitImmediate();
    expect(observed.signals).toEqual(["SIGTERM"]);
    expect(hasTerminated(child)).toBe(false);
    world.clock.advance(2_999);
    await waitImmediate();
    expect(observed.signals).toEqual(["SIGTERM"]);
    expect(hasTerminated(child)).toBe(false);
    world.clock.advance(1);
    await observed.exit;
    await shutting;
    expect(observed.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(observed.exits[0]?.signal).toBe("SIGKILL");
  });

  it("reaps a child when shutdown races startup and forbids later prompts", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld();
    const pending = collectUntilError(world.runtime.prompt("startup"));
    const spawned = await world.waitSpawn();
    const shutting = world.runtime.shutdown();
    world.clock.advance(8_000);
    const result = await pending;
    await shutting;
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    await spawned.exit;
    expect(hasTerminated(spawned.child)).toBe(true);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(() => world.runtime.prompt("closed")).toThrow(AgentUnavailableError);
  });
});

interface SpawnCall {
  args: string[];
  env: Record<string, string>;
}

interface ChildObservation {
  child: ChildProcessWithoutNullStreams;
  signals: NodeJS.Signals[];
  exits: OmpExit[];
  exit: Promise<OmpExit>;
}

interface World {
  runtime: SessionRuntime;
  clock: TestClock;
  tokens: TokenBook;
  calls: SpawnCall[];
  children: ChildProcessWithoutNullStreams[];
  observed: ChildObservation[];
  exits: OmpExit[];
  spawns: number;
  scenario: string | undefined;
  waitSpawn(): Promise<ChildObservation>;
}

function openWorld(options: { resumePath?: string | null; scenario?: string } = {}): World {
  const clock = createClock();
  const tokens = createTokens(TOKEN_PREFIX);
  const calls: SpawnCall[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const observed: ChildObservation[] = [];
  const exits: OmpExit[] = [];
  const spawnWaiters: Array<(value: ChildObservation) => void> = [];
  const world: World = {
    runtime: undefined as unknown as SessionRuntime,
    clock,
    tokens,
    calls,
    children,
    observed,
    exits,
    get spawns() {
      return calls.length;
    },
    scenario: options.scenario,
    waitSpawn() {
      const existing = observed[observed.length - 1];
      if (existing !== undefined && observed.length > calls.length - 1) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        spawnWaiters.push(resolve);
      });
    },
  };
  const spawnImpl: SpawnImpl = (_command, args, spawnOptions) => {
    const extra = world.scenario === undefined ? [] : ["--scenario", world.scenario];
    const child = spawn(process.execPath, [FAKE, ...args, ...extra], {
      cwd: typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : undefined,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    harness.children.push(child);
    children.push(child);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spawnOptions.env ?? {})) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    calls.push({ args: [...args], env });
    const watch = observeChild(child);
    observed.push(watch);
    spawnWaiters.splice(0).forEach((resolve) => {
      resolve(watch);
    });
    return child;
  };
  const opts: SessionRuntimeOpts = {
    sessionId: SESSION_ID,
    ...harness.tempOpts(`${TOKEN_PREFIX}-unused`, "omp-rt-"),
    bin: FAKE,
    tokens,
    idleMs: IDLE_MS,
    clock,
    spawnImpl,
    onExit: (exit) => {
      exits.push(exit);
    },
    ...(options.resumePath === undefined ? {} : { resumePath: options.resumePath }),
  };
  world.runtime = new SessionRuntime(opts);
  return world;
}

function observeChild(child: ChildProcessWithoutNullStreams): ChildObservation {
  const signals: NodeJS.Signals[] = [];
  const exits: OmpExit[] = [];
  const originalKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals) => {
    signals.push(signal ?? "SIGTERM");
    return originalKill(signal);
  }) as typeof child.kill;
  const exit = new Promise<OmpExit>((resolve) => {
    child.once("exit", (code, signal) => {
      const seen = { code, signal };
      exits.push(seen);
      resolve(seen);
    });
  });
  return { child, signals, exits, exit };
}

function resumeOf(args: string[] | undefined): string | undefined {
  if (args === undefined) {
    return undefined;
  }
  const index = args.indexOf("--resume");
  return index === -1 ? undefined : args[index + 1];
}
