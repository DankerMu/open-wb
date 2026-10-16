/**
 * Issue 1471 (chat-interleaved-segments 3a, design D2/D7) at the store seam: a real `SessionStore`
 * over in-memory SQLite. `chat_steps.body_offset` is the turn's published body length (UTF-16 code
 * units) when the step starts — pending deltas included, reset for every new turn, written by the
 * step insert itself — and fork copies it value for value. Expected offsets are literals from the
 * chat-stream「分段位置的记录与下发」and turn-control「拷贝分段位置」scenarios or plain arithmetic
 * on the deltas the test appends; rows are read with the test's own SQL. Issue 1472 (3b, design D7)
 * adds the `chat_thinking_segments` rows: fork copies them value for value in row order, and
 * regenerate's delete of the old assistant cascades them (no code, the 045 foreign key).
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { SessionStore } from "../src/sessions/store.js";
import {
  captureThrown,
  FIXED_NOW,
  messageRow,
  withFakeClock,
  withSessionStore,
} from "./session-store-helpers.js";

const OWNER = "u1";
const FORK_ID = "f".repeat(32);

function offsetOf(db: DatabaseSync, stepId: number): unknown {
  const row = db.prepare("SELECT body_offset FROM chat_steps WHERE id = ?").get(stepId) as
    | { body_offset: unknown }
    | undefined;
  if (row === undefined) {
    throw new Error(`missing step ${String(stepId)}`);
  }
  return row.body_offset;
}

function stepsOf(db: DatabaseSync, messageId: number) {
  return db
    .prepare(
      "SELECT id, ordinal, body_offset FROM chat_steps WHERE message_id = ? ORDER BY ordinal, id",
    )
    .all(messageId) as Array<{ id: number; ordinal: number; body_offset: number | null }>;
}

function step(store: SessionStore, messageId: number, ordinal: number): number {
  return store.startStep(messageId, { ordinal, name: "bash", detail: "{}" });
}

/** The snapshot's body for the message: stored content plus the running turn's pending deltas. */
function snapshotContent(store: SessionStore, session: string, messageId: number): string {
  const message = store
    .getMessages(session, OWNER)
    ?.messages.find((candidate) => candidate.id === messageId);
  if (message === undefined) {
    throw new Error(`missing message ${String(messageId)}`);
  }
  return message.content;
}

describe("chat-stream「分段位置的记录与下发」: a step's body offset at the store", () => {
  it("码元而非码点: a step started after `a😀` records body_offset 3", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create(OWNER).id;
        const { assistantMessageId: reply } = store.acceptPrompt(session, OWNER, "emoji");
        expect(store.appendDelta(reply, "a😀")).toBe(true);
        expect(offsetOf(db, step(store, reply, 0))).toBe(3);
        expect(store.finishTurn(reply, "done")).toBe(true);
      });
    });
  });

  it("pending deltas count: after a 2048-byte flush the offset is the published length, not the stored one", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create(OWNER).id;
        const { assistantMessageId: reply } = store.acceptPrompt(session, OWNER, "bytes");
        // 2044 + 3 + 1 = 2048 UTF-8 bytes flush the buffer; they are 2044 + 1 + 1 = 2046 code units.
        const almostFull = `${"a".repeat(2044)}€`;
        store.appendDelta(reply, almostFull);
        store.appendDelta(reply, "b");
        expect(messageRow(db, reply).content).toBe(`${almostFull}b`);
        store.appendDelta(reply, "后续");
        expect(messageRow(db, reply).content).toBe(`${almostFull}b`);
        const stepId = step(store, reply, 0);
        expect(offsetOf(db, stepId)).toBe(2048);
        expect(snapshotContent(store, session, reply)).toHaveLength(2048);
        expect(store.finishTurn(reply, "done")).toBe(true);
      });
    });
  });

  it("pending deltas count: after the 2000ms flush the offset still includes what is pending", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create(OWNER).id;
        const { assistantMessageId: reply } = store.acceptPrompt(session, OWNER, "quiet");
        store.appendDelta(reply, "first ");
        vi.advanceTimersByTime(2_000);
        expect(messageRow(db, reply).content).toBe("first ");
        store.appendDelta(reply, "😀second");
        // "first " is 6 code units, "😀second" is 2 + 6.
        expect(offsetOf(db, step(store, reply, 0))).toBe(14);
        expect(snapshotContent(store, session, reply)).toHaveLength(14);
        store.appendDelta(reply, "!");
        expect(offsetOf(db, step(store, reply, 1))).toBe(15);
        expect(store.finishTurn(reply, "done")).toBe(true);
      });
    });
  });

  it("a new turn starts from 0, after a prompt and after a regenerate", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create(OWNER).id;
        const first = store.acceptPrompt(session, OWNER, "one").assistantMessageId;
        store.appendDelta(first, "上一回合的正文");
        expect(offsetOf(db, step(store, first, 0))).toBe(7);
        expect(store.finishTurn(first, "done")).toBe(true);

        const second = store.acceptPrompt(session, OWNER, "two").assistantMessageId;
        expect(offsetOf(db, step(store, second, 0))).toBe(0);
        store.appendDelta(second, "ab");
        expect(offsetOf(db, step(store, second, 1))).toBe(2);
        expect(store.finishTurn(second, "done")).toBe(true);

        const regenerated = store.acceptRegenerate(session, second, "/r.jsonl");
        expect(offsetOf(db, step(store, regenerated, 0))).toBe(0);
        expect(store.finishTurn(regenerated, "done")).toBe(true);
      });
    });
  });

  it("the step row carries its offset from the insert on (same statement, same transaction)", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        db.exec("CREATE TEMP TABLE inserted_offsets(body_offset)");
        db.exec(`CREATE TEMP TRIGGER record_inserted_offset AFTER INSERT ON chat_steps
          BEGIN INSERT INTO inserted_offsets VALUES (NEW.body_offset); END`);
        const session = store.create(OWNER).id;
        const { assistantMessageId: reply } = store.acceptPrompt(session, OWNER, "insert");
        store.appendDelta(reply, "hello");
        step(store, reply, 0);
        expect(db.prepare("SELECT body_offset FROM inserted_offsets").all()).toEqual([
          { body_offset: 5 },
        ]);
        expect(store.finishTurn(reply, "done")).toBe(true);
      });
    });
  });

  it("a failed step insert leaves neither the row nor an offset, and the count is untouched", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create(OWNER).id;
        const { assistantMessageId: reply } = store.acceptPrompt(session, OWNER, "fault");
        store.appendDelta(reply, "abc");
        db.exec(`CREATE TEMP TRIGGER reject_step_insert BEFORE INSERT ON chat_steps
          BEGIN SELECT RAISE(ABORT, 'step insert denied'); END`);
        expect(captureThrown(() => step(store, reply, 0))).toMatchObject({
          code: "ERR_SQLITE_ERROR",
        });
        expect(db.isTransaction).toBe(false);
        expect(stepsOf(db, reply)).toEqual([]);
        db.exec("DROP TRIGGER reject_step_insert");
        const stepId = step(store, reply, 0);
        expect(stepsOf(db, reply)).toEqual([{ id: stepId, ordinal: 0, body_offset: 3 }]);
        expect(store.finishTurn(reply, "done")).toBe(true);
      });
    });
  });
});

