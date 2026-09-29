/**
 * Issue #619 infra-fault retire settles its pending approvals as `deny` (tool-approval path 7):
 * a failed persistence write, a violated onEvent sink or a failed approval transaction retires the
 * slot with infraFaulted, and every approval still registered on it is denied through the store CAS
 * with its audit, its timer revoked, no frame written. Real fake-omp children, real SQLite triggers
 * for injected failures, the production REST assembly and the injected clock.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalRow,
  type ApprovalWorld,
  approvalRow,
  approvalRows,
  auditCount,
  isToolStart,
  ofType,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  responses,
  settle,
  spawnedAt,
  T,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  closeAfterRetainedFault,
  containsMessage,
  waitFor,
} from "./session-supervisor-helpers.js";
import { waitExited } from "./session-supervisor-pool-helpers.js";

const STEP_BLOCKED = "tool step insert blocked";
const SINK_BROKEN = "observation sink broken";
const TIMEOUT_BLOCKED = "r1 timeout blocked";
const AUDIT_BLOCKED = "approval audit blocked";
/** In `approval`, the first persistent write after r1 registers is tool_execution_start's step. */
const BLOCK_STEP = `CREATE TRIGGER block_tool_step BEFORE INSERT ON chat_steps
  BEGIN SELECT RAISE(ABORT, '${STEP_BLOCKED}'); END`;
const BLOCK_AUDIT = `CREATE TRIGGER block_approval_audit BEFORE INSERT ON audit_events
  WHEN NEW.kind = 'session.approval' BEGIN SELECT RAISE(ABORT, '${AUDIT_BLOCKED}'); END`;

/** Only r1's timeout transaction fails; any other settlement of any row still commits. */
function blockTimeoutOf(approvalId: number): string {
  return `CREATE TRIGGER block_r1_timeout BEFORE UPDATE ON chat_approvals
    WHEN OLD.id = ${String(approvalId)} AND NEW.decision = 'timeout'
    BEGIN SELECT RAISE(ABORT, '${TIMEOUT_BLOCKED}'); END`;
}

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await closeAfterRetainedFault(world.fixture, true);
  }
});

async function open(
  scenario: "approval" | "approval-parallel",
  options: Parameters<typeof openApprovalWorld>[1] = {},
): Promise<ApprovalWorld> {
  const world = await openApprovalWorld(scenario, options);
  worlds.push(world);
  return world;
}

