/**
 * Issue #944 the supervisor's pre-dispatch step port (`prompt(sessionId, text, beforeDispatch)`):
 * chat-sessions「Stop during the pre-dispatch step keeps its intent」(both WHEN/THEN pairs) and the
 * pre-dispatch-step case of turn-control「准入与前代退役等待期间停止」. The step is a controllable
 * Promise (no snapshot module); real fake-omp children, real SQLite, the production assembly, the
 * injected clock.
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import {
  type ApprovalWorld,
  ofType,
  REAL,
  rejection,
  sessionEvents,
  settle,
  spawnedAt,
  waitForEvent,
} from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  abortCount,
  afterPrompt,
  expectNoError,
  probeFrames,
  stop,
  turnEnds,
} from "./session-stop-helpers.js";
import { ended, frameTypes, intentWorlds, PROBED } from "./session-stop-intent-helpers.js";
import { IDLE_MS, OWNER_ID, waitFor } from "./session-supervisor-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const TERM_MS = 5_000;
const STEP_FAILED = "pre-dispatch step sentinel";

const { open } = intentWorlds(true);

/**
 * The REST prompt order (acceptPrompt, then supervisor.prompt in the same synchronous segment) with
 * a step the test settles; `entered` is how many times the supervisor has invoked it.
 */
function promptWithStep(world: ApprovalWorld, text: string) {
  const gate = { resolve: () => {}, reject: (_reason: Error) => {} };
  const settled = new Promise<void>((resolve, reject) => {
    Object.assign(gate, { resolve, reject });
  });
  const step = { entered: 0 };
  const { assistantMessageId } = world.fixture.store.acceptPrompt(world.session, OWNER_ID, text);
  const prompt = world.fixture.supervisor.prompt(world.session, text, () => {
    step.entered += 1;
    return settled;
  });
  return { assistantMessageId, prompt, port: observePromise(prompt), step, gate };
}

/** A stop that lands while the step is pending: it returns, and nothing was spawned or written. */
async function stopDuringStep(
  world: ApprovalWorld,
  pending: ReturnType<typeof promptWithStep>,
  spawnedBefore: number,
): Promise<void> {
  await waitFor(() => (pending.step.entered === 1 ? true : undefined), "step entered");
  await settle();
  // No spawn and no pool admission either: the step runs before the prompt acquires anything.
  expect(world.rt.calls).toHaveLength(spawnedBefore);
  expect(world.fixture.supervisor.liveProcessCount()).toBe(spawnedBefore);
  await stop(world);
  await settle();
  // The stop resolved while the step, and therefore the port, is still pending.
  expect(pending.port.outcome).toBe("pending");
  expect(world.rt.calls).toHaveLength(spawnedBefore);
  expect(world.spawned).toHaveLength(spawnedBefore);
}

describe("supervisor.prompt pre-dispatch step (#944)", () => {
  it(
    "a stop during the pending step keeps its intent: no spawn before the step settles, then prompt, one abort, one turn.end(stopped) (chat-sessions; turn-control 派发前步骤)",
    REAL,
    async () => {
      const world = await open("abort-ok");
      const pending = promptWithStep(world, "stop during the step");
      await stopDuringStep(world, pending, 0);

      pending.gate.resolve();
      await pending.prompt;
      expect(pending.step.entered).toBe(1);
      expect(world.rt.calls).toHaveLength(1);
      const { stdin } = spawnedAt(world, 0);
      await waitFor(() => (abortCount(stdin) === 1 ? true : undefined), "abort");
      await waitForEvent(world, "turn.end");
      await settle();
      expect(frameTypes(stdin)).toEqual([
        "negotiate_protocol",
        "get_state",
        "set_model",
        "set_thinking_level",
        "prompt",
        "abort",
      ]);
      expect(turnEnds(world)).toEqual([ended(pending.assistantMessageId, "stopped")]);
      expectNoError(world);
      expect(await probeFrames(world)).toBe(PROBED);
    },
  );

  it(
    "a process that starts retiring during the step is waited for after it: the prompt and its one abort land on the new process (turn-control 派发前步骤)",
    REAL,
    async () => {
      const world = await open("hang-eof");
      const sent = await postPrompt(
        world.fixture.app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "first" }),
      );
      expect(sent.statusCode).toBe(202);
      await waitForEvent(world, "turn.end");
      await settle();
      const first = spawnedAt(world, 0);
      world.rt.setScenario("abort-ok");

      const pending = promptWithStep(world, "second");
      await stopDuringStep(world, pending, 1);
      // The live process goes idle while the step is pending; hang-eof ignores the EOF.
      world.clock.advance(IDLE_MS);
      await waitFor(() => (first.child.stdin.writableEnded ? true : undefined), "idle EOF");

      pending.gate.resolve();
      await settle();
      expect(pending.port.outcome).toBe("pending");
      expect(world.rt.calls).toHaveLength(1);

      world.clock.advance(TERM_MS);
      await pending.prompt;
      expect(pending.step.entered).toBe(1);
      expect(world.rt.calls).toHaveLength(2);
      const second = spawnedAt(world, 1);
      await waitFor(() => (abortCount(second.stdin) === 1 ? true : undefined), "abort");
      await waitForEvent(world, "turn.end", 2);
      await settle();
      expect(frameTypes(afterPrompt(second.stdin))).toEqual(["abort"]);
      expect(abortCount(first.stdin)).toBe(0);
      expect(turnEnds(world).slice(1)).toEqual([ended(pending.assistantMessageId, "stopped")]);
      expectNoError(world);
    },
  );

  it(
    "a rejecting step rejects the port as a generic failure, spawns nothing and releases the stop state: the next prompt dispatches normally",
    REAL,
    async () => {
      const world = await open("normal");
      const pending = promptWithStep(world, "x");
      // Entered in the prompt call's own synchronous segment, before anything could be awaited.
      expect(pending.step.entered).toBe(1);
      await stopDuringStep(world, pending, 0);

      const failure = new Error(STEP_FAILED);
      pending.gate.reject(failure);
      const rejected = await rejection(pending.prompt);
      expect(rejected).toBe(failure);
      expect(rejected).not.toBeInstanceOf(HttpError);
      await settle();
      expect(world.rt.calls).toHaveLength(0);
      expect(world.spawned).toHaveLength(0);
      expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
      expect(turnEnds(world)).toEqual([]);
      expect(ofType(sessionEvents(world), "error")).toEqual([]);

      // The same turn re-dispatched (the I8 oracle): a leaked stop intent would write an abort.
      await world.fixture.supervisor.prompt(world.session, "x");
      expect(world.rt.calls).toHaveLength(1);
      await waitForEvent(world, "turn.end");
      await settle();
      expect(frameTypes(spawnedAt(world, 0).stdin)).toEqual([
        "negotiate_protocol",
        "get_state",
        "set_model",
        "set_thinking_level",
        "prompt",
      ]);
      expect(turnEnds(world)).toEqual([ended(pending.assistantMessageId, "done")]);
      expectNoError(world);
    },
  );

  it(
    "a shutdown during the pending step rejects the port agent_unavailable without a spawn",
    REAL,
    async () => {
      const world = await open("normal");
      const pending = promptWithStep(world, "x");
      expect(pending.step.entered).toBe(1);
      const closing = world.fixture.supervisor.shutdown();
      await settle();
      expect(pending.port.outcome).toBe("pending");

      pending.gate.resolve();
      expect(await rejection(pending.prompt)).toMatchObject({ code: "agent_unavailable" });
      await closing;
      expect(world.rt.calls).toHaveLength(0);
    },
  );
});
