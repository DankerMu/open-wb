/**
 * Issue #652 SpawnGate unit (design G1) and two SessionRuntimes sharing one gate over real fake-omp
 * children (G4b: shutdown cancels a queued acquisition; G5b: a boot that resolves after shutdown
 * returns its permit before the retirement; G7: a pre-spawn token failure returns its
 * permit). Oracles: promise settlement observed after real macrotasks, spawn records, the injected
 * clock left at 0, the fake's own terminal frames.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AgentUnavailableError } from "../src/sessions/omp/process.js";
import {
  SessionRuntime,
  type SessionRuntimeOpts,
  type SessionTokens,
} from "../src/sessions/omp/runtime.js";
import { SpawnGate } from "../src/sessions/omp/spawn-gate.js";
import { settle } from "./session-approval-helpers.js";
import { waitFor } from "./session-supervisor-helpers.js";
import { createRpcHarness, observePromise } from "./support/omp-rpc.js";
import {
  collectPrompt,
  collectUntilError,
  createClock,
  createTokens,
  type TestClock,
} from "./support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const REAL = { timeout: 20_000 };
const harness = createRpcHarness();

describe("SpawnGate (G1)", () => {
  it("limit 2 queues the third; release hands permits over FIFO and is idempotent", async () => {
    const gate = new SpawnGate(2);
    const first = observePromise(gate.acquire().granted);
    const second = gate.acquire();
    const third = gate.acquire();
    const fourth = gate.acquire();
    const thirdSeen = observePromise(third.granted);
    const fourthSeen = observePromise(fourth.granted);
    await settle(2);
    expect(first.outcome).toBe("resolved");
    expect([thirdSeen.outcome, fourthSeen.outcome]).toEqual(["pending", "pending"]);

    const release = await second.granted;
    release();
    await settle(2);
    expect([thirdSeen.outcome, fourthSeen.outcome]).toEqual(["resolved", "pending"]);
    release();
    await settle(2);
    expect(fourthSeen.outcome).toBe("pending");

    (await third.granted)();
    await settle(2);
    expect(fourthSeen.outcome).toBe("resolved");
  });

  it("cancel while queued rejects with runtime shutdown and takes no permit", async () => {
    const gate = new SpawnGate(1);
    const release = await gate.acquire().granted;
    const queued = gate.acquire();
    const later = gate.acquire();
    const laterSeen = observePromise(later.granted);

    queued.cancel();
    await expect(queued.granted).rejects.toThrow(new AgentUnavailableError("runtime shutdown"));
    await expect(queued.granted).rejects.toBeInstanceOf(AgentUnavailableError);
    release();
    await settle(2);
    expect(laterSeen.outcome).toBe("resolved");
    (await later.granted)();
    const fresh = observePromise(gate.acquire().granted);
    await settle(2);
    expect(fresh.outcome).toBe("resolved");
  });

  it("cancel after the grant is a no-op: the permit stays held until released", async () => {
    const gate = new SpawnGate(1);
    const held = gate.acquire();
    const release = await held.granted;
    held.cancel();
    const next = observePromise(gate.acquire().granted);
    await settle(2);
    expect(next.outcome).toBe("pending");
    release();
    await settle(2);
    expect(next.outcome).toBe("resolved");
  });
});

interface GatedRuntime {
  runtime: SessionRuntime;
  clock: TestClock;
  spawned: ChildProcessWithoutNullStreams[];
  /** Set by `holdStateReply`: releases the held stdout from the get_state reply on. */
  releaseReply?: () => void;
  heldReply?: () => number;
}

function gatedRuntime(
  gate: SpawnGate,
  sessionId: string,
  scenario: string | undefined,
  extra: Partial<SessionRuntimeOpts> = {},
  holdReply = false,
): GatedRuntime {
  const clock = createClock();
  const temp = harness.tempOpts("unused", "omp-spawn-gate-");
  const spawned: ChildProcessWithoutNullStreams[] = [];
  const runtime = new SessionRuntime({
    sessionId,
    bin: FAKE,
    sandboxRoot: temp.sandboxRoot,
    stateDir: temp.stateDir,
    ownerId: "u1",
    cwd: temp.cwd,
    modelId: temp.modelId,
    tokens: createTokens(`wb-652-${sessionId}`),
    clock,
    spawnGate: gate,
    spawnImpl: (_command, args, options) => {
      const child = harness.spawnTracked(
        [FAKE, ...args, ...(scenario === undefined ? [] : ["--scenario", scenario])],
        options,
      );
      spawned.push(child);
      if (holdReply) {
        holdStateReply(world, child);
      }
      return child;
    },
    ...extra,
  });
  const world: GatedRuntime = { runtime, clock, spawned };
  return world;
}

