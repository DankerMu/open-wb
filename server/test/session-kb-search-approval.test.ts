/**
 * Change s2c-kb-session 3.6 (#1965): session-permission-tier「kb_search 的确认只在 always-ask 档出卡」
 * through the production assembly (createApp → registerSessions → SessionSupervisor, in-memory
 * SQLite; precedent session-prelude-card.test.ts) over real fake-omp `host-tool` children spawned with
 * the session's `--approval-mode`. The session is moved off the default `write` over
 * `PATCH /api/sessions/:id` before its first prompt (the cap is the assembly's default `yolo`).
 * Before group 4 the slot injects no host tool handler, so both `kb_search` calls are answered
 * `未知工具`: "the calls complete" here means both steps end failed and the turn ends done.
 * Oracles: `chat_approvals` rows, the recorded `approval.request` events, the `session.approval`
 * audits, the step rows and the spawn argv; never supervisor internals.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalMode } from "../src/model-catalog.js";
import {
  approvalAuditCount,
  approvalRows,
  flagValue,
  ofType,
  prompted,
  REAL,
  sessionEvents,
  settle,
  T,
  waitForEvent,
} from "./session-approval-helpers.js";
import { decide, pairingRows, stepRows } from "./session-approval-script.js";
import { patch } from "./session-archive-helpers.js";
import {
  assistantIdFor,
  createRealFakeRuntime,
  openRecordingSession,
  type RealFakeRuntime,
  type RecordingWorld,
  requiredCall,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const KB_TITLE = "Allow tool: kb_search";
const worlds: RecordingWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(mode: ApprovalMode): Promise<{ world: RecordingWorld; rt: RealFakeRuntime }> {
  const rt = createRealFakeRuntime("host-tool");
  rt.clock.nowMs = T;
  const world = await openRecordingSession(rt.runtime);
  worlds.push(world);
  if (mode !== "write") {
    expect((await patch(world, { approvalMode: mode })).statusCode).toBe(200);
  }
  return { world, rt };
}

function kbSteps(world: RecordingWorld): Array<[string, string]> {
  const messageId = assistantIdFor(world.fixture, world.session);
  return stepRows(world.fixture.db, messageId).map((row) => [row.name, row.status]);
}

describe("session-permission-tier「kb_search 的确认只在 always-ask 档出卡」", () => {
  it.each<ApprovalMode>(["write", "yolo"])(
    "%s: no approval.request, no chat_approvals row, no session.approval audit; both calls end",
    REAL,
    async (mode) => {
      const { world, rt } = await open(mode);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      await settle();

      expect(flagValue(requiredCall(rt.calls, 0).args, "--approval-mode")).toBe(mode);
      expect(kbSteps(world)).toEqual([
        ["kb_search", "failed"],
        ["kb_search", "failed"],
      ]);
      expect(approvalRows(world.fixture.db)).toEqual([]);
      expect(ofType(sessionEvents(world), "approval.request")).toEqual([]);
      expect(approvalAuditCount(world.fixture.db)).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "always-ask: each call has its own approval.request, the next only after the owner allows",
    REAL,
    async () => {
      const { world, rt } = await open("always-ask");
      await prompted(world);
      const [first] = await waitForEvent(world, "approval.request");
      await settle();

      expect(flagValue(requiredCall(rt.calls, 0).args, "--approval-mode")).toBe("always-ask");
      expect(first?.data).toMatchObject({ tool: "kb_search", title: KB_TITLE });
      expect(ofType(sessionEvents(world), "approval.request")).toHaveLength(1);
      expect(kbSteps(world)).toEqual([["kb_search", "running"]]);

      await decide(world, "r1", "allow");
      const requests = await waitForEvent(world, "approval.request", 2);
      await decide(world, "r2", "allow");
      await waitForTurn(world.fixture, world.session, "done");

      const messageId = assistantIdFor(world.fixture, world.session);
      const steps = stepRows(world.fixture.db, messageId);
      expect(steps.map((row) => [row.name, row.status])).toEqual([
        ["kb_search", "failed"],
        ["kb_search", "failed"],
      ]);
      expect(
        requests.map((event) => [event.data.tool, event.data.title, event.data.stepId]),
      ).toEqual([
        ["kb_search", KB_TITLE, steps[0]?.id],
        ["kb_search", KB_TITLE, steps[1]?.id],
      ]);
      expect(pairingRows(world.fixture.db, messageId)).toEqual([
        { request_id: "r1", decision: "allow", decided_at: T, step_id: steps[0]?.id },
        { request_id: "r2", decision: "allow", decided_at: T, step_id: steps[1]?.id },
      ]);
      expect(approvalAuditCount(world.fixture.db)).toBe(2);
      expect(world.errors).toEqual([]);
    },
  );
});
