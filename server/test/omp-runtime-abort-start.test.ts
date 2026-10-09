/**
 * Issue #650 SessionRuntime `abort()` only after the turn started (change stop-after-agent-start,
 * design R1–R7). omp v18.0.10 silently drops a prompt still pre-processing when `abort` arrives
 * before its `agent_start` (#495), so between the dispatch receipt and the start `abort()` defers:
 * the one frame is written as the start frame (`agent_start` or the local-only outcome) reaches the
 * runtime, and the Promise rejects with AgentUnavailableError, writing nothing, when the turn ends,
 * fails or is abandoned first. Real fake-omp children only (`--start-delay-ms` holds the start
 * open); oracles are a stdin tap that snapshots the child's stdout at each write, the iterator, the
 * abort Promise and Node's own exit.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as waitTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { AgentUnavailableError, type SpawnImpl } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { createRealFakeRuntime, type RealFakeRuntime } from "./session-supervisor-helpers.js";
import { parseJsonl } from "./support/omp-rpc.js";
import {
  type ChildObservation,
  collectPrompt,
  collectUntilError,
  createTokens,
  observeChild,
  requireIteratorReturn,
  settlesWithin,
  type TokenBook,
} from "./support/omp-runtime.js";

const REAL = { timeout: 20_000 };
const SETTLE_MS = 3_000;
const START = (ms: number): string[] => ["--start-delay-ms", String(ms)];
const STARTED = '"type":"agent_start"';
const LOCAL_OUTCOME = '"agentInvoked":false';
const AGENT_START: OmpFrame = { type: "agent_start" };
const ABORTED_END: OmpFrame = {
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "aborted" },
};
const TERMINAL: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
/** The held abort-ok turn from its start to the aborted end (fake-omp `holdTurn`). */
const ABORTED_TURN = [AGENT_START, delta("Hello "), delta("from "), ABORTED_END, TERMINAL];

/** One stdin write and the child's whole stdout as the runtime had received it at that moment. */
interface Written {
  frame: OmpFrame;
  stdout: string;
}

interface World {
  runtime: SessionRuntime;
  real: RealFakeRuntime;
  tokens: TokenBook;
  stdin: Written[];
  watches: ChildObservation[];
  spawns: number;
}

/** Real fake-omp children with `extraArgs`; stdout listener installed before the runtime's own. */
function open(scenario: string, extraArgs: string[], idleMs = 600_000): World {
  const real = createRealFakeRuntime(scenario);
  const tokens = createTokens("wb-issue650-secret-token");
  const world: World = {
    runtime: undefined as unknown as SessionRuntime,
    real,
    tokens,
    stdin: [],
    watches: [],
    spawns: 0,
  };
  const spawnImpl: SpawnImpl = (command, args, options) => {
    world.spawns += 1;
    const child = real.runtime.spawnImpl(command, [...args, ...extraArgs], options);
    tap(child, world);
    world.watches.push(observeChild(child));
    return child;
  };
  world.runtime = new SessionRuntime({
    ...real.runtime,
    approvalMode: "write",
    sessionId: "sess-abort-start-650",
    ownerId: "u1",
    cwd: `${real.runtime.sandboxRoot}/u1`,
    tokens,
    idleMs,
    resumePath: null,
    spawnImpl,
  });
  return world;
}

function tap(child: ChildProcessWithoutNullStreams, world: World): void {
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });
  const original = child.stdin.write;
  child.stdin.write = ((...args: unknown[]): boolean => {
    world.stdin.push(...parseJsonl(String(args[0])).map((frame) => ({ frame, stdout })));
    return Reflect.apply(original, child.stdin, args) as boolean;
  }) as typeof child.stdin.write;
}

function aborts(world: World): Written[] {
  return world.stdin.filter((entry) => entry.frame.type === "abort");
}

function types(world: World): string[] {
  return world.stdin.map((entry) => String(entry.frame.type));
}

