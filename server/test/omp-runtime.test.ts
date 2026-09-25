/**
 * Issue #96 SessionRuntime real-child lifecycle.
 * Independent oracles: Node child_process exit/signal vs injected clock, frozen rpc.md.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as waitImmediate, setTimeout as waitTimeout } from "node:timers/promises";
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
import {
  createRpcHarness,
  DEFAULT_SESSION,
  hasTerminated,
  observePromise,
} from "./support/omp-rpc.js";
import {
  type ChildObservation,
  capturePromptWrites,
  collectPrompt,
  collectUntilError,
  createClock,
  createTokens,
  observeChild,
  observeIteratorResult,
  requireIteratorReturn,
  settlesWithin,
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
    const { child, observed, world } = await openHangTerm();
    const shutting = world.runtime.shutdown();
    await advanceHangTermGrace(world, observed, child);
    expect(hasTerminated(child)).toBe(false);
    world.clock.advance(1);
    await observed.exit;
    await shutting;
    expect(observed.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(observed.exits[0]?.signal).toBe("SIGKILL");
  });

  it("does not resolve shutdown until hang-term native exit is observed", {
    timeout: 15_000,
  }, async () => {
    const { child, observed, world } = await openHangTerm();
    let atShutdown:
      | { exits: number; exitCode: number | null; signalCode: NodeJS.Signals | null }
      | undefined;
    const shutting = world.runtime.shutdown().then(() => {
      atShutdown = {
        exits: observed.exits.length,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      };
    });
    await advanceHangTermGrace(world, observed, child);
    world.clock.advance(1);
    await observed.exit;
    await shutting;
    expect(atShutdown).toBeDefined();
    expect(atShutdown?.exits).toBeGreaterThan(0);
    expect(atShutdown?.exitCode !== null || atShutdown?.signalCode !== null).toBe(true);
    expect(hasTerminated(child)).toBe(true);
    expect(observed.exits[0]).toBeDefined();
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

describe("SessionRuntime failed acquisition, delayed shutdown and iterator return", () => {
  it("rejects a missing executable at clock 0 and keeps the known resume path", {
    timeout: 15_000,
  }, async () => {
    await expectFailedAcquisition("missing-bin");
  });

  it("rejects a synchronous spawn throw at clock 0 and keeps the known resume path", {
    timeout: 15_000,
  }, async () => {
    await expectFailedAcquisition("sync-throw");
  });

  it("rejects an obstructed directory before a child exists at clock 0", {
    timeout: 15_000,
  }, async () => {
    await expectFailedAcquisition("obstructed-dir");
  });

  it("releases owned clock timers after failed acquisition and shutdown", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ spawnFailure: "missing-bin" });
    expect(world.clock.pending()).toBe(0);
    const failed = await collectUntilError(world.runtime.prompt("boot"));
    expect(failed.error).toBeInstanceOf(AgentUnavailableError);
    expect(world.clock.nowMs).toBe(0);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    await world.runtime.shutdown();
    expect(world.clock.pending()).toBe(0);
  });

  it("closes stdin then TERM at 5000 and KILL at 8000 when shutdown races spawn return", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({
      scenario: "no-ready-hang",
      shutdownInSpawn: true,
      handshakeTimeoutMs: 60_000,
    });
    const pending = collectUntilError(world.runtime.prompt("startup"));
    const spawned = await world.waitSpawn();
    await spawned.ready;
    expect(world.clock.nowMs).toBe(0);
    expect(spawned.stdinEnded).toBe(true);
    expect(spawned.signals).toEqual([]);
    expect(hasTerminated(spawned.child)).toBe(false);

    world.clock.advance(4_999);
    await waitImmediate();
    expect(spawned.signals).toEqual([]);
    expect(hasTerminated(spawned.child)).toBe(false);

    world.clock.advance(1);
    await waitImmediate();
    expect(spawned.signals).toEqual(["SIGTERM"]);
    expect(hasTerminated(spawned.child)).toBe(false);

    world.clock.advance(2_999);
    await waitImmediate();
    expect(spawned.signals).toEqual(["SIGTERM"]);
    expect(hasTerminated(spawned.child)).toBe(false);

    world.clock.advance(1);
    await spawned.exit;
    const result = await pending;
    await world.shutdownInSpawn;
    expect(spawned.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawned.exits[0]?.signal).toBe("SIGKILL");
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(() => world.runtime.prompt("closed")).toThrow(AgentUnavailableError);
  });

  it("settles shutdown at clock 0 when it races a missing-binary spawn failure", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ spawnFailure: "missing-bin", shutdownInSpawn: true });
    const pending = collectUntilError(world.runtime.prompt("boot"));
    const { shutting } = await waitShutdownInSpawn(world);
    expect(await settlesWithin(shutting, 1_000)).toBe(true);
    expect(world.clock.nowMs).toBe(0);
    expect(world.clock.pending()).toBe(0);
    expect(world.kills).toEqual([]);
    expect(world.children).toHaveLength(0);
    expect(world.tokens.issued).toHaveLength(1);
    expect(world.tokens.revoked).toEqual(world.tokens.issued);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    const result = await pending;
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    expect((result.error as AgentUnavailableError).code).toBe("agent_unavailable");
    expect(() => world.runtime.prompt("closed")).toThrow(AgentUnavailableError);
  });

  it("retires a pid-less child that never reports failure at clock 0", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ spawnFailure: "pid-less" });
    const pending = collectUntilError(world.runtime.prompt("boot"));
    expect(await settlesWithin(pending, 1_000)).toBe(true);
    const result = await pending;
    expect(result.error).toBeInstanceOf(AgentUnavailableError);
    const shutting = world.runtime.shutdown();
    expect(await settlesWithin(shutting, 1_000)).toBe(true);
    expect(world.clock.nowMs).toBe(0);
    expect(world.clock.pending()).toBe(0);
    // Only OmpProcess#failStartup's handshake-failure SIGKILL; the runtime retire never signals.
    expect(world.kills).toEqual(["SIGKILL"]);
    expect(world.children).toHaveLength(0);
    expect(world.tokens.issued).toHaveLength(1);
    expect(world.tokens.revoked).toEqual(world.tokens.issued);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
  });

  it("keeps TERM at 5000 and KILL at 8000 for a live child that emitted error", {
    timeout: 15_000,
  }, async () => {
    const { child, observed, world } = await openHangTerm();
    child.emit("error", new Error("simulated kill/IPC failure on a live child"));
    expect(hasTerminated(child)).toBe(false);
    const shutting = world.runtime.shutdown();
    await waitImmediate();
    expect(observed.stdinEnded).toBe(true);
    await advanceHangTermGrace(world, observed, child);
    expect(hasTerminated(child)).toBe(false);
    world.clock.advance(1);
    await observed.exit;
    await shutting;
    expect(observed.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(observed.exits[0]?.signal).toBe("SIGKILL");
    expect(world.tokens.revoked).toEqual(world.tokens.issued);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
  });

  it("settles a parked next after iterator return and reclaims the child", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld({ scenario: "hang-prompt" });
    const iterator = world.runtime.prompt("busy")[Symbol.asyncIterator]();
    const ack = await iterator.next();
    expect(ack.done).toBe(false);
    expect(ack.value).toMatchObject({ type: "response", command: "prompt", success: true });
    const parked = iterator.next();
    const parkedWatch = observeIteratorResult(parked);
    const returnIterator = requireIteratorReturn(iterator);
    const returned = await returnIterator();
    expect(returned).toEqual({ value: undefined, done: true });
    await waitImmediate();
    expect(parkedWatch.outcome).not.toBe("pending");
    if (parkedWatch.outcome === "rejected") {
      expect(parkedWatch.error).toBeInstanceOf(AgentUnavailableError);
      expect((parkedWatch.error as AgentUnavailableError).code).toBe("agent_unavailable");
    } else {
      expect(parkedWatch.outcome).toBe("done");
      expect(parkedWatch.result).toEqual({ value: undefined, done: true });
    }
    const child = world.children[0];
    if (child === undefined) {
      throw new Error("missing hang-prompt child");
    }
    world.clock.advance(8_000);
    await world.observed[0]?.exit;
    expect(hasTerminated(child)).toBe(true);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    world.scenario = undefined;
    const next = await collectPrompt(world.runtime.prompt("after-parked-return"));
    expect(world.spawns).toBe(2);
    expect(next.some((frame) => frame.type === "agent_end")).toBe(true);
  });

  it("discards queued frames after return so later next stays terminal", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld();
    const iterator = world.runtime.prompt("full-turn")[Symbol.asyncIterator]();
    const ack = await iterator.next();
    expect(ack.done).toBe(false);
    expect(ack.value).toMatchObject({ type: "response", command: "prompt" });
    const observed = world.observed[0];
    if (observed === undefined) {
      throw new Error("missing full-turn child");
    }
    await observed.agentEnd;
    await waitImmediate();
    await waitImmediate();
    const returnIterator = requireIteratorReturn(iterator);
    const returned = await returnIterator();
    expect(returned).toEqual({ value: undefined, done: true });
    const afterReturn = await iterator.next();
    expect(afterReturn).toEqual({ value: undefined, done: true });
    expect(hasTerminated(observed.child)).toBe(false);
    expect(world.tokens.live.get(SESSION_ID)).toBeDefined();
    const reused = await collectPrompt(world.runtime.prompt("reuse-after-return"));
    expect(world.spawns).toBe(1);
    expect(reused.some((frame) => frame.type === "agent_end")).toBe(true);
    const shutting = world.runtime.shutdown();
    await observed.exit;
    await shutting;
  });

  it("does not write a canceled unsent prompt onto a reused child", {
    timeout: 15_000,
  }, async () => {
    const world = openWorld();
    await collectPrompt(world.runtime.prompt("first"));
    expect(world.prompts).toEqual(["first"]);
    const iterator = world.runtime.prompt("canceled-before-send")[Symbol.asyncIterator]();
    const returnIterator = requireIteratorReturn(iterator);
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        void returnIterator().then(() => {
          resolve();
        }, reject);
      });
    });
    await waitImmediate();
    expect(world.prompts).toEqual(["first"]);
    expect(world.spawns).toBe(1);
    const reused = await collectPrompt(world.runtime.prompt("after-cancel"));
    expect(world.spawns).toBe(1);
    expect(world.prompts).toEqual(["first", "after-cancel"]);
    expect(reused.some((frame) => frame.type === "agent_end")).toBe(true);
    await world.runtime.shutdown();
  });
});

interface SpawnCall {
  args: string[];
  env: Record<string, string>;
}

type SpawnFailure = "missing-bin" | "sync-throw" | "obstructed-dir" | "pid-less";

interface World {
  runtime: SessionRuntime;
  clock: TestClock;
  tokens: TokenBook;
  calls: SpawnCall[];
  children: ChildProcessWithoutNullStreams[];
  observed: ChildObservation[];
  exits: OmpExit[];
  kills: NodeJS.Signals[];
  prompts: string[];
  spawns: number;
  scenario: string | undefined;
  spawnFailure: SpawnFailure | undefined;
  shutdownInSpawn: Promise<void> | undefined;
  obstructedPath: string | undefined;
  waitSpawn(): Promise<ChildObservation>;
}

function openWorld(
  options: {
    resumePath?: string | null;
    scenario?: string;
    spawnFailure?: SpawnFailure;
    shutdownInSpawn?: boolean;
    handshakeTimeoutMs?: number;
  } = {},
): World {
  const clock = createClock();
  const tokens = createTokens(TOKEN_PREFIX);
  const calls: SpawnCall[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const observed: ChildObservation[] = [];
  const exits: OmpExit[] = [];
  const kills: NodeJS.Signals[] = [];
  const prompts: string[] = [];
  const spawnWaiters: Array<(value: ChildObservation) => void> = [];
  const world: World = {
    runtime: undefined as unknown as SessionRuntime,
    clock,
    tokens,
    calls,
    children,
    observed,
    exits,
    kills,
    prompts,
    get spawns() {
      return calls.length;
    },
    scenario: options.scenario,
    spawnFailure: options.spawnFailure,
    shutdownInSpawn: undefined,
    obstructedPath: undefined,
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
  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    calls.push(captureSpawnCall(args, spawnOptions.env));
    if (world.spawnFailure === "sync-throw") {
      throw new Error("spawnImpl refused before a child existed");
    }
    const child = spawnWorldChild(command, args, spawnOptions, world.spawnFailure, world.scenario);
    child.on("error", () => {});
    const originalKill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals) => {
      kills.push(signal ?? "SIGTERM");
      return originalKill(signal);
    }) as typeof child.kill;
    capturePromptWrites(child, prompts);
    if (world.spawnFailure !== "pid-less") {
      harness.children.push(child);
    }
    if (world.spawnFailure === undefined) {
      children.push(child);
      const watch = observeChild(child);
      observed.push(watch);
      spawnWaiters.splice(0).forEach((resolve) => {
        resolve(watch);
      });
    }
    if (options.shutdownInSpawn) {
      world.shutdownInSpawn = world.runtime.shutdown();
    }
    return child;
  };
  const temp = harness.tempOpts(`${TOKEN_PREFIX}-unused`, "omp-rt-");
  const opts: SessionRuntimeOpts = {
    sessionId: SESSION_ID,
    ...temp,
    bin: FAKE,
    tokens,
    idleMs: IDLE_MS,
    clock,
    spawnImpl,
    onExit: (exit) => {
      exits.push(exit);
    },
    ...(options.resumePath === undefined ? {} : { resumePath: options.resumePath }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
  };
  if (options.spawnFailure === "missing-bin") {
    opts.bin = join(temp.sandboxRoot, "absent-omp");
  }
  if (options.spawnFailure === "obstructed-dir") {
    mkdirSync(temp.sandboxRoot, { recursive: true });
    world.obstructedPath = join(temp.sandboxRoot, temp.ownerId);
    writeFileSync(world.obstructedPath, "not-a-directory");
  }
  world.runtime = new SessionRuntime(opts);
  return world;
}

async function openHangTerm() {
  const world = openWorld({ scenario: "hang-term" });
  await collectPrompt(world.runtime.prompt("hang-term"));
  const observed = world.observed[0];
  const child = world.children[0];
  if (observed === undefined || child === undefined) {
    throw new Error("missing hang-term child");
  }
  return { child, observed, world };
}

async function advanceHangTermGrace(
  world: World,
  observed: ChildObservation,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
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
}

function captureSpawnCall(
  args: readonly string[],
  env: Parameters<SpawnImpl>[2]["env"],
): SpawnCall {
  const captured: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      captured[key] = value;
    }
  }
  return { args: [...args], env: captured };
}

function spawnWorldChild(
  command: string,
  args: readonly string[],
  spawnOptions: Parameters<SpawnImpl>[2],
  spawnFailure: SpawnFailure | undefined,
  scenario: string | undefined,
): ChildProcessWithoutNullStreams {
  if (spawnFailure === "pid-less") {
    return spawnPidlessFake(command, args, spawnOptions);
  }
  if (spawnFailure === "missing-bin") {
    return spawn(command, args, {
      cwd: typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : undefined,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
  }
  const extra = scenario === undefined ? [] : ["--scenario", scenario];
  return spawn(process.execPath, [FAKE, ...args, ...extra], {
    cwd: typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : undefined,
    env: spawnOptions.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
}

/**
 * A spawn result that never obtained a pid and never reports failure: no 'error',
 * no exitCode/signalCode, and kill() is a no-op returning false like a handle-less
 * Node ChildProcess. Its stdout ends so the handshake fails as a closed transport.
 */
