/**
 * Issue #473 stop on the dispatched path (parent s1c tasks 4.2a), design S1–S6: Deny every
 * snapshot approval before one `abort`, native aborted settlement, bounded fallback retire after
 * OMP_ABORT_GRACE_MS on the injected clock, one abort per turn, and startup reconciliation leaving
 * `stopped` rows alone. Real fake-omp children, real SQLite, the production createApp →
 * registerSessions assembly; oracles are stdin frames, probe `frames=`, observed events, REST reads
 * and Node's own child state — never supervisor internals.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../src/sessions/store.js";
import {
  type ApprovalWorld,
  approvalRow,
  assistantSteps,
  DENIED_OUTPUT,
  ofType,
  pendingApproval,
  REAL,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  abortCount,
  afterPrompt,
  collectRejections,
  eventIndex,
  expectAnswersThenAbort,
  expectNoError,
  GRACE_MS,
  heldTurn,
  history,
  listedStatus,
  openStopWorld,
  probeFrames,
  type StopScenario,
  stop,
  turnEnds,
} from "./session-stop-helpers.js";
import {
  messageRows,
  seedMessage,
  seedSession,
  seedStep,
  sessionId,
  sessionRow,
  sessionRows,
  stepRows,
} from "./session-store-helpers.js";
import { assistantIdFor, OWNER_ID } from "./session-supervisor-helpers.js";
import { isLive, waitExited } from "./session-supervisor-pool-helpers.js";

const worlds = new Set<ApprovalWorld>();

afterEach(async () => {
  for (const world of worlds) {
    await world.fixture.close();
  }
  worlds.clear();
});

async function open(scenario: StopScenario): Promise<ApprovalWorld> {
  const world = await openStopWorld(scenario);
  worlds.add(world);
  return world;
}

/** Closes app and db now; the shared cleanup no longer owns this world. */
async function close(world: ApprovalWorld): Promise<void> {
  worlds.delete(world);
  await world.fixture.close();
}

function stoppedEnd(world: ApprovalWorld) {
  return {
    type: "turn.end",
    data: { messageId: assistantIdFor(world.fixture, world.session), status: "stopped" },
  };
}

function expectAlive(world: ApprovalWorld): void {
  const { child } = spawnedAt(world, 0);
  expect(isLive(child)).toBe(true);
  expect(child.signalCode).toBeNull();
  expect(child.stdin.writableEnded).toBe(false);
}

/** abort-ok to its native `stopped` end (S1 up to the turn end; S6 reuses it). */
async function stopNatively(world: ApprovalWorld): Promise<void> {
  await heldTurn(world);
  const { stdin } = spawnedAt(world, 0);
  await stop(world);
  expect(abortCount(afterPrompt(stdin))).toBe(1);
  expect(sessionRow(world.fixture.db, world.session).status).toBe("running");
  expect(world.timersDueAt(T + GRACE_MS)).toBe(1);
  await waitForEvent(world, "turn.end");
  expect(turnEnds(world)).toEqual([stoppedEnd(world)]);
  expectNoError(world);
}

