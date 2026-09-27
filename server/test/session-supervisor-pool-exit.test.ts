/**
 * Issue #463 E group: every process exit releases its capacity slot (idle expiry, pid-less start
 * failure, external kill mid-turn and between turns, shutdown, native exit mid-turn) and a prompt
 * racing a runtime-internal idle retirement is re-admitted instead of spawning uncounted.
 * Oracles: Node child exit state at spawn time, recorded spawn argv, SQL rows, REST envelopes.
 * E7 (carry-forward #573) pins `SessionRuntime.shutdown()` called from inside `onExit`, the path
 * the supervisor takes for an exit outside a turn: injected-clock pending timers, the token
 * book, recorded exits and a `stdout.destroy` count on a FakeChild whose stdout stays open.
 */
import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { AgentUnavailableError, type OmpExit } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import {
  capturedFailure,
  createControlledRuntime,
  createRealFakeRuntime,
  emitAssistantDelta,
  expectCompensatedIdleSession,
  IDLE_MS,
  OWNER_ID,
  resumePath,
  waitFor,
  waitForContent,
} from "./session-supervisor-helpers.js";
import {
  A_FILE,
  autoComplete,
  child,
  completed,
  countAtExit,
  expectWithinCap,
  holdAfterHello,
  isLive,
  openPool,
  presetSessionFile,
  sampleSpawns,
  send,
  settledTurn,
  switchSpawns,
  waitExited,
} from "./session-supervisor-pool-helpers.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  type FakeChild,
  observePromise,
} from "./support/omp-rpc.js";
import {
  collectPrompt,
  createClock,
  createTokens,
  type TestClock,
  type TokenBook,
} from "./support/omp-runtime.js";

const REAL = { timeout: 20_000 };

