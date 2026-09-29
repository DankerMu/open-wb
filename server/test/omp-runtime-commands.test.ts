/**
 * Issue #488 SessionRuntime correlated `command(frame)` and in-turn `abort()` (parent
 * s1c-turn-control-governance 2.2b). Oracles: the real fake-omp scenarios (`abort-ok`,
 * `slow-ready`, `branch`, `normal`, `hang-prompt`, `slash --compact-silent`) observed through a
 * stdin tap, argv, the probe `frames=` record and Node's own exit; FakeChild only for the three
 * windows a real child cannot hold open (held prompt write, native exit with stdout open, a
 * command the child never answers).
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as waitImmediate, setTimeout as waitTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  AgentUnavailableError,
  type OmpExit,
  type SpawnImpl,
} from "../src/sessions/omp/process.js";
import { SessionBusyError, SessionRuntime } from "../src/sessions/omp/runtime.js";
import { createRealFakeRuntime, type RealFakeRuntime } from "./session-supervisor-helpers.js";
import {
  asRecord,
  createRpcHarness,
  DEFAULT_READY,
  DEFAULT_SESSION,
  type FakeChild,
  holdNextPromptWrite,
  observePromise,
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

const SESSION_ID = "sess-runtime-commands-488";
const TOKEN = "wb-issue488-secret-token";
const IDLE_MS = 10_000;
const REAL = { timeout: 20_000 };
const ABORTED_END: OmpFrame = {
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "aborted" },
};
const TERMINAL: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
const BRANCH_MESSAGES = [
  { entryId: "fake-entry-1", text: "first question" },
  { entryId: "fake-entry-2", text: "second question" },
];
const harness = createRpcHarness();

/** One stdin write: the frame plus how many tokens the owner had issued at that moment. */
interface Written {
  frame: OmpFrame;
  issued: number;
}

interface RealWorld {
  runtime: SessionRuntime;
  real: RealFakeRuntime;
  tokens: TokenBook;
  exits: OmpExit[];
  stdin: Written[];
  watches: ChildObservation[];
  argv: string[][];
}

interface RealOptions {
  idleMs?: number;
  resumePath?: string;
  extraArgs?: string[];
}

/** Real fake-omp children; argv recorded before the helper appends `--scenario`. */
function openReal(scenario: string, options: RealOptions = {}): RealWorld {
  const real = createRealFakeRuntime(scenario);
  const tokens = createTokens(TOKEN);
  const world: RealWorld = {
    runtime: undefined as unknown as SessionRuntime,
    real,
    tokens,
    exits: [],
    stdin: [],
    watches: [],
    argv: [],
  };
  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    world.argv.push([...args]);
    const child = real.runtime.spawnImpl(
      command,
      [...args, ...(options.extraArgs ?? [])],
      spawnOptions,
    );
    tapStdin(child, world);
    world.watches.push(observeChild(child));
    return child;
  };
  world.runtime = new SessionRuntime({
    ...real.runtime,
    sessionId: SESSION_ID,
    ownerId: "u1",
    tokens,
    idleMs: options.idleMs ?? IDLE_MS,
    resumePath: options.resumePath ?? null,
    spawnImpl,
    onExit: (exit) => {
      world.exits.push(exit);
    },
  });
  return world;
}

/** Records every stdin frame with the owner's issued-token count at write time. */
function tapStdin(child: ChildProcessWithoutNullStreams, world: RealWorld): void {
  const original = child.stdin.write;
  const tapped = (...args: unknown[]): boolean => {
    const issued = world.tokens.issued.length;
    world.stdin.push(...parseJsonl(String(args[0])).map((frame) => ({ frame, issued })));
    return Reflect.apply(original, child.stdin, args) as boolean;
  };
  child.stdin.write = tapped as typeof child.stdin.write;
}

function written(world: RealWorld, type: string): OmpFrame[] {
  return world.stdin.map((entry) => entry.frame).filter((frame) => frame.type === type);
}

function writtenTypes(world: RealWorld): string[] {
  return world.stdin.map((entry) => String(entry.frame.type));
}

interface FakeWorld {
  runtime: SessionRuntime;
  child: FakeChild;
  clock: TestClock;
  tokens: TokenBook;
  exits: OmpExit[];
  inbound: OmpFrame[];
  spawns: number;
}