describe("stop on the dispatched path (#473)", () => {
  it(
    "S1 running stop: one abort, native stopped end, no retire, the same process continues",
    REAL,
    async () => {
      const world = await open("abort-ok");
      await stopNatively(world);
      expect(world.timersDueAt(T + GRACE_MS)).toBe(0);
      expect(await listedStatus(world)).toBe("stopped");
      const stopped = await history(world);
      expect(stopped.session.status).toBe("stopped");
      expect(stopped.messages[1]).toMatchObject({
        role: "assistant",
        status: "stopped",
        content: "Hello from ",
      });
      expectAlive(world);

      const observed = sessionEvents(world).length;
      world.clock.advance(GRACE_MS);
      await settle();
      expectAlive(world);
      expect(sessionEvents(world)).toHaveLength(observed);

      expect(await probeFrames(world)).toBe("negotiate_protocol,get_state,prompt,abort,prompt");
      expect(world.rt.calls).toHaveLength(1);
      const after = await history(world);
      expect(after.session.status).toBe("done");
      expect(after.messages[1]).toMatchObject({ status: "stopped", content: "Hello from " });
    },
  );

  it(
    "S2 ignored abort: bounded fallback retire at exactly 8000ms, one stopped end, no error",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      const rejections = collectRejections();
      try {
        await heldTurn(world);
        const { child } = spawnedAt(world, 0);
        await stop(world);

        world.clock.advance(GRACE_MS - 1);
        await settle();
        expectAlive(world);
        expect(turnEnds(world)).toEqual([]);
        expect(sessionRow(world.fixture.db, world.session).status).toBe("running");

        world.clock.advance(1);
        expect(child.stdin.writableEnded).toBe(true);
        await waitExited(child, "retired child");
        expect(child.exitCode).toBe(0);
        await waitForEvent(world, "turn.end");
        const observed = sessionEvents(world).length;
        await settle();
        expect(sessionEvents(world)).toHaveLength(observed);
        expect(turnEnds(world)).toEqual([stoppedEnd(world)]);
        expectNoError(world);
        const stopped = await history(world);
        expect(stopped.session.status).toBe("stopped");
        expect(stopped.messages[1]).toMatchObject({ status: "stopped", content: "Hello from " });
        expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
        expect(world.errors).toEqual([]);

        await close(world);
        await settle();
        expect(rejections.reasons).toEqual([]);
      } finally {
        rejections.dispose();
      }
    },
  );

  it(
    "S3 Deny before abort: the snapshot approval is answered Deny, then exactly one abort",
    REAL,
    async () => {
      const world = await open("approval-then-abort");
      const row = await pendingApproval(world);
      // The select precedes its tool start (#620): stop only once step.start(bash) is delivered.
      await waitForEvent(world, "step.start");
      const { stdin } = spawnedAt(world, 0);
      await stop(world);
      expectAnswersThenAbort(stdin, [["r1", "Deny"]]);

      await waitForEvent(world, "turn.end");
      expect(turnEnds(world)).toEqual([stoppedEnd(world)]);
      expectNoError(world);
      const resolved = eventIndex(
        world,
        (event) =>
          event.type === "approval.resolved" &&
          event.data.approvalId === row.id &&
          event.data.decision === "deny",
      );
      expect(resolved).toBeGreaterThanOrEqual(0);
      expect(resolved).toBeLessThan(eventIndex(world, (event) => event.type === "turn.end"));
      expect(assistantSteps(world).steps).toEqual([
        expect.objectContaining({ name: "bash", status: "failed", output: DENIED_OUTPUT }),
      ]);

      expect(await probeFrames(world)).toBe(
        "negotiate_protocol,get_state,prompt,extension_ui_response,abort,prompt",
      );
      expect(world.rt.calls).toHaveLength(1);
    },
  );

  it("S4 stop denies every pending approval in id order before one abort", REAL, async () => {
    const world = await open("approval-parallel");
    await heldApprovals(world);
    const { stdin } = spawnedAt(world, 0);
    await stop(world);
    expectAnswersThenAbort(stdin, [
      ["r1", "Deny"],
      ["r2", "Deny"],
    ]);

    await waitForEvent(world, "turn.end");
    expect(turnEnds(world)).toEqual([stoppedEnd(world)]);
    expectNoError(world);
    const resolved = ofType(sessionEvents(world), "approval.resolved");
    expect(resolved.map((event) => event.data.decision)).toEqual(["deny", "deny"]);
    const end = eventIndex(world, (event) => event.type === "turn.end");
    expect(
      sessionEvents(world)
        .slice(end)
        .filter((entry) => entry.event.type === "approval.resolved"),
    ).toEqual([]);
    expect(assistantSteps(world).steps.map((step) => step.status)).toEqual(["failed", "failed"]);

    expect(await probeFrames(world)).toBe(
      "negotiate_protocol,get_state,prompt,extension_ui_response,extension_ui_response,abort,prompt",
    );
    expect(world.rt.calls).toHaveLength(1);
  });

  it(
    "S5a a repeated stop of the same turn writes no second abort and never re-arms the grace",
    REAL,
    async () => {
      const world = await open("abort-ignored");
      await heldTurn(world);
      const { stdin } = spawnedAt(world, 0);
      await Promise.all([stop(world), stop(world)]);
      expect(abortCount(stdin)).toBe(1);
      expect(world.timersDueAt(T + GRACE_MS)).toBe(1);

      world.clock.advance(4_000);
      await stop(world);
      expect(abortCount(stdin)).toBe(1);
      expect(world.timersDueAt(T + GRACE_MS)).toBe(1);
      expect(world.timersDueAt(T + 4_000 + GRACE_MS)).toBe(0);
      world.clock.advance(3_999);
      await settle();
      expect(turnEnds(world)).toEqual([]);
      expectAlive(world);

      world.clock.advance(1);
      await waitForEvent(world, "turn.end");
      await settle();
      expect(turnEnds(world)).toEqual([stoppedEnd(world)]);
      expectNoError(world);
      expect(abortCount(stdin)).toBe(1);
    },
  );

  it(
    "S5b a repeated stop settles nothing new: an approval raised after the snapshot stays pending",
    REAL,
    async () => {
      const world = await open("approval-chain-abort-ignored");
      await pendingApproval(world);
      const child = spawnedAt(world, 0);
      await stop(world);
      const [, second] = await waitForRows(world, 2);
      if (second === undefined) {
        throw new Error("missing r2 approval row");
      }
      await stop(world);
      await settle();

      expect(responses(child)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Deny" },
      ]);
      expect(abortCount(child.stdin)).toBe(1);
      expect(approvalRow(world.fixture.db, second.id).decision).toBeNull();
      expect(
        ofType(sessionEvents(world), "approval.resolved").filter(
          (event) => event.data.approvalId === second.id,
        ),
      ).toEqual([]);
    },
  );

  it(
    "S6 startup reconciliation fails running rows and leaves stopped rows unchanged",
    REAL,
    async () => {
      const world = await openStopWorld("abort-ok");
      let appClosed = false;
      try {
        await stopNatively(world);
        appClosed = true;
        await world.fixture.app.close();
        const { db } = world.fixture;
        const own = <R extends { session_id: string }>(rows: R[]): R[] =>
          rows.filter((row) => row.session_id === world.session);
        const sessionBefore = sessionRow(db, world.session);
        const messagesBefore = own(messageRows(db));
        const ids = new Set(messagesBefore.map((row) => row.id));
        const stepsBefore = stepRows(db).filter((row) => ids.has(row.message_id));
        expect(sessionBefore.status).toBe("stopped");
        expect(messagesBefore.map((row) => row.status)).toEqual(["done", "stopped"]);

        const running = sessionId("e");
        seedSession(db, {
          id: running,
          ownerId: OWNER_ID,
          title: null,
          status: "running",
          ompSessionFile: null,
          streamEpoch: 0,
          createdAt: T,
          updatedAt: T,
        });
        const assistant = seedMessage(db, {
          sessionId: running,
          role: "assistant",
          content: "",
          status: "running",
          createdAt: T,
        });
        const step = seedStep(db, {
          messageId: assistant,
          ordinal: 0,
          name: "bash",
          detail: "",
          status: "running",
          startedAt: T,
          endedAt: null,
        });
        createSessionStore(db, { onFlushError() {} }).reconcileOnStartup();

        expect(sessionRow(db, world.session)).toEqual(sessionBefore);
        expect(own(messageRows(db))).toEqual(messagesBefore);
        expect(stepRows(db).filter((row) => ids.has(row.message_id))).toEqual(stepsBefore);
        expect(sessionRows(db).find((row) => row.id === running)?.status).toBe("failed");
        // Reconciliation records no end: the conflict criterion of undo reads this (#952).
        expect(sessionRows(db).find((row) => row.id === running)?.updated_at).toBe(T);
        expect(messageRows(db).find((row) => row.id === assistant)?.status).toBe("failed");
        expect(stepRows(db).find((row) => row.id === step)?.status).toBe("failed");
      } finally {
        if (!appClosed) {
          await world.fixture.app.close().catch(() => undefined);
        }
        world.fixture.db.close();
      }
    },
  );
});

/** Both approval-parallel selects persisted pending and both approval.request events published. */
async function heldApprovals(world: ApprovalWorld): Promise<void> {
  await pendingApproval(world);
  await waitForRows(world, 2);
  await waitForEvent(world, "approval.request", 2);
}
