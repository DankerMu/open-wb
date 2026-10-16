/**
 * Issue #909 task 6.4 at the store seam (`persistEvent` over a real `SessionStore` on in-memory
 * SQLite): the three error columns travel with a forked assistant row, vanish with a regenerated
 * one, and startup reconciliation never writes them (upstream-failure「失败的公开形状」Scenario
 * 「拷贝、删除与对账」; design D13 for a row the crash left running with its error already stored).
 * Expected values are literals of the scenario and the classification table.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { sanitizeUpstreamText } from "../src/core/upstream-failure.js";
import { PumpSteps } from "../src/sessions/approval-pairing.js";
import type { ChatEvent } from "../src/sessions/events.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";

const OWNER = "u1";
const FORK_ID = "f".repeat(32);
const FAILURE = {
  message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
  reason: "auth_failed",
  status: 401,
  detail: "401 bad key k-1",
} as const;
const STORED = {
  error_reason: "auth_failed",
  error_status: 401,
  error_detail: "401 bad key [已移除]",
};
const UNSET = { error_reason: null, error_status: null, error_detail: null };

const opened: Array<{ db: DatabaseSync; store: SessionStore }> = [];

afterEach(() => {
  for (const { db, store } of opened.splice(0)) {
    store.close();
    db.close();
  }
});

function open(db = openDb(":memory:")): { db: DatabaseSync; store: SessionStore } {
  const store = createSessionStore(db, { onFlushError: () => {}, composer: TEST_COMPOSER });
  opened.push({ db, store });
  return { db, store };
}

/** The supervisor's `error` then `turn.end failed`, with a sanitiser that knows the key `k-1`. */
function failTurn(store: SessionStore, assistant: number): ChatEvent<number> | undefined {
  const published = persistEvent(
    store,
    assistant,
    { type: "error", data: { messageId: assistant, ...FAILURE } },
    new PumpSteps(assistant),
    [],
    null,
    (text) => sanitizeUpstreamText(text, ["k-1"]),
  );
  store.finishTurn(assistant, "failed");
  return published;
}

function columns(db: DatabaseSync, id: number) {
  return db
    .prepare("SELECT error_reason, error_status, error_detail FROM chat_messages WHERE id = ?")
    .get(id);
}

/** A session whose first turn failed with FAILURE: its user and assistant ids. */
function failedSession(store: SessionStore) {
  const session = store.create(OWNER).id;
  const turn = store.acceptPrompt(session, OWNER, "你好");
  failTurn(store, turn.assistantMessageId);
  return { session, ...turn };
}

describe("persistEvent stores the sanitised failure and returns it for publication", () => {
  it("the five-key event carries the sanitised detail the columns hold", () => {
    const { db, store } = open();
    const session = store.create(OWNER).id;
    const { assistantMessageId: assistant } = store.acceptPrompt(session, OWNER, "你好");
    expect(failTurn(store, assistant)).toEqual({
      type: "error",
      data: { messageId: assistant, ...FAILURE, detail: "401 bad key [已移除]" },
    });
    expect(columns(db, assistant)).toEqual(STORED);
    const [user, reply] = store.getMessages(session, OWNER)?.messages ?? [];
    expect(user?.error).toBeNull();
    expect(reply?.error).toEqual({ ...FAILURE, detail: "401 bad key [已移除]" });
  });
});

describe("upstream-failure「拷贝、删除与对账」", () => {
  it("fork copies the three columns of the assistant row it copies, value for value", () => {
    const { db, store } = open();
    const source = failedSession(store);
    const next = store.acceptPrompt(source.session, OWNER, "再来");
    store.finishTurn(next.assistantMessageId, "done");
    store.commitFork({
      sourceId: source.session,
      sessionId: FORK_ID,
      ownerId: OWNER,
      messageId: next.userMessageId,
      expectedAssistantId: next.assistantMessageId,
      sessionFile: "/fork.jsonl",
    });
    const copied = store.getMessages(FORK_ID, OWNER)?.messages ?? [];
    expect(copied.map((message) => message.role)).toEqual(["user", "assistant"]);
    const [, reply] = copied;
    expect(columns(db, reply?.id ?? 0)).toEqual(columns(db, source.assistantMessageId));
    expect(columns(db, reply?.id ?? 0)).toEqual(STORED);
    expect(reply?.status).toBe("failed");
  });

  it("regenerate deletes the old row and its columns; the new row reads NULL", () => {
    const { db, store } = open();
    const source = failedSession(store);
    const fresh = store.acceptRegenerate(source.session, source.assistantMessageId, "/r.jsonl");
    expect(columns(db, source.assistantMessageId)).toBeUndefined();
    expect(columns(db, fresh)).toEqual(UNSET);
    expect(store.getMessages(source.session, OWNER)?.messages.at(-1)?.error).toBeNull();
  });

  it("startup reconciliation settles a running row as failed and writes no column", () => {
    const db = openDb(":memory:");
    // Abandoned, never closed: its close would settle the open turns (a crash does not).
    const before = createSessionStore(db, { onFlushError: () => {}, composer: TEST_COMPOSER });
    const plain = before.create(OWNER).id;
    const plainTurn = before.acceptPrompt(plain, OWNER, "你好");
    // design D13: a crash between storing the error and settling the turn leaves both.
    const crashed = before.create(OWNER).id;
    const crashedTurn = before.acceptPrompt(crashed, OWNER, "你好");
    before.recordError(crashedTurn.assistantMessageId, {
      reason: "auth_failed",
      status: 401,
      detail: "401 bad key [已移除]",
    });
    const { store: restarted } = open(db);
    restarted.reconcileOnStartup();
    expect(columns(db, plainTurn.assistantMessageId)).toEqual(UNSET);
    expect(restarted.getMessages(plain, OWNER)?.messages.map((m) => [m.status, m.error])).toEqual([
      ["done", null],
      ["failed", null],
    ]);
    expect(columns(db, crashedTurn.assistantMessageId)).toEqual(STORED);
    expect(restarted.getMessages(crashed, OWNER)?.messages[1]?.status).toBe("failed");
  });
});

describe("a stored row the classification table does not know reads null", () => {
  it("an unknown reason, and a column set on a user row, read error null", () => {
    const { db, store } = open();
    const source = failedSession(store);
    db.prepare("UPDATE chat_messages SET error_reason = 'auth_failed' WHERE id = ?").run(
      source.userMessageId,
    );
    db.prepare("UPDATE chat_messages SET error_reason = 'teapot' WHERE id = ?").run(
      source.assistantMessageId,
    );
    expect(store.getMessages(source.session, OWNER)?.messages.map((m) => m.error)).toEqual([
      null,
      null,
    ]);
  });

  it("a stored error_status outside 100–599 or not an integer reads status null", () => {
    const { db, store } = open();
    const source = failedSession(store);
    const statusOf = (value: number) => {
      db.prepare("UPDATE chat_messages SET error_status = ? WHERE id = ?").run(
        value,
        source.assistantMessageId,
      );
      return store.getMessages(source.session, OWNER)?.messages[1]?.error;
    };
    // The web rejects a snapshot whose status is not an HTTP status (「消息 error 键严格解析」).
    expect([99, 100, 599, 600, 0, -401, 1.5].map((value) => statusOf(value)?.status)).toEqual([
      null,
      100,
      599,
      null,
      null,
      null,
      null,
    ]);
    expect(statusOf(70000)).toEqual({ ...FAILURE, status: null, detail: "401 bad key [已移除]" });
  });
});
