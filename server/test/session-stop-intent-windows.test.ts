/**
 * Issue #490 stop intent across the supervisor's other pre-dispatch waits and its failure exits,
 * design I6, I7, F1, F2, I8: an intent registered during the handshake survives re-admission onto a
 * new process, a stop while the previous process is still retiring (eviction) is honored on the
 * process the prompt finally gets, and a failed acquisition or dispatch drops the intent — the
 * failure is the same as without a stop (control worlds) and a re-dispatch of the same turn writes
 * no `abort`. Real fake-omp children, real SQLite, the production assembly, the injected clock.
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
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
  history,
  probeFrames,
  stop,
  turnEnds,
} from "./session-stop-helpers.js";
import {
  type EarlyStop,
  type EvictionWorld,
  ended,
  frameTypes,
  handshakeBound,
  intentWorlds,
  openEvictionWorld,
  PROBED,
  promptedWith,
  stopBeforeDispatch,
} from "./session-stop-intent-helpers.js";
import { IDLE_MS, OWNER_ID, waitFor } from "./session-supervisor-helpers.js";

const TERM_MS = 5_000;
const BLOCKED = "session file blocked";
const BLOCK_SESSION_FILE = `CREATE TRIGGER block_session_file BEFORE UPDATE OF omp_session_file
  ON chat_sessions BEGIN SELECT RAISE(ABORT, '${BLOCKED}'); END`;

const { open, track } = intentWorlds(true);

function send(world: ApprovalWorld, session: string, message: string) {
  return postPrompt(world.fixture.app, session, world.cookie, JSON.stringify({ message }));
}

async function completed(world: ApprovalWorld, session: string, message: string): Promise<void> {
  const before = ofType(sessionEvents(world, session), "turn.end").length;
  expect((await send(world, session, message)).statusCode).toBe(202);
  await waitForEvent(world, "turn.end", before + 1, session);
  await settle();
}

async function released(world: ApprovalWorld): Promise<void> {
  await waitFor(
    () => (world.fixture.supervisor.liveProcessCount() === 0 ? true : undefined),
    "every process released",
  );
}

/** One world of a with/without-stop pair: its prompt failed and nothing was published. */
/** The re-dispatched second turn of `world.session` ended `stopped` natively; `old` saw no abort. */
async function expectStoppedSecondTurn(
  world: ApprovalWorld,
  early: EarlyStop,
  old: readonly OmpFrame[],
): Promise<void> {
  await waitForEvent(world, "turn.end", 2);
  await settle();
  expect(turnEnds(world).slice(1)).toEqual([ended(early.assistantMessageId, "stopped")]);
  expectNoError(world);
  expect(abortCount(old)).toBe(0);
  expect(await probeFrames(world)).toBe(PROBED);
  expect(abortCount(old)).toBe(0);
}

function expectSilentFailure(world: ApprovalWorld): void {
  expect(turnEnds(world)).toEqual([]);
  expect(ofType(sessionEvents(world), "error")).toEqual([]);
  expect(world.rt.calls).toHaveLength(1);
}

describe("stop intent across re-admission and eviction (#490)", () => {
  it(
    "I6 an intent registered during the handshake is honored after re-admission (W3→W4)",
    REAL,
    async () => {
      const world = await open("hang-eof");
      await completed(world, world.session, "first");
      const first = spawnedAt(world, 0);
      world.clock.advance(IDLE_MS);
      await waitFor(() => (first.child.stdin.writableEnded ? true : undefined), "idle EOF");
      world.rt.setScenario("abort-ok");

      const early = stopBeforeDispatch(world);
      await Promise.all(early.stops);
      expect(world.rt.calls).toHaveLength(1);
      expect(abortCount(first.stdin)).toBe(0);

      world.clock.advance(TERM_MS);
      await early.prompt;
      expect(world.rt.calls).toHaveLength(2);
      const second = spawnedAt(world, 1);
      // #650: the intent's abort is written once the turn's agent_start arrives.
      await waitFor(() => (abortCount(second.stdin) === 1 ? true : undefined), "abort");
      expect(frameTypes(afterPrompt(second.stdin))).toEqual(["abort"]);
      await expectStoppedSecondTurn(world, early, first.stdin);
    },
  );

  it(
    "I7 a stop while the previous process is being evicted is honored on the new one (W1→W2)",
    REAL,
    async () => {
      const world: EvictionWorld = track(await openEvictionWorld());
      const a = world.session;
      await completed(world, a, "a one");
      world.rt.setScenario("normal");
      await completed(world, world.c, "c one");
      const promptB = send(world, world.b, "b one");
      const oldA = spawnedAt(world, 0);
      await waitFor(() => (oldA.child.stdin.writableEnded ? true : undefined), "a evicted EOF");

      const early = stopBeforeDispatch(world, 1, "a two");
      world.rt.setScenario("abort-ok");
      await Promise.all(early.stops);
      expect(world.rt.calls).toHaveLength(2);
      expect(abortCount(oldA.stdin)).toBe(0);

      world.clock.advance(TERM_MS);
      await early.prompt;
      expect((await promptB).statusCode).toBe(202);
      const newA = promptedWith(world, "a two");
      expect(newA).not.toBe(oldA);
      // #650: the intent's abort is written once the turn's agent_start arrives.
      await waitFor(() => (abortCount(newA?.stdin ?? []) === 1 ? true : undefined), "abort");
      expect(frameTypes(afterPrompt(newA?.stdin ?? []))).toEqual(["abort"]);
      await expectStoppedSecondTurn(world, early, oldA.stdin);

      await world.fixture.supervisor.stop(world.b);
      const [endB] = await waitForEvent(world, "turn.end", 1, world.b);
      expect(endB?.data.status).toBe("stopped");
    },
  );
});