describe("turn-control「拷贝分段位置」: fork copies each step's body_offset", () => {
  it("copies 3 and 9 value for value and a pre-045 NULL as NULL; the source rows are unchanged", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const source = store.create(OWNER).id;
        const positioned = store.acceptPrompt(source, OWNER, "positioned").assistantMessageId;
        store.appendDelta(positioned, "abc");
        step(store, positioned, 0);
        store.appendDelta(positioned, "defghi");
        step(store, positioned, 1);
        expect(store.finishTurn(positioned, "done")).toBe(true);

        const legacy = store.acceptPrompt(source, OWNER, "legacy").assistantMessageId;
        step(store, legacy, 0);
        expect(store.finishTurn(legacy, "done")).toBe(true);
        // A message written before migration 045 has steps whose body_offset is NULL.
        db.prepare("UPDATE chat_steps SET body_offset = NULL WHERE message_id = ?").run(legacy);

        const tail = store.acceptPrompt(source, OWNER, "fork here");
        expect(store.finishTurn(tail.assistantMessageId, "done")).toBe(true);
        const sourceSteps = [stepsOf(db, positioned), stepsOf(db, legacy)];
        expect(sourceSteps.map((rows) => rows.map((row) => row.body_offset))).toEqual([
          [3, 9],
          [null],
        ]);

        store.commitFork({
          sourceId: source,
          sessionId: FORK_ID,
          ownerId: OWNER,
          messageId: tail.userMessageId,
          expectedAssistantId: tail.assistantMessageId,
          sessionFile: "/fork.jsonl",
        });
        const copies = (store.getMessages(FORK_ID, OWNER)?.messages ?? []).filter(
          (message) => message.role === "assistant",
        );
        expect(copies).toHaveLength(2);
        const copied = copies.map((message) => stepsOf(db, message.id));
        expect(
          copied.map((rows) => rows.map(({ ordinal, body_offset }) => [ordinal, body_offset])),
        ).toEqual([
          [
            [0, 3],
            [1, 9],
          ],
          [[0, null]],
        ]);
        const sourceIds = new Set(sourceSteps.flat().map((row) => row.id));
        expect(copied.flat().filter((row) => sourceIds.has(row.id))).toEqual([]);
        expect([stepsOf(db, positioned), stepsOf(db, legacy)]).toEqual(sourceSteps);
      });
    });
  });
});

const INSERT_SEGMENT =
  "INSERT INTO chat_thinking_segments(message_id, body_offset, thinking_offset, steps_before, thinking_length, thinking_ms) VALUES (?, ?, ?, ?, ?, ?)";

