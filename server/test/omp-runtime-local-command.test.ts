/**
 * Issue #553 local-only completion wait (s1c 10.2, design D15).
 * Independent oracles: omp v18.0.10 rpc-mode.ts:1019-1054 (built-in commands answer with an
 * `agentInvoked:false` receipt and emit `command_output`), todo.ts:246-260 (`/todo` output before the
 * receipt), builtin-lifecycle.ts:176-187 (`/compact` receipt before the output); design.md decision
 * table; injected clock. "Receipt" below always means the frame yielded by the iterator.
 */
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  decideLocalCompletion,
  LOCAL_COMMAND_GRACE_MS,
  type LocalSignal,
  type LocalState,
} from "../src/sessions/omp/local-command.js";
import { AgentUnavailableError, type SpawnImpl } from "../src/sessions/omp/process.js";
import { type SessionClock, SessionRuntime } from "../src/sessions/omp/runtime.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  type FakeChild,
  observePromise,
} from "./support/omp-rpc.js";
import {
  collectPrompt,
  collectUntilError,
  createClock,
  createTokens,
  requireIteratorReturn,
  settlesWithin,
} from "./support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const SESSION_ID = "sess-local-command-553";
const TOKEN = "wb-issue553-secret-token";
const REAL = { timeout: 20_000 };
const TERMINAL: OmpFrame = { type: "agent_end", isTerminal: true, messages: [] };
const TODO_OUTPUT: OmpFrame = {
  type: "command_output",
  text: "No todos. Use /todo append <task> to start one.",
};
const COMPACT_OUTPUT: OmpFrame = { type: "command_output", text: "Compaction complete." };
const LATE_OUTPUT: OmpFrame = { type: "command_output", text: "late local output" };
const DONE = { value: undefined, done: true };
const harness = createRpcHarness();

type Decision = ReturnType<typeof decideLocalCompletion>;

const BASE: LocalState = { slashText: true, outputSeen: false, awaiting: false, elapsedMs: 0 };
const WAITING: LocalState = { ...BASE, awaiting: true };
const TABLE: [string, LocalState, LocalSignal, Decision][] = [
  ["hello receipt completes", { ...BASE, slashText: false }, "local-outcome", "complete"],
  ["/x receipt after output completes", { ...BASE, outputSeen: true }, "local-outcome", "complete"],
  ["/x receipt without output awaits", BASE, "local-outcome", "await"],
  ["repeated receipt while awaiting", WAITING, "local-outcome", "none"],
  ["other frame for hello", { ...BASE, slashText: false }, "other", "none"],
  ["other frame for /x", BASE, "other", "none"],
  ["other frame for /x after output", { ...BASE, outputSeen: true }, "other", "none"],
  ["other frame while awaiting", { ...WAITING, elapsedMs: 120_000 }, "other", "none"],
  ["output while awaiting completes", WAITING, "command-output", "complete"],
  ["output while not awaiting", BASE, "command-output", "none"],
  ["output for hello", { ...BASE, slashText: false }, "command-output", "none"],
  ["grace tick at 119999", { ...WAITING, elapsedMs: 119_999 }, "grace-tick", "none"],
  ["grace tick at 120000", { ...WAITING, elapsedMs: 120_000 }, "grace-tick", "complete"],
  ["grace tick not awaiting", { ...BASE, elapsedMs: 120_000 }, "grace-tick", "none"],
];

describe("decideLocalCompletion", () => {
  it.each(TABLE)("%s", (_name, state, signal, expected) => {
    expect(decideLocalCompletion(state, signal)).toBe(expected);
  });

  it("uses a 120000 ms grace", () => {
    expect(LOCAL_COMMAND_GRACE_MS).toBe(120_000);
  });
});

