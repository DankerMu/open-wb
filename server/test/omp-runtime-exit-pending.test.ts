/**
 * Issue #462 SessionRuntime exit reporting, pending-approval idle suspension and approval
 * forwarding (parent s1c-turn-control-governance 2.2a). Oracles: Node's own child exit/signal
 * observation, the injected clock, the token book at callback time, the fake-omp approval scenarios
 * (gated by the production argv `--approval-mode write`) and FakeChild synthetic frames for the two
 * gate branches a real child cannot reach.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  AgentUnavailableError,
  type OmpExit,
  type SpawnImpl,
} from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import type { ApprovalRequest } from "../src/sessions/omp/ui-requests.js";
import { createRealFakeRuntime, type RealFakeRuntime } from "./session-supervisor-helpers.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  DEFAULT_SESSION,
  type FakeChild,
  parseJsonl,
} from "./support/omp-rpc.js";
import {
  type ChildObservation,
  collectPrompt,
  collectUntilError,
  createClock,
  createTokens,
  observeChild,
  settlesWithin,
  type TestClock,
  type TokenBook,
} from "./support/omp-runtime.js";

const SESSION_ID = "sess-exit-pending-462";
const TOKEN = "wb-issue462-secret-token";
const IDLE_MS = 10_000;
const QUIET_MS = 300;
const REAL = { timeout: 20_000 };
const T = "Allow tool: bash\nCommand: echo workbuddy-smoke";
const TERMINAL: OmpFrame = { type: "agent_end", isTerminal: true, messages: [] };
const harness = createRpcHarness();

/** `onExit` snapshot taken inside the callback: the payload plus the token book at that moment. */
interface ExitCall {
  exit: OmpExit;
  live: string | undefined;
  revoked: string[];
}

interface RealWorld {
  runtime: SessionRuntime;
  real: RealFakeRuntime;
  tokens: TokenBook;
  exits: ExitCall[];
  forwarded: ApprovalRequest[];
  stdin: OmpFrame[];
  watches: ChildObservation[];
  argv: string[][];
}

interface RealOptions {
  scenario?: string;
  mark?: boolean;
  bin?: string;
  spawnImpl?: SpawnImpl;
}

/** Real fake-omp children on the production argv (`--approval-mode write` gates approvals). */
function openReal(options: RealOptions = {}): RealWorld {
  const real = createRealFakeRuntime(options.scenario);
  const tokens = createTokens(TOKEN);
  const world: RealWorld = {
    runtime: undefined as unknown as SessionRuntime,
    real,
    tokens,
    exits: [],
    forwarded: [],
    stdin: [],
    watches: [],
    argv: [],
  };
  const base = options.spawnImpl ?? real.runtime.spawnImpl;
  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    world.argv.push([...args]);
    const child = base(command, args, spawnOptions);
    tapStdin(child, world.stdin);
    world.watches.push(observeChild(child));
    return child;
  };
  world.runtime = new SessionRuntime({
    ...real.runtime,
    approvalMode: "write",
    ...(options.bin === undefined ? {} : { bin: options.bin }),
    sessionId: SESSION_ID,
    ownerId: "u1",
    cwd: join(real.runtime.sandboxRoot, "u1"),
    tokens,
    idleMs: IDLE_MS,
    spawnImpl,
    onExit: (exit) => {
      world.exits.push({ exit, live: tokens.live.get(SESSION_ID), revoked: [...tokens.revoked] });
    },
    onApproval: (request) => {
      world.forwarded.push(request);
      if (options.mark === true) {
        world.runtime.markPending(request.id);
      }
    },
  });
  return world;
}

function tapStdin(child: ChildProcessWithoutNullStreams, sink: OmpFrame[]): void {
  const write = child.stdin.write.bind(child.stdin) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;
  child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    sink.push(...parseJsonl(String(chunk)));
    return write(chunk, ...rest);
  }) as typeof child.stdin.write;
}

const realSpawn: SpawnImpl = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.on("error", () => {});
  return child;
};

function watchAt(world: RealWorld, index: number): ChildObservation {
  const watch = world.watches[index];
  if (watch === undefined) {
    throw new Error(`missing child observation ${String(index)}`);
  }
  return watch;
}

/** Generation `index` reported Node's observed exit, after its own token was revoked. */
async function expectReported(world: RealWorld, index: number): Promise<OmpExit> {
  const seen = await watchAt(world, index).exit;
  const call = world.exits[index];
  expect(call?.exit).toEqual(seen);
  expect(call?.live).toBeUndefined();
  expect(call?.revoked).toContain(world.tokens.issued[index]);
  return seen;
}

