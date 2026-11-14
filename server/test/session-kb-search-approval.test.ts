/**
 * Change s2c-kb-session 3.6 (#1965): session-permission-tier「kb_search 的确认只在 always-ask 档出卡」
 * through the production assembly (createApp → registerSessions → SessionSupervisor, in-memory
 * SQLite; precedent session-prelude-card.test.ts) over real fake-omp `host-tool` children spawned with
 * the session's `--approval-mode`. The session is moved off the default `write` over
 * `PATCH /api/sessions/:id` before its first prompt (the cap is the assembly's default `yolo`).
 *
 * Change kb-search-approval-scope (#2011): the three-tier cases run with the knowledge base on and an
 * owner who has a base (a stub session search handed in through the assembly seam), so the host
 * registers `kb_search` before the prompt and its handler answers both calls: the steps end `done`.
 * session-permission-tier「未注册 kb_search 时 write 档照常出卡」 and tasks 1.4: with the knowledge base
 * off, or an owner without a base, nothing is registered and the `write` card goes to the owner.
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
import { stubSearch } from "./session-regenerate-helpers.js";
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

type Search = ReturnType<typeof stubSearch>["source"];

/** The owner has one base unless the case passes `null` (knowledge base off) or its own search. */
async function open(
  mode: ApprovalMode,
  search: Search | null = stubSearch([{ id: "k1", name: "产品文档" }]).source,
): Promise<{ world: RecordingWorld; rt: RealFakeRuntime }> {
  const rt = createRealFakeRuntime("host-tool");
  rt.clock.nowMs = T;
  const world = await openRecordingSession(
    rt.runtime,
    search === null ? {} : { assembly: { sessionSearch: search } },
  );
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
        ["kb_search", "done"],
        ["kb_search", "done"],
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
        ["kb_search", "done"],
        ["kb_search", "done"],
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

describe("session-permission-tier「未注册 kb_search 时 write 档照常出卡」 (#2011)", () => {
  it.each<[string, () => Search | null]>([
    ["knowledge base off", () => null],
    ["owner without a base", () => stubSearch([]).source],
  ])(
    "write, %s: each kb_search card is an approval.request with a chat_approvals row, answered by the owner",
    REAL,
    async (_label, search) => {
      const { world, rt } = await open("write", search());
      await prompted(world);
      const [first] = await waitForEvent(world, "approval.request");
      await settle();

      expect(flagValue(requiredCall(rt.calls, 0).args, "--approval-mode")).toBe("write");
      expect(first?.data).toMatchObject({ tool: "kb_search", title: KB_TITLE });
      expect(approvalRows(world.fixture.db).map((row) => [row.request_id, row.tool])).toEqual([
        ["r1", "kb_search"],
      ]);
      expect(kbSteps(world)).toEqual([["kb_search", "running"]]);

      await decide(world, "r1", "deny");
      await waitForEvent(world, "approval.request", 2);
      await decide(world, "r2", "deny");
      await waitForTurn(world.fixture, world.session, "done");

      expect(
        approvalRows(world.fixture.db).map((row) => [row.request_id, row.tool, row.decision]),
      ).toEqual([
        ["r1", "kb_search", "deny"],
        ["r2", "kb_search", "deny"],
      ]);
      expect(kbSteps(world)).toEqual([
        ["kb_search", "failed"],
        ["kb_search", "failed"],
      ]);
      expect(approvalAuditCount(world.fixture.db)).toBe(2);
      expect(world.errors).toEqual([]);
    },
  );
});