/** FakeChild wired world: handshake and every `get_state` answered; prompt/abort/branch reads recorded, never answered. Each respawn gets a fresh child. */
function openFake(): FakeWorld {
  const inbound: OmpFrame[] = [];
  const bind = (child: FakeChild): FakeChild => {
    child.emitLine(DEFAULT_READY);
    child.replyHandshake();
    for (const type of ["prompt", "abort", "get_branch_messages"]) {
      child.onCommand(type, (frame) => {
        inbound.push(frame);
      });
    }
    return child;
  };
  const world: FakeWorld = {
    runtime: undefined as unknown as SessionRuntime,
    child: bind(harness.fake()),
    clock: createClock(),
    tokens: createTokens(TOKEN),
    exits: [],
    inbound,
    spawns: 0,
  };
  world.runtime = new SessionRuntime({
    sessionId: SESSION_ID,
    ...harness.tempOpts(TOKEN, "omp-rt-commands-"),
    tokens: world.tokens,
    idleMs: IDLE_MS,
    clock: world.clock,
    spawnImpl: (command, args, options) => {
      world.spawns += 1;
      if (world.spawns > 1) {
        world.child = bind(harness.fake());
      }
      return world.child.spawnImpl(command, args, options);
    },
    onExit: (exit) => {
      world.exits.push(exit);
    },
  });
  return world;
}

async function until(predicate: () => boolean, ms = 8_000): Promise<void> {
  for (let waited = 0; !predicate(); waited += 5) {
    if (waited >= ms) {
      throw new Error("timed out waiting for condition");
    }
    await waitTimeout(5);
  }
}

function isDelta(frame: OmpFrame): boolean {
  return (
    frame.type === "message_update" && asRecord(frame.assistantMessageEvent).type === "text_delta"
  );
}

async function untilDeltas(iterator: AsyncIterator<OmpFrame>, count: number): Promise<OmpFrame[]> {
  const frames: OmpFrame[] = [];
  while (frames.filter(isDelta).length < count) {
    const next = await iterator.next();
    if (next.done === true) {
      throw new Error("turn ended before the expected deltas");
    }
    frames.push(next.value);
  }
  return frames;
}

async function drain(iterator: AsyncIterator<OmpFrame>): Promise<OmpFrame[]> {
  const frames: OmpFrame[] = [];
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
    frames.push(next.value);
  }
  return frames;
}

function mustAbort(runtime: SessionRuntime): Promise<OmpFrame> {
  const pending = runtime.abort();
  if (pending === false) {
    throw new Error("abort() returned false on an active dispatched turn");
  }
  return pending;
}

/** Probe turn: the fake's per-process inbound `frames=` record. */
async function probeFrames(runtime: SessionRuntime): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "omp-rt-commands-probe-"));
  harness.temps.push(dir);
  const frames = await collectPrompt(
    runtime.prompt(`probe:${String(process.pid)}:${dir}/probe.txt`),
  );
  const text = String(asRecord(frames.find(isDelta)?.assistantMessageEvent).delta);
  return / frames=(\S*) cwd=/u.exec(text)?.[1] ?? `<no frames= in ${text}>`;
}

/** A following prompt completes on the one existing generation; then the runtime shuts down. */
async function expectSameGeneration(world: RealWorld, text: string): Promise<void> {
  const frames = await collectPrompt(world.runtime.prompt(text));
  expect(frames.at(-1)).toMatchObject({ type: "agent_end" });
  expect(world.argv).toHaveLength(1);
  expect(world.tokens.issued).toHaveLength(1);
  await world.runtime.shutdown();
}

function persistedPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-rt-commands-resume-"));
  harness.temps.push(dir);
  return join(dir, "persisted.jsonl");
}

