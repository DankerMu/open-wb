/**
 * Issue 1474 (chat-interleaved-segments 5.2b, design D8) through the production assembly
 * (createApp → registerSessions → SessionSupervisor, in-memory SQLite): the three published payloads
 * that gain fields — `step.start{…, bodyOffset, approvalId}`, `approval.request{…, stepId}` and
 * `thinking.end{…, segment}` — and their agreement with the snapshot read over the history route.
 * Real fake-omp children (`approval`, `approval-parallel`, `edit-write`) where their frame order
 * is the case; the other arrival orders use the scripted children of session-approval-script.ts.
 * Expected values: tool-approval「审批事件」「确认与步骤配对」, chat-stream「分段位置的记录与下发」
 * literals, fake-omp's DELTAS (`Hello from fake-omp`, 19 UTF-16 code units, copied, not imported)
 * and rows read with the test's own SQL.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import {
  type ApprovalWorld,
  ofType,
  openApprovalWorld,
  pendingApproval,
  prompted,
  REAL,
  sessionEvents,
  T,
  TITLE,
  TITLE_2,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import {
  chunk,
  closeScripted,
  decide,
  end,
  finishing,
  openScripted,
  pairingRows,
  select,
  start,
  stepIds,
  TEXT,
} from "./session-approval-script.js";
import { getSessionMessages } from "./session-rest-helpers.js";
import {
  assistantIdFor,
  createRealFakeRuntime,
  openRecordingSession,
  type RecordingWorld,
  waitForTurn,
} from "./session-supervisor-helpers.js";

/** fake-omp DELTAS joined: the text every fake turn publishes before its tool round. */
const FAKE_TEXT = "Hello from fake-omp";
const STEP_START_KEYS = ["approvalId", "bodyOffset", "detail", "messageId", "name", "stepId"];

const worlds: RecordingWorld[] = [];

afterEach(closeScripted);
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function open(scenario: "approval" | "approval-parallel"): Promise<ApprovalWorld> {
  const world = await openApprovalWorld(scenario);
  worlds.push(world);
  return world;
}

interface WireStep {
  id: number;
  bodyOffset: number | null;
}

interface WireMessage {
  id: number;
  steps: WireStep[];
  approvals: Array<{ id: number; stepId: number | null }>;
  thinkingSegments: unknown[];
}

async function snapshotMessage(world: RecordingWorld): Promise<WireMessage> {
  const response = await getSessionMessages(world.fixture.app, world.session, world.cookie);
  expect(response.statusCode).toBe(200);
  const messageId = assistantIdFor(world.fixture, world.session);
  const found = (response.json() as { messages: WireMessage[] }).messages.find(
    (message) => message.id === messageId,
  );
  if (found === undefined) {
    throw new Error("missing assistant message in the snapshot");
  }
  return found;
}

function starts(world: RecordingWorld) {
  return ofType(sessionEvents(world), "step.start").map((event) => event.data);
}

function requests(world: RecordingWorld) {
  return ofType(sessionEvents(world), "approval.request").map((event) => event.data);
}

/** Concatenated text.delta of the ring before each step.start, in ring order. */
function textBeforeEachStart(world: RecordingWorld): string[] {
  let body = "";
  const before: string[] = [];
  for (const { event } of sessionEvents(world)) {
    if (event.type === "text.delta") body += event.data.delta;
    if (event.type === "step.start") before.push(body);
  }
  return before;
}

