/**
 * Issue #455 stopped settlement: finishTurn(stopped) settles assistant, session and running steps
 * in one transaction, leaves settled steps untouched and stays re-admittable; REST reads it back.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SessionStore } from "../src/sessions/store.js";
import {
  cookieFor,
  getSessionMessages,
  SESSION_NOW,
  withSessionRest,
} from "./session-rest-helpers.js";
import {
  captureThrown,
  FIXED_NOW,
  messageRow,
  persistenceSnapshot,
  sessionRow,
  stepRow,
  withFakeClock,
  withSessionStore,
} from "./session-store-helpers.js";
import { expectWorkspaceResponse } from "./workspaces-http-helpers.js";

const ACCEPTED_AT = FIXED_NOW + 10;
const SETTLED_AT = FIXED_NOW + 50;
const READMITTED_AT = FIXED_NOW + 90;

afterEach(() => {
  vi.useRealTimers();
});

/** Accepts one prompt with two unflushed deltas and one running step (the stop-shaped turn). */
function stopShapedTurn(store: SessionStore, sessionId: string) {
  const accepted = store.acceptPrompt(sessionId, "u1", "stop me");
  expect(store.appendDelta(accepted.assistantMessageId, "ab")).toBe(true);
  expect(store.appendDelta(accepted.assistantMessageId, "cd")).toBe(true);
  const runningStep = store.startStep(accepted.assistantMessageId, {
    ordinal: 1,
    name: "bash",
    detail: '{"command":"sleep 9"}',
  });
  return { accepted, runningStep };
}

describe("session store — stopped settlement", () => {
  it("settles residual body, assistant, session and running step as stopped; done step unchanged; re-admits from stopped", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        vi.setSystemTime(ACCEPTED_AT);
        const accepted = store.acceptPrompt(session.id, "u1", "stop me");
        expect(store.appendDelta(accepted.assistantMessageId, "ab")).toBe(true);
        expect(store.appendDelta(accepted.assistantMessageId, "cd")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        const doneStep = store.startStep(accepted.assistantMessageId, {
          ordinal: 0,
          name: "read",
          detail: '{"path":"a.md"}',
        });
        const runningStep = store.startStep(accepted.assistantMessageId, {
          ordinal: 1,
          name: "bash",
          detail: '{"command":"sleep 9"}',
        });
        expect(store.finishStep(doneStep, "done", "ok")).toBe(true);
        const doneBefore = stepRow(db, doneStep);

        vi.setSystemTime(SETTLED_AT);
        expect(store.finishTurn(accepted.assistantMessageId, "stopped")).toBe(true);

        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "abcd",
          status: "stopped",
        });
        expect(sessionRow(db, session.id)).toMatchObject({
          status: "stopped",
          updated_at: SETTLED_AT,
        });
        expect(stepRow(db, runningStep)).toMatchObject({
          status: "stopped",
          output: null,
          ended_at: SETTLED_AT,
        });
        expect(stepRow(db, doneStep)).toEqual(doneBefore);
        const view = store.getMessages(session.id, "u1");
        const assistant = view?.messages.find((m) => m.id === accepted.assistantMessageId);
        expect(assistant?.steps.find((s) => s.id === runningStep)).toMatchObject({
          status: "stopped",
          output: "",
          endedAt: SETTLED_AT,
        });

        const beforeReadmission = persistenceSnapshot(db);
        vi.setSystemTime(READMITTED_AT);
        const next = store.acceptPrompt(session.id, "u1", "continue");
        expect(sessionRow(db, session.id)).toMatchObject({
          status: "running",
          updated_at: READMITTED_AT,
        });
        expect(store.rollbackPrompt(next.assistantMessageId)).toBe(true);
        expect(sessionRow(db, session.id)).toMatchObject({
          status: "stopped",
          title: "stop me",
          updated_at: SETTLED_AT,
        });
        expect(persistenceSnapshot(db)).toEqual(beforeReadmission);
      });
    });
  });

  it("guard: a rejected stopped settlement leaves no partial rows and a repaired retry applies once", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const { accepted, runningStep } = stopShapedTurn(store, session.id);
        const before = persistenceSnapshot(db);
        db.exec(`CREATE TEMP TRIGGER reject_stopped_step
          BEFORE UPDATE OF status ON chat_steps
          WHEN NEW.status = 'stopped'
          BEGIN SELECT RAISE(ABORT, 'stopped step denied'); END`);

        const fault = captureThrown(() => store.finishTurn(accepted.assistantMessageId, "stopped"));
        expect(fault).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(persistenceSnapshot(db)).toEqual(before);
        db.exec("DROP TRIGGER reject_stopped_step");

        expect(store.finishTurn(accepted.assistantMessageId, "stopped")).toBe(true);
        expect(store.finishTurn(accepted.assistantMessageId, "stopped")).toBe(false);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "abcd",
          status: "stopped",
        });
        expect(sessionRow(db, session.id)).toMatchObject({ status: "stopped" });
        expect(stepRow(db, runningStep)).toMatchObject({ status: "stopped", output: null });
      });
    });
  });

  it("types: finishTurn accepts stopped while finishStep stays done | failed", () => {
    expectTypeOf<Parameters<SessionStore["finishTurn"]>[1]>().toEqualTypeOf<
      "done" | "failed" | "stopped"
    >();
    expectTypeOf<Parameters<SessionStore["finishStep"]>[1]>().toEqualTypeOf<"done" | "failed">();
  });
});

describe("session REST — stopped read-back", () => {
  it("guard: GET list and messages return the stopped session, assistant and step", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1");
      const { accepted, runningStep } = stopShapedTurn(store, session.id);
      expect(store.finishTurn(accepted.assistantMessageId, "stopped")).toBe(true);

      const cookie = await cookieFor(app, "zhangsan");
      const listed = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });
      expectWorkspaceResponse(listed, 200, {
        sessions: [
          {
            id: session.id,
            title: "stop me",
            status: "stopped",
            createdAt: SESSION_NOW,
            updatedAt: SESSION_NOW,
          },
        ],
      });

      const history = await getSessionMessages(app, session.id, cookie);
      expectWorkspaceResponse(history, 200, {
        session: {
          id: session.id,
          title: "stop me",
          status: "stopped",
          createdAt: SESSION_NOW,
          updatedAt: SESSION_NOW,
        },
        messages: [
          {
            id: accepted.userMessageId,
            role: "user",
            content: "stop me",
            status: "done",
            createdAt: SESSION_NOW,
            steps: [],
          },
          {
            id: accepted.assistantMessageId,
            role: "assistant",
            content: "abcd",
            status: "stopped",
            createdAt: SESSION_NOW,
            steps: [
              {
                id: runningStep,
                ordinal: 1,
                name: "bash",
                detail: '{"command":"sleep 9"}',
                output: "",
                status: "stopped",
              },
            ],
          },
        ],
        streamCursor: { epoch: 0, seq: null },
      });
    });
  });
});
