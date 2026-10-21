/**
 * Issue #619 infra-fault retire settles its pending approvals as `deny` (tool-approval path 7):
 * a failed persistence write, a violated onEvent sink or a failed approval transaction retires the
 * slot with infraFaulted, and every approval still registered on it is denied through the store CAS
 * with its audit, its timer revoked, no frame written. Real fake-omp children, real SQLite triggers
 * for injected failures, the production REST assembly and the injected clock. Issue #662: the
 * approval whose own timeout transaction failed keeps its registration, so that retire denies it too.
 * Issue #1571: fake-omp emits each tool start before its select (omp v18.12.3), so the cases that
 * fail the step insert hold the start and release it together with r1's select as one chunk: the
 * runtime registers r1 at parse time, before the pump commits the step.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalRow,
  type ApprovalWorld,
  approvalRow,
  approvalRows,
  auditCount,
  isSelect,
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
import { collectRejections } from "./session-stop-helpers.js";
import {
  assertRetainedFaultOnShutdown,
  capturedFailure,
  closeAfterRetainedFault,
  containsMessage,
  waitFor,
} from "./session-supervisor-helpers.js";
import { waitExited } from "./session-supervisor-pool-helpers.js";

const STEP_BLOCKED = "tool step insert blocked";
const SINK_BROKEN = "observation sink broken";
const TIMEOUT_BLOCKED = "r1 timeout blocked";
const DENY_BLOCKED = "r1 deny blocked";
const AUDIT_BLOCKED = "approval audit blocked";
const PAIRING_BLOCKED = "r2 pairing blocked";
/** With start and r1's select in one chunk, the first persistent write after r1 registers is the step. */
const BLOCK_STEP = `CREATE TRIGGER block_tool_step BEFORE INSERT ON chat_steps
  BEGIN SELECT RAISE(ABORT, '${STEP_BLOCKED}'); END`;
/** r2's select-time pairing write (tool-approval「配对写失败」, the select-time case). */
const BLOCK_R2_PAIRING = `CREATE TEMP TRIGGER block_r2_pairing BEFORE UPDATE OF step_id ON chat_approvals
  WHEN NEW.request_id = 'r2' BEGIN SELECT RAISE(ABORT, '${PAIRING_BLOCKED}'); END`;
const BLOCK_AUDIT = `CREATE TRIGGER block_approval_audit BEFORE INSERT ON audit_events
  WHEN NEW.kind = 'session.approval' BEGIN SELECT RAISE(ABORT, '${AUDIT_BLOCKED}'); END`;

