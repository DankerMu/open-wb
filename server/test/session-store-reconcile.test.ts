import { describe, expect, it, vi } from "vitest";
import {
  captureThrown,
  FIXED_NOW,
  messageRow,
  messageRows,
  persistenceSnapshot,
  seedMessage,
  seedSession,
  seedStep,
  sessionId,
  sessionRow,
  sessionRows,
  stepRow,
  stepRows,
  withFakeClock,
  withSessionStore,
} from "./session-store-helpers.js";

describe("SessionStore flush and close fault ownership", () => {
  it("retains a background timer flush fault, notifies once, and drains exactly once after explicit repair", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, flushFailures, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "timer failure");
        db.exec(`CREATE TEMP TRIGGER reject_timer_flush
          BEFORE UPDATE OF content ON chat_messages
          WHEN NEW.id = ${accepted.assistantMessageId}
          BEGIN SELECT RAISE(ABORT, 'timer flush denied'); END`);

        expect(store.appendDelta(accepted.assistantMessageId, "timer pending")).toBe(true);
        expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "",
          status: "running",
        });
        expect(flushFailures).toHaveLength(1);
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe("timer pending");
        const failure = flushFailures.at(0);
        expect(failure).toMatchObject({
          sessionId: session.id,
          assistantMessageId: accepted.assistantMessageId,
        });
        const retainedError = failure?.error;
        vi.advanceTimersByTime(10_000);
        expect(flushFailures).toHaveLength(1);

        const repeatedAppend = captureThrown(() =>
          store.appendDelta(accepted.assistantMessageId, "must not grow the buffer"),
        );
        expect(repeatedAppend).toBe(retainedError);
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe("timer pending");
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        db.exec("DROP TRIGGER reject_timer_flush");

        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "timer pending",
          status: "done",
        });
        expect(store.getMessages(session.id, "u1")?.messages[1]?.content).toBe("timer pending");
        expect(sessionRow(db, session.id)).toMatchObject({ status: "done" });
        expect(flushFailures).toHaveLength(1);
      });
    });
  });

  it("propagates an immediate threshold fault, preserves its exact pending bytes, and permits recovery", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, flushFailures, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "synchronous failure");
        const thresholdBody = "x".repeat(2_048);
        db.exec(`CREATE TEMP TRIGGER reject_threshold_flush
          BEFORE UPDATE OF content ON chat_messages
          WHEN NEW.id = ${accepted.assistantMessageId}
          BEGIN SELECT RAISE(ABORT, 'threshold flush denied'); END`);

        const immediateFault = captureThrown(() =>
          store.appendDelta(accepted.assistantMessageId, thresholdBody),
        );
        expect(immediateFault).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        expect(flushFailures).toEqual([]);
        expect(captureThrown(() => store.appendDelta(accepted.assistantMessageId, "late"))).toBe(
          immediateFault,
        );
        db.exec("DROP TRIGGER reject_threshold_flush");

        expect(store.finishTurn(accepted.assistantMessageId, "failed")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: thresholdBody,
          status: "failed",
        });
        expect(sessionRow(db, session.id)).toMatchObject({ status: "failed" });
      });
    });
  });

  it("keeps a failed terminal transaction recoverable without a timer retry or partial terminal rows", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, flushFailures, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "terminal failure");
        expect(store.appendDelta(accepted.assistantMessageId, "residual body")).toBe(true);
        const stepId = store.startStep(accepted.assistantMessageId, {
          ordinal: 0,
          name: "running during failure",
          detail: "unsettled",
        });
        const beforeFailure = persistenceSnapshot(db);
        db.exec(`CREATE TEMP TRIGGER reject_terminal_session
          BEFORE UPDATE OF status ON chat_sessions
          WHEN NEW.id = '${session.id}' AND NEW.status = 'done'
          BEGIN SELECT RAISE(ABORT, 'terminal session denied'); END`);

        const terminalFault = captureThrown(() =>
          store.finishTurn(accepted.assistantMessageId, "done"),
        );
        expect(terminalFault).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(persistenceSnapshot(db)).toEqual(beforeFailure);
        vi.advanceTimersByTime(2_000);
        expect(persistenceSnapshot(db)).toEqual(beforeFailure);
        expect(flushFailures).toEqual([]);
        db.exec("DROP TRIGGER reject_terminal_session");

        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "residual body",
          status: "done",
        });
        expect(stepRow(db, stepId)).toMatchObject({ status: "done" });
      });
    });
  });
  it("rejects rollback after a failed terminal entry and retains the turn for explicit recovery", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "terminal progress");
        const beforeTerminal = persistenceSnapshot(db);
        db.exec(`CREATE TEMP TRIGGER reject_terminal_progress
          BEFORE UPDATE OF status ON chat_sessions
          WHEN NEW.id = '${session.id}' AND NEW.status = 'done'
          BEGIN SELECT RAISE(ABORT, 'terminal progress denied'); END`);

        const terminalFault = captureThrown(() =>
          store.finishTurn(accepted.assistantMessageId, "done"),
        );
        expect(terminalFault).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(persistenceSnapshot(db)).toEqual(beforeTerminal);
        expect(
          captureThrown(() => store.rollbackPrompt(accepted.assistantMessageId)),
        ).toBeInstanceOf(Error);
        expect(persistenceSnapshot(db)).toEqual(beforeTerminal);
        expect(store.runtimeState(session.id)?.activeTurn).toEqual(accepted);
        db.exec("DROP TRIGGER reject_terminal_progress");

        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({ status: "done" });
        expect(sessionRow(db, session.id)).toMatchObject({ status: "done" });
      });
    });
  });

  it("cancels owned timers and leaves the caller database open while a failed close remains explicitly retryable", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, flushFailures, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "close failure");
        const stepId = store.startStep(accepted.assistantMessageId, {
          ordinal: 0,
          name: "close step",
          detail: "running",
        });
        expect(store.appendDelta(accepted.assistantMessageId, "close residual")).toBe(true);
        db.exec(`CREATE TEMP TRIGGER reject_close_session
          BEFORE UPDATE OF status ON chat_sessions
          WHEN NEW.id = '${session.id}' AND NEW.status = 'failed'
          BEGIN SELECT RAISE(ABORT, 'close session denied'); END`);

        const closeFault = captureThrown(() => store.close());
        expect(closeFault).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "",
          status: "running",
        });
        expect(sessionRow(db, session.id)).toMatchObject({ status: "running" });
        expect(stepRow(db, stepId)).toMatchObject({ status: "running", ended_at: null });
        vi.advanceTimersByTime(2_000);
        expect(flushFailures).toEqual([]);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        db.exec("DROP TRIGGER reject_close_session");

        expect(() => store.close()).not.toThrow();
        const closed = persistenceSnapshot(db);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "close residual",
          status: "failed",
        });
        expect(stepRow(db, stepId)).toMatchObject({ status: "failed" });
        expect(db.prepare("SELECT COUNT(*) AS count FROM chat_sessions").get()).toEqual({
          count: 1,
        });
        expect(() => store.close()).not.toThrow();
        expect(persistenceSnapshot(db)).toEqual(closed);
        expect(() => store.create("u1")).toThrow();
      });
    });
  });
});