describe("SessionRuntime local-only completion over hand-written frames", () => {
  it("ends hello at its bare agentInvoked:false receipt", async () => {
    const world = openWired(createClock());
    const pending = collectUntilError(world.runtime.prompt("hello"));
    const request = await world.nextPrompt();
    world.child().emitLine(receipt(request.id, false));
    expect(await pending).toEqual({ frames: [receipt(request.id, false)], error: undefined });
  });

  it("ends /x with output and an agentInvoked:true receipt only at the terminal agent_end", async () => {
    const world = openWired(createClock());
    const pending = collectUntilError(world.runtime.prompt("/x"));
    const request = await world.nextPrompt();
    const frames: OmpFrame[] = [
      LATE_OUTPUT,
      receipt(request.id, true),
      { type: "agent_start" },
      { type: "agent_end", isTerminal: false, messages: [] },
    ];
    for (const frame of frames) {
      world.child().emitLine(frame);
    }
    expect(await isOpen(pending)).toBe(true);
    world.child().emitLine(TERMINAL);
    expect(await pending).toEqual({ frames: [...frames, TERMINAL], error: undefined });
  });

  it("ends /a at its first command_output and its timer never ends the next turn", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    const tail = turn.iter.next();
    expect(await isOpen(tail)).toBe(true);
    world.child().emitLine(LATE_OUTPUT);
    expect(await tail).toEqual({ value: LATE_OUTPUT, done: false });
    expect(await turn.iter.next()).toEqual(DONE);
    expect(world.clock.pending()).toBe(1);
    const next = collectUntilError(world.runtime.prompt("hello"));
    const request = await world.nextPrompt();
    world.child().emitLine(receipt(request.id, true));
    await waitImmediate();
    world.clock.advance(120_000);
    expect(await isOpen(next)).toBe(true);
    world.child().emitLine(TERMINAL);
    expect(await next).toEqual({ frames: [receipt(request.id, true), TERMINAL], error: undefined });
    expect(world.clock.pending()).toBe(1);
    expect(world.children).toHaveLength(1);
  });

  it("does not restart the grace on a repeated outcome", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    world.clock.advance(60_000);
    const repeated: OmpFrame = { type: "prompt_result", id: turn.id, agentInvoked: false };
    world.child().emitLine(repeated);
    expect(await turn.iter.next()).toEqual({ value: repeated, done: false });
    const tail = turn.iter.next();
    world.clock.advance(59_999);
    expect(await isOpen(tail)).toBe(true);
    world.clock.advance(1);
    expect(await tail).toEqual(DONE);
    expect(world.clock.pending()).toBe(1);
  });

  it("pushes other frames during the wait and lets them reset idle", async () => {
    const world = openWired(createClock(), 1_000);
    const turn = await openTurn(world, "/a");
    world.clock.advance(900);
    const notice: OmpFrame = { type: "notice", text: "compacting" };
    world.child().emitLine(notice);
    expect(await turn.iter.next()).toEqual({ value: notice, done: false });
    world.clock.advance(900);
    const tail = turn.iter.next();
    expect(await isOpen(tail)).toBe(true);
    expect(world.child().stdin.writableEnded).toBe(false);
    world.child().emitLine(LATE_OUTPUT);
    expect(await tail).toEqual({ value: LATE_OUTPUT, done: false });
    expect(await turn.iter.next()).toEqual(DONE);
  });

  it("ends a waiting turn at a terminal agent_end", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    world.child().emitLine(TERMINAL);
    expect(await turn.iter.next()).toEqual({ value: TERMINAL, done: false });
    expect(await turn.iter.next()).toEqual(DONE);
    expect(world.clock.pending()).toBe(1);
  });

  it("fails a waiting turn on a same-id failure and retires its generation", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    const failure: OmpFrame = {
      id: turn.id,
      type: "response",
      command: "prompt",
      success: false,
      error: "compaction failed",
    };
    world.child().emitLine(failure);
    expect(await turn.iter.next()).toEqual({ value: failure, done: false });
    await expect(turn.iter.next()).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(world.child().stdin.writableEnded).toBe(true);
    expect(world.clock.pending()).toBe(1);
  });
});

