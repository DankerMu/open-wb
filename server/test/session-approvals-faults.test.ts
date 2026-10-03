/**
 * Issue #464 approval faults and lifetimes (R14–R18, R17b): pending approvals suspend idle expiry,
 * persistence failures publish nothing and take the owned error sink, late answers never reach a
 * successor process, and shutdown revokes approval timers. Real fake-omp children, real SQLite
 * triggers for injected failures, Node's own child exit state and the injected clock.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalWorld,
  approvalRow,
  approvalRows,
  expectQuiet,
  ofType,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  rejection,
  responses,
  sessionEvents,
  settle,
  spawnedAt,
  T,
  TTL_MS,
  waitForEvent,
  waitForResponses,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  closeAfterRetainedFault,
  containsMessage,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { isLive, waitExited } from "./session-supervisor-pool-helpers.js";

const INSERT_BLOCKED = "approval insert blocked";
const AUDIT_BLOCKED = "approval audit blocked";
const BLOCK_INSERT = `CREATE TRIGGER block_approval_insert BEFORE INSERT ON chat_approvals
  BEGIN SELECT RAISE(ABORT, '${INSERT_BLOCKED}'); END`;
const BLOCK_AUDIT = `CREATE TRIGGER block_approval_audit BEFORE INSERT ON audit_events
  WHEN NEW.kind = 'session.approval' BEGIN SELECT RAISE(ABORT, '${AUDIT_BLOCKED}'); END`;

const worlds: ApprovalWorld[] = [];
const faulted = new Set<ApprovalWorld>();

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await closeAfterRetainedFault(world.fixture, faulted.has(world));
  }
  faulted.clear();
});

async function open(
  scenario: "approval" | "approval-parallel",
  options: Parameters<typeof openApprovalWorld>[1] = {},
): Promise<ApprovalWorld> {
  const world = await openApprovalWorld(scenario, options);
  worlds.push(world);
  return world;
}

function expectRunning(world: ApprovalWorld, index: number): void {
  const { child } = spawnedAt(world, index);
  expect(isLive(child)).toBe(true);
  expect(child.stdin.writableEnded).toBe(false);
  expect(child.signalCode).toBeNull();
}

async function expectRetired(world: ApprovalWorld, index: number): Promise<void> {
  const { child } = spawnedAt(world, index);
  await waitFor(() => (child.stdin.writableEnded ? true : undefined), "stdin EOF");
  await waitExited(child, "retired child");
}

/** SIGKILLs the first child while its approval is pending and waits for the failed turn. */
async function killFirst(world: ApprovalWorld): Promise<void> {
  const { child } = spawnedAt(world, 0);
  child.kill("SIGKILL");
  await waitForTurn(world.fixture, world.session, "failed");
  await waitExited(child, "killed P1");
  await settle();
}

describe("pending approvals and idle expiry", () => {
  it(
    "R14a a pending approval suspends idle until one full idle period after settlement",
    REAL,
    async () => {
      const world = await open("approval", { idleMs: 1_000 });
      await pendingApproval(world);

      world.clock.advance(50_000);
      await settle();
      expectRunning(world, 0);

      world.clock.advance(10_000);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      world.clock.advance(999);
      await settle();
      expectRunning(world, 0);
      world.clock.advance(1);
      await expectRetired(world, 0);
    },
  );

  it("R14b idle stays suspended while any parallel approval is pending", REAL, async () => {
    const world = await open("approval-parallel", { idleMs: 1_000 });
    await prompted(world);
    const [r1, r2] = await waitForRows(world, 2);
    await waitForEvent(world, "approval.request", 2);

    world.clock.advance(10_000);
    await world.fixture.supervisor.decide(world.session, r2?.id as number, "deny");
    await waitForResponses(spawnedAt(world, 0), 1);
    await settle();
    world.clock.advance(40_000);
    await settle();
    expectRunning(world, 0);

    await world.fixture.supervisor.decide(world.session, r1?.id as number, "allow");
    await waitForTurn(world.fixture, world.session, "done");
    await settle();
    world.clock.advance(999);
    await settle();
    expectRunning(world, 0);
    world.clock.advance(1);
    await expectRetired(world, 0);
  });
});

