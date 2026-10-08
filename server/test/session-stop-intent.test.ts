/**
 * Issue #490 stop intent (parent s1c tasks 4.2b), design I1–I5: a stop that lands before the
 * prompt's dispatch receipt (acquisition/handshake, pool admission) registers an intent and
 * resolves; once the receipt is honored the supervisor writes exactly one `abort` on the same
 * process and the turn ends through the ordinary reduction (never synthesized), a later terminal
 * state is not rewritten. Real fake-omp children, real SQLite, the production createApp →
 * registerSessions assembly and the injected clock; oracles are stdin frames, probe `frames=`,
 * observed events, REST reads and Node's own child state.
 */
import { describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  ofType,
  REAL,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  waitForEvent,
} from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  abortCount,
  afterPrompt,
  expectNoError,
  GRACE_MS,
  history,
  listedStatus,
  probeFrames,
  stop,
  turnEnds,
} from "./session-stop-helpers.js";
import {
  delayReady,
  ended,
  frameTypes,
  intentWorlds,
  PROBED,
  stopBeforeDispatch,
} from "./session-stop-intent-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import { waitFor } from "./session-supervisor-helpers.js";
import { isLive, waitExited } from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const { open } = intentWorlds(false);

function expectAlive(world: ApprovalWorld): void {
  const { child } = spawnedAt(world, 0);
  expect(isLive(child)).toBe(true);
  expect(child.stdin.writableEnded).toBe(false);
}

/** After the turn ended: no grace left, and 8000ms more on the clock retire nothing. */
async function expectNoGraceAfterEnd(world: ApprovalWorld): Promise<void> {
  await settle();
  expect(world.timersDueAt(T + GRACE_MS)).toBe(0);
  const observed = sessionEvents(world).length;
  world.clock.advance(GRACE_MS);
  await settle();
  expectAlive(world);
  expect(world.fixture.supervisor.liveProcessCount()).toBe(1);
  expect(sessionEvents(world)).toHaveLength(observed);
}