/** The exited generation stays silent: nothing more after a tick and a final shutdown. */
async function expectNoLateReport(world: RealWorld, count: number): Promise<void> {
  await waitImmediate();
  await world.runtime.shutdown();
  expect(world.exits).toHaveLength(count);
}

/** Generation `index` is neither retiring nor dead over a real-time quiet window. */
async function expectAlive(world: RealWorld, index: number): Promise<void> {
  const watch = watchAt(world, index);
  expect(await settlesWithin(watch.exit, QUIET_MS)).toBe(false);
  expect(watch.stdinEnded).toBe(false);
  expect(watch.signals).toEqual([]);
  expect(world.tokens.live.get(SESSION_ID)).toBe(world.tokens.issued[index]);
}

/** From now, generation `index` survives IDLE_MS - 1 and is retired at exactly IDLE_MS. */
async function expectFullIdle(world: RealWorld, index: number): Promise<OmpExit> {
  world.real.clock.advance(IDLE_MS - 1);
  await expectAlive(world, index);
  world.real.clock.advance(1);
  return expectReported(world, index);
}

async function runTurn(world: RealWorld, text = "turn"): Promise<OmpFrame[]> {
  return collectPrompt(world.runtime.prompt(text));
}

async function iterateTo(
  runtime: SessionRuntime,
  wanted: (frame: OmpFrame) => boolean,
  text = "run the tool",
): Promise<AsyncIterator<OmpFrame>> {
  const iterator = runtime.prompt(text)[Symbol.asyncIterator]();
  let step = await iterator.next();
  while (step.done !== true && !wanted(step.value)) {
    step = await iterator.next();
  }
  if (step.done === true) {
    throw new Error("turn ended before the awaited frame");
  }
  return iterator;
}

async function drain(iterator: AsyncIterator<OmpFrame>): Promise<OmpFrame[]> {
  const frames: OmpFrame[] = [];
  for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
    frames.push(step.value);
  }
  return frames;
}

function pendingNext(iterator: AsyncIterator<OmpFrame>): Promise<IteratorResult<OmpFrame>> {
  const next = iterator.next();
  void next.catch(() => {});
  return next;
}

function externalKill(watch: ChildObservation): void {
  const pid = watch.child.pid;
  if (pid === undefined) {
    throw new Error("child has no pid");
  }
  process.kill(pid, "SIGKILL");
}

const isUi =
  (id: string) =>
  (frame: OmpFrame): boolean =>
    frame.type === "extension_ui_request" && frame.id === id;

/** omp v18.0.10 (#620): tool-1's start follows the r1 select unanswered, the last frame before r1 is answered. */
async function iterateToR1Start(runtime: SessionRuntime): Promise<AsyncIterator<OmpFrame>> {
  const iterator = await iterateTo(runtime, isUi("r1"));
  const start = await iterator.next();
  expect(start.value).toMatchObject({ type: "tool_execution_start", toolCallId: "tool-1" });
  return iterator;
}

const isPromptAck = (frame: OmpFrame): boolean =>
  frame.type === "response" && frame.command === "prompt";

const uiAnswers = (frames: OmpFrame[]): OmpFrame[] =>
  frames.filter((frame) => frame.type === "extension_ui_response");

const approvalSelect = (id: string): OmpFrame => ({
  type: "extension_ui_request",
  id,
  method: "select",
  title: T,
  options: ["Approve", "Deny"],
});

