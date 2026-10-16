/**
 * Issue 1474 (chat-interleaved-segments 5.2a, design D8): the snapshot and REST shapes that gain a
 * key — message `thinkingSegments` (13 keys), step `bodyOffset` (8), approval `stepId` (7) and the
 * seven-key `decideApproval` 200 — read over the history route (chat-sessions「会话 REST」,
 * tool-approval「审批作答 REST」「审批快照」). The real layer is the production assembly over fake-omp
 * `approval` / `approval-parallel`; fork and regenerate run on the real store (`withSessionRest`)
 * with rows seeded by the test's own SQL, then read over the same route. Expected values are the
 * scenarios' literals, the seeded values and fake-omp's DELTAS (`Hello from fake-omp`, 19 UTF-16
 * code units, copied, not imported).
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStore } from "../src/sessions/store.js";
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
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import { cookieFor, getSessionMessages, withSessionRest } from "./session-rest-helpers.js";
import { assistantIdFor, waitForTurn } from "./session-supervisor-helpers.js";

const FAKE_TEXT = "Hello from fake-omp";
const MESSAGE_KEYS = [
  "approvals",
  "attachments",
  "content",
  "createdAt",
  "error",
  "id",
  "role",
  "status",
  "steps",
  "thinking",
  "thinkingMs",
  "thinkingSegments",
  "undo",
];
const STEP_KEYS = ["bodyOffset", "changes", "detail", "id", "name", "ordinal", "output", "status"];
const APPROVAL_KEYS = ["decision", "expiresAt", "id", "requestedAt", "stepId", "title", "tool"];

interface Segment {
  bodyOffset: number;
  thinkingOffset: number;
  thinkingLength: number | null;
  stepsBefore: number;
  thinkingMs: number | null;
}

interface WireMessage {
  id: number;
  role: string;
  steps: Array<{ id: number; ordinal: number; bodyOffset: number | null }>;
  approvals: Array<{ id: number; stepId: number | null }>;
  thinkingSegments: Segment[];
}

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

async function messages(app: FastifyInstance, session: string, cookie: string) {
  const response = await getSessionMessages(app, session, cookie);
  expect(response.statusCode).toBe(200);
  return (response.json() as { messages: WireMessage[] }).messages;
}

function byId(list: WireMessage[], id: number): WireMessage {
  const found = list.find((message) => message.id === id);
  if (found === undefined) {
    throw new Error(`missing message ${String(id)}`);
  }
  return found;
}

describe("chat-sessions「会话 REST」: 13 message, 8 step and 7 approval keys", () => {
  it(
    "approval: the running snapshot carries stepId of the started bash step; allow answers 7 keys",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval");
      worlds.push(world);
      const row = await pendingApproval(world);
      await waitForEvent(world, "step.start");
      const messageId = assistantIdFor(world.fixture, world.session);
      const [start] = ofType(sessionEvents(world), "step.start");
      const stepId = start?.data.stepId;

      const running = await messages(world.fixture.app, world.session, world.cookie);
      for (const message of running) {
        expect(Object.keys(message).sort()).toEqual(MESSAGE_KEYS);
        expect(message.thinkingSegments).toStrictEqual([]);
      }
      const assistant = byId(running, messageId);
      expect(assistant.steps.map((step) => Object.keys(step).sort())).toEqual([STEP_KEYS]);
      expect(assistant.steps.map((step) => [step.id, step.bodyOffset])).toEqual([
        [stepId, FAKE_TEXT.length],
      ]);
      const pending = {
        id: row.id,
        tool: "bash",
        title: TITLE,
        requestedAt: T,
        expiresAt: T + TTL_MS,
        decision: null,
        stepId,
      };
      expect(assistant.approvals).toStrictEqual([pending]);
      expect(Object.keys(pending).sort()).toEqual(APPROVAL_KEYS);

      const answer = await world.fixture.app.inject({
        method: "POST",
        url: `/api/sessions/${world.session}/approvals/${String(row.id)}`,
        headers: { "content-type": "application/json", cookie: world.cookie },
        payload: JSON.stringify({ decision: "allow" }),
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toStrictEqual({ ...pending, decision: "allow" });
      await waitForTurn(world.fixture, world.session, "done");
      const done = byId(await messages(world.fixture.app, world.session, world.cookie), messageId);
      expect(done.approvals).toStrictEqual([{ ...pending, decision: "allow" }]);
      expect(world.errors).toEqual([]);
    },
  );
});

/** A message stored before migration 045: a step without body_offset, an unpaired approval. */
function seedOldPair(db: DatabaseSync, session: string): number {
  const insert = db.prepare(
    "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, ?, ?, 'done', 1)",
  );
  insert.run(session, "user", "old question");
  const assistant = Number(insert.run(session, "assistant", "old answer").lastInsertRowid);
  db.prepare(
    "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at) VALUES (?, 0, 'bash', '{}', 'done', 1, 2)",
  ).run(assistant);
  db.prepare(
    "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at) VALUES (?, 'r0', 'bash', 'Allow tool: bash', 1, 60001, 'allow', 2)",
  ).run(assistant);
  return assistant;
}