function delta(text: string): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
    message: { role: "assistant", content: [] },
  };
}

function deferred(runtime: SessionRuntime): Promise<OmpFrame> {
  const pending = runtime.abort();
  if (pending === false) {
    throw new Error("abort() returned false on a dispatched turn");
  }
  return pending;
}

async function drain(iterator: AsyncIterator<OmpFrame>): Promise<OmpFrame[]> {
  const frames: OmpFrame[] = [];
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
    frames.push(next.value);
  }
  return frames;
}

/** Settles within the bound (a mutation that never settles it fails fast) and rejects unavailable. */
async function expectRejected(pending: Promise<OmpFrame>): Promise<void> {
  expect(await settlesWithin(pending, SETTLE_MS)).toBe(true);
  await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
}

/** The deferred abort's one frame followed `prompt` and was written only after `marker` arrived. */
function expectOneAbortAfter(world: World, marker: string): Written {
  const written = aborts(world);
  expect(written).toHaveLength(1);
  expect(types(world).indexOf("abort")).toBeGreaterThan(types(world).indexOf("prompt"));
  expect(written[0]?.stdout).toContain(marker);
  return written[0] as Written;
}

function abortResponse(written: Written): OmpFrame {
  return { id: written.frame.id, type: "response", command: "abort", success: true };
}

/** A following prompt completes on the same child without a new spawn or issue. */
async function expectSameGeneration(world: World, text: string): Promise<void> {
  const frames = await collectPrompt(world.runtime.prompt(text));
  expect(frames.at(-1)).toEqual(TERMINAL);
  expect(world.spawns).toBe(1);
  expect(world.tokens.issued).toHaveLength(1);
  await world.runtime.shutdown();
}

/** R1/R2 tail: the deferred abort opens at agent_start and the held turn ends aborted. */
async function expectDeferredToStart(
  world: World,
  iterator: AsyncIterator<OmpFrame>,
  pending: Promise<OmpFrame>,
): Promise<void> {
  expect(aborts(world)).toEqual([]);
  await waitTimeout(50);
  expect(aborts(world)).toEqual([]);

  const frames = await drain(iterator);
  expect(frames.slice(frames.findIndex((frame) => frame.type === "agent_start"))).toEqual(
    ABORTED_TURN,
  );
  const written = expectOneAbortAfter(world, STARTED);
  expect(await settlesWithin(pending, SETTLE_MS)).toBe(true);
  await expect(pending).resolves.toEqual(abortResponse(written));
  await expectSameGeneration(world, "next");
}

