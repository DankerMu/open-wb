import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import {
  cookieFor,
  getSessionMessages,
  SESSION_NOW,
  withSessionRest,
} from "./session-rest-helpers.js";
import { FIXED_NOW, messageRow, withFakeClock, withSessionStore } from "./session-store-helpers.js";
import { expectWorkspaceResponse } from "./workspaces-http-helpers.js";

const PENDING_1000 = "p".repeat(1_000);
const UNICODE_PENDING = `\u0000\uFEFFKeep BOM 中文 😀`;

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionStore complete current-history views", () => {
  it("returns owned pending text without flushing timers, budgets, or SQLite content", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "pending overlay");
        expect(store.appendDelta(accepted.assistantMessageId, PENDING_1000)).toBe(true);

        const first = store.getMessages(session.id, "u1");
        expect(first?.messages[1]).toMatchObject({
          id: accepted.assistantMessageId,
          role: "assistant",
          content: PENDING_1000,
          status: "running",
        });
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "",
          status: "running",
        });

        vi.advanceTimersByTime(1_999);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        const second = store.getMessages(session.id, "u1");
        expect(second?.messages[1]?.content).toBe(PENDING_1000);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");

        vi.advanceTimersByTime(1);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: PENDING_1000,
          status: "running",
        });
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(PENDING_1000);

        expect(store.appendDelta(accepted.assistantMessageId, "next quiet")).toBe(true);
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(
          `${PENDING_1000}next quiet`,
        );
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(PENDING_1000);
        vi.advanceTimersByTime(1_999);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(PENDING_1000);
        vi.advanceTimersByTime(1);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(
          `${PENDING_1000}next quiet`,
        );
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("overlays owned Unicode, NUL, and BOM pending text while SQLite stays empty", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "unicode overlay");
        expect(store.appendDelta(accepted.assistantMessageId, UNICODE_PENDING)).toBe(true);
        expect(Buffer.byteLength(UNICODE_PENDING, "utf8")).toBeLessThan(2_048);

        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(UNICODE_PENDING);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        expect(store.getMessages(session.id, "u2")).toBeNull();
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(UNICODE_PENDING);
      });
    });
  });

  it("keeps a 2048-byte flushed body plus later pending without duplicating after repair", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "threshold overlay");
        const flushed = "a".repeat(2_048);
        expect(store.appendDelta(accepted.assistantMessageId, flushed)).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(flushed);
        expect(store.appendDelta(accepted.assistantMessageId, "Z")).toBe(true);
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(`${flushed}Z`);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(flushed);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe(`${flushed}Z`);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(`${flushed}Z`);
      });
    });
  });
});

describe("session REST snapshot capture", () => {
  it("keeps the preParsing streamCursor even if publication advances later in the request", async () => {
    await withSessionRest(async ({ app, store, supervisor }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "cached cursor");
      expect(store.appendDelta(accepted.assistantMessageId, "hello")).toBe(true);
      supervisor.cursor = { epoch: 1, seq: 1002 };
      supervisor.onStreamCursor((sessionId) => {
        expect(sessionId).toBe(session.id);
        const captured = supervisor.cursor;
        supervisor.cursor = { epoch: 1, seq: 1003 };
        return captured;
      });

      const history = await getSessionMessages(app, session.id, await cookieFor(app, "zhangsan"));
      expectWorkspaceResponse(history, 200, {
        session: {
          id: session.id,
          title: "cached cursor",
          status: "running",
          createdAt: SESSION_NOW,
          updatedAt: SESSION_NOW,
          ...NULL_SESSION_META,
        },
        messages: [
          {
            id: accepted.userMessageId,
            role: "user",
            content: "cached cursor",
            status: "done",
            createdAt: SESSION_NOW,
            approvals: [],
            undo: "unbound",
            attachments: [],
            steps: [],
            thinking: null,
          },
          {
            id: accepted.assistantMessageId,
            role: "assistant",
            content: "hello",
            status: "running",
            createdAt: SESSION_NOW,
            approvals: [],
            undo: null,
            attachments: [],
            steps: [],
            thinking: null,
          },
        ],
        streamCursor: { epoch: 1, seq: 1002 },
        todo: null,
      });
      expect(supervisor.cursor).toEqual({ epoch: 1, seq: 1003 });
      expect(supervisor.cursorCalls).toEqual([session.id]);
    });
  });

  it("keeps the preParsing task list even if the column and the stream move later in the request", async () => {
    const stored =
      '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"}]}]}';
    const later =
      '{"phases":[{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}';
    await withSessionRest(async ({ app, db, store, supervisor }) => {
      const session = store.create("u1");
      const setTodo = db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?");
      setTodo.run(stored, session.id);
      supervisor.cursor = { epoch: 1, seq: 7 };
      // After every preParsing hook, before the handler: the list and the stream both move on.
      let moved = 0;
      app.addHook("preValidation", (request, _reply, done) => {
        if (request.url.endsWith("/messages")) {
          setTodo.run(later, session.id);
          supervisor.cursor = { epoch: 1, seq: 8 };
          moved += 1;
        }
        done();
      });

      const history = await getSessionMessages(app, session.id, await cookieFor(app, "zhangsan"));

      expect(history.statusCode).toBe(200);
      const body = history.json() as { streamCursor: unknown; todo: unknown };
      expect(body.todo).toEqual(JSON.parse(stored));
      expect(body.streamCursor).toEqual({ epoch: 1, seq: 7 });
      expect(moved).toBe(1);
      expect(store.readTodo(session.id, "u1")).toEqual(JSON.parse(later));
    });
  });

  // session-todo「存量坏值降级为 null」: the snapshot is the one the NULL column gives.
  it.each(["{not json", '{"phases":"x"}', "null"])(
    "answers 200 with todo null when the column holds %s and leaves the column alone",
    async (tampered) => {
      await withSessionRest(async ({ app, db, store, supervisor }) => {
        const session = store.create("u1");
        store.acceptPrompt(session.id, "u1", "bad stored list");
        supervisor.cursor = { epoch: 1, seq: 3 };
        const cookie = await cookieFor(app, "zhangsan");
        const clean = await getSessionMessages(app, session.id, cookie);
        expect(clean.statusCode).toBe(200);
        db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?").run(tampered, session.id);

        const history = await getSessionMessages(app, session.id, cookie);

        expect(history.statusCode).toBe(200);
        const body = history.json() as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(["messages", "session", "streamCursor", "todo"]);
        expect(body.todo).toBeNull();
        expect(body).toEqual(clean.json());
        expect(db.prepare("SELECT todo FROM chat_sessions WHERE id = ?").get(session.id)).toEqual({
          todo: tampered,
        });
      });
    },
  );
});