/** Only r1's settlement as `decision` fails; any other settlement of any row still commits. */
function blockDecisionOf(
  approvalId: number,
  decision: "timeout" | "deny",
  message: string,
): string {
  return `CREATE TRIGGER block_r1_${decision} BEFORE UPDATE ON chat_approvals
    WHEN OLD.id = ${String(approvalId)} AND NEW.decision = '${decision}'
    BEGIN SELECT RAISE(ABORT, '${message}'); END`;
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

/** The owner's `allow` through the production REST route is 409 `approval_settled`. */
async function expectAllowRefused(world: ApprovalWorld, row: ApprovalRow): Promise<void> {
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
}

/** F2/F6 set-up: both `approval-parallel` requests registered and published, r1 first. */
async function parallelPending(world: ApprovalWorld): Promise<[ApprovalRow, ApprovalRow]> {
  await prompted(world);
  const [r1, r2] = await waitForRows(world, 2);
  await waitForEvent(world, "approval.request", 2);
  if (r1 === undefined || r2 === undefined) {
    throw new Error("missing parallel approval rows");
  }
  return [r1, r2];
}

/** Holds `approval`'s tool start until r1's select is held too, then writes both as one chunk. */
async function releaseStartWithSelect(world: ApprovalWorld): Promise<void> {
  const spawned = await waitFor(() => world.spawned[0], "gated child");
  await waitFor(() => (isSelect("r1")(spawned.gate.held()) ? true : undefined), "held r1 select");
  spawned.gate.release();
}

/** F1a/F1b/F3/F4 set-up: r1 registered, then the step commit of its tool start faults. */
async function commitFaulted(options: Parameters<typeof openApprovalWorld>[1]) {
  const world = await open("approval", { ...options, hold: isToolStart });
  await prompted(world);
  await releaseStartWithSelect(world);
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
      const { world, row } = await commitFaulted({ prepare: (db) => db.exec(BLOCK_STEP) });

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
      const { world, row } = await commitFaulted({
        onEvent(_sessionId, _epoch, event) {
          if (event.type === "step.start") {
            throw new Error(SINK_BROKEN);
          }
        },
      });

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
    "F2 r1's failed timeout transaction retires the slot; r1 and r2 are denied, never timed out",
    REAL,
    async () => {
      const world = await open("approval-parallel");
      const [r1, r2] = await parallelPending(world);
      world.fixture.db.exec(blockDecisionOf(r1.id, "timeout", TIMEOUT_BLOCKED));

      world.clock.advance(TTL_MS);
      await infraRetired(world);

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], TIMEOUT_BLOCKED)).toBe(true);
      // r1 kept its registration through its failed transaction: the retire denies it with r2.
      const denied = [approvalRow(world.fixture.db, r1.id), approvalRow(world.fixture.db, r2.id)];
      for (const row of denied) {
        expect(row.decision).toBe("deny");
        expect(row.decided_at).not.toBeNull();
      }
      expect(auditedDecisions(world.fixture.db)).toEqual(["deny", "deny"]);
      expectNoTimeoutNoFrames(world);
      expect(ofType(world.events, "approval.resolved")).toEqual([]);
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
      const auditsBefore = auditCount(world.fixture.db);

      await expectAllowRefused(world, r1);
      expect(auditCount(world.fixture.db)).toBe(auditsBefore);

      world.clock.advance(TTL_MS);
      await settle();

      expect([
        approvalRow(world.fixture.db, r1.id),
        approvalRow(world.fixture.db, r2.id),
      ]).toStrictEqual(denied);
      expect(auditedDecisions(world.fixture.db)).toEqual(["deny", "deny"]);
      expectNoTimeoutNoFrames(world);
      expect(ofType(world.events, "approval.resolved")).toEqual([]);
      expect(world.errors).toHaveLength(1);
      await assertRetainedFaultOnShutdown(world.fixture, TIMEOUT_BLOCKED);
    },
  );

  it(
    "F3 the owner's answer after the infra retire is 409 approval_settled and writes nothing",
    REAL,
    async () => {
      const { world, row } = await commitFaulted({ prepare: (db) => db.exec(BLOCK_STEP) });
      const rowBefore = approvalRow(world.fixture.db, row.id);
      const auditsBefore = auditCount(world.fixture.db);

      await expectAllowRefused(world, row);
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
      const { world, row } = await commitFaulted({
        prepare: (db) => {
          db.exec(BLOCK_STEP);
          db.exec(BLOCK_AUDIT);
        },
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
      const world = await open("approval-parallel", { hold: isSelect("r2") });
      const r1 = await pendingApproval(world);
      // r1 paired c1 at its select; c2 still runs unpaired, so r2's select will write step_id.
      // Created only now: in `prepare` it would have blocked r1's pairing first.
      world.fixture.db.exec(BLOCK_R2_PAIRING);
      // The rows a message-delete cascade removes, while r2's select is still held.
      world.fixture.db
        .prepare("DELETE FROM chat_approvals WHERE message_id = ?")
        .run(r1.message_id);
      spawnedAt(world, 0).gate.release();
      await infraRetired(world);

      expect(world.errors).toHaveLength(1);
      expect(containsMessage(world.errors[0], PAIRING_BLOCKED)).toBe(true);
      expect(world.timersDueAt(T + TTL_MS)).toBe(0);
      // r2 was inserted at arrival and denied by the retire; r1's deleted row is the silent miss.
      const [r2] = approvalRows(world.fixture.db);
      expect(approvalRows(world.fixture.db)).toEqual([
        expect.objectContaining({ request_id: "r2", decision: "deny" }),
      ]);
      expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
      world.clock.advance(TTL_MS + 1);
      await settle();

      expect(world.errors).toHaveLength(1);
      expect(approvalRows(world.fixture.db)).toStrictEqual([r2]);
      expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
      expectNoTimeoutNoFrames(world);
      await assertRetainedFaultOnShutdown(world.fixture, PAIRING_BLOCKED);
    },
  );

  it(
    "F6 with r1's timeout and deny transactions both failing, r1 stays undecided and both faults are retained",
    REAL,
    async () => {
      const rejections = collectRejections();
      try {
        const world = await open("approval-parallel");
        const [r1, r2] = await parallelPending(world);
        world.fixture.db.exec(blockDecisionOf(r1.id, "timeout", TIMEOUT_BLOCKED));
        world.fixture.db.exec(blockDecisionOf(r1.id, "deny", DENY_BLOCKED));

        world.clock.advance(TTL_MS);
        await infraRetired(world);

        expect(world.errors).toHaveLength(2);
        expect(containsMessage(world.errors[0], TIMEOUT_BLOCKED)).toBe(true);
        expect(containsMessage(world.errors[1], DENY_BLOCKED)).toBe(true);
        // The known residue: r1 waits for shutdown or startup reconciliation; r2 is still denied.
        const undecided = { decision: null, decided_at: null };
        expect(approvalRow(world.fixture.db, r1.id)).toMatchObject(undecided);
        expect(approvalRow(world.fixture.db, r2.id).decision).toBe("deny");
        expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
        expect(world.timersDueAt(T + TTL_MS)).toBe(0);

        world.clock.advance(TTL_MS);
        await settle();

        expect(world.errors).toHaveLength(2);
        expect(approvalRow(world.fixture.db, r1.id)).toMatchObject(undecided);
        expect(auditedDecisions(world.fixture.db)).toEqual(["deny"]);
        expectNoTimeoutNoFrames(world);
        expect(ofType(world.events, "approval.resolved")).toEqual([]);
        const shutdownFailure = await capturedFailure(() => world.fixture.app.close());
        expect(containsMessage(shutdownFailure, TIMEOUT_BLOCKED)).toBe(true);
        expect(containsMessage(shutdownFailure, DENY_BLOCKED)).toBe(true);
        await settle();
        expect(rejections.reasons).toEqual([]);
      } finally {
        rejections.dispose();
      }
    },
  );
});
