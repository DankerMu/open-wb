import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
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
        },
        messages: [
          {
            id: accepted.userMessageId,
            role: "user",
            content: "cached cursor",
            status: "done",
            createdAt: SESSION_NOW,
            steps: [],
          },
          {
            id: accepted.assistantMessageId,
            role: "assistant",
            content: "hello",
            status: "running",
            createdAt: SESSION_NOW,
            steps: [],
          },
        ],
        streamCursor: { epoch: 1, seq: 1002 },
      });
      expect(supervisor.cursor).toEqual({ epoch: 1, seq: 1003 });
      expect(supervisor.cursorCalls).toEqual([session.id]);
    });
  });
});
