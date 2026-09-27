/**
 * Issue #473 stop faults and edges, design S7–S9 (with S8b): a failed `stopped` settlement
 * publishes nothing on either end path, a failed Deny settlement writes no `abort` and clears the
 * in-flight mark, an approval answered concurrently after the snapshot is skipped, and stop after
 * shutdown is `agent_unavailable`. Real fake-omp children, real SQLite triggers for injected
 * failures, the injected clock and Node's own child state.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  approvalRow,
  assistantSteps,
  ofType,
  pendingApproval,
  REAL,
  rejection,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  abortCount,
  afterPrompt,
  collectRejections,
  expectAnswersThenAbort,
  expectNoError,
  GRACE_MS,
  heldTurn,
  openStopWorld,
  type StopScenario,
  stop,
  turnEnds,
} from "./session-stop-helpers.js";
import { messageRows, sessionRow } from "./session-store-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  assistantIdFor,
  closeAfterRetainedFault,
  containsMessage,
  waitFor,
} from "./session-supervisor-helpers.js";
import { waitExited } from "./session-supervisor-pool-helpers.js";

const SETTLE_BLOCKED = "stopped settle blocked";
const BLOCK_STOPPED = `CREATE TRIGGER block_stopped_settle BEFORE UPDATE OF status ON chat_messages
  WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(ABORT, '${SETTLE_BLOCKED}'); END`;
const DENY_BLOCKED = "stop deny blocked";
const BLOCK_DENY = `CREATE TRIGGER block_stop_deny BEFORE INSERT ON audit_events
  WHEN NEW.kind = 'session.approval' BEGIN SELECT RAISE(ABORT, '${DENY_BLOCKED}'); END`;

const worlds = new Set<ApprovalWorld>();
const faulted = new Set<ApprovalWorld>();

afterEach(async () => {
  for (const world of worlds) {
    await closeAfterRetainedFault(world.fixture, faulted.has(world));
  }
  worlds.clear();
  faulted.clear();
});

async function open(scenario: StopScenario): Promise<ApprovalWorld> {
  const world = await openStopWorld(scenario);
  worlds.add(world);
  return world;
}

/** Both end paths: no turn.end or error published, one retained fault, the turn row unsettled. */
async function expectUnpublishedStop(world: ApprovalWorld): Promise<void> {
  faulted.add(world);
  const { child } = spawnedAt(world, 0);
  await waitFor(() => (world.errors.length > 0 ? true : undefined), "retained settle fault");
  await waitFor(() => (child.stdin.writableEnded ? true : undefined), "stdin EOF");
  await waitExited(child, "retired child");
  await settle();
  expect(turnEnds(world)).toEqual([]);
  expect(ofType(sessionEvents(world), "error")).toEqual([]);
  expect(world.errors).toHaveLength(1);
  expect(containsMessage(world.errors[0], SETTLE_BLOCKED)).toBe(true);
  const assistantId = assistantIdFor(world.fixture, world.session);
  expect(messageRows(world.fixture.db).find((row) => row.id === assistantId)?.status).toBe(
    "running",
  );
  await assertRetainedFaultOnShutdown(world.fixture, SETTLE_BLOCKED);
}

describe("stop faults and edges (#473)", () => {
  it(
    "S7a a failed native stopped settlement publishes nothing and retires the runtime",
    REAL,
    async () => {
      const world = await open("abort-ok");
      await heldTurn(world);
      world.fixture.db.exec(BLOCK_STOPPED);
      await stop(world);
      await expectUnpublishedStop(world);
    },
  );

  it("S7b a failed bounded-fallback stopped settlement publishes nothing", REAL, async () => {
    const world = await open("abort-ignored");
    await heldTurn(world);
    world.fixture.db.exec(BLOCK_STOPPED);
    await stop(world);
    world.clock.advance(GRACE_MS);
    await expectUnpublishedStop(world);
  });

  it(
    "S8 a failed Deny settlement rejects stop, writes no abort and clears the in-flight mark",
    REAL,
    async () => {
      const world = await open("approval-then-abort");
      const row = await pendingApproval(world);
      const child = spawnedAt(world, 0);
      world.fixture.db.exec(BLOCK_DENY);

      const failure = await rejection(stop(world));
      expect(containsMessage(failure, DENY_BLOCKED)).toBe(true);
      await settle();
      expect(afterPrompt(child.stdin)).toEqual([]);
      expect(approvalRow(world.fixture.db, row.id).decision).toBeNull();
      expect(ofType(sessionEvents(world), "approval.resolved")).toEqual([]);
      expect(sessionRow(world.fixture.db, world.session).status).toBe("running");

      world.fixture.db.exec("DROP TRIGGER block_stop_deny");
      await stop(world);
      expect(responses(child)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Deny" },
      ]);
      expect(abortCount(child.stdin)).toBe(1);
      await waitForEvent(world, "turn.end");
      await settle();
      expect(turnEnds(world)).toEqual([
        { type: "turn.end", data: { messageId: row.message_id, status: "stopped" } },
      ]);
      expectNoError(world);
    },
  );

  it(
    "S8b an approval answered after the snapshot is skipped, not a stop failure",
    REAL,
    async () => {
      const world = await open("approval-parallel");
      await pendingApproval(world);
      const [first, second] = await waitForRows(world, 2);
      await waitForEvent(world, "approval.request", 2);
      if (first === undefined || second === undefined) {
        throw new Error("missing parallel approval rows");
      }
      const child = spawnedAt(world, 0);
      const rejections = collectRejections();
      try {
        const stopped = stop(world);
        void world.fixture.supervisor.decide(world.session, second.id, "allow");
        await stopped;
        expectAnswersThenAbort(child.stdin, [
          ["r1", "Deny"],
          ["r2", "Approve"],
        ]);

        await waitForEvent(world, "turn.end");
        await settle();
        expect(turnEnds(world)).toEqual([
          { type: "turn.end", data: { messageId: first.message_id, status: "done" } },
        ]);
        expectNoError(world);
        expect(assistantSteps(world).steps.map((step) => step.status)).toEqual(["failed", "done"]);
        const resolved = ofType(sessionEvents(world), "approval.resolved").map((event) => [
          event.data.approvalId,
          event.data.decision,
        ]);
        expect(resolved.sort()).toEqual(
          [
            [first.id, "deny"],
            [second.id, "allow"],
          ].sort(),
        );

        worlds.delete(world);
        await world.fixture.close();
        await settle();
        expect(rejections.reasons).toEqual([]);
      } finally {
        rejections.dispose();
      }
    },
  );

  it("S9 stop after shutdown rejects agent_unavailable", REAL, async () => {
    const world = await openStopWorld("abort-ok");
    try {
      await world.fixture.app.close();
      const failure = await rejection(stop(world));
      expect(failure).toMatchObject({ code: "agent_unavailable" });
    } finally {
      world.fixture.db.close();
    }
  });
});
