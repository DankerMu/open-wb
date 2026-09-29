/**
 * Issue #650 stop right after dispatch (change stop-after-agent-start, design S1–S3; turn-control
 * Scenarios「派发后极早停止」and「回合迟迟不开始时仍有界收尾」). The fake's `--start-delay-ms`
 * opens the window between the prompt ack and `agent_start` in which real omp v18.0.10 drops the
 * whole turn on an `abort`. Both stop branches (dispatched: `TurnStops.#run`; intent:
 * `dispatched()`) must end the turn through the ordinary aborted reduction without the grace; a
 * turn that never starts still ends by the bounded fallback, with no frame and nothing unhandled.
 * Real fake-omp children, real SQLite, the production assembly and the injected clock.
 */
import { describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  REAL,
  settle,
  spawnedAt,
  T,
  waitForEvent,
} from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  abortCount,
  afterPrompt,
  collectRejections,
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
} from "./session-stop-intent-helpers.js";
import { waitFor } from "./session-supervisor-helpers.js";
import { isLive, waitExited } from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const { open } = intentWorlds(false);

/** Every later spawn gets `--start-delay-ms <ms>` appended (fake-omp: last occurrence wins). */
function delayStart(world: ApprovalWorld, ms: number): void {
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) =>
    inner(command, [...args, "--start-delay-ms", String(ms)], options);
}

function send(world: ApprovalWorld, message: string) {
  return postPrompt(world.fixture.app, world.session, world.cookie, JSON.stringify({ message }));
}

async function accepted(
  response: Awaited<ReturnType<typeof send>>,
): Promise<{ userMessageId: number; assistantMessageId: number }> {
  expect(response.statusCode).toBe(202);
  return response.json<{ userMessageId: number; assistantMessageId: number }>();
}

/**
 * The stopped turn ended natively on the untouched clock: one `turn.end(stopped)`, the two held
 * deltas kept, one abort after the prompt, the process alive; the probe then runs on it.
 */
async function expectStoppedWithoutGrace(world: ApprovalWorld, assistantId: number): Promise<void> {
  await waitForEvent(world, "turn.end");
  await settle();
  expect(world.clock.nowMs).toBe(T);
  expect(turnEnds(world)).toEqual([ended(assistantId, "stopped")]);
  expectNoError(world);
  const { child, stdin } = spawnedAt(world, 0);
  expect(frameTypes(afterPrompt(stdin))).toEqual(["abort"]);
  expect(isLive(child)).toBe(true);
  expect(world.fixture.supervisor.liveProcessCount()).toBe(1);
  const stopped = await history(world);
  expect(stopped.session.status).toBe("stopped");
  expect(stopped.messages[1]).toMatchObject({
    id: assistantId,
    status: "stopped",
    content: "Hello from ",
  });

  expect(await probeFrames(world)).toBe(PROBED);
  expect(world.rt.calls).toHaveLength(1);
  expect(world.clock.nowMs).toBe(T);
}

describe("stop right after the dispatch receipt (#650)", () => {
  it(
    "S1 dispatched branch: a stop right after the 202 ends the turn stopped without the grace",
    REAL,
    async () => {
      const world = await open("abort-ok");
      delayStart(world, 300);
      const body = await accepted(await send(world, "stop right after dispatch"));
      await stop(world);

      await expectStoppedWithoutGrace(world, body.assistantMessageId);
    },
  );

  it(
    "S2 intent branch: a stop during the handshake is honored at agent_start, not before",
    REAL,
    async () => {
      const world = await open("slow-ready");
      delayReady(world, 300);
      delayStart(world, 300);
      const response = send(world, "stop during handshake");
      const observed = observePromise(response);
      const spawned = await waitFor(() => world.spawned[0], "slow-ready child");
      await stop(world);
      expect(spawned.stdin).toEqual([]);
      expect(observed.outcome).toBe("pending");
      expect(await listedStatus(world)).toBe("running");

      const body = await accepted(await response);
      await expectStoppedWithoutGrace(world, body.assistantMessageId);
    },
  );

  it(
    "S3 a turn that never starts still ends by the bounded fallback from the stop, with no abort",
    REAL,
    async () => {
      const rejections = collectRejections();
      try {
        const world = await open("abort-ok");
        delayStart(world, 60_000);
        const body = await accepted(await send(world, "never starts"));
        await stop(world);
        await settle();
        const { child, stdin } = spawnedAt(world, 0);
        expect(abortCount(stdin)).toBe(0);
        expect(world.timersDueAt(T + GRACE_MS)).toBe(1);

        world.clock.advance(GRACE_MS - 1);
        await settle();
        expect(turnEnds(world)).toEqual([]);
        world.clock.advance(1);
        await waitForEvent(world, "turn.end");
        await settle();
        expect(turnEnds(world)).toEqual([ended(body.assistantMessageId, "stopped")]);
        expectNoError(world);
        expect((await history(world)).messages[1]).toMatchObject({ status: "stopped" });
        await waitExited(child, "fallback-retired child");
        expect(abortCount(stdin)).toBe(0);
        await settle();
        expect(rejections.reasons).toEqual([]);
      } finally {
        rejections.dispose();
      }
    },
  );
});