/** `detail.decision` of every session.approval audit row, in insertion order. */
function auditedDecisions(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT json_extract(detail, '$.decision') AS decision FROM audit_events
        WHERE kind = 'session.approval' ORDER BY id`,
    )
    .all() as unknown as Array<{ decision: string }>;
  return rows.map((row) => row.decision);
}

function timeoutRows(db: DatabaseSync): number {
  return approvalRows(db).filter((row) => row.decision === "timeout").length;
}

/** No approval row or audit anywhere says `timeout`, and no child ever got an answer frame. */
function expectNoTimeoutNoFrames(world: ApprovalWorld): void {
  expect(timeoutRows(world.fixture.db)).toBe(0);
  expect(auditedDecisions(world.fixture.db)).not.toContain("timeout");
  for (const spawned of world.spawned) {
    expect(responses(spawned)).toEqual([]);
  }
}

/** Waits for the first retained fault, the child's stdin EOF and exit: the slot is retired. */
async function infraRetired(world: ApprovalWorld): Promise<void> {
  const { child } = spawnedAt(world, 0);
  await waitFor(() => (world.errors.length > 0 ? true : undefined), "retained infra fault");
  await waitFor(() => (child.stdin.writableEnded ? true : undefined), "stdin EOF");
  await waitExited(child, "infra-retired child");
  await settle();
  expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
}

/** The single-approval deny outcome of path 7, checked before and after the TTL elapses. */
function expectDenied(world: ApprovalWorld, row: ApprovalRow): void {
  const settled = approvalRow(world.fixture.db, row.id);
  expect(settled.decision).toBe("deny");
  expect(settled.decided_at).not.toBeNull();
  expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
  expectNoTimeoutNoFrames(world);
}

/** F1(a)/F3/F4 set-up: r1 pending, then its tool_execution_start step insert fails. */
async function commitFaulted(prepare: (db: DatabaseSync) => void) {
  const world = await open("approval", { prepare });
  await prompted(world);
  const [row] = await waitForRows(world, 1);
  if (row === undefined) {
    throw new Error("missing pending approval row");
  }
  await infraRetired(world);
  return { world, row };
}

describe("infra-fault retire denies pending approvals (#619)", () => {
  it(
    "F1a a failed #commit write retires the slot and denies r1; the TTL never writes timeout",
    REAL,
    async () => {
      const { world, row } = await commitFaulted((db) => db.exec(BLOCK_STEP));

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], STEP_BLOCKED)).toBe(true);
      expectDenied(world, row);
      expect(ofType(world.events, "approval.resolved")).toEqual([]);

      world.clock.advance(TTL_MS + 1);
      await settle();

      expectDenied(world, row);
      expect(ofType(world.events, "approval.resolved")).toEqual([]);
      expect(world.errors).toHaveLength(1);
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
      await assertRetainedFaultOnShutdown(world.fixture, STEP_BLOCKED);
    },
  );

  it(
    "F1b an onEvent sink violation retires the slot and denies r1; the TTL never writes timeout",
    REAL,
    async () => {
      const world = await open("approval", {
        onEvent(_sessionId, _epoch, event) {
          if (event.type === "step.start") {
            throw new Error(SINK_BROKEN);
          }
        },
      });
      const row = await pendingApproval(world);
      await infraRetired(world);

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], SINK_BROKEN)).toBe(true);
      expectDenied(world, row);
      expect(ofType(world.events, "approval.resolved")).toEqual([]);

      world.clock.advance(TTL_MS + 1);
      await settle();

      expectDenied(world, row);
      expect(ofType(world.events, "approval.resolved")).toEqual([]);
      expect(world.errors).toHaveLength(1);
      await assertRetainedFaultOnShutdown(world.fixture, SINK_BROKEN);
    },
  );

  it(
    "F2 r1's failed timeout transaction retires the slot; r2 is denied, never timed out",
    REAL,
    async () => {
      const world = await open("approval-parallel");
      await prompted(world);
      const [r1, r2] = await waitForRows(world, 2);
      await waitForEvent(world, "approval.request", 2);
      if (r1 === undefined || r2 === undefined) {
        throw new Error("missing parallel approval rows");
      }
      world.fixture.db.exec(blockTimeoutOf(r1.id));

      world.clock.advance(TTL_MS);
      await infraRetired(world);

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], TIMEOUT_BLOCKED)).toBe(true);
      const denied = approvalRow(world.fixture.db, r2.id);
      expect(denied.decision).toBe("deny");
      expect(denied.decided_at).not.toBeNull();
      // r1's registration dropped with its failed transaction: it stays NULL for reconciliation.
      expect(approvalRow(world.fixture.db, r1.id).decision).toBeNull();
      expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
      expectNoTimeoutNoFrames(world);

      world.clock.advance(TTL_MS);
      await settle();

      expect(approvalRow(world.fixture.db, r2.id).decision).toBe("deny");
      expect(approvalRow(world.fixture.db, r1.id).decision).not.toBe("timeout");
      expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
      expectNoTimeoutNoFrames(world);
      expect(world.errors).toHaveLength(1);
      await assertRetainedFaultOnShutdown(world.fixture, TIMEOUT_BLOCKED);
    },
  );

  it(
    "F3 the owner's answer after the infra retire is 409 approval_settled and writes nothing",
    REAL,
    async () => {
      const { world, row } = await commitFaulted((db) => db.exec(BLOCK_STEP));
      const rowBefore = approvalRow(world.fixture.db, row.id);
      const auditsBefore = auditCount(world.fixture.db);

      const response = await world.fixture.app.inject({
        method: "POST",
        url: `/api/sessions/${world.session}/approvals/${String(row.id)}`,
        headers: { "content-type": "application/json", cookie: world.cookie },
        payload: JSON.stringify({ decision: "allow" }),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toStrictEqual({
        error: { code: "approval_settled", message: "该审批已处理" },
      });
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toStrictEqual(rowBefore);
      expect(rowBefore.decision).toBe("deny");
      expect(auditCount(world.fixture.db)).toBe(auditsBefore);
      expect(responses(spawnedAt(world, 0))).toEqual([]);
      expect(world.errors).toHaveLength(1);
    },
  );

  it(
    "F4 a failed deny transaction never blocks the retire and leaves no timer behind",
    REAL,
    async () => {
      const { world, row } = await commitFaulted((db) => {
        db.exec(BLOCK_STEP);
        db.exec(BLOCK_AUDIT);
      });

      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
      expect(world.errors).toHaveLength(2);
      expect(containsMessage(world.errors[0], STEP_BLOCKED)).toBe(true);
      expect(containsMessage(world.errors[1], AUDIT_BLOCKED)).toBe(true);
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });

      world.clock.advance(TTL_MS + 1);
      await settle();

      expect(world.errors).toHaveLength(2);
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expect(auditedDecisions(world.fixture.db)).toEqual([]);
      expectNoTimeoutNoFrames(world);
      await assertRetainedFaultOnShutdown(world.fixture, AUDIT_BLOCKED);
    },
  );

  it(
    "F5 a cascade-deleted approval row is a silent miss of the infra retire, not a second fault",
    REAL,
    async () => {
      const world = await open("approval", {
        prepare: (db) => db.exec(BLOCK_STEP),
        hold: isToolStart,
      });
      const row = await pendingApproval(world);
      // The rows a message-delete cascade removes, while tool_execution_start is still held.
      world.fixture.db
        .prepare("DELETE FROM chat_approvals WHERE message_id = ?")
        .run(row.message_id);
      spawnedAt(world, 0).gate.release();
      await infraRetired(world);

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], STEP_BLOCKED)).toBe(true);
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
      world.clock.advance(TTL_MS + 1);
      await settle();

      expect(world.errors).toHaveLength(1);
      expect(approvalRows(world.fixture.db)).toEqual([]);
      expect(auditedDecisions(world.fixture.db)).toEqual([]);
      expectNoTimeoutNoFrames(world);
      await assertRetainedFaultOnShutdown(world.fixture, STEP_BLOCKED);
    },
  );
});