describe("SessionStore explicit startup reconciliation", () => {
  it("has no constructor-side reconcile and explicitly changes every running row across owners only", () => {
    const runningSession = sessionId("a");
    const idleSession = sessionId("b");
    const doneSession = sessionId("c");
    const failedSession = sessionId("d");
    let preconstructorBaseline: unknown;

    withSessionStore(
      ({ db, store }) => {
        const before = persistenceSnapshot(db);
        expect(before).toEqual(preconstructorBaseline);
        store.reconcileOnStartup();
        expect(sessionRows(db)).toEqual(
          before.sessions.map((row) => ({
            ...row,
            status: row.status === "running" ? "failed" : row.status,
          })),
        );
        expect(messageRows(db)).toEqual(
          before.messages.map((row) => ({
            ...row,
            status: row.status === "running" ? "failed" : row.status,
          })),
        );
        expect(stepRows(db)).toEqual(
          before.steps.map((row) => ({
            ...row,
            status: row.status === "running" ? "failed" : row.status,
          })),
        );
      },
      (db) => {
        seedSession(db, {
          id: runningSession,
          ownerId: "u1",
          title: "running session",
          status: "running",
          ompSessionFile: "keep-running.jsonl",
          streamEpoch: 4,
          createdAt: 10,
          updatedAt: 11,
        });
        seedSession(db, {
          id: idleSession,
          ownerId: "u1",
          title: null,
          status: "idle",
          ompSessionFile: null,
          streamEpoch: 0,
          createdAt: 20,
          updatedAt: 21,
        });
        seedSession(db, {
          id: doneSession,
          ownerId: "u2",
          title: "done session",
          status: "done",
          ompSessionFile: "keep-done.jsonl",
          streamEpoch: 7,
          createdAt: 30,
          updatedAt: 31,
        });
        seedSession(db, {
          id: failedSession,
          ownerId: "u2",
          title: "failed session",
          status: "failed",
          ompSessionFile: "keep-failed.jsonl",
          streamEpoch: 9,
          createdAt: 40,
          updatedAt: 41,
        });
        const runningMessage = seedMessage(db, {
          sessionId: runningSession,
          role: "assistant",
          content: "running content",
          status: "running",
          createdAt: 12,
        });
        const doneMessage = seedMessage(db, {
          sessionId: idleSession,
          role: "user",
          content: "done content",
          status: "done",
          createdAt: 22,
        });
        const failedMessage = seedMessage(db, {
          sessionId: doneSession,
          role: "assistant",
          content: "failed content",
          status: "failed",
          createdAt: 32,
        });
        const secondRunningMessage = seedMessage(db, {
          sessionId: failedSession,
          role: "assistant",
          content: "other running content",
          status: "running",
          createdAt: 42,
        });
        seedStep(db, {
          messageId: runningMessage,
          ordinal: 0,
          name: "running step",
          detail: "keep detail",
          status: "running",
          startedAt: 13,
          endedAt: null,
        });
        seedStep(db, {
          messageId: doneMessage,
          ordinal: 0,
          name: "done step",
          detail: "done detail",
          status: "done",
          startedAt: 23,
          endedAt: 24,
        });
        seedStep(db, {
          messageId: failedMessage,
          ordinal: 0,
          name: "failed step",
          detail: "failed detail",
          status: "failed",
          startedAt: 33,
          endedAt: 34,
        });
        seedStep(db, {
          messageId: secondRunningMessage,
          ordinal: 0,
          name: "other running step",
          detail: "other detail",
          status: "running",
          startedAt: 43,
          endedAt: null,
        });
        preconstructorBaseline = persistenceSnapshot(db);
      },
    );
  });

  it("rolls back all reconciliation status changes when a real table write raises, then succeeds after repair", () => {
    const session = sessionId("e");
    withSessionStore(
      ({ db, store }) => {
        const before = persistenceSnapshot(db);
        db.exec(`CREATE TEMP TRIGGER reject_reconcile_step
          BEFORE UPDATE OF status ON chat_steps
          WHEN OLD.status = 'running' AND NEW.status = 'failed'
          BEGIN SELECT RAISE(ABORT, 'reconcile step denied'); END`);
        const reconciliationFault = captureThrown(() => store.reconcileOnStartup());
        expect(reconciliationFault).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        expect(persistenceSnapshot(db)).toEqual(before);
        db.exec("DROP TRIGGER reject_reconcile_step");

        store.reconcileOnStartup();
        expect(sessionRow(db, session)).toMatchObject({ status: "failed" });
        expect(messageRows(db).map((row) => row.status)).toEqual(["failed"]);
        expect(stepRows(db).map((row) => row.status)).toEqual(["failed"]);
      },
      (db) => {
        seedSession(db, {
          id: session,
          ownerId: "u1",
          title: "atomic reconciliation",
          status: "running",
          ompSessionFile: "atomic.jsonl",
          streamEpoch: 3,
          createdAt: 50,
          updatedAt: 51,
        });
        const message = seedMessage(db, {
          sessionId: session,
          role: "assistant",
          content: "pending",
          status: "running",
          createdAt: 52,
        });
        seedStep(db, {
          messageId: message,
          ordinal: 0,
          name: "pending step",
          detail: "pending detail",
          status: "running",
          startedAt: 53,
          endedAt: null,
        });
      },
    );
  });

  it("rejects reconciliation while it owns a live turn and becomes usable after that turn finishes", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "live reconcile guard");
        expect(store.appendDelta(accepted.assistantMessageId, "pending")).toBe(true);
        const before = persistenceSnapshot(db);

        expect(captureThrown(() => store.reconcileOnStartup())).toBeInstanceOf(Error);
        expect(persistenceSnapshot(db)).toEqual(before);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(() => store.reconcileOnStartup()).not.toThrow();
        expect(sessionRow(db, session.id)).toMatchObject({ status: "done" });
      });
    });
  });
});