describe("SessionRuntime abort() before the turn starts (#650)", () => {
  it(
    "R1 abort right after the receipt waits for agent_start, then writes one frame",
    REAL,
    async () => {
      const world = open("abort-ok", START(200));
      const turn = world.runtime.prompt("x");
      const iterator = turn[Symbol.asyncIterator]();
      await turn.dispatched;

      const pending = world.runtime.abort();
      expect(pending).toBeInstanceOf(Promise);
      await expectDeferredToStart(world, iterator, pending as Promise<OmpFrame>);
    },
  );

  it(
    "R2 slow-ready: false before the receipt, deferred after it, one frame at agent_start",
    REAL,
    async () => {
      const world = open("slow-ready", ["--ready-delay-ms", "300", ...START(200)]);
      const turn = world.runtime.prompt("stop me");
      const iterator = turn[Symbol.asyncIterator]();
      expect(world.runtime.abort()).toBe(false);
      await turn.dispatched;
      expect(aborts(world)).toEqual([]);

      const pending = world.runtime.abort();
      expect(pending).toBeInstanceOf(Promise);
      await expectDeferredToStart(world, iterator, pending as Promise<OmpFrame>);
    },
  );

  it(
    "R3 crash after the ack: the deferred abort rejects and no frame is written",
    REAL,
    async () => {
      const world = open("crash", []);
      const turn = world.runtime.prompt("x");
      await turn.dispatched;
      const pending = deferred(world.runtime);

      await expectRejected(pending);
      const settled = await collectUntilError(turn);
      expect(settled.error).toBeInstanceOf(AgentUnavailableError);
      expect(settled.frames).toMatchObject([{ type: "response", command: "prompt" }]);
      expect(await world.watches[0]?.exit).toEqual({ code: 2, signal: null });
      expect(aborts(world)).toEqual([]);
      await world.runtime.shutdown();
    },
  );

  it(
    "R4 /todo: the local outcome that ends the turn rejects the deferred abort; the child stays",
    REAL,
    async () => {
      const world = open("slash", []);
      const turn = world.runtime.prompt("/todo");
      await turn.dispatched;
      const pending = deferred(world.runtime);

      await expectRejected(pending);
      expect(await collectPrompt(turn)).toEqual([
        { type: "command_output", text: "No todos. Use /todo append <task> to start one." },
        expect.objectContaining({ command: "prompt", data: { agentInvoked: false } }),
      ]);
      expect(aborts(world)).toEqual([]);
      await expectSameGeneration(world, "hello");
      expect(aborts(world)).toEqual([]);
    },
  );

  it(
    "R5 /compact awaiting output: the local outcome opens the deferred abort; the grace still ends the turn",
    REAL,
    async () => {
      const world = open("slash", ["--compact-silent"]);
      const turn = world.runtime.prompt("/compact");
      const iterator = turn[Symbol.asyncIterator]();
      await turn.dispatched;
      const pending = deferred(world.runtime);
      expect(aborts(world)).toEqual([]);

      expect(await settlesWithin(pending, SETTLE_MS)).toBe(true);
      const written = expectOneAbortAfter(world, LOCAL_OUTCOME);
      await expect(pending).resolves.toEqual(abortResponse(written));
      expect((await iterator.next()).value).toMatchObject({ data: { agentInvoked: false } });
      expect(await iterator.next()).toEqual({ done: false, value: abortResponse(written) });

      const end = iterator.next();
      expect(await settlesWithin(end, 300)).toBe(false);
      world.real.clock.advance(119_999);
      expect(await settlesWithin(end, 50)).toBe(false);
      world.real.clock.advance(1);
      expect(await end).toEqual({ done: true, value: undefined });
      expect(aborts(world)).toHaveLength(1);
      await expectSameGeneration(world, "hello");
    },
  );

  it(
    "R6 an abandoned iterator rejects the deferred abort; a later agent_start writes nothing",
    REAL,
    async () => {
      const world = open("abort-ok", START(300));
      const turn = world.runtime.prompt("x");
      const iterator = turn[Symbol.asyncIterator]();
      await turn.dispatched;
      const pending = deferred(world.runtime);

      await requireIteratorReturn(iterator)();
      await expectRejected(pending);
      await waitTimeout(450);
      expect(aborts(world)).toEqual([]);
      expect(await world.watches[0]?.exit).toEqual({ code: 0, signal: null });
      expect(aborts(world)).toEqual([]);
      await world.runtime.shutdown();
    },
  );

  it("R7 two calls before the start share one Promise and one frame", REAL, async () => {
    const world = open("abort-ok", START(200));
    const turn = world.runtime.prompt("x");
    const iterator = turn[Symbol.asyncIterator]();
    await turn.dispatched;

    const first = deferred(world.runtime);
    const second = deferred(world.runtime);
    expect(second).toBe(first);
    expect(aborts(world)).toEqual([]);

    const frames = await drain(iterator);
    expect(frames.slice(-2)).toEqual([ABORTED_END, TERMINAL]);
    const written = expectOneAbortAfter(world, STARTED);
    await expect(first).resolves.toEqual(abortResponse(written));
    await expectSameGeneration(world, "next");
    expect(aborts(world)).toHaveLength(1);
  });
});
