/**
 * Issue #464 approval registration, answer and timeout settlement (parent s1c tasks 4.3), R1–R10.
 * Real fake-omp `approval` children under `--approval-mode write`, real SQLite, the injected clock
 * and the production createApp → registerSessions assembly. Expected rows, frames and payloads are
 * fixture literals from the tool-approval spec (T, T+60000, "Approve"/"Deny", audit title).
 *
 * Issue #1009 (s1g-composer-capabilities task 9.3), W1–W2: the same flow for the `write` tool of an
 * `always-ask` session (fake-omp `approval-write`, which gates under `--approval-mode always-ask`
 * only) — tool-approval「审批请求识别」 and session-permission-tier「每次都问下的超时」. The session is
 * moved to `always-ask` over `PATCH /api/sessions/:id` before its first prompt.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApprovalRow,
  type ApprovalWorld,
  approvalAuditCount,
  approvalRow,
  approvalRows,
  assistantSteps,
  auditCount,
  DENIED_OUTPUT,
  expectQuiet,
  extraSession,
  flagValue,
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
  TITLE,
  TTL_MS,
  waitForEvent,
  waitForResponses,
  waitForRows,
} from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import {
  assistantIdFor,
  OWNER_ID,
  requiredCall,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(): Promise<ApprovalWorld> {
  const world = await openApprovalWorld("approval");
  worlds.push(world);
  return world;
}

function resolvedFor(world: ApprovalWorld, session = world.session) {
  return ofType(sessionEvents(world, session), "approval.resolved").map((event) => event.data);
}

describe("approval registration", () => {
  it(
    "R1 persists one pending row at T and publishes exactly one approval.request",
    REAL,
    async () => {
      const world = await open();
      await pendingApproval(world);
      await settle();

      const assistantId = assistantIdFor(world.fixture, world.session);
      const rows = await waitForRows(world, 1);
      expect(rows).toEqual([
        {
          id: expect.any(Number),
          message_id: assistantId,
          request_id: "r1",
          tool: "bash",
          title: TITLE,
          requested_at: T,
          expires_at: T + TTL_MS,
          decision: null,
          decided_at: null,
        },
      ]);
      const requests = ofType(sessionEvents(world), "approval.request");
      expect(requests.map((event) => event.data)).toEqual([
        {
          messageId: assistantId,
          approvalId: rows[0]?.id,
          tool: "bash",
          title: TITLE,
          expiresAt: T + TTL_MS,
        },
      ]);
      expectQuiet(world);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("approval answers", () => {
  it("R2 allow settles the row, answers Approve once and completes the turn", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    world.clock.nowMs = T + 1_000;

    const settled = await world.fixture.supervisor.decide(world.session, row.id, "allow");

    expect(settled).toStrictEqual({
      id: row.id,
      tool: "bash",
      title: TITLE,
      requestedAt: T,
      expiresAt: T + TTL_MS,
      decision: "allow",
    });
    expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
      decision: "allow",
      decided_at: T + 1_000,
    });
    await waitForTurn(world.fixture, world.session, "done");
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Approve" },
    ]);
    expect(resolvedFor(world)).toEqual([
      { messageId: row.message_id, approvalId: row.id, decision: "allow" },
    ]);
    const tree = assistantSteps(world);
    expect(tree.steps.map((step) => [step.name, step.status])).toEqual([["bash", "done"]]);
    expect(tree.assistant.status).toBe("done");
    expect(tree.session.status).toBe("done");
    expect(world.errors).toEqual([]);
  });

  it("R3 deny answers Deny; only the bash step fails and the turn ends done", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    world.clock.nowMs = T + 1_000;

    const settled = await world.fixture.supervisor.decide(world.session, row.id, "deny");

    expect(settled).toMatchObject({ id: row.id, decision: "deny" });
    expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
      decision: "deny",
      decided_at: T + 1_000,
    });
    await waitForTurn(world.fixture, world.session, "done");
    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Deny" },
    ]);
    expect(resolvedFor(world)).toEqual([
      { messageId: row.message_id, approvalId: row.id, decision: "deny" },
    ]);
    const tree = assistantSteps(world);
    expect(tree.steps.map((step) => [step.name, step.status, step.output])).toEqual([
      ["bash", "failed", DENIED_OUTPUT],
    ]);
    expect(tree.assistant.status).toBe("done");
    expect(tree.session.status).toBe("done");
  });

  it(
    "R4 nothing settles at T+59999; T+60000 settles timeout and answers Approve",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);

      world.clock.advance(TTL_MS - 1);
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expectQuiet(world);

      world.clock.advance(1);
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: "timeout",
        decided_at: T + TTL_MS,
      });
      expect(await waitForResponses(spawnedAt(world, 0), 1)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      expect(resolvedFor(world)).toEqual([
        { messageId: row.message_id, approvalId: row.id, decision: "timeout" },
      ]);
      expect(assistantSteps(world).steps.map((step) => [step.name, step.status])).toEqual([
        ["bash", "done"],
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("settled approvals", () => {
  it(
    "R5 re-answering an allowed, denied or timed-out approval is approval_settled",
    REAL,
    async () => {
      const world = await open();
      const sessions = [world.session, await extraSession(world), await extraSession(world)];
      const rows: ApprovalRow[] = [];
      for (const session of sessions) {
        rows.push(await pendingApproval(world, session));
      }
      const [allowed, denied, timedOut] = rows as [ApprovalRow, ApprovalRow, ApprovalRow];
      await world.fixture.supervisor.decide(sessions[0] as string, allowed.id, "allow");
      await world.fixture.supervisor.decide(sessions[1] as string, denied.id, "deny");
      await waitForTurn(world.fixture, sessions[0] as string, "done");
      await waitForTurn(world.fixture, sessions[1] as string, "done");
      world.clock.advance(TTL_MS);
      await waitForTurn(world.fixture, sessions[2] as string, "done");

      const expected = [
        {
          session: sessions[0] as string,
          row: allowed,
          decision: "allow",
          at: T,
          value: "Approve",
        },
        { session: sessions[1] as string, row: denied, decision: "deny", at: T, value: "Deny" },
        {
          session: sessions[2] as string,
          row: timedOut,
          decision: "timeout",
          at: T + TTL_MS,
          value: "Approve",
        },
      ];
      for (const [index, entry] of expected.entries()) {
        for (const again of ["allow", "deny"] as const) {
          const failure = await rejection(
            world.fixture.supervisor.decide(entry.session, entry.row.id, again),
          );
          expect(failure).toMatchObject({ code: "approval_settled" });
        }
        expect(approvalRow(world.fixture.db, entry.row.id)).toMatchObject({
          decision: entry.decision,
          decided_at: entry.at,
        });
        expect(responses(spawnedAt(world, index))).toEqual([
          { type: "extension_ui_response", id: "r1", value: entry.value },
        ]);
        expect(resolvedFor(world, entry.session)).toEqual([
          { messageId: entry.row.message_id, approvalId: entry.row.id, decision: entry.decision },
        ]);
      }
      await settle();
      expect(approvalAuditCount(world.fixture.db)).toBe(3);
    },
  );

  it(
    "R5 concurrent answers: exactly one fulfils, the other is approval_settled",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);

      const results = await Promise.allSettled([
        world.fixture.supervisor.decide(world.session, row.id, "allow"),
        world.fixture.supervisor.decide(world.session, row.id, "deny"),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "approval_settled" });
      const winner = fulfilled[0]?.value.decision;
      expect(approvalRow(world.fixture.db, row.id).decision).toBe(winner);
      await waitForTurn(world.fixture, world.session, "done");
      expect(responses(spawnedAt(world, 0))).toHaveLength(1);
      expect(approvalAuditCount(world.fixture.db)).toBe(1);
      expect(resolvedFor(world)).toEqual([
        { messageId: row.message_id, approvalId: row.id, decision: winner },
      ]);
    },
  );

  it(
    "R6 a row settled by a non-answer path rejects the answer and its timer stays silent",
    REAL,
    async () => {
      const world = await open();
      const row = await pendingApproval(world);
      world.fixture.db
        .prepare("UPDATE chat_approvals SET decision = 'deny', decided_at = ? WHERE id = ?")
        .run(T + 500, row.id);

      const failure = await rejection(
        world.fixture.supervisor.decide(world.session, row.id, "allow"),
      );

      expect(failure).toMatchObject({ code: "approval_settled" });
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: "deny",
        decided_at: T + 500,
      });
      expectQuiet(world);
      world.clock.advance(TTL_MS);
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: "deny",
        decided_at: T + 500,
      });
      expectQuiet(world);
      expect(world.errors).toEqual([]);
    },
  );

  it("R7 an answered approval's timer never fires a second settlement", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);
    expect(world.timersDueAt(T + TTL_MS)).toBe(1);
    world.clock.nowMs = T + 10_000;
    await world.fixture.supervisor.decide(world.session, row.id, "deny");
    await waitForTurn(world.fixture, world.session, "done");
    expect(world.timersDueAt(T + TTL_MS)).toBe(0);

    world.clock.advance(T + 120_000 - world.clock.nowMs);
    await settle();

    expect(responses(spawnedAt(world, 0))).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Deny" },
    ]);
    expect(approvalAuditCount(world.fixture.db)).toBe(1);
    expect(resolvedFor(world)).toHaveLength(1);
    expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
      decision: "deny",
      decided_at: T + 10_000,
    });
    expect(world.errors).toEqual([]);
  });
});

describe("approval audit", () => {
  it("R8 writes one session.approval audit per decision, none while pending", REAL, async () => {
    const world = await open();
    const sessions = [world.session, await extraSession(world), await extraSession(world)];
    const before = auditCount(world.fixture.db);
    const rows: ApprovalRow[] = [];
    for (const session of sessions) {
      rows.push(await pendingApproval(world, session));
    }
    await settle();
    expect(auditCount(world.fixture.db)).toBe(before);

    await world.fixture.supervisor.decide(sessions[0] as string, rows[0]?.id as number, "allow");
    await world.fixture.supervisor.decide(sessions[1] as string, rows[1]?.id as number, "deny");
    world.clock.advance(TTL_MS);
    await waitForTurn(world.fixture, sessions[2] as string, "done");

    const response = await world.fixture.app.inject({
      method: "GET",
      url: "/api/audit?limit=3",
      headers: { cookie: world.cookie },
    });
    expect(response.statusCode).toBe(200);
    const events = (response.json() as { events: Array<Record<string, unknown>> }).events;
    const detail = (index: number, decision: string) => ({
      sessionId: sessions[index],
      messageId: rows[index]?.message_id,
      tool: "bash",
      decision,
    });
    expect(
      events.map(({ kind, actorId, title, detail: body }) => ({ kind, actorId, title, body })),
    ).toEqual([
      {
        kind: "session.approval",
        actorId: OWNER_ID,
        title: "工具执行审批",
        body: detail(2, "timeout"),
      },
      {
        kind: "session.approval",
        actorId: OWNER_ID,
        title: "工具执行审批",
        body: detail(1, "deny"),
      },
      {
        kind: "session.approval",
        actorId: OWNER_ID,
        title: "工具执行审批",
        body: detail(0, "allow"),
      },
    ]);
    const ids = events.map((event) => event.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it("R9 the production registerSessions assembly lands the audit row", REAL, async () => {
    const world = await open();
    const row = await pendingApproval(world);

    await world.fixture.supervisor.decide(world.session, row.id, "allow");

    const audits = world.fixture.db
      .prepare("SELECT kind FROM audit_events WHERE kind = 'session.approval'")
      .all();
    expect(audits).toEqual([{ kind: "session.approval" }]);
  });
});

describe("approval ownership", () => {
  it("R10 an approval of another session or an unknown id is not_found", REAL, async () => {
    const world = await open();
    const other = await extraSession(world);
    const row = await pendingApproval(world);

    const foreign = await rejection(world.fixture.supervisor.decide(other, row.id, "allow"));
    const unknown = await rejection(
      world.fixture.supervisor.decide(world.session, 999_999, "allow"),
    );

    expect(foreign).toMatchObject({ code: "not_found" });
    expect(unknown).toMatchObject({ code: "not_found" });
    await settle();
    expect(approvalRow(world.fixture.db, row.id)).toEqual(row);
    expectQuiet(world);
    expect(await waitForEvent(world, "approval.request")).toHaveLength(1);
  });
});

describe("approvals of an always-ask session (#1009)", () => {
  /** fake-omp-composer.mjs WRITE_CALL / WRITE_SELECT_ID, as omp v18.0.10 titles a `write` call. */
  const WRITE_TITLE = "Allow tool: write\nPath: workbuddy-report.html";

  /** An `approval-write` world; `always-ask` is chosen over REST before the first prompt. */
  async function openWrite(mode?: "always-ask"): Promise<ApprovalWorld> {
    const world = await openApprovalWorld("approval-write");
    worlds.push(world);
    if (mode !== undefined) {
      expect((await patch(world, { approvalMode: mode })).statusCode).toBe(200);
    }
    return world;
  }

  /** The `detail` of every `session.approval` audit, oldest first. */
  function approvalAudits(world: ApprovalWorld): unknown[] {
    return world.fixture.db
      .prepare("SELECT detail FROM audit_events WHERE kind = 'session.approval' ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.detail)) as unknown);
  }

  it(
    "W1 a `write` call registers, is published and answered Approve once; `write` mode asks nothing",
    REAL,
    async () => {
      const world = await openWrite("always-ask");
      const row = await pendingApproval(world);
      await settle();

      expect(flagValue(requiredCall(world.rt.calls, 0).args, "--approval-mode")).toBe("always-ask");
      const assistantId = assistantIdFor(world.fixture, world.session);
      expect(await waitForRows(world, 1)).toEqual([
        {
          id: row.id,
          message_id: assistantId,
          request_id: "w1",
          tool: "write",
          title: WRITE_TITLE,
          requested_at: T,
          expires_at: T + TTL_MS,
          decision: null,
          decided_at: null,
        },
      ]);
      expect(ofType(sessionEvents(world), "approval.request").map((event) => event.data)).toEqual([
        {
          messageId: assistantId,
          approvalId: row.id,
          tool: "write",
          title: WRITE_TITLE,
          expiresAt: T + TTL_MS,
        },
      ]);
      // The PATCH wrote a `session.permission`: only the approval audits are counted.
      expectQuiet(world);

      const settled = await world.fixture.supervisor.decide(world.session, row.id, "allow");

      expect(settled).toMatchObject({ id: row.id, tool: "write", decision: "allow" });
      await waitForTurn(world.fixture, world.session, "done");
      await settle();
      expect(responses(spawnedAt(world, 0))).toEqual([
        { type: "extension_ui_response", id: "w1", value: "Approve" },
      ]);
      expect(resolvedFor(world)).toEqual([
        { messageId: assistantId, approvalId: row.id, decision: "allow" },
      ]);
      expect(approvalAudits(world)).toEqual([
        { sessionId: world.session, messageId: assistantId, tool: "write", decision: "allow" },
      ]);
      expect(world.errors).toEqual([]);

      // The control: the same scenario on a session left at `write` asks for nothing.
      const control = await openWrite();
      await prompted(control);
      await waitForTurn(control.fixture, control.session, "done");
      await settle();
      expect(flagValue(requiredCall(control.rt.calls, 0).args, "--approval-mode")).toBe("write");
      expect(approvalRows(control.fixture.db, control.session)).toEqual([]);
      expect(ofType(sessionEvents(control), "approval.request")).toEqual([]);
      expectQuiet(control);
    },
  );

  it(
    "W2 每次都问下的超时: pending at T+59999; T+60000 settles timeout and answers Approve",
    REAL,
    async () => {
      const world = await openWrite("always-ask");
      const row = await pendingApproval(world);
      expect(row).toMatchObject({ tool: "write", request_id: "w1", expires_at: T + TTL_MS });

      world.clock.advance(TTL_MS - 1);
      await settle();
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: null,
        decided_at: null,
      });
      expectQuiet(world);

      world.clock.advance(1);
      expect(approvalRow(world.fixture.db, row.id)).toMatchObject({
        decision: "timeout",
        decided_at: T + TTL_MS,
      });
      expect(await waitForResponses(spawnedAt(world, 0), 1)).toEqual([
        { type: "extension_ui_response", id: "w1", value: "Approve" },
      ]);
      await waitForTurn(world.fixture, world.session, "done");
      expect(resolvedFor(world)).toEqual([
        { messageId: row.message_id, approvalId: row.id, decision: "timeout" },
      ]);
      expect(approvalAudits(world)).toEqual([
        {
          sessionId: world.session,
          messageId: row.message_id,
          tool: "write",
          decision: "timeout",
        },
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});