describe("approval persistence failures", () => {
  it(
    "R15 a failed pending insert publishes nothing, answers nothing and retires the child",
    REAL,
    async () => {
      const world = await open("approval", { prepare: (db) => db.exec(BLOCK_INSERT) });
      faulted.add(world);
      await prompted(world);
      await waitFor(() => (world.errors.length > 0 ? true : undefined), "insert fault");
      await expectRetired(world, 0);
      await settle();

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], INSERT_BLOCKED)).toBe(true);
      expect(approvalRows(world.fixture.db)).toEqual([]);
      expect(
        sessionEvents(world).filter((entry) => entry.event.type.startsWith("approval.")),
      ).toEqual([]);
      expect(responses(spawnedAt(world, 0))).toEqual([]);
      await assertRetainedFaultOnShutdown(world.fixture, INSERT_BLOCKED);
    },
  );

  it(
    "R16a a failed answer transaction rolls back the decision and can be retried",
    REAL,
    async () => {
      const world = await open("approval", { prepare: (db) => db.exec(BLOCK_AUDIT) });
      const row = await pendingApproval(world);

      const failure = await rejection(
        world.fixture.supervisor.decide(world.session, row.id, "allow"),
      );

      expect(containsMessage(failure, AUDIT_BLOCKED)).toBe(true);
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expectQuiet(world);
      expect(world.errors).toEqual([]);

      world.fixture.db.exec("DROP TRIGGER block_approval_audit");
      const settled = await world.fixture.supervisor.decide(world.session, row.id, "allow");
      expect(settled).toMatchObject({ id: row.id, decision: "allow" });
      await waitForTurn(world.fixture, world.session, "done");
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      expect(ofType(sessionEvents(world), "approval.resolved")).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "R16b a failed timeout transaction takes the owned error sink and retires the child",
    REAL,
    async () => {
      const world = await open("approval", { prepare: (db) => db.exec(BLOCK_AUDIT) });
      faulted.add(world);
      const row = await pendingApproval(world);

      world.clock.advance(TTL_MS);
      await waitFor(() => (world.errors.length > 0 ? true : undefined), "timeout fault");
      await expectRetired(world, 0);
      await settle();

      expect(world.errors).toHaveLength(2);
      for (const error of world.errors) {
        expect(containsMessage(error, AUDIT_BLOCKED)).toBe(true);
      }
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expectQuiet(world);
      await assertRetainedFaultOnShutdown(world.fixture, AUDIT_BLOCKED);
    },
  );
});

describe("late settlements never reach a successor process", () => {
  it(
    "R17 a late answer for a dead process's approval leaves the successor's r1 pending",
    REAL,
    async () => {
      const world = await open("approval", { idleMs: 1_000 });
      const a1 = await pendingApproval(world);
      await killFirst(world);

      await prompted(world);
      const a2 = (await waitForRows(world, 2))[1];
      await waitForEvent(world, "approval.request", 2);
      if (a2 === undefined) {
        throw new Error("missing successor approval");
      }
      const successor = spawnedAt(world, 1);
      const resolvedBefore = ofType(sessionEvents(world), "approval.resolved").length;

      await world.fixture.supervisor.decide(world.session, a1.id, "allow").catch(() => undefined);
      await settle();

      expect(responses(successor)).toEqual([]);
      expect(approvalRow(world.fixture.db, a2.id)).toMatchObject({ decision: null });
      expect(ofType(sessionEvents(world), "approval.resolved")).toHaveLength(resolvedBefore);
      world.clock.advance(5_000);
      await settle();
      expectRunning(world, 1);

      await world.fixture.supervisor.decide(world.session, a2.id, "allow");
      await waitForTurn(world.fixture, world.session, "done");
      expect(responses(successor)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
    },
  );

  it(
    "R17b a dead process's approval timer never answers or publishes to the successor",
    REAL,
    async () => {
      const world = await open("approval", { idleMs: 1_000 });
      await pendingApproval(world);
      await killFirst(world);

      world.clock.advance(30_000);
      await prompted(world);
      const a2 = (await waitForRows(world, 2))[1];
      const requests = await waitForEvent(world, "approval.request", 2);
      expect(a2).toMatchObject({ requested_at: T + 30_000, decision: null });
      const successorEpoch = sessionEvents(world).find(
        (entry) => entry.event === requests[1],
      )?.epoch;
      const successorResolved = () =>
        sessionEvents(world).filter(
          (entry) => entry.epoch === successorEpoch && entry.event.type === "approval.resolved",
        ).length;
      const before = successorResolved();

      world.clock.advance(30_000);
      await settle();

      expect(responses(spawnedAt(world, 1))).toEqual([]);
      expect(approvalRow(world.fixture.db, a2?.id as number)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expect(successorResolved()).toBe(before);
      expectRunning(world, 1);
    },
  );
});

describe("vanished approval rows", () => {
  it(
    "R21 expiry of a cascade-deleted approval row is a silent miss, not a fault",
    REAL,
    async () => {
      const world = await open("approval");
      const row = await pendingApproval(world);
      // The rows a message-delete cascade removes. Deleting the running assistant row itself would
      // also break the store's own terminal writes, which is unrelated to the approval timer.
      world.fixture.db
        .prepare("DELETE FROM chat_approvals WHERE message_id = ?")
        .run(row.message_id);
      expect(approvalRows(world.fixture.db)).toEqual([]);

      world.clock.advance(TTL_MS);
      await settle();

      expect(world.errors).toEqual([]);
      expectRunning(world, 0);
      expectQuiet(world);
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
      await expect(world.fixture.app.close()).resolves.toBeUndefined();
    },
  );
});

describe("shutdown", () => {
  it("R18 shutdown revokes approval timers without settling them", REAL, async () => {
    const world = await openApprovalWorld("approval");
    let closed = false;
    try {
      await pendingApproval(world);
      const child = spawnedAt(world, 0);
      closed = true;
      await world.fixture.app.close();
      const framesAtClose = child.stdin.length;

      world.clock.advance(120_000);
      await settle();

      expect(world.errors).toEqual([]);
      expect(
        world.fixture.db
          .prepare("SELECT COUNT(*) AS count FROM chat_approvals WHERE decision = 'timeout'")
          .get(),
      ).toEqual({ count: 0 });
      expect(child.stdin.length).toBe(framesAtClose);
      expect(responses(child)).toEqual([]);
    } finally {
      if (!closed) {
        await world.fixture.app.close().catch(() => undefined);
      }
      world.fixture.db.close();
    }
  });
});