function segmentsOf(db: DatabaseSync, messageId: number) {
  return db
    .prepare(
      "SELECT id, body_offset, thinking_offset, steps_before, thinking_length, thinking_ms FROM chat_thinking_segments WHERE message_id = ? ORDER BY id",
    )
    .all(messageId) as Array<Record<string, number | null>>;
}

/** The row values without the row id. */
function values(rows: Array<Record<string, number | null>>) {
  return rows.map(({ id: _id, ...rest }) => rest);
}

const segment = (
  body_offset: number,
  thinking_offset: number,
  steps_before: number,
  thinking_length: number | null,
  thinking_ms: number | null,
) => ({ body_offset, thinking_offset, steps_before, thinking_length, thinking_ms });

describe("turn-control「拷贝分段位置」: fork copies the thinking segment rows (issue 1472)", () => {
  it("value for value in row order, NULL kept, new ids; none for a message without rows", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const source = store.create(OWNER).id;
        const turn = (text: string) => {
          const reply = store.acceptPrompt(source, OWNER, text).assistantMessageId;
          expect(store.finishTurn(reply, "done")).toBe(true);
          return reply;
        };
        const first = turn("one");
        const second = turn("two");
        const legacy = turn("legacy");
        // Interleaved inserts: within each message the copy keeps the source's row order.
        db.prepare(INSERT_SEGMENT).run(first, 0, 0, 0, 4, 120);
        db.prepare(INSERT_SEGMENT).run(second, 2, 0, 0, 3, 50);
        db.prepare(INSERT_SEGMENT).run(first, 9, 4, 2, null, null);
        const tail = store.acceptPrompt(source, OWNER, "fork here");
        expect(store.finishTurn(tail.assistantMessageId, "done")).toBe(true);
        const sourceRows = [first, second, legacy].map((id) => segmentsOf(db, id));

        store.commitFork({
          sourceId: source,
          sessionId: FORK_ID,
          ownerId: OWNER,
          messageId: tail.userMessageId,
          expectedAssistantId: tail.assistantMessageId,
          sessionFile: "/fork.jsonl",
        });
        const copies = (store.getMessages(FORK_ID, OWNER)?.messages ?? []).filter(
          (message) => message.role === "assistant",
        );
        const copied = copies.map((message) => segmentsOf(db, message.id));
        expect(copied.map(values)).toEqual([
          [segment(0, 0, 0, 4, 120), segment(9, 4, 2, null, null)],
          [segment(2, 0, 0, 3, 50)],
          [],
        ]);
        const sourceIds = new Set(sourceRows.flat().map((row) => row.id));
        expect(copied.flat().filter((row) => sourceIds.has(row.id))).toEqual([]);
        expect([first, second, legacy].map((id) => segmentsOf(db, id))).toEqual(sourceRows);
      });
    });
  });
});

describe("chat-sessions「Regenerate replaces only the last assistant message」: segment rows", () => {
  it("the old assistant's segments, steps and approvals cascade away; the new row has none", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create(OWNER).id;
        const earlier = store.acceptPrompt(session, OWNER, "one").assistantMessageId;
        store.appendDelta(earlier, "abc");
        const earlierStep = step(store, earlier, 0);
        expect(store.finishTurn(earlier, "done")).toBe(true);
        const last = store.acceptPrompt(session, OWNER, "two").assistantMessageId;
        const lastStep = step(store, last, 0);
        expect(store.finishTurn(last, "done")).toBe(true);
        const approval = db.prepare(
          "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at, step_id) VALUES (?, ?, 'bash', 't', 1, 60001, 'deny', 2, ?)",
        );
        for (const [id, stepId] of [
          [earlier, earlierStep],
          [last, lastStep],
        ] as const) {
          db.prepare(INSERT_SEGMENT).run(id, 0, 0, 0, 2, 30);
          db.prepare(INSERT_SEGMENT).run(id, 3, 2, 1, null, null);
          approval.run(id, `r-${String(id)}`, stepId);
        }
        const kept = () => ({
          segments: segmentsOf(db, earlier),
          steps: stepsOf(db, earlier),
          approvals: db.prepare("SELECT * FROM chat_approvals WHERE message_id = ?").all(earlier),
        });
        const before = kept();

        const regenerated = store.acceptRegenerate(session, last, "/r.jsonl");
        expect(segmentsOf(db, regenerated)).toEqual([]);
        const count = (table: string) =>
          db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE message_id = ?`).get(last);
        for (const table of ["chat_thinking_segments", "chat_steps", "chat_approvals"]) {
          expect(count(table)).toEqual({ n: 0 });
        }
        const orphans = db
          .prepare(
            "SELECT COUNT(*) AS n FROM chat_thinking_segments WHERE message_id NOT IN (SELECT id FROM chat_messages)",
          )
          .get();
        expect(orphans).toEqual({ n: 0 });
        expect(kept()).toEqual(before);
        expect(before.steps.map((row) => row.body_offset)).toEqual([3]);
        expect(values(before.segments)).toEqual([
          segment(0, 0, 0, 2, 30),
          segment(3, 2, 1, null, null),
        ]);
        expect(store.finishTurn(regenerated, "done")).toBe(true);
      });
    });
  });
});