describe("SessionSupervisor process exit releases capacity", () => {
  it("E1 idle expiry frees the slot so another session spawns without eviction", REAL, async () => {
    const rt = createRealFakeRuntime();
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      presetSessionFile(world.fixture.db, a, A_FILE);
      await completed(world, a, "a one");
      rt.clock.advance(IDLE_MS);
      await waitExited(child(rt.children, 0), "A idle exit");
      expect(world.fixture.supervisor.liveProcessCount()).toBe(0);

      await completed(world, b, "b one");
      expect(rt.calls).toHaveLength(2);
      expect(liveAtSpawn[1]).toEqual([]);

      const resumed = await send(world, a, "a two");
      expect(resumed.statusCode).toBe(202);
      const childB = child(rt.children, 1);
      expect(childB.stdin.writableEnded).toBe(true);
      expect(isLive(childB)).toBe(false);
      expect(liveAtSpawn[2]).toEqual([]);
      expect(resumePath(child(rt.calls, 2).args)).toBe(A_FILE);
      await settledTurn(world, a);
      expect(sessionRow(world.fixture.db, a).stream_epoch).toBe(2);
      expectWithinCap(liveAtSpawn, 1);
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });

  it("E2 releases the slot for pid-less start failures before the 502 returns", REAL, async () => {
    const rt = createRealFakeRuntime();
    const modes = switchSpawns(rt.runtime);
    const world = await openPool(rt.runtime, 1, 3);
    try {
      const [a, b, c] = world.sessions as [string, string, string];
      const failures: Array<[string, "missing" | "throw"]> = [
        [a, "missing"],
        [b, "missing"],
        [c, "throw"],
      ];
      for (const [session, mode] of failures) {
        modes.mode = mode;
        const failed = await send(world, session, `${mode} start`);
        expect(failed.statusCode).toBe(502);
        expect(failed.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
        expectCompensatedIdleSession(world.fixture, session);
        expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
      }
      modes.mode = "valid";
      const admitted = await send(world, a, "valid start");
      expect(admitted.statusCode).toBe(202);
      expect(modes.pids).toHaveLength(4);
      expect(modes.pids.slice(0, 3)).toEqual([undefined, undefined, undefined]);
      expect(typeof modes.pids[3]).toBe("number");
      expect(world.fixture.supervisor.liveProcessCount()).toBe(1);
      await settledTurn(world, a);
    } finally {
      await world.fixture.close();
    }
  });

  it("E3 an external kill mid-turn frees the slot at exit and fails the turn", REAL, async () => {
    const rt = createRealFakeRuntime("hang-prompt");
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      const admitted = await send(world, a, "a held");
      expect(admitted.statusCode).toBe(202);
      const childA = child(rt.children, 0);
      const atExit = countAtExit(childA, world.fixture);
      process.kill(requiredPid(childA.pid), "SIGKILL");
      expect(await atExit).toBe(0);
      await settledTurn(world, a, "failed");

      const other = await send(world, b, "b one");
      expect(other.statusCode).toBe(202);
      expect(liveAtSpawn[1]).toEqual([]);
      expect(rt.calls).toHaveLength(2);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      await world.fixture.close();
    }
  });

  it(
    "E3b an external kill between turns frees the slot and retires without a fault",
    REAL,
    async () => {
      const rt = createRealFakeRuntime();
      const liveAtSpawn = sampleSpawns(rt);
      const world = await openPool(rt.runtime, 1, 2);
      try {
        const [a, b] = world.sessions as [string, string];
        presetSessionFile(world.fixture.db, a, A_FILE);
        await completed(world, a, "a one");
        const childA = child(rt.children, 0);
        const atExit = countAtExit(childA, world.fixture);
        process.kill(requiredPid(childA.pid), "SIGKILL");
        expect(await atExit).toBe(0);

        await completed(world, b, "b one");
        expect(liveAtSpawn[1]).toEqual([]);
        expect(rt.calls).toHaveLength(2);
        const resumed = await send(world, a, "a two");
        expect(resumed.statusCode).toBe(202);
        expect(isLive(child(rt.children, 1))).toBe(false);
        expect(resumePath(child(rt.calls, 2).args)).toBe(A_FILE);
        await settledTurn(world, a);
        expectWithinCap(liveAtSpawn, 1);
        expect(world.errors).toEqual([]);
        await expect(world.fixture.app.close()).resolves.toBeUndefined();
        expect(world.errors).toEqual([]);
      } finally {
        await world.fixture.close();
      }
    },
  );

  it("E4 shutdown retires every process and leaves the pool empty", REAL, async () => {
    const rt = createRealFakeRuntime("hang-prompt");
    const world = await openPool(rt.runtime, 2, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      const held = await send(world, a, "a held");
      expect(held.statusCode).toBe(202);
      rt.setScenario(undefined);
      await completed(world, b, "b idle");
      expect(world.fixture.supervisor.liveProcessCount()).toBe(2);

      await world.fixture.app.close();
      expect(rt.children.map(isLive)).toEqual([false, false]);
      expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
      expect(sessionRow(world.fixture.db, a).status).toBe("failed");
      expect(world.fixture.supervisor.streamCursor(a).seq).toBeNull();
      expect(world.fixture.supervisor.streamCursor(b).seq).toBeNull();
      const late = await capturedFailure(() => world.fixture.supervisor.prompt(a, "late"));
      expect(late).toBeInstanceOf(HttpError);
      expect((late as HttpError).code).toBe("agent_unavailable");
    } finally {
      await world.fixture.close();
    }
  });

  it("E5 a native exit mid-turn frees the slot at once while the ring drains residuals", async () => {
    const rt = createControlledRuntime((fake, _call, ordinal) => {
      if (ordinal === 0) {
        holdAfterHello(fake);
        return;
      }
      autoComplete(fake);
    });
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      const supervisor = world.fixture.supervisor;
      const held = await send(world, a, "a held");
      expect(held.statusCode).toBe(202);
      await waitForContent(world.fixture, a, "Hello");
      expect(supervisor.streamCursor(a)).toEqual({ epoch: 1, seq: 2 });

      const childA = child(rt.children, 0);
      childA.nativeExit(1);
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(supervisor.streamCursor(a)).toEqual({ epoch: 1, seq: 2 });

      emitAssistantDelta(childA, "!");
      await waitForContent(world.fixture, a, "Hello!");
      expect(supervisor.streamCursor(a)).toEqual({ epoch: 1, seq: 3 });
      childA.emitLine({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "child crashed" },
      });
      childA.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      await settledTurn(world, a, "failed");
      childA.endStdout();
      await waitFor(
        () => (supervisor.streamCursor(a).seq === null ? true : undefined),
        "A ring sealed",
      );

      await completed(world, b, "b one");
      const resumed = await send(world, a, "a two");
      expect(resumed.statusCode).toBe(202);
      expect(isLive(child(rt.children, 1))).toBe(false);
      await settledTurn(world, a);
      expect(sessionRow(world.fixture.db, a).stream_epoch).toBe(2);
      expect(rt.calls).toHaveLength(3);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      // The natively exited first child holds stdout open until the test ends it; a failed
      // assertion before that must not leave shutdown waiting on the injected drain budget.
      const first = rt.children[0];
      if (first !== undefined && !first.stdout.writableEnded) {
        first.endStdout();
      }
      await world.fixture.close();
    }
  });

  it("E6 a prompt racing idle retirement is re-admitted and resumes at the next epoch", async () => {
    const rt = createControlledRuntime((fake, _call, ordinal) => {
      autoComplete(fake, ordinal !== 0);
    });
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      await completed(world, a, "a one");
      const firstA = child(rt.children, 0);
      rt.clock.advance(IDLE_MS);
      await waitFor(() => (firstA.stdin.writableEnded ? true : undefined), "A1 idle stdin EOF");
      presetSessionFile(world.fixture.db, a, A_FILE);

      const racing = send(world, a, "a during idle retirement");
      const observed = observePromise(racing);
      for (let n = 0; n < 5; n += 1) {
        await waitImmediate();
      }
      expect(observed.outcome).toBe("pending");
      expect(rt.calls).toHaveLength(1);
      firstA.nativeExit(0);
      firstA.endStdout();
      const readmitted = await racing;
      expect(readmitted.statusCode).toBe(202);
      expect(rt.calls).toHaveLength(2);
      expect(resumePath(child(rt.calls, 1).args)).toBe(A_FILE);
      expect(sessionRow(world.fixture.db, a).stream_epoch).toBe(2);
      expect(world.fixture.supervisor.liveProcessCount()).toBe(1);
      await settledTurn(world, a);
      expect(world.fixture.store.getMessages(a, OWNER_ID)?.messages).toHaveLength(4);

      const other = await send(world, b, "b one");
      expect(other.statusCode).toBe(202);
      const secondA = child(rt.children, 1);
      expect(secondA.stdin.writableEnded).toBe(true);
      expect(isLive(secondA)).toBe(false);
      expect(liveAtSpawn[2]).toEqual([]);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      await world.fixture.close();
    }
  });
});

