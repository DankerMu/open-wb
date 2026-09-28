/**
 * Issue #474 B1–B3: the stop paths leave no pending approval. B1 is stop's bounded-retire
 * exception — an approval raised after the Deny snapshot (fake `approval-chain-abort-ignored`)
 * is denied in the running→stopped transaction once the grace runs out on the injected clock.
 * B2/B3 are always-green guards for the #464/#473 stop settlement (Deny before abort, all pending
 * denied) driven through REST `POST /stop`. Production createApp → registerSessions over real
 * fake-omp children and real SQLite; oracles are rows, audit rows, stdin frames, onEvent, a live
 * subscriber, REST reads and Node's own child state.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  approvalRow,
  approvalRows,
  pendingApproval,
  prompted,
  REAL,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  approvalAudits,
  denyAudit,
  expectDeniedBeforeEnd,
  observed,
  subscribeLive,
} from "./session-settlement-helpers.js";
import {
  abortCount,
  afterPrompt,
  collectRejections,
  expectAnswersThenAbort,
  expectNoError,
  GRACE_MS,
  history,
  openStopWorld,
  type StopScenario,
  stop,
  turnEnds,
} from "./session-stop-helpers.js";
import { sessionRow } from "./session-store-helpers.js";
import { OWNER_ID } from "./session-supervisor-helpers.js";
import { waitExited } from "./session-supervisor-pool-helpers.js";

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

async function postStop(world: ApprovalWorld) {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/stop`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(202);
  expect(response.payload).toBe("{}");
}

function expectDenyAudits(world: ApprovalWorld, messageId: number, count: number): void {
  const deny = denyAudit(OWNER_ID, world.session, messageId);
  expect(approvalAudits(world.fixture.db)).toEqual(Array.from({ length: count }, () => deny));
}

describe("stop's bounded retire settles what the snapshot missed (B1)", () => {
  it(
    "B1 an approval raised after the Deny snapshot is denied in the running→stopped transaction",
    REAL,
    async () => {
      const world = await open("approval-chain-abort-ignored");
      const rejections = collectRejections();
      try {
        await prompted(world);
        const [r1] = await waitForRows(world, 1);
        await waitForEvent(world, "approval.request", 1);
        if (r1 === undefined) {
          throw new Error("missing r1 approval row");
        }
        const live = subscribeLive(world);
        const { child, stdin } = spawnedAt(world, 0);
        await stop(world);
        const [, r2] = await waitForRows(world, 2);
        await waitForEvent(world, "approval.request", 2);
        if (r2 === undefined) {
          throw new Error("missing r2 approval row");
        }
        expect(approvalRow(world.fixture.db, r2.id).decision).toBeNull();
        expect(world.timersDueAt(T + TTL_MS)).toBe(1);

        world.clock.advance(GRACE_MS - 1);
        await settle();
        expect(turnEnds(world)).toEqual([]);
        expect(sessionRow(world.fixture.db, world.session).status).toBe("running");

        world.clock.advance(1);
        await waitForEvent(world, "turn.end");
        await waitExited(child, "retired child");
        expect(child.exitCode).toBe(0);
        const seen = sessionEvents(world).length;
        await settle();
        expect(sessionEvents(world)).toHaveLength(seen);

        expectNoError(world);
        expect(approvalRow(world.fixture.db, r1.id).decision).toBe("deny");
        expect(approvalRow(world.fixture.db, r2.id)).toMatchObject({ decision: "deny" });
        expect(approvalRow(world.fixture.db, r2.id).decided_at).not.toBeNull();
        expectDenyAudits(world, r1.message_id, 2);
        const written = afterPrompt(stdin);
        expect(written.filter((frame) => frame.type === "extension_ui_response")).toEqual([
          { type: "extension_ui_response", id: "r1", value: "Deny" },
        ]);
        expect(abortCount(written)).toBe(1);
        expectDeniedBeforeEnd(observed(world), r1.message_id, [r1.id, r2.id], "stopped");
        expectDeniedBeforeEnd(live, r1.message_id, [r1.id, r2.id], "stopped");

        const stopped = await history(world);
        expect(stopped.session.status).toBe("stopped");
        expect(stopped.messages[1]?.status).toBe("stopped");
        expect(stopped.messages[1]?.steps.map((step) => step.status)).toEqual([
          "failed",
          "stopped",
        ]);
        expect(world.timersDueAt(T + TTL_MS)).toBe(0);
        expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
        expect(world.errors).toEqual([]);

        worlds.delete(world);
        await world.fixture.close();
        await settle();
        expect(rejections.reasons).toEqual([]);
      } finally {
        rejections.dispose();
      }
    },
  );
});

describe("stop settlement guards (B2–B3)", () => {
  it(
    "B2 REST stop answers Deny before abort and denies the approval before turn.end",
    REAL,
    async () => {
      const world = await open("approval-then-abort");
      const row = await pendingApproval(world);
      const { stdin } = spawnedAt(world, 0);

      await postStop(world);

      expectAnswersThenAbort(stdin, [["r1", "Deny"]]);
      await waitForEvent(world, "turn.end");
      await settle();
      expect(approvalRow(world.fixture.db, row.id).decision).toBe("deny");
      expectDenyAudits(world, row.message_id, 1);
      expectDeniedBeforeEnd(observed(world), row.message_id, [row.id], "stopped");
    },
  );

  it("B3 REST stop denies every pending approval before turn.end", REAL, async () => {
    const world = await open("approval-parallel");
    await prompted(world);
    const rows = await waitForRows(world, 2);
    await waitForEvent(world, "approval.request", 2);
    const ids = rows.map((row) => row.id);
    const messageId = approvalRow(world.fixture.db, ids[0] as number).message_id;

    await postStop(world);

    await waitForEvent(world, "turn.end");
    await settle();
    expect(approvalRows(world.fixture.db).map((row) => row.decision)).toEqual(["deny", "deny"]);
    expectDenyAudits(world, messageId, 2);
    expectDeniedBeforeEnd(observed(world), messageId, ids, "stopped");
    expect(responses(spawnedAt(world, 0))).toHaveLength(2);
  });
});