describe("SessionRuntime reports every native exit once, after revocation", () => {
  it("X1 reports idle expiry with the observed EOF exit", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    world.real.clock.advance(IDLE_MS - 1);
    await expectAlive(world, 0);
    expect(world.exits).toEqual([]);
    world.real.clock.advance(1);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
    expect(watchAt(world, 0).signals).toEqual([]);
    expect(world.exits).toHaveLength(1);
    await expectNoLateReport(world, 1);
  });

  it("X2 reports a shutdown during an active turn before shutdown resolves", REAL, async () => {
    const world = openReal({ scenario: "hang-prompt" });
    const iterator = await iterateTo(world.runtime, isPromptAck);
    const next = pendingNext(iterator);
    await world.runtime.shutdown();
    expect(world.exits).toHaveLength(1);
    await expect(next).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
    await expectNoLateReport(world, 1);
  });

  it("X3 reports an external retirement between turns", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    await world.runtime.shutdown();
    expect(world.exits).toHaveLength(1);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
    expect(watchAt(world, 0).signals).toEqual([]);
    await expectNoLateReport(world, 1);
  });

  it("X4 reports a crash during a turn", REAL, async () => {
    const world = openReal({ scenario: "crash" });
    const crashed = await collectUntilError(world.runtime.prompt("crash"));
    expect(crashed.error).toBeInstanceOf(AgentUnavailableError);
    expect(await expectReported(world, 0)).toEqual({ code: 2, signal: null });
    expect(world.exits).toHaveLength(1);
    await expectNoLateReport(world, 1);
  });

  it("X5 reports a crash between turns and resumes without re-reporting", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    const first = watchAt(world, 0);
    externalKill(first);
    expect(await expectReported(world, 0)).toEqual({ code: null, signal: "SIGKILL" });
    expect(first.signals).toEqual([]);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    await runTurn(world, "after crash");
    const resumed = world.argv[1] ?? [];
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("/tmp/open-wb-fake-session.jsonl");
    expect(world.exits).toHaveLength(1);
    await expectNoLateReport(world, 2);
    expect(await expectReported(world, 1)).toEqual({ code: 0, signal: null });
  });

  it("X6 reports an eviction-style retirement that escalates to SIGKILL", REAL, async () => {
    const world = openReal({ scenario: "hang-term" });
    await runTurn(world);
    const watch = watchAt(world, 0);
    const closing = world.runtime.shutdown();
    world.real.clock.advance(5_000);
    await waitImmediate();
    expect(watch.signals).toEqual(["SIGTERM"]);
    world.real.clock.advance(2_999);
    await waitImmediate();
    expect(watch.signals).toEqual(["SIGTERM"]);
    expect(world.exits).toEqual([]);
    world.real.clock.advance(1);
    expect(await expectReported(world, 0)).toEqual({ code: null, signal: "SIGKILL" });
    await closing;
    expect(world.exits).toHaveLength(1);
    await expectNoLateReport(world, 1);
  });

  it("X7 never reports a generation that obtained no pid", REAL, async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-exit-absent-"));
    harness.temps.push(dir);
    // ENOENT arrives as error + close(-2, null), never 'exit'; the close is a later macrotask, so it
    // is captured at spawn time and awaited before asserting that no onExit happened.
    let closed: Promise<unknown> | undefined;
    const absent: SpawnImpl = (command, args, options) => {
      const child = realSpawn(command, args, options);
      // Not events.once: it rejects on the 'error' (ENOENT) that precedes this close.
      closed = new Promise((resolve) => {
        child.once("close", (code, signal) => {
          resolve([code, signal]);
        });
      });
      return child;
    };
    const refuse: SpawnImpl = () => {
      throw new Error("spawnImpl refused before a child existed");
    };
    const cases: RealOptions[] = [
      { bin: join(dir, "absent-omp"), spawnImpl: absent },
      { spawnImpl: refuse },
    ];
    for (const options of cases) {
      closed = undefined;
      const world = openReal(options);
      const failed = await collectUntilError(world.runtime.prompt("boot"));
      expect(failed.error).toBeInstanceOf(AgentUnavailableError);
      expect(world.real.clock.nowMs).toBe(0);
      await world.runtime.shutdown();
      if (options.spawnImpl === absent) {
        expect(await closed).toEqual([-2, null]);
        await waitImmediate();
      }
      expect(world.exits).toEqual([]);
    }
  });

  it("X8 reports a startup failure after the child obtained a pid", REAL, async () => {
    const world = openReal({ scenario: "missing-session" });
    const failed = await collectUntilError(world.runtime.prompt("boot"));
    expect(failed.error).toBeInstanceOf(AgentUnavailableError);
    await expectReported(world, 0);
    expect(world.exits).toHaveLength(1);
    await expectNoLateReport(world, 1);
  });

  it("X9 reports each generation exactly once, in generation order", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    world.real.clock.advance(IDLE_MS);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
    await runTurn(world, "second generation");
    await world.runtime.shutdown();
    expect(await expectReported(world, 1)).toEqual({ code: 0, signal: null });
    expect(world.exits).toHaveLength(2);
    const [issued0, issued1] = world.tokens.issued;
    expect(world.exits.map((call) => call.revoked)).toEqual([[issued0], [issued0, issued1]]);
    await expectNoLateReport(world, 2);
  });
});