describe("tool-approval「审批事件」: the request and the step carry the pairing", () => {
  it(
    "事件序与回放 (approval): step.start{bodyOffset 19, approvalId null} before request{…, stepId}",
    REAL,
    async () => {
      const world = await open("approval");
      const row = await pendingApproval(world);
      const messageId = assistantIdFor(world.fixture, world.session);

      const [step] = starts(world);
      expect(Object.keys(step ?? {}).sort()).toEqual(STEP_START_KEYS);
      expect(step).toMatchObject({ messageId, name: "bash", bodyOffset: 19, approvalId: null });
      expect(typeof step?.stepId).toBe("number");
      expect(requests(world)).toStrictEqual([
        {
          messageId,
          approvalId: row.id,
          tool: "bash",
          title: TITLE,
          expiresAt: T + TTL_MS,
          stepId: step?.stepId,
        },
      ]);
      const types = sessionEvents(world).map((entry) => entry.event.type);
      expect(types.indexOf("step.start")).toBeLessThan(types.indexOf("approval.request"));
      const snapshot = await snapshotMessage(world);
      expect(snapshot.steps.map((entry) => entry.bodyOffset)).toEqual([step?.bodyOffset]);
      expect(snapshot.approvals.map((entry) => entry.stepId)).toEqual([step?.stepId]);
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "两条并行审批分别作答: both step.start approvalId null; requests pair r1 then r2; offsets = text before",
    REAL,
    async () => {
      const world = await open("approval-parallel");
      await prompted(world);
      const [r1, r2] = await waitForRows(world, 2);
      // Answer only after the pump read both selects, or the answer path publishes stepId null.
      await waitForEvent(world, "approval.request", 2);
      await decide(world, "r2", "deny");
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");
      const messageId = assistantIdFor(world.fixture, world.session);

      const [first, second] = stepIds(world.fixture.db, messageId);
      const request = (approvalId: number | undefined, title: string, stepId?: number) => ({
        messageId,
        approvalId,
        tool: "bash",
        title,
        expiresAt: T + TTL_MS,
        stepId,
      });
      expect(requests(world)).toStrictEqual([
        request(r1?.id, TITLE, first),
        request(r2?.id, TITLE_2, second),
      ]);
      expect(
        starts(world).map(({ stepId, bodyOffset, approvalId }) => [stepId, bodyOffset, approvalId]),
      ).toEqual([
        [first, FAKE_TEXT.length, null],
        [second, FAKE_TEXT.length, null],
      ]);
      // 步骤的正文偏移: each offset is the length of the text the ring published before it.
      expect(textBeforeEachStart(world).map((text) => text.length)).toEqual(
        starts(world).map((step) => step.bodyOffset),
      );
      const snapshot = await snapshotMessage(world);
      expect(snapshot.steps.map((step) => [step.id, step.bodyOffset])).toEqual(
        starts(world).map((step) => [step.stepId, step.bodyOffset]),
      );
      expect(snapshot.approvals.map((entry) => [entry.id, entry.stepId])).toEqual([
        [r1?.id, first],
        [r2?.id, second],
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("tool-approval「确认与步骤配对」: the event that delivers the pairing", () => {
  it(
    "步骤先于审批 select 到达: step.start approvalId null, then approval.request stepId = that step",
    REAL,
    async () => {
      const { world } = await openScripted({
        prompt: (child) => child.emitRaw(chunk(start("c1"), select("r1"))),
        answer: finishing(end("c1")),
      });
      await prompted(world);
      await waitForEvent(world, "approval.request");
      const messageId = assistantIdFor(world.fixture, world.session);
      const [step] = stepIds(world.fixture.db, messageId);

      expect(starts(world).map((data) => data.approvalId)).toEqual([null]);
      expect(requests(world).map((data) => data.stepId)).toEqual([step]);
      await decide(world, "r1", "allow");
      await waitForTurn(world.fixture, world.session, "done");
      expect((await snapshotMessage(world)).approvals.map((entry) => entry.stepId)).toEqual([step]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "作答先于 pump 读到 select: the answer path's request has stepId null; the next bash start pairs it",
    REAL,
    async () => {
      let decided: Promise<unknown> | undefined;
      const { world } = await openScripted({
        // One chunk: the runtime inserts r1's row before the pump reads c1's start.
        prompt: (child) => child.emitRaw(chunk(start("c1"), TEXT, select("r1"))),
        answer: finishing(end("c1"), start("c2"), end("c2")),
        onEvent(opened, event: ChatEvent<number>) {
          if (event.type === "text.delta" && decided === undefined) {
            decided = decide(opened, "r1", "allow");
            decided.catch(() => undefined);
          }
        },
      });
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");
      await expect(decided).resolves.toMatchObject({ decision: "allow", stepId: null });

      const messageId = assistantIdFor(world.fixture, world.session);
      const [, second] = stepIds(world.fixture.db, messageId);
      const [row] = pairingRows(world.fixture.db, messageId);
      const approvalId = rowId(world.fixture.db, messageId);
      expect(requests(world).map((data) => [data.approvalId, data.stepId])).toEqual([
        [approvalId, null],
      ]);
      expect(starts(world).map((data) => data.approvalId)).toEqual([null, approvalId]);
      // The live association (step.start's approvalId) and the snapshot's stepId agree.
      expect(row?.step_id).toBe(second);
      expect((await snapshotMessage(world)).approvals).toMatchObject([
        { id: approvalId, stepId: second },
      ]);
      expect(world.errors).toEqual([]);
    },
  );
});

function rowId(db: DatabaseSync, messageId: number): number {
  const row = db.prepare("SELECT id FROM chat_approvals WHERE message_id = ?").get(messageId);
  return Number((row as { id: number }).id);
}

describe("chat-stream「Ordered publication after persistence」: thinking.end carries the row", () => {
  it(
    "edit-write: thinking.end.segment equals the segment row at publication and the snapshot's",
    REAL,
    async () => {
      const atEnd: unknown[] = [];
      let db: DatabaseSync | undefined;
      const world = await openRecordingSession(createRealFakeRuntime("edit-write").runtime, {
        prepare(opened) {
          db = opened;
        },
        onEvent(_session, _epoch, event) {
          if (event.type === "thinking.end" && db !== undefined) {
            atEnd.push(
              db
                .prepare(
                  `SELECT body_offset AS bodyOffset, thinking_offset AS thinkingOffset,
                     thinking_length AS thinkingLength, steps_before AS stepsBefore,
                     thinking_ms AS thinkingMs
                   FROM chat_thinking_segments WHERE message_id = ? ORDER BY id DESC LIMIT 1`,
                )
                .get(event.data.messageId),
            );
          }
        },
      });
      worlds.push(world);
      await prompted(world);
      await waitForTurn(world.fixture, world.session, "done");

      const ends = ofType(sessionEvents(world), "thinking.end").map((event) => event.data);
      expect(ends).toHaveLength(1);
      expect(Object.keys(ends[0] ?? {}).sort()).toEqual(["messageId", "segment", "thinkingMs"]);
      expect(ends.map((data) => ({ ...data.segment }))).toEqual(
        atEnd.map((row) => ({ ...(row as object) })),
      );
      expect(ends[0]?.segment.thinkingMs).toBe(ends[0]?.thinkingMs);
      expect((await snapshotMessage(world)).thinkingSegments).toStrictEqual(
        ends.map((data) => data.segment),
      );
      expect(world.errors).toEqual([]);
    },
  );
});