describe("chat-sessions「Snapshot carries segment positions」", () => {
  it(
    "approval-parallel: offsets of the text before each step, stepIds as step.start paired; old rows null",
    REAL,
    async () => {
      const world = await openApprovalWorld("approval-parallel");
      worlds.push(world);
      await prompted(world);
      const [r1, r2] = await waitForRows(world, 2);
      await waitForEvent(world, "step.start", 2);
      for (const [row, decision] of [
        [r2, "deny"],
        [r1, "allow"],
      ] as const) {
        await world.fixture.supervisor.decide(world.session, Number(row?.id), decision);
      }
      await waitForTurn(world.fixture, world.session, "done");
      const old = seedOldPair(world.fixture.db, world.session);
      const messageId = assistantIdFor(world.fixture, world.session);

      const list = await messages(world.fixture.app, world.session, world.cookie);
      const assistant = byId(list, messageId);
      expect(assistant.thinkingSegments).toStrictEqual([]);
      expect(assistant.steps.map((step) => step.bodyOffset)).toEqual([
        FAKE_TEXT.length,
        FAKE_TEXT.length,
      ]);
      const paired = ofType(sessionEvents(world), "step.start").map((event) => [
        event.data.approvalId,
        event.data.stepId,
      ]);
      expect(assistant.approvals.map((approval) => [approval.id, approval.stepId])).toEqual(paired);
      expect(paired.map(([approvalId]) => approvalId)).toEqual([r1?.id, r2?.id]);

      const stored = byId(list, old);
      expect(stored.steps.map((step) => step.bodyOffset)).toEqual([null]);
      expect(stored.approvals.map((approval) => approval.stepId)).toEqual([null]);
      expect(stored.thinkingSegments).toStrictEqual([]);
      expect(world.errors).toEqual([]);
    },
  );
});

const SEGMENTS: Segment[] = [
  { bodyOffset: 3, thinkingOffset: 0, thinkingLength: 2, stepsBefore: 0, thinkingMs: 400 },
  { bodyOffset: 9, thinkingOffset: 2, thinkingLength: null, stepsBefore: 1, thinkingMs: null },
];

/** One finished turn with two steps (offsets 3 and 9), two segment rows and a deny on ordinal 1. */
function seedTurn(db: DatabaseSync, store: SessionStore, session: string, text: string) {
  const turn = store.acceptPrompt(session, "u1", text);
  const steps = [0, 1].map(
    (ordinal) =>
      store.startStep(turn.assistantMessageId, { ordinal, name: "bash", detail: "{}" }).stepId,
  );
  steps.forEach((id, index) => {
    db.prepare("UPDATE chat_steps SET body_offset = ? WHERE id = ?").run(index === 0 ? 3 : 9, id);
  });
  for (const segment of SEGMENTS) {
    db.prepare(
      "INSERT INTO chat_thinking_segments(message_id, body_offset, thinking_offset, steps_before, thinking_length, thinking_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      turn.assistantMessageId,
      segment.bodyOffset,
      segment.thinkingOffset,
      segment.stepsBefore,
      segment.thinkingLength,
      segment.thinkingMs,
    );
  }
  db.prepare(
    "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at, step_id) VALUES (?, 'r1', 'bash', 'Allow tool: bash', 10, 60010, 'deny', 20, ?)",
  ).run(turn.assistantMessageId, Number(steps[1]));
  expect(store.finishTurn(turn.assistantMessageId, "done")).toBe(true);
  return { ...turn, steps };
}