describe("SessionRuntime grace timer release", () => {
  it("cancels the grace on idle retirement so it never ends the next generation's turn", async () => {
    const world = openWired(createClock(), 100_000);
    const turn = await openTurn(world, "/a");
    const tail = turn.iter.next();
    world.clock.advance(100_000);
    expect(world.clock.pending()).toBe(1);
    world.child().endStdout();
    world.child().exit(0);
    await expect(tail).rejects.toBeInstanceOf(AgentUnavailableError);
    const next = collectUntilError(world.runtime.prompt("hello"));
    const request = await world.nextPrompt();
    expect(world.children).toHaveLength(2);
    world.child().emitLine(receipt(request.id, true));
    await waitImmediate();
    world.clock.advance(20_000);
    expect(await isOpen(next)).toBe(true);
    world.child().emitLine(TERMINAL);
    expect(await next).toEqual({ frames: [receipt(request.id, true), TERMINAL], error: undefined });
  });

  it("releases the grace when shutdown fails the waiting turn", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    const tail = turn.iter.next();
    const closing = world.runtime.shutdown();
    await expect(tail).rejects.toBeInstanceOf(AgentUnavailableError);
    world.child().endStdout();
    world.child().exit(0);
    await closing;
    expect(world.clock.pending()).toBe(0);
  });

  it("releases the grace when the child crashes during the wait", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    const tail = turn.iter.next();
    world.child().endStdout();
    world.child().exit(1);
    await expect(tail).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(world.clock.pending()).toBe(0);
  });

  it("releases the grace when the consumer abandons the waiting turn", async () => {
    const world = openWired(createClock());
    const turn = await openTurn(world, "/a");
    await requireIteratorReturn(turn.iter)();
    expect(world.child().stdin.writableEnded).toBe(true);
    expect(world.clock.pending()).toBe(1);
  });

  it("re-arms a tick that fires before the wall clock reaches the grace", async () => {
    const clock = manualClock();
    const world = openWired(clock);
    const first = await openTurn(world, "/a");
    expect(clock.delays()).toEqual([120_000, 600_000]);
    clock.nowMs = 119_999;
    clock.fire(120_000);
    const tail = first.iter.next();
    expect(await isOpen(tail)).toBe(true);
    expect(clock.delays()).toEqual([1, 600_000]);
    clock.nowMs = 120_000;
    clock.fire(1);
    expect(await tail).toEqual(DONE);
    expect(clock.delays()).toEqual([600_000]);

    const second = await openTurn(world, "/b");
    clock.nowMs += 119_999;
    clock.fire(120_000);
    expect(clock.delays()).toEqual([1, 600_000]);
    world.child().emitLine(LATE_OUTPUT);
    expect(await second.iter.next()).toEqual({ value: LATE_OUTPUT, done: false });
    expect(await second.iter.next()).toEqual(DONE);
    expect(clock.delays()).toEqual([600_000]);
  });
});