describe("a failed acquisition or dispatch drops the intent (#490)", () => {
  it(
    "F1 handshake timeout: the same REST failure with or without a stop, no abort",
    REAL,
    async () => {
      const pair = [await open("no-ready-hang"), await open("no-ready-hang")] as const;
      const [intent, control] = pair;
      const responses = pair.map((world) => {
        handshakeBound(world, 1_000);
        return send(world, world.session, "never ready");
      });
      await waitFor(() => intent.spawned[0], "intent child");
      await waitFor(() => control.spawned[0], "control child");
      await stop(intent);
      expect(spawnedAt(intent, 0).stdin).toEqual([]);

      const [withStop, without] = await Promise.all(responses);
      expect(withStop?.statusCode).toBe(without?.statusCode);
      expect(withStop?.statusCode).not.toBe(202);
      expect(withStop?.json()).toEqual(without?.json());
      const intentHistory = await history(intent);
      const controlHistory = await history(control);
      expect(intentHistory.messages).toEqual(controlHistory.messages);
      expect(intentHistory.session.status).toBe(controlHistory.session.status);
      for (const world of pair) {
        await released(world);
        expectSilentFailure(world);
      }
      const typesOf = (world: ApprovalWorld) => frameTypes(spawnedAt(world, 0).stdin);
      expect(typesOf(intent)).toEqual(typesOf(control));
      expect(typesOf(intent)).not.toContain("abort");
      expect(intent.errors).toEqual(control.errors);
    },
  );

  it(
    "F2 a dispatch failing after its receipt: the same rejection with or without a stop",
    REAL,
    async () => {
      const pair = [await open("abort-ok"), await open("abort-ok")] as const;
      const [intent, control] = pair;
      for (const world of pair) {
        world.fixture.db.exec(BLOCK_SESSION_FILE);
      }
      const early = stopBeforeDispatch(intent);
      control.fixture.store.acceptPrompt(control.session, OWNER_ID, "stop before dispatch");
      const plain = control.fixture.supervisor.prompt(control.session, "stop before dispatch");
      await Promise.all(early.stops);

      const [withStop, without] = await Promise.all([rejection(early.prompt), rejection(plain)]);
      expect(String(withStop)).toContain(BLOCKED);
      expect(String(withStop)).toBe(String(without));
      for (const world of pair) {
        await released(world);
        await settle();
        expectSilentFailure(world);
        expect(frameTypes(spawnedAt(world, 0).stdin)).toEqual([
          "negotiate_protocol",
          "get_state",
          "set_model",
          "set_thinking_level",
          "prompt",
        ]);
      }
    },
  );

  it(
    "I8 the dropped intent does not survive into a re-dispatch of the same turn",
    REAL,
    async () => {
      const world = await open("no-ready-hang");
      handshakeBound(world, 1_000);
      const { assistantMessageId } = world.fixture.store.acceptPrompt(world.session, OWNER_ID, "x");
      const failing = world.fixture.supervisor.prompt(world.session, "x");
      await waitFor(() => world.spawned[0], "never-ready child");
      await stop(world);
      expect(await rejection(failing)).toMatchObject({ code: "agent_unavailable" });
      expect(turnEnds(world)).toEqual([]);
      expect(world.fixture.store.runtimeState(world.session)?.activeTurn?.assistantMessageId).toBe(
        assistantMessageId,
      );

      world.rt.setScenario("normal");
      handshakeBound(world, undefined);
      await world.fixture.supervisor.prompt(world.session, "x");
      expect(world.rt.calls).toHaveLength(2);
      expect(abortCount(afterPrompt(spawnedAt(world, 1).stdin))).toBe(0);
      await waitForEvent(world, "turn.end");
      await settle();
      expect(turnEnds(world)).toEqual([ended(assistantMessageId, "done")]);
      expectNoError(world);
    },
  );
});