describe("SessionRuntime pending approvals suspend idle expiry", () => {
  it(
    "P1 keeps a child with one pending approval, then retires a full idle after clear",
    REAL,
    async () => {
      const world = openReal({ scenario: "approval", mark: true });
      const iterator = await iterateToR1Start(world.runtime);
      const next = pendingNext(iterator);
      const argv = world.argv[0] ?? [];
      expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("write");
      world.real.clock.advance(30_000);
      await expectAlive(world, 0);
      expect(world.exits).toEqual([]);
      world.runtime.clearPending("r1");
      expect(await expectFullIdle(world, 0)).toEqual({ code: 0, signal: null });
      expect(world.exits).toHaveLength(1);
      await expect(next).rejects.toBeInstanceOf(AgentUnavailableError);
      expect(uiAnswers(world.stdin)).toEqual([]);
    },
  );

  it("P2 stays suspended until the last of two parallel approvals is cleared", REAL, async () => {
    const world = openReal({ scenario: "approval-parallel", mark: true });
    await iterateTo(world.runtime, isUi("r2"));
    expect(world.forwarded.map((request) => request.id)).toEqual(["r1", "r2"]);
    world.runtime.clearPending("r1");
    world.runtime.clearPending("r1");
    world.real.clock.advance(30_000);
    await expectAlive(world, 0);
    world.runtime.clearPending("r2");
    await expectFullIdle(world, 0);
    expect(world.exits).toHaveLength(1);
    expect(uiAnswers(world.stdin)).toEqual([]);
  });

  it("P3a treats a repeated mark as one set member, not a reference count", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    world.runtime.markPending("a1");
    world.runtime.markPending("a1");
    world.runtime.clearPending("a1");
    expect(await expectFullIdle(world, 0)).toEqual({ code: 0, signal: null });
  });

  it("P3b does not re-arm the timer when clearing an id that is not pending", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    world.real.clock.advance(IDLE_MS - 1);
    world.runtime.clearPending("never");
    world.real.clock.advance(1);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
  });

  it("P4 ignores prompt and frame activity while an approval is pending", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    await runTurn(world);
    world.runtime.markPending("a1");
    await runTurn(world, "activity while pending");
    world.real.clock.advance(30_000);
    await expectAlive(world, 0);
    expect(world.exits).toEqual([]);
    world.runtime.clearPending("a1");
    expect(await expectFullIdle(world, 0)).toEqual({ code: 0, signal: null });
  });

  it("P5 discards pending ids with their generation", REAL, async () => {
    const world = openReal({ scenario: "normal" });
    expect(() => {
      world.runtime.markPending("a0");
    }).not.toThrow();
    expect(world.argv).toHaveLength(0);
    expect(world.tokens.issued).toEqual([]);
    await runTurn(world);
    world.runtime.markPending("a1");
    externalKill(watchAt(world, 0));
    expect(await expectReported(world, 0)).toEqual({ code: null, signal: "SIGKILL" });
    await runTurn(world, "second generation");
    world.real.clock.advance(IDLE_MS - 1);
    await expectAlive(world, 1);
    world.runtime.clearPending("a1");
    world.real.clock.advance(1);
    expect(await expectReported(world, 1)).toEqual({ code: 0, signal: null });
    expect(world.exits).toHaveLength(2);
  });
});