describe("SessionRuntime abort()", () => {
  it(
    "A1 abort on an active abort-ok turn writes one frame after prompt and resolves with the correlated response",
    REAL,
    async () => {
      const world = openReal("abort-ok");
      const turn = world.runtime.prompt("hi");
      const iterator = turn[Symbol.asyncIterator]();
      await turn.dispatched;
      const head = await untilDeltas(iterator, 2);

      const pending = world.runtime.abort();
      expect(pending).toBeInstanceOf(Promise);
      const rest = await drain(iterator);

      expect(rest.slice(-2)).toEqual([ABORTED_END, TERMINAL]);
      expect([...head, ...rest].filter((frame) => frame.command === "abort")).toEqual([]);
      const aborts = written(world, "abort");
      expect(aborts).toHaveLength(1);
      expect(writtenTypes(world).indexOf("abort")).toBeGreaterThan(
        writtenTypes(world).indexOf("prompt"),
      );
      await expect(pending).resolves.toEqual({
        id: aborts[0]?.id,
        type: "response",
        command: "abort",
        success: true,
      });
      expect(world.runtime.abort()).toBe(false);
      expect(written(world, "abort")).toHaveLength(1);

      await expectSameGeneration(world, "next");
    },
  );

  it("A2 returns false while the prompt write is held and writes abort only after the receipt", async () => {
    const world = openFake();
    const held = holdNextPromptWrite(world.child);
    const turn = world.runtime.prompt("x");
    const iterator = turn[Symbol.asyncIterator]();
    await held.entered;

    expect(world.runtime.abort()).toBe(false);
    await waitImmediate();
    expect(world.inbound).toEqual([]);

    held.release();
    await turn.dispatched;
    const pending = world.runtime.abort();
    expect(pending).toBeInstanceOf(Promise);
    // #650: the abort frame waits for the turn's agent_start.
    world.child.emitLine({ type: "agent_start" });
    await until(() => world.inbound.length === 2);
    expect(world.inbound.map((frame) => frame.type)).toEqual(["prompt", "abort"]);
    expect(await iterator.next()).toEqual({ done: false, value: { type: "agent_start" } });

    const abortId = String(world.inbound[1]?.id);
    const response = { id: abortId, type: "response", command: "abort", success: true };
    world.child.emitLine(ABORTED_END);
    world.child.emitLine(TERMINAL);
    world.child.emitLine(response);
    expect(await drain(iterator)).toEqual([ABORTED_END, TERMINAL]);
    await expect(pending).resolves.toEqual(response);
  });

  it(
    "A3 slow-ready: false before the receipt, then one abort after prompt; frames= proves the order",
    REAL,
    async () => {
      const world = openReal("slow-ready");
      const turn = world.runtime.prompt("stop me");
      const iterator = turn[Symbol.asyncIterator]();
      const receipt = observePromise(turn.dispatched);
      expect(world.runtime.abort()).toBe(false);

      await until(() => world.real.children.length === 1);
      expect(receipt.outcome).toBe("pending");
      expect(world.runtime.abort()).toBe(false);
      expect(written(world, "abort")).toEqual([]);

      await turn.dispatched;
      const pending = mustAbort(world.runtime);
      expect((await drain(iterator)).slice(-2)).toEqual([ABORTED_END, TERMINAL]);
      const aborts = written(world, "abort");
      expect(aborts).toHaveLength(1);
      await expect(pending).resolves.toEqual({
        id: aborts[0]?.id,
        type: "response",
        command: "abort",
        success: true,
      });

      expect(await probeFrames(world.runtime)).toBe(
        "negotiate_protocol,get_state,prompt,abort,prompt",
      );
      expect(world.argv).toHaveLength(1);
      expect(world.tokens.issued).toHaveLength(1);
      await world.runtime.shutdown();
    },
  );

  it("A4 the abort response alone does not end a /compact turn awaiting output", REAL, async () => {
    const world = openReal("slash", { idleMs: 600_000, extraArgs: ["--compact-silent"] });
    const turn = world.runtime.prompt("/compact");
    const iterator = turn[Symbol.asyncIterator]();
    const receipt = await iterator.next();
    expect(receipt.value).toMatchObject({
      type: "response",
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    await turn.dispatched;

    const pending = mustAbort(world.runtime);
    const response = await pending;
    const aborts = written(world, "abort");
    expect(aborts).toHaveLength(1);
    expect(response).toEqual({
      id: aborts[0]?.id,
      type: "response",
      command: "abort",
      success: true,
    });
    expect(await iterator.next()).toEqual({ done: false, value: response });

    const end = iterator.next();
    const observed = observePromise(end);
    expect(await settlesWithin(end, 300)).toBe(false);
    world.real.clock.advance(119_999);
    await waitImmediate();
    expect(observed.outcome).toBe("pending");
    world.real.clock.advance(1);
    expect(await end).toEqual({ done: true, value: undefined });

    await expectSameGeneration(world, "hello");
  });

  it(
    "A5 without an active turn abort() is false: fresh, between turns and after shutdown",
    REAL,
    async () => {
      const world = openReal("normal");
      expect(world.runtime.abort()).toBe(false);
      expect(world.argv).toHaveLength(0);
      expect(world.tokens.issued).toEqual([]);

      await collectPrompt(world.runtime.prompt("hi"));
      expect(world.runtime.abort()).toBe(false);
      expect(written(world, "abort")).toEqual([]);

      await world.runtime.shutdown();
      expect(world.runtime.abort()).toBe(false);
      expect(written(world, "abort")).toEqual([]);
      expect(world.argv).toHaveLength(1);
    },
  );

  it(
    "A6 a dispatched turn on a retiring generation gets false and ends on the failure path",
    REAL,
    async () => {
      const world = openReal("hang-prompt");
      const turn = world.runtime.prompt("x");
      const iterator = turn[Symbol.asyncIterator]();
      await turn.dispatched;
      expect((await iterator.next()).value).toMatchObject({ type: "response", command: "prompt" });

      world.real.clock.advance(IDLE_MS);
      expect(world.runtime.abort()).toBe(false);
      expect(written(world, "abort")).toEqual([]);

      const settled = await collectUntilError({ [Symbol.asyncIterator]: () => iterator });
      expect(settled.error).toBeInstanceOf(AgentUnavailableError);
      expect(await world.watches[0]?.exit).toEqual({ code: 0, signal: null });
      expect(world.exits).toEqual([{ code: 0, signal: null }]);
      expect(written(world, "abort")).toEqual([]);
      await world.runtime.shutdown();
    },
  );

  it("A7 a dispatched turn whose child exited natively with stdout open gets false", async () => {
    const world = openFake();
    const turn = world.runtime.prompt("x");
    await until(() => world.inbound.length === 1);
    const promptId = String(world.inbound[0]?.id);
    world.child.emitLine({ id: promptId, type: "response", command: "prompt", success: true });
    await turn.dispatched;
    world.child.nativeExit(0);
    await waitImmediate();

    expect(world.runtime.abort()).toBe(false);
    await waitImmediate();
    expect(world.inbound.map((frame) => frame.type)).toEqual(["prompt"]);
    expect(world.tokens.live.get(SESSION_ID)).toBeUndefined();
    expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
    expect(world.exits).toEqual([{ code: 0, signal: null }]);

    world.child.endStdout();
    expect((await collectUntilError(turn)).error).toBeInstanceOf(AgentUnavailableError);
  });
});

describe("SessionRuntime command()", () => {
  it(
    "C1 a command on an idle runtime acquires like prompt: one issue before the frame, --resume kept",
    REAL,
    async () => {
      const persisted = persistedPath();
      const world = openReal("branch", { resumePath: persisted });
      await expect(world.runtime.command({ type: "get_branch_messages" })).resolves.toEqual({
        messages: BRANCH_MESSAGES,
      });
      const sent = world.stdin.find((entry) => entry.frame.type === "get_branch_messages");
      expect(sent?.issued).toBe(1);
      expect(world.argv[0]?.slice(-2)).toEqual(["--resume", persisted]);

      await expectSameGeneration(world, "hi");
    },
  );

  it(
    "C2 branch then get_state adopts the new session file as the next --resume path",
    REAL,
    async () => {
      const persisted = persistedPath();
      const world = openReal("branch", { resumePath: persisted });
      await expect(
        world.runtime.command({ type: "branch", entryId: "fake-entry-2" }),
      ).resolves.toEqual({ text: "second question", cancelled: false });
      const state = asRecord(await world.runtime.command({ type: "get_state" }));
      const branched = String(state.sessionFile);
      expect(branched).not.toBe(persisted);
      expect(dirname(branched)).toBe(join(world.real.runtime.stateDir, "sessions", "u1"));
      expect(existsSync(branched)).toBe(true);
      expect(world.runtime.sessionFile).toBe(branched);

      world.real.clock.advance(IDLE_MS);
      expect(await world.watches[0]?.exit).toEqual({ code: 0, signal: null });
      await expect(world.runtime.command({ type: "get_state" })).resolves.toMatchObject({
        sessionFile: branched,
      });
      expect(world.argv).toHaveLength(2);
      expect(world.argv[1]?.slice(-2)).toEqual(["--resume", branched]);
      expect(world.tokens.issued).toHaveLength(2);
      expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);

      const turn = world.runtime.prompt("after branch");
      expect(await turn.dispatched).toMatchObject({ sessionFile: branched });
      await collectPrompt(turn);
      await world.runtime.shutdown();
    },
  );

  it(
    "C3 command during a turn throws SessionBusyError before and after the receipt, writing nothing",
    REAL,
    async () => {
      const world = openReal("abort-ok");
      const turn = world.runtime.prompt("hi");
      const iterator = turn[Symbol.asyncIterator]();
      expect(() => world.runtime.command({ type: "get_branch_messages" })).toThrow(
        SessionBusyError,
      );
      await turn.dispatched;
      expect(() => world.runtime.command({ type: "get_branch_messages" })).toThrow(
        SessionBusyError,
      );

      await untilDeltas(iterator, 2);
      const pending = mustAbort(world.runtime);
      await drain(iterator);
      await pending;
      expect(written(world, "get_branch_messages")).toEqual([]);

      await expect(world.runtime.command({ type: "get_state" })).resolves.toMatchObject({
        sessionFile: DEFAULT_SESSION,
      });
      expect(world.argv).toHaveLength(1);
      await world.runtime.shutdown();
    },
  );

  it(
    "C4 an in-flight command excludes prompt/command and rejects when the child dies",
    REAL,
    async () => {
      const world = openReal("normal");
      const inFlight = world.runtime.command({ type: "get_branch_messages" });
      const rejected = expect(inFlight).rejects.toBeInstanceOf(AgentUnavailableError);
      expect(() => world.runtime.prompt("x")).toThrow(SessionBusyError);
      expect(() => world.runtime.command({ type: "get_state" })).toThrow(SessionBusyError);

      await until(() => written(world, "get_branch_messages").length === 1);
      const watch = world.watches[0];
      process.kill(Number(watch?.child.pid), "SIGKILL");
      await rejected;
      expect(await watch?.exit).toEqual({ code: null, signal: "SIGKILL" });
      expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
      expect(world.exits).toEqual([{ code: null, signal: "SIGKILL" }]);
      expect(world.exits).toEqual(watch?.exits);

      const frames = await collectPrompt(world.runtime.prompt("y"));
      expect(frames.at(-1)).toMatchObject({ type: "agent_end" });
      expect(world.argv[1]?.slice(-2)).toEqual(["--resume", DEFAULT_SESSION]);
      expect(world.tokens.issued).toHaveLength(2);
      await world.runtime.shutdown();
      expect(world.tokens.revoked).toEqual([world.tokens.issued[0], world.tokens.issued[1]]);
    },
  );

  it("C5 a failure response rejects without reclaiming the generation", REAL, async () => {
    const persisted = persistedPath();
    const world = openReal("branch", { resumePath: persisted });
    await expect(world.runtime.command({ type: "branch", entryId: "nope" })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    expect(world.runtime.sessionFile).toBe(persisted);

    await expect(world.runtime.command({ type: "get_branch_messages" })).resolves.toEqual({
      messages: BRANCH_MESSAGES,
    });
    expect(world.argv).toHaveLength(1);
    expect(world.tokens.issued).toHaveLength(1);
    expect(world.exits).toEqual([]);
    await world.runtime.shutdown();
  });

  it("C6a after shutdown command throws AgentUnavailableError synchronously and spawns nothing", async () => {
    const world = openReal("normal");
    await world.runtime.shutdown();
    expect(() => world.runtime.command({ type: "get_state" })).toThrow(AgentUnavailableError);
    expect(world.argv).toHaveLength(0);
    expect(world.tokens.issued).toEqual([]);
  });

  it(
    "C6b shutdown during an unanswered command rejects it and retires the child",
    REAL,
    async () => {
      const world = openReal("normal");
      const inFlight = world.runtime.command({ type: "get_branch_messages" });
      const rejected = expect(inFlight).rejects.toBeInstanceOf(AgentUnavailableError);
      await until(() => written(world, "get_branch_messages").length === 1);
      await world.runtime.shutdown();
      await rejected;
      expect(await world.watches[0]?.exit).toEqual({ code: 0, signal: null });
      expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
    },
  );

  it(
    "C6c shutdown while a command's child withholds ready rejects it with no frame written",
    REAL,
    async () => {
      const world = openReal("slow-ready");
      const inFlight = world.runtime.command({ type: "get_state" });
      const rejected = expect(inFlight).rejects.toBeInstanceOf(AgentUnavailableError);
      await until(() => world.real.calls.length === 1);
      await world.runtime.shutdown();
      await rejected;
      expect(world.argv).toHaveLength(1);
      expect(world.stdin).toEqual([]);
      expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
    },
  );

  it("C6d command then shutdown in the same tick rejects without spawning", async () => {
    const world = openReal("normal");
    const inFlight = world.runtime.command({ type: "get_state" });
    const rejected = expect(inFlight).rejects.toBeInstanceOf(AgentUnavailableError);
    await world.runtime.shutdown();
    await rejected;
    expect(world.argv).toHaveLength(0);
    expect(world.tokens.issued).toEqual([]);
  });

  it("C7 a command counts as activity for idle expiry", REAL, async () => {
    const world = openReal("normal");
    await collectPrompt(world.runtime.prompt("hi"));
    world.real.clock.advance(IDLE_MS - 1);
    await expect(world.runtime.command({ type: "get_state" })).resolves.toMatchObject({
      sessionFile: DEFAULT_SESSION,
    });
    world.real.clock.advance(IDLE_MS - 1);
    await waitImmediate();
    const watch = world.watches[0];
    expect(watch?.stdinEnded).toBe(false);
    world.real.clock.advance(1);
    expect(await watch?.exit).toEqual({ code: 0, signal: null });
    expect(world.argv).toHaveLength(1);
    await world.runtime.shutdown();
  });

  it("C8 command entry re-arms idle even when the child never answers", async () => {
    const world = openFake();
    await expect(world.runtime.command({ type: "get_state" })).resolves.toEqual({
      sessionFile: DEFAULT_SESSION,
    });
    let stdinEnded = false;
    world.child.stdin.on("finish", () => {
      stdinEnded = true;
    });
    world.clock.advance(IDLE_MS - 1);
    const inFlight = world.runtime.command({ type: "get_branch_messages" });
    const observed = observePromise(inFlight);
    const rejected = expect(inFlight).rejects.toBeInstanceOf(AgentUnavailableError);

    world.clock.advance(IDLE_MS - 1);
    await waitImmediate();
    expect(stdinEnded).toBe(false);
    expect(observed.outcome).toBe("pending");
    expect(world.tokens.live.get(SESSION_ID)).toBeDefined();

    world.clock.advance(1);
    await waitImmediate();
    expect(stdinEnded).toBe(true);
    world.child.exit(0);
    await rejected;
    expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
    expect(world.exits).toEqual([{ code: 0, signal: null }]);
    expect(world.inbound.map((frame) => frame.type)).toEqual(["get_branch_messages"]);

    world.child.endStdout();
    await world.runtime.shutdown();
  });
});

describe("SessionRuntime command() protocol failure", () => {
  it("C9 a protocol error during an in-flight command retires the generation and frees the claim", async () => {
    const world = openFake();
    await world.runtime.command({ type: "get_state" });
    const first = world.child;
    first.onCommand("get_state", (frame) => {
      world.inbound.push(frame);
    });
    let stdinEnded = false;
    first.stdin.on("finish", () => {
      stdinEnded = true;
    });
    const inFlight = world.runtime.command({ type: "get_state" });
    const rejected = expect(inFlight).rejects.toBeInstanceOf(AgentUnavailableError);
    await until(() => world.inbound.some((frame) => frame.type === "get_state"));

    first.emitRaw("{not json\n");
    await waitImmediate();
    expect(stdinEnded).toBe(true);
    first.exit(0);
    await rejected;
    first.endStdout();
    expect(world.clock.nowMs).toBe(0);
    expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);

    await until(() => world.exits.length === 1);
    const turn = world.runtime.prompt("after protocol error");
    await until(() => world.inbound.some((frame) => frame.type === "prompt"));
    expect(world.spawns).toBe(2);
    expect(world.tokens.issued).toHaveLength(2);
    world.child.emitLine(TERMINAL);
    expect(await collectPrompt(turn)).toEqual([TERMINAL]);
  });
});

describe("runtime command/abort source boundary", () => {
  const omp = fileURLToPath(new URL("../src/sessions/omp/", import.meta.url));
  const source = (name: string): string => readFileSync(join(omp, name), "utf8");

  it("G1 commands.ts reaches runtime.js only via import type; runtime.ts has one acquisition call site", () => {
    const statements =
      source("commands.ts").match(
        /\b(?:import|export)\b[^;]*?["']\.\/runtime\.js["']\s*\)?\s*;/gu,
      ) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^import type\b/u);
    }
    expect(source("commands.ts")).not.toMatch(/import\s*\(\s*["']\.\/runtime\.js["']/u);
    expect(source("runtime.ts").split("this.#acquire(").length - 1).toBe(1);
  });
});