describe("chat-sessions「Fork copies history…」: the new keys of the copies", () => {
  it("segments and offsets verbatim, the approval's stepId the copied ordinal-1 step", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const source = store.create("u1").id;
      const a1 = seedTurn(db, store, source, "a1");
      const tail = store.acceptPrompt(source, "u1", "fork here");
      expect(store.finishTurn(tail.assistantMessageId, "done")).toBe(true);
      const forked = "f".repeat(32);
      store.commitFork({
        sourceId: source,
        sessionId: forked,
        ownerId: "u1",
        messageId: tail.userMessageId,
        expectedAssistantId: tail.assistantMessageId,
        sessionFile: "/fork.jsonl",
      });
      const cookie = await cookieFor(app, "zhangsan");

      const original = byId(await messages(app, source, cookie), a1.assistantMessageId);
      const copy = (await messages(app, forked, cookie)).find((m) => m.role === "assistant");
      expect(copy?.thinkingSegments).toStrictEqual(SEGMENTS);
      expect(copy?.thinkingSegments).toStrictEqual(original.thinkingSegments);
      expect(copy?.steps.map((step) => step.bodyOffset)).toEqual([3, 9]);
      const copiedOrdinal1 = copy?.steps.find((step) => step.ordinal === 1)?.id;
      expect(copy?.approvals.map((approval) => approval.stepId)).toEqual([copiedOrdinal1]);
      expect(a1.steps).not.toContain(copiedOrdinal1);
      expect(original.approvals.map((approval) => approval.stepId)).toEqual([a1.steps[1]]);
    });
  });

  it("a copied message from before migration 045 reads null offsets, null stepId and []", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const source = store.create("u1").id;
      seedOldPair(db, source);
      const tail = store.acceptPrompt(source, "u1", "fork here");
      expect(store.finishTurn(tail.assistantMessageId, "done")).toBe(true);
      const forked = "e".repeat(32);
      store.commitFork({
        sourceId: source,
        sessionId: forked,
        ownerId: "u1",
        messageId: tail.userMessageId,
        expectedAssistantId: tail.assistantMessageId,
        sessionFile: "/fork.jsonl",
      });

      const copied = await messages(app, forked, await cookieFor(app, "zhangsan"));
      const copy = copied.find((m) => m.role === "assistant");
      expect(copy?.steps.map((step) => step.bodyOffset)).toEqual([null]);
      expect(copy?.approvals.map((approval) => approval.stepId)).toEqual([null]);
      expect(copied.map((message) => message.thinkingSegments)).toStrictEqual([[], []]);
    });
  });
});

describe("chat-sessions「Regenerate replaces only the last assistant message」: the new keys", () => {
  it("the new row has no segments; the earlier pair keeps segments, offsets and stepIds", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1").id;
      const earlier = seedTurn(db, store, session, "first");
      const last = seedTurn(db, store, session, "second");
      const cookie = await cookieFor(app, "zhangsan");
      const before = byId(await messages(app, session, cookie), earlier.assistantMessageId);

      const replaced = store.acceptRegenerate(session, last.assistantMessageId, "/regen.jsonl");

      const after = await messages(app, session, cookie);
      expect(after.map((message) => message.id)).not.toContain(last.assistantMessageId);
      expect(byId(after, replaced).thinkingSegments).toStrictEqual([]);
      expect(byId(after, earlier.assistantMessageId)).toStrictEqual(before);
      expect(before.thinkingSegments).toStrictEqual(SEGMENTS);
      const orphans = db
        .prepare("SELECT COUNT(*) AS count FROM chat_thinking_segments WHERE message_id = ?")
        .get(last.assistantMessageId) as { count: number };
      expect(orphans.count).toBe(0);
    });
  });
});