/**
 * Issue #1019 (message-attachments「附件落库与快照」): the column is written by `store.acceptPrompt`
 * itself — the prompt route does not pass attachments yet — and read back over the history route.
 */
describe("session REST snapshot attachments (#1019)", () => {
  const STORED = [
    { path: "uploads/a.pdf", size: 3 },
    { path: "uploads/子目录/b.png", size: 0 },
  ];
  const column = (db: DatabaseSync, id: number) =>
    db
      .prepare("SELECT attachments, typeof(attachments) AS kind FROM chat_messages WHERE id = ?")
      .get(id);
  const attachmentsOf = (history: LightMyRequestResponse) => {
    expect(history.statusCode).toBe(200);
    const { messages } = history.json() as {
      messages: Array<{ id: number; attachments: unknown }>;
    };
    return messages.map((message) => [message.id, message.attachments]);
  };

  it("serves the stored list in stored order on its message and [] on every other", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1");
      const plain = store.acceptPrompt(session.id, "u1", "no files");
      store.finishTurn(plain.assistantMessageId, "done");
      const accepted = store.acceptPrompt(session.id, "u1", "", STORED);
      const cookie = await cookieFor(app, "zhangsan");

      expect(attachmentsOf(await getSessionMessages(app, session.id, cookie))).toEqual([
        [plain.userMessageId, []],
        [plain.assistantMessageId, []],
        [accepted.userMessageId, STORED],
        [accepted.assistantMessageId, []],
      ]);
      const tree = store.getMessages(session.id, "u1");
      expect(tree?.messages.map((message) => message.attachments)).toEqual([[], [], STORED, []]);
      expect(tree?.messages[2]?.content).toBe("");
      expect(column(db, accepted.userMessageId)).toEqual({
        attachments: '[{"path":"uploads/a.pdf","size":3},{"path":"uploads/子目录/b.png","size":0}]',
        kind: "text",
      });
      expect(column(db, accepted.assistantMessageId)).toEqual({ attachments: null, kind: "null" });
    });
  });

  it("a compensated admission leaves no message, and so no attachment, in the snapshot", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "看看", STORED);

      expect(store.rollbackPrompt(accepted.assistantMessageId)).toBe(true);

      const history = await getSessionMessages(app, session.id, await cookieFor(app, "zhangsan"));
      expect(attachmentsOf(history)).toEqual([]);
    });
  });

  // 「补偿与坏值」: only an out-of-band write gets these into the column.
  it.each(["not json", "{}", '[{"path":1}]', '[{"path":"a.pdf","size":3},{"path":"","size":1}]'])(
    "reads a column holding %s as [] and leaves the column alone",
    async (tampered) => {
      await withSessionRest(async ({ app, db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "看看", STORED);
        db.prepare("UPDATE chat_messages SET attachments = ? WHERE id = ?").run(
          tampered,
          accepted.userMessageId,
        );

        const history = await getSessionMessages(app, session.id, await cookieFor(app, "zhangsan"));

        expect(attachmentsOf(history)).toEqual([
          [accepted.userMessageId, []],
          [accepted.assistantMessageId, []],
        ]);
        expect(column(db, accepted.userMessageId)).toEqual({ attachments: tampered, kind: "text" });
      });
    },
  );

  it("serves exactly {path, size} of a stored element that carries more", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      const session = store.create("u1");
      const accepted = store.acceptPrompt(session.id, "u1", "看看");
      db.prepare("UPDATE chat_messages SET attachments = ? WHERE id = ?").run(
        '[{"size":3,"absPath":"/srv/a.pdf","path":"uploads/a.pdf"}]',
        accepted.userMessageId,
      );

      const history = await getSessionMessages(app, session.id, await cookieFor(app, "zhangsan"));

      expect(history.payload).toContain('"attachments":[{"path":"uploads/a.pdf","size":3}]');
      expect(history.payload).not.toContain("absPath");
    });
  });
});