/** Buffers stdout `data` from the chunk carrying the get_state reply on, until `releaseReply()`. */
function holdStateReply(world: GatedRuntime, child: ChildProcessWithoutNullStreams): void {
  const emit = child.stdout.emit.bind(child.stdout);
  const buffered: unknown[][] = [];
  let holding = true;
  child.stdout.emit = ((event: string | symbol, ...args: unknown[]) => {
    const reply = buffered.length > 0 || String(args[0]).includes('"command":"get_state"');
    if (holding && event === "data" && reply) {
      buffered.push(args);
      return true;
    }
    return emit(event, ...args);
  }) as typeof child.stdout.emit;
  world.heldReply = () => buffered.length;
  world.releaseReply = () => {
    holding = false;
    for (const args of buffered.splice(0)) {
      emit("data", ...args);
    }
  };
}

/** no-ready-hang ignores EOF and SIGTERM: drive TERM (5000) and KILL (3000) on the injected clock. */
async function shutdownHung(world: GatedRuntime): Promise<void> {
  const done = observePromise(world.runtime.shutdown());
  await waitFor(() => {
    if (done.outcome === "pending") {
      world.clock.advance(1_000);
      return undefined;
    }
    return true;
  }, "hung runtime shutdown");
}

describe("SessionRuntimes sharing one gate", () => {
  it(
    "G4b shutdown of a queued runtime rejects its request before the holder's boot settles",
    REAL,
    async () => {
      const gate = new SpawnGate(1);
      const acquire = vi.spyOn(gate, "acquire");
      const a = gatedRuntime(gate, "sess-652-a", "no-ready-hang", { handshakeTimeoutMs: 60_000 });
      const b = gatedRuntime(gate, "sess-652-b", undefined);
      const aTurn = observePromise(collectUntilError(a.runtime.prompt("holds the permit")));
      await waitFor(() => (a.spawned.length === 1 ? true : undefined), "a spawned");

      const command = b.runtime.command({ type: "get_state" });
      const commandSeen = observePromise(command);
      await waitFor(() => (acquire.mock.calls.length === 2 ? true : undefined), "b queued");
      const shutdown = observePromise(b.runtime.shutdown());
      for (let n = 0; n < 5; n += 1) {
        await waitImmediate();
      }

      expect(commandSeen.outcome).toBe("rejected");
      await expect(command).rejects.toThrow(new AgentUnavailableError("runtime shutdown"));
      expect(shutdown.outcome).toBe("resolved");
      expect(b.spawned).toHaveLength(0);
      expect(aTurn.outcome).toBe("pending");
      expect(a.clock.nowMs).toBe(0);

      await shutdownHung(a);
      expect(b.spawned).toHaveLength(0);
    },
  );

  it(
    "G5b a boot that resolves after shutdown returns the permit before the retirement",
    REAL,
    async () => {
      const gate = new SpawnGate(1);
      const acquire = vi.spyOn(gate, "acquire");
      const a = gatedRuntime(gate, "sess-652-a", "hang-eof", { handshakeTimeoutMs: 60_000 }, true);
      const b = gatedRuntime(gate, "sess-652-b", undefined);
      const aTurn = collectUntilError(a.runtime.prompt("reply held"));
      await waitFor(
        () => ((a.heldReply?.() ?? 0) > 0 ? true : undefined),
        "a's get_state reply held",
      );
      const command = b.runtime.command({ type: "get_state" });
      await waitFor(() => (acquire.mock.calls.length === 2 ? true : undefined), "b queued");

      const aShutdown = observePromise(a.runtime.shutdown());
      a.releaseReply?.();
      await waitFor(() => (b.spawned.length === 1 ? true : undefined), "b spawned");

      expect(aShutdown.outcome).toBe("pending");
      expect(a.clock.nowMs).toBe(0);
      await expect(command).resolves.toMatchObject({ sessionFile: expect.any(String) });
      expect((await aTurn).error).toBeInstanceOf(AgentUnavailableError);
      await shutdownHung(a);
      await b.runtime.shutdown();
    },
  );

  it(
    "G7 a token failure after the grant returns the permit: the queued runtime spawns and completes",
    REAL,
    async () => {
      const gate = new SpawnGate(1);
      const acquire = vi.spyOn(gate, "acquire");
      const hold = await gate.acquire().granted;
      const failing: SessionTokens = {
        issue: () => {
          throw new Error("token store down");
        },
        revoke: () => {},
      };
      const a = gatedRuntime(gate, "sess-652-a", undefined, { tokens: failing });
      const b = gatedRuntime(gate, "sess-652-b", undefined);
      const aTurn = collectUntilError(a.runtime.prompt("token fails"));
      const bTurn = collectPrompt(b.runtime.prompt("queued behind a"));
      await waitFor(() => (acquire.mock.calls.length === 3 ? true : undefined), "a and b queued");

      hold();
      expect((await aTurn).error).toBeInstanceOf(AgentUnavailableError);
      await waitFor(() => (b.spawned.length === 1 ? true : undefined), "b spawned");
      const frames = await bTurn;
      expect(frames.at(-1)).toMatchObject({ type: "agent_end" });
      expect(a.spawned).toHaveLength(0);
      await a.runtime.shutdown();
      await b.runtime.shutdown();
    },
  );
});
