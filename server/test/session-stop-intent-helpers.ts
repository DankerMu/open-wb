/**
 * Issue #490 stop-intent test plumbing, composed over the #464/#473 worlds (production createApp →
 * registerSessions, real fake-omp children, per-child stdin record, injected clock): the synchronous
 * prompt-then-stop window that lands a stop before the dispatch receipt, per-dispatch runtime knobs
 * (ready delay, handshake bound) and a capped eviction world whose first session behaves like an
 * ApprovalWorld. The underlying helpers are used unchanged; oracles stay public.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, expect } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { type ApprovalWorld, settle, T } from "./session-approval-helpers.js";
import { collectRejections, openStopWorld, type RejectionLog } from "./session-stop-helpers.js";
import {
  createRealFakeRuntime,
  createSession,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
} from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";

/**
 * Probe record of a process whose only turn before the probe was stopped by one `abort`. The two
 * alignment commands precede the generation's first prompt only (#1010).
 */
export const PROBED =
  "negotiate_protocol,get_state,set_model,set_thinking_level,prompt,abort,prompt";

export function ended(messageId: number, status: string) {
  return { type: "turn.end", data: { messageId, status } };
}

/**
 * Per-test world ownership for one test file: every tracked world is closed after the case and no
 * unhandledRejection may surface during the case or its close. `killSurvivors` SIGKILLs live
 * children first (hang-eof ignores stdin EOF, so a failed case would stall close() on the clock).
 */
export function intentWorlds(killSurvivors: boolean) {
  const worlds = new Set<ApprovalWorld>();
  let rejections: RejectionLog | undefined;
  beforeEach(() => {
    rejections = collectRejections();
  });
  afterEach(async () => {
    try {
      for (const world of worlds) {
        if (killSurvivors) {
          killLive(world);
        }
        await world.fixture.close();
      }
      worlds.clear();
      await settle();
      expect(rejections?.reasons).toEqual([]);
    } finally {
      rejections?.dispose();
    }
  });
  const track = <W extends ApprovalWorld>(world: W): W => {
    worlds.add(world);
    return world;
  };
  return {
    track,
    open: async (scenario: string) => track(await openIntentWorld(scenario)),
  };
}

/** Any fake-omp scenario: the stop world opens lazily, so the first prompt spawns `scenario`. */
async function openIntentWorld(scenario: string): Promise<ApprovalWorld> {
  const world = await openStopWorld("abort-ok");
  world.rt.setScenario(scenario);
  return world;
}

/** Every later spawn gets `--ready-delay-ms <ms>` appended (fake-omp: last occurrence wins). */
export function delayReady(world: ApprovalWorld, ms: number): void {
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) =>
    inner(command, [...args, "--ready-delay-ms", String(ms)], options);
}

/**
 * The supervisor holds this same runtime object and reads the handshake bound on every dispatch;
 * `undefined` restores the default. The field is outside RuntimeOptions, hence Object.assign.
 */
export function handshakeBound(world: ApprovalWorld, ms: number | undefined): void {
  Object.assign(world.rt.runtime, { handshakeTimeoutMs: ms });
}

export interface EarlyStop {
  assistantMessageId: number;
  /** The supervisor prompt; REST would await it before its 202. */
  prompt: Promise<void>;
  stops: Promise<void>[];
  /** Children spawned when the last stop call returned (read synchronously). */
  spawnedAtStop: number;
}

/**
 * The REST prompt order (acceptPrompt, then supervisor.prompt in the same synchronous segment)
 * followed by `count` stops before any await: every stop lands before the dispatch receipt.
 */
export function stopBeforeDispatch(
  world: RecordingWorld & { spawned: readonly unknown[] },
  count = 1,
  text = "stop before dispatch",
): EarlyStop {
  const { supervisor, store } = world.fixture;
  const admitted = store.acceptPrompt(world.session, OWNER_ID, text);
  const prompt = supervisor.prompt(world.session, text);
  const stops: Promise<void>[] = [];
  for (let n = 0; n < count; n += 1) {
    stops.push(supervisor.stop(world.session));
  }
  return {
    assistantMessageId: admitted.assistantMessageId,
    prompt,
    stops,
    spawnedAtStop: world.spawned.length,
  };
}

export function frameTypes(frames: readonly OmpFrame[]): string[] {
  return frames.map((frame) => String(frame.type));
}

/** The first child whose stdin carried a prompt with exactly this message. */
export function promptedWith(world: ApprovalWorld, message: string) {
  return world.spawned.find((spawned) =>
    spawned.stdin.some((frame) => frame.type === "prompt" && frame.message === message),
  );
}

function killLive(world: ApprovalWorld): void {
  for (const { child } of world.spawned) {
    if (isLive(child)) {
      child.kill("SIGKILL");
    }
  }
}

export interface EvictionWorld extends ApprovalWorld {
  /** Created after `world.session` (= a), in this order. */
  c: string;
  b: string;
}

/**
 * Cap-2 world (`{...runtime, maxProcesses: 2}` is a copy, so stdin taps are installed before
 * open) with sessions a (`world.session`), c and b; starts in `hang-eof`.
 */
export async function openEvictionWorld(): Promise<EvictionWorld> {
  const rt = createRealFakeRuntime("hang-eof");
  rt.clock.nowMs = T;
  const spawned: ApprovalWorld["spawned"] = [];
  const inner = rt.runtime.spawnImpl;
  rt.runtime.spawnImpl = (command, args, options) => {
    const child = inner(command, args, options);
    spawned.push({ child, stdin: tapStdin(child), gate: { held: () => "", release() {} } });
    return child;
  };
  const armed = armedTimers(rt.clock);
  const world = await openRecordingSession({ ...rt.runtime, maxProcesses: 2 });
  const c = await createSession(world.fixture.app, world.cookie);
  const b = await createSession(world.fixture.app, world.cookie);
  return {
    ...world,
    rt,
    clock: rt.clock,
    spawned,
    timersDueAt: (due) => [...armed.values()].filter((at) => at === due).length,
    c,
    b,
  };
}

function tapStdin(child: ChildProcessWithoutNullStreams): OmpFrame[] {
  const frames: OmpFrame[] = [];
  const write = child.stdin.write.bind(child.stdin) as (...args: unknown[]) => boolean;
  child.stdin.write = ((...args: unknown[]) => {
    for (const line of String(args[0]).split("\n")) {
      if (line.length > 0) {
        frames.push(JSON.parse(line) as OmpFrame);
      }
    }
    return write(...args);
  }) as typeof child.stdin.write;
  return frames;
}

/** Due time of every injected-clock timer still armed (neither fired nor cleared). */
function armedTimers(clock: TestClock): Map<unknown, number> {
  const armed = new Map<unknown, number>();
  const { setTimeout: arm, clearTimeout: disarm } = clock;
  clock.setTimeout = (callback, ms) => {
    const handle = arm.call(
      clock,
      () => {
        armed.delete(handle);
        callback();
      },
      ms,
    );
    armed.set(handle, clock.nowMs + ms);
    return handle;
  };
  clock.clearTimeout = (handle) => {
    armed.delete(handle);
    disarm.call(clock, handle);
  };
  return armed;
}