describe("stop intent before the dispatch receipt (#490)", () => {
  it(
    "I1 stop during the handshake returns first, then one abort follows the prompt (W3)",
    REAL,
    async () => {
      const world = await open("slow-ready");
      delayReady(world, 2_000);
      const response = postPrompt(
        world.fixture.app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "stop during handshake" }),
      );
      const observed = observePromise(response);
      const spawned = await waitFor(() => world.spawned[0], "slow-ready child");
      await stop(world);
      expect(spawned.stdin).toEqual([]);
      expect(observed.outcome).toBe("pending");
      expect(await listedStatus(world)).toBe("running");

      const accepted = await response;
      expect(accepted.statusCode).toBe(202);
      const body = accepted.json<{ userMessageId: number; assistantMessageId: number }>();
      expect(Object.keys(body).sort()).toEqual(["assistantMessageId", "undo", "userMessageId"]);
      const before = await history(world);
      expect(before.messages.map((message) => message.id)).toEqual([
        body.userMessageId,
        body.assistantMessageId,
      ]);

      await waitForEvent(world, "turn.end");
      expect(turnEnds(world)).toEqual([ended(body.assistantMessageId, "stopped")]);
      expectNoError(world);
      expect(frameTypes(afterPrompt(spawned.stdin))).toEqual(["abort"]);
      const stopped = await history(world);
      expect(stopped.session.status).toBe("stopped");
      expect(await listedStatus(world)).toBe("stopped");
      expect(stopped.messages[1]).toMatchObject({ status: "stopped", content: "Hello from " });
      await expectNoGraceAfterEnd(world);

      expect(await probeFrames(world)).toBe(PROBED);
      expect(world.rt.calls).toHaveLength(1);
    },
  );

  it(
    "I2 two stops during pool admission register one intent and write one abort (W2)",
    REAL,
    async () => {
      const world = await open("abort-ok");
      const early = stopBeforeDispatch(world, 2);
      expect(early.spawnedAtStop).toBe(0);
      await Promise.all(early.stops);
      await early.prompt;

      await waitForEvent(world, "turn.end");
      await settle();
      expect(turnEnds(world)).toEqual([ended(early.assistantMessageId, "stopped")]);
      expectNoError(world);
      expect(frameTypes(afterPrompt(spawnedAt(world, 0).stdin))).toEqual(["abort"]);
      const stopped = await history(world);
      expect(stopped.messages[1]).toMatchObject({ status: "stopped", content: "Hello from " });

      expect(await probeFrames(world)).toBe(PROBED);
      expect(world.rt.calls).toHaveLength(1);
    },
  );

  it(
    "I3 the honored intent arms the grace once; a later stop joins it and adds no abort (W2)",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      const early = stopBeforeDispatch(world);
      await Promise.all(early.stops);
      await early.prompt;
      await waitForEvent(world, "text.delta", 2);
      const { child, stdin } = spawnedAt(world, 0);
      // Honored by the receipt itself, before any later stop could take the dispatched path.
      expect(abortCount(stdin)).toBe(1);
      expect(world.timersDueAt(T + GRACE_MS)).toBe(1);
      await stop(world);
      expect(abortCount(stdin)).toBe(1);
      expect(world.timersDueAt(T + GRACE_MS)).toBe(1);

      world.clock.advance(GRACE_MS - 1);
      await settle();
      expect(turnEnds(world)).toEqual([]);
      expect(sessionRow(world.fixture.db, world.session).status).toBe("running");

      world.clock.advance(1);
      await waitForEvent(world, "turn.end");
      await settle();
      expect(turnEnds(world)).toEqual([ended(early.assistantMessageId, "stopped")]);
      expectNoError(world);
      expect(child.stdin.writableEnded).toBe(true);
      await waitExited(child, "fallback-retired child");
      await waitFor(
        () => (world.fixture.supervisor.liveProcessCount() === 0 ? true : undefined),
        "released process",
      );
      expect(abortCount(stdin)).toBe(1);
    },
  );

  it(
    "I4 an intent honored after the turn already completed leaves `done` untouched (W2)",
    REAL,
    async () => {
      const world = await open("normal");
      const early = stopBeforeDispatch(world);
      await Promise.all(early.stops);
      await early.prompt;
      // #650: the intent's abort is written once the turn's agent_start arrives.
      await waitFor(
        () => (abortCount(spawnedAt(world, 0).stdin) === 1 ? true : undefined),
        "abort",
      );
      expect(frameTypes(afterPrompt(spawnedAt(world, 0).stdin))).toEqual(["abort"]);

      await waitForEvent(world, "turn.end");
      await settle();
      expect(turnEnds(world)).toEqual([ended(early.assistantMessageId, "done")]);
      expectNoError(world);
      const done = await history(world);
      expect(done.messages[1]).toMatchObject({ status: "done", content: "Hello from fake-omp" });
      await expectNoGraceAfterEnd(world);

      expect(await probeFrames(world)).toBe(PROBED);
    },
  );

  it(
    "I5 an intent honored before a crash leaves `failed` untouched and nothing unhandled (W2)",
    REAL,
    async () => {
      const world = await open("crash");
      const early = stopBeforeDispatch(world);
      await Promise.all(early.stops);
      await early.prompt;

      await waitForEvent(world, "turn.end");
      await waitFor(
        () => (world.fixture.supervisor.liveProcessCount() === 0 ? true : undefined),
        "crashed process released",
      );
      await settle();
      // #650: `crash` exits before any agent_start, so the honored intent's abort is never written.
      expect(abortCount(afterPrompt(spawnedAt(world, 0).stdin))).toBe(0);
      expect(turnEnds(world)).toEqual([ended(early.assistantMessageId, "failed")]);
      expect(ofType(sessionEvents(world), "error")).toHaveLength(1);
      const failed = await history(world);
      expect(failed.messages[1]).toMatchObject({ status: "failed" });
      expect(world.timersDueAt(T + GRACE_MS)).toBe(0);
    },
  );
});