describe("SessionRuntime forwards approvals of the active turn and passes answers through", () => {
  it("F1 forwards the real r1 request once, unchanged, and answers nothing", REAL, async () => {
    const world = openReal({ scenario: "approval" });
    const iterator = await iterateToR1Start(world.runtime);
    expect(world.forwarded).toEqual([{ id: "r1", title: T, tool: "bash" }]);
    expect(await settlesWithin(pendingNext(iterator), QUIET_MS)).toBe(false);
    expect(uiAnswers(world.stdin)).toEqual([]);
    expect(world.forwarded).toHaveLength(1);
  });

  it("F4 writes the owner's answer synchronously and the turn completes", REAL, async () => {
    const world = openReal({ scenario: "approval" });
    const iterator = await iterateTo(world.runtime, isUi("r1"));
    expect(world.forwarded).toEqual([{ id: "r1", title: T, tool: "bash" }]);
    world.runtime.respondApproval("r1", "allow");
    expect(uiAnswers(world.stdin)).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Approve" },
    ]);
    const rest = await drain(iterator);
    const toolEnd = rest.find((frame) => frame.type === "tool_execution_end");
    expect(toolEnd).toMatchObject({ toolCallId: "tool-1" });
    expect(toolEnd).not.toHaveProperty("isError");
    expect(rest.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
      true,
    );
    world.runtime.respondApproval("r1", "deny");
    expect(uiAnswers(world.stdin)).toHaveLength(1);
    const second = await runTurn(world, "second prompt");
    expect(second.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
      true,
    );
    expect(world.argv).toHaveLength(1);
  });

  it("F5a respondApproval before any generation writes, throws and spawns nothing", async () => {
    const world = openReal({ scenario: "approval" });
    expect(() => {
      world.runtime.respondApproval("r1", "allow");
    }).not.toThrow();
    expect(world.argv).toHaveLength(0);
    expect(world.tokens.issued).toEqual([]);
  });

  it("F5b respondApproval while retiring and after shutdown is a silent no-op", REAL, async () => {
    const world = openReal({ scenario: "approval" });
    await iterateTo(world.runtime, isUi("r1"));
    expect(world.forwarded.map((request) => request.id)).toEqual(["r1"]);
    let closing: Promise<void> = Promise.resolve();
    expect(() => {
      closing = world.runtime.shutdown();
      world.runtime.respondApproval("r1", "allow");
    }).not.toThrow();
    await closing;
    expect(() => {
      world.runtime.respondApproval("r1", "deny");
    }).not.toThrow();
    expect(uiAnswers(world.stdin)).toEqual([]);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
    expect(watchAt(world, 0).signals).toEqual([]);
    expect(world.argv).toHaveLength(1);
  });

  it("F6 forwarding alone does not suspend idle expiry", REAL, async () => {
    const world = openReal({ scenario: "approval" });
    await iterateTo(world.runtime, isUi("r1"));
    expect(world.forwarded.map((request) => request.id)).toEqual(["r1"]);
    world.real.clock.advance(IDLE_MS);
    expect(await expectReported(world, 0)).toEqual({ code: 0, signal: null });
    expect(world.exits).toHaveLength(1);
    expect(uiAnswers(world.stdin)).toEqual([]);
  });
});

interface WiredWorld {
  runtime: SessionRuntime;
  clock: TestClock;
  tokens: TokenBook;
  children: FakeChild[];
  forwarded: ApprovalRequest[];
  answers: OmpFrame[];
}

/**
 * FakeChild generations per omp-runtime-io.test.ts: ready + handshake + auto-ACKed prompts;
 * `plan[n]` then adjusts the n-th child (pid-less, custom get_state).
 */