function spawnPidlessFake(
  command: string,
  args: readonly string[],
  spawnOptions: Parameters<SpawnImpl>[2],
): ChildProcessWithoutNullStreams {
  const fake = harness.fake();
  (fake as { pid: number | undefined }).pid = undefined;
  fake.kill = () => false;
  const child = fake.spawnImpl(command, args, spawnOptions);
  fake.endStdout();
  return child;
}

async function waitShutdownInSpawn(world: World): Promise<{ shutting: Promise<void> }> {
  for (let waited = 0; waited < 1_000 && world.shutdownInSpawn === undefined; waited += 5) {
    await waitTimeout(5);
  }
  if (world.shutdownInSpawn === undefined) {
    throw new Error("shutdown was not started inside spawnImpl");
  }
  // Boxed: an async function returning the bare promise would await shutdown itself.
  return { shutting: world.shutdownInSpawn };
}

function resumeOf(args: string[] | undefined): string | undefined {
  if (args === undefined) {
    return undefined;
  }
  const index = args.indexOf("--resume");
  return index === -1 ? undefined : args[index + 1];
}

async function expectFailedAcquisition(kind: SpawnFailure): Promise<void> {
  const persisted = "/tmp/open-wb-persisted-session.jsonl";
  const world = openWorld({
    resumePath: persisted,
    spawnFailure: kind,
  });
  const pending = collectUntilError(world.runtime.prompt("boot"));
  const observation = observePromise(pending);
  for (let i = 0; i < 40 && observation.outcome === "pending"; i += 1) {
    await waitTimeout(5);
  }
  expect(world.clock.nowMs).toBe(0);
  expect(observation.outcome).toBe("resolved");
  const result = await pending;
  expect(result.error).toBeInstanceOf(AgentUnavailableError);
  expect((result.error as AgentUnavailableError).code).toBe("agent_unavailable");
  expect(world.clock.nowMs).toBe(0);
  expect(world.tokens.issued).toHaveLength(1);
  expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
  expect(world.tokens.revoked).toEqual(world.tokens.issued);
  expect(world.runtime.sessionFile).toBe(persisted);
  expect(world.kills).toEqual([]);
  expect(world.children).toHaveLength(0);
  if (world.calls[0] !== undefined) {
    expect(resumeOf(world.calls[0].args)).toBe(persisted);
  }
  if (world.obstructedPath !== undefined) {
    unlinkSync(world.obstructedPath);
  }
  world.spawnFailure = undefined;
  world.scenario = "new-session";
  const recovered = await collectPrompt(world.runtime.prompt("retry"));
  expect(world.spawns).toBeGreaterThanOrEqual(1);
  expect(resumeOf(world.calls[world.calls.length - 1]?.args)).toBe(persisted);
  expect(recovered.some((frame) => frame.type === "agent_end")).toBe(true);
  expect(world.runtime.sessionFile).toBe("/tmp/open-wb-new-session.jsonl");
  await world.runtime.shutdown();
}