function requiredPid(pid: number | undefined): number {
  if (pid === undefined) {
    throw new Error("missing child pid");
  }
  return pid;
}

const SESSION_ID = "sess-exit-shutdown-463";
const TOKEN = "wb-issue463-secret-token";
const SHUTDOWN_BUDGET_MS = 8_000;
const rpc = createRpcHarness();

interface ShutdownWorld {
  runtime: SessionRuntime;
  clock: TestClock;
  tokens: TokenBook;
  children: FakeChild[];
  exits: OmpExit[];
  shutdowns: Promise<void>[];
  destroyed: number;
}

/** FakeChild generations that ACK prompts; `onExit` records and calls `void runtime.shutdown()`. */
function openShutdownOnExit(completeTurns: boolean): ShutdownWorld {
  const clock = createClock();
  const tokens = createTokens(TOKEN);
  const world: ShutdownWorld = {
    runtime: undefined as unknown as SessionRuntime,
    clock,
    tokens,
    children: [],
    exits: [],
    shutdowns: [],
    destroyed: 0,
  };
  world.runtime = new SessionRuntime({
    sessionId: SESSION_ID,
    ...rpc.tempOpts(TOKEN, "omp-exit-shutdown-"),
    tokens,
    idleMs: IDLE_MS,
    clock,
    spawnImpl: (command, args, options) => {
      const fake = rpc.fake();
      fake.emitLine(DEFAULT_READY);
      fake.replyHandshake();
      fake.onCommand("prompt", (frame) => {
        fake.emitLine({
          id: frame.id,
          type: "response",
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        if (completeTurns) {
          fake.emitLine({ type: "agent_end", isTerminal: true, messages: [] });
        }
      });
      const destroy = fake.stdout.destroy.bind(fake.stdout);
      fake.stdout.destroy = ((error?: Error) => {
        world.destroyed += 1;
        return destroy(error);
      }) as typeof fake.stdout.destroy;
      world.children.push(fake);
      return fake.spawnImpl(command, args, options);
    },
    onExit: (exit) => {
      world.exits.push(exit);
      world.shutdowns.push(world.runtime.shutdown());
    },
  });
  return world;
}

function onlyChild(world: ShutdownWorld): FakeChild {
  const [fake] = world.children;
  if (fake === undefined || world.children.length !== 1) {
    throw new Error("expected exactly one fake child");
  }
  return fake;
}

async function expectBudgetedDrain(world: ShutdownWorld): Promise<void> {
  const [shutdown] = world.shutdowns;
  if (shutdown === undefined) {
    throw new Error("onExit did not start shutdown");
  }
  const observed = observePromise(shutdown);
  await waitImmediate();
  expect(world.clock.pending()).toBe(1);
  expect(observed.outcome).toBe("pending");
  expect(world.destroyed).toBe(0);
  world.clock.advance(SHUTDOWN_BUDGET_MS);
  await shutdown;
  expect(world.destroyed).toBe(1);
  expect(world.exits).toEqual([{ code: 1, signal: null }]);
  expect(world.tokens.revoked).toEqual([world.tokens.issued[0]]);
  expect(world.tokens.issued).toHaveLength(1);
}

describe("SessionRuntime shutdown called from inside onExit", () => {
  it("E7a an idle crash retires once with only the drain timer armed", async () => {
    const world = openShutdownOnExit(true);
    const frames: OmpFrame[] = await collectPrompt(world.runtime.prompt("one"));
    expect(frames.at(-1)).toMatchObject({ type: "agent_end" });
    onlyChild(world).nativeExit(1);
    expect(world.shutdowns).toHaveLength(1);
    await expectBudgetedDrain(world);
  });

  it("E7b a mid-turn crash fails the turn and retires once with only the drain timer", async () => {
    const world = openShutdownOnExit(false);
    const iterator = world.runtime.prompt("one")[Symbol.asyncIterator]();
    let step = await iterator.next();
    while (step.done !== true && !(step.value.type === "response")) {
      step = await iterator.next();
    }
    expect(step.done).not.toBe(true);
    onlyChild(world).nativeExit(1);
    expect(world.shutdowns).toHaveLength(1);
    await expect(iterator.next()).rejects.toBeInstanceOf(AgentUnavailableError);
    await expectBudgetedDrain(world);
  });
});