describe("SessionRuntime local-only completion on the real fake (slash)", () => {
  it("ends /todo at its receipt and /compact at its late output on one child", REAL, async () => {
    const world = openReal([]);
    const todo = world.runtime.prompt("/todo");
    const todoFrames = await collectPrompt(todo);
    expect(todoFrames).toEqual([TODO_OUTPUT, receipt((await todo.dispatched).requestId, false)]);
    await expectNormalTurn(world);
    const compact = world.runtime.prompt("/compact");
    const compactFrames = await collectPrompt(compact);
    const compactId = (await compact.dispatched).requestId;
    expect(compactFrames).toEqual([receipt(compactId, false), COMPACT_OUTPUT]);
    await expectNormalTurn(world);
    expect(world.spawns()).toBe(1);
    await world.runtime.shutdown();
  });

  it("ends a silent /compact exactly 120000 ms after its receipt", REAL, async () => {
    const world = openReal(["--compact-silent"]);
    const compact = world.runtime.prompt("/compact");
    const iter = compact[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({
      value: receipt((await compact.dispatched).requestId, false),
      done: false,
    });
    const tail = iter.next();
    world.clock.advance(119_999);
    expect(await settlesWithin(tail, 200)).toBe(false);
    world.clock.advance(1);
    expect(await tail).toEqual(DONE);
    await expectNormalTurn(world);
    expect(world.spawns()).toBe(1);
    await world.runtime.shutdown();
  });
});

interface WiredWorld<C extends SessionClock> {
  runtime: SessionRuntime;
  clock: C;
  children: FakeChild[];
  child(): FakeChild;
  nextPrompt(): Promise<OmpFrame>;
}

/** One FakeChild per spawn (ready + handshake, as omp-runtime-io.test.ts); prompts are queued. */
function openWired<C extends SessionClock>(clock: C, idleMs?: number): WiredWorld<C> {
  const children: FakeChild[] = [];
  const sent: OmpFrame[] = [];
  const waiters: ((frame: OmpFrame) => void)[] = [];
  const runtime = new SessionRuntime({
    sessionId: SESSION_ID,
    ...harness.tempOpts(TOKEN, "omp-local-cmd-"),
    tokens: createTokens(TOKEN),
    clock,
    ...(idleMs === undefined ? {} : { idleMs }),
    spawnImpl: (command, args, options) => {
      const fake = harness.fake();
      fake.emitLine(DEFAULT_READY);
      fake.replyHandshake();
      fake.onCommand("prompt", (frame) => {
        const waiter = waiters.shift();
        if (waiter === undefined) {
          sent.push(frame);
        } else {
          waiter(frame);
        }
      });
      children.push(fake);
      return fake.spawnImpl(command, args, options);
    },
  });
  return {
    runtime,
    clock,
    children,
    child() {
      const last = children[children.length - 1];
      if (last === undefined) {
        throw new Error("no fake child spawned yet");
      }
      return last;
    },
    nextPrompt() {
      const queued = sent.shift();
      return queued === undefined
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve(queued);
    },
  };
}

/** Starts `text`, answers it with a receipt and returns once the iterator has yielded that receipt. */
async function openTurn(
  world: WiredWorld<SessionClock>,
  text: string,
): Promise<{ iter: AsyncIterator<OmpFrame>; id: unknown }> {
  const iter = world.runtime.prompt(text)[Symbol.asyncIterator]();
  const request = await world.nextPrompt();
  expect(request.message).toBe(text);
  world.child().emitLine(receipt(request.id, false));
  expect(await iter.next()).toEqual({ value: receipt(request.id, false), done: false });
  return { iter, id: request.id };
}

interface ManualClock extends SessionClock {
  nowMs: number;
  delays(): number[];
  fire(delay: number): void;
}

/** Wall-clock `now()` set by hand; timers only run when fired, located by their requested delay. */
function manualClock(): ManualClock {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 0;
  const clock: ManualClock = {
    nowMs: 0,
    now: () => clock.nowMs,
    setTimeout(callback, delay) {
      nextId += 1;
      timers.set(nextId, { callback, delay });
      return nextId;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    delays: () => [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b),
    fire(delay) {
      const found = [...timers].find(([, timer]) => timer.delay === delay);
      if (found === undefined) {
        throw new Error(`no timer registered with delay ${String(delay)}`);
      }
      timers.delete(found[0]);
      found[1].callback();
    },
  };
  return clock;
}

function openReal(flags: string[]) {
  const clock = createClock();
  let spawns = 0;
  const spawnImpl: SpawnImpl = (_command, args, options) => {
    spawns += 1;
    return harness.spawnTracked([FAKE, ...args, "--scenario", "slash", ...flags], options);
  };
  const runtime = new SessionRuntime({
    sessionId: SESSION_ID,
    ...harness.tempOpts(TOKEN, "omp-local-real-"),
    tokens: createTokens(TOKEN),
    clock,
    spawnImpl,
  });
  return { runtime, clock, spawns: () => spawns };
}

async function expectNormalTurn(world: { runtime: SessionRuntime }): Promise<void> {
  const frames = await collectPrompt(world.runtime.prompt("hello"));
  expect(frames[0]).toMatchObject({ type: "response", command: "prompt", success: true });
  expect(frames[frames.length - 1]).toEqual(TERMINAL);
}

function receipt(id: unknown, agentInvoked: boolean): OmpFrame {
  return { id, type: "response", command: "prompt", success: true, data: { agentInvoked } };
}

async function isOpen(promise: Promise<unknown>): Promise<boolean> {
  const observation = observePromise(promise);
  await waitImmediate();
  return observation.outcome === "pending";
}