function openWired(plan: ((child: FakeChild) => void)[]): WiredWorld {
  const clock = createClock();
  const tokens = createTokens(TOKEN);
  const world: WiredWorld = {
    runtime: undefined as unknown as SessionRuntime,
    clock,
    tokens,
    children: [],
    forwarded: [],
    answers: [],
  };
  world.runtime = new SessionRuntime({
    sessionId: SESSION_ID,
    ...harness.tempOpts(TOKEN, "omp-exit-wired-"),
    tokens,
    idleMs: IDLE_MS,
    clock,
    spawnImpl: (command, args, options) => {
      const child = harness.fake();
      child.emitLine(DEFAULT_READY);
      child.replyHandshake();
      child.onCommand("prompt", (frame) => {
        child.emitLine({
          id: frame.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
      });
      child.onCommand("extension_ui_response", (frame) => {
        world.answers.push(frame);
      });
      plan[world.children.length]?.(child);
      world.children.push(child);
      return child.spawnImpl(command, args, options);
    },
    onApproval: (request) => {
      world.forwarded.push(request);
    },
  });
  return world;
}

function childAt(world: WiredWorld, index: number): FakeChild {
  const child = world.children[index];
  if (child === undefined) {
    throw new Error(`missing fake child ${String(index)}`);
  }
  return child;
}

const pidless = (child: FakeChild): void => {
  (child as { pid: number | undefined }).pid = undefined;
  child.kill = () => false;
};

describe("SessionRuntime approval gate over synthetic frames", () => {
  it("F2 drops approvals from a generation that is no longer current", async () => {
    const world = openWired([pidless]);
    const first = await iterateTo(world.runtime, isPromptAck, "one");
    const stale = childAt(world, 0);
    world.clock.advance(IDLE_MS);
    await waitImmediate();
    expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
    stale.emitLine(approvalSelect("rA"));
    await waitImmediate();
    expect(world.forwarded).toEqual([]);
    await first.return?.();
    const second = await iterateTo(world.runtime, isPromptAck, "two");
    childAt(world, 1).emitLine(approvalSelect("rB"));
    const reached = await second.next();
    expect(reached.value).toMatchObject({ type: "extension_ui_request", id: "rB" });
    expect(world.forwarded.map((request) => request.id)).toEqual(["rB"]);
    stale.emitLine(approvalSelect("rA2"));
    await waitImmediate();
    expect(world.forwarded.map((request) => request.id)).toEqual(["rB"]);
    expect(world.answers).toEqual([]);
  });

  it("F3 drops approvals outside the current generation's sent turn", async () => {
    const early = (child: FakeChild): void => {
      child.onCommand("get_state", (frame) => {
        child.emitLine(approvalSelect("rEarly"));
        child.emitLine({
          id: frame.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionFile: DEFAULT_SESSION },
        });
      });
    };
    const world = openWired([() => {}, early]);
    // (a) between turns on the current generation.
    const beforeA = world.forwarded.length;
    const one = await iterateTo(world.runtime, isPromptAck, "one");
    const idle = childAt(world, 0);
    idle.emitLine(TERMINAL);
    await drain(one);
    idle.emitLine(approvalSelect("rIdle"));
    await waitImmediate();
    expect.soft(world.forwarded.slice(beforeA).map((request) => request.id)).toEqual([]);
    idle.exit(0);
    // (b) the next generation surfaces rEarly during get_state, before its turn is bound or sent.
    const beforeB = world.forwarded.length;
    const two = await iterateTo(world.runtime, isPromptAck, "two");
    const current = childAt(world, 1);
    current.emitLine(TERMINAL);
    await drain(two);
    expect.soft(world.forwarded.slice(beforeB).map((request) => request.id)).toEqual([]);
    // (c) positive control: the sent turn of the current generation is forwarded.
    const beforeC = world.forwarded.length;
    const three = await iterateTo(world.runtime, isPromptAck, "three");
    current.emitLine(approvalSelect("rTurn"));
    expect((await three.next()).value).toMatchObject({ id: "rTurn" });
    expect(world.forwarded.slice(beforeC).map((request) => request.id)).toEqual(["rTurn"]);
    expect(world.forwarded.map((request) => request.id)).toEqual(["rTurn"]);
    expect(world.answers).toEqual([]);
  });
});

describe("runtime source boundary toward ui-requests", () => {
  const sessionsRoot = fileURLToPath(new URL("../src/sessions/", import.meta.url));
  const source = (relative: string): string => readFileSync(join(sessionsRoot, relative), "utf8");
  const statementsOf = (text: string, path: RegExp["source"]): string[] =>
    text.match(new RegExp(`\\b(?:import|export)\\b[^;]*?${path}\\s*\\)?\\s*;`, "g")) ?? [];

  it("G1 runtime.ts and commands.ts reach ui-requests.js only through statement-level import type", () => {
    for (const name of ["omp/runtime.ts", "omp/commands.ts"]) {
      const text = source(name);
      for (const statement of statementsOf(text, `["']\\./ui-requests\\.js["']`)) {
        expect(statement, name).toMatch(/^import type\b/u);
      }
      expect(text, name).not.toMatch(/import\s*["']\.\/ui-requests\.js["']/u);
      expect(text, name).not.toMatch(/import\s*\(\s*["']\.\/ui-requests\.js["']/u);
      expect(text, name).not.toMatch(/export\b[^;]*?from\s*["']\.\/ui-requests\.js["']/u);
      expect(text, name).not.toMatch(/\b(?:answerFrame|cancelFrame|approvalRequest)\b/u);
    }
  });

  it("G2 no other sessions module value-imports ui-requests.js or spells the answer frame", () => {
    const files = readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" })
      .map((file) => file.split(sep).join("/"))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => file !== "omp/process.ts" && file !== "omp/ui-requests.ts");
    expect(files).toContain("omp/runtime.ts");
    expect(files).toContain("supervisor.ts");
    for (const file of files) {
      const text = source(file);
      for (const statement of statementsOf(text, `["'][^"']*ui-requests\\.js["']`)) {
        expect(statement, file).toMatch(/^import type\b/u);
      }
      expect(text, file).not.toMatch(/extension_ui_response/u);
    }
  });
});
