import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  expectHttpError,
  FIXED_NOW,
  messageRow,
  persistenceSnapshot,
  sessionRow,
  stepRow,
  withFakeClock,
  withSessionStore,
} from "./session-store-helpers.js";

describe("SessionStore UTF-8 buffering", () => {
  it("drains at the exact cumulative UTF-8 threshold and starts a fresh quiet budget after commit", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "byte boundary");
        const almostFull = `${"a".repeat(2044)}€`;

        expect(Buffer.byteLength(almostFull, "utf8")).toBe(2047);
        expect(store.appendDelta(accepted.assistantMessageId, almostFull)).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "",
          status: "running",
        });
        expect(store.appendDelta(accepted.assistantMessageId, "b")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: `${almostFull}b`,
          status: "running",
        });

        expect(store.appendDelta(accepted.assistantMessageId, "next quiet cycle")).toBe(true);
        vi.advanceTimersByTime(1_999);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe(`${almostFull}b`);
        vi.advanceTimersByTime(1);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: `${almostFull}bnext quiet cycle`,
          status: "running",
        });
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("uses the first pending delta deadline even when later deltas arrive", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "quiet deadline");

        expect(store.appendDelta(accepted.assistantMessageId, "first ")).toBe(true);
        vi.advanceTimersByTime(1_500);
        expect(store.appendDelta(accepted.assistantMessageId, "second")).toBe(true);
        vi.advanceTimersByTime(499);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        vi.advanceTimersByTime(1);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("first second");
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("keeps an empty active delta idle while a later nonempty delta still flushes on its own timer", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "empty delta");

        expect(store.appendDelta(accepted.assistantMessageId, "")).toBe(true);
        vi.advanceTimersByTime(2_000);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("");
        expect(store.appendDelta(accepted.assistantMessageId, "positive control")).toBe(true);
        vi.advanceTimersByTime(2_000);
        expect(messageRow(db, accepted.assistantMessageId).content).toBe("positive control");
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });
});

describe("SessionStore steps and terminal identity", () => {
  it("persists started steps immediately and changes only a running step when it is explicitly finished", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "step lifecycle");

        expectHttpError(
          () =>
            store.startStep(accepted.assistantMessageId + 1_000, {
              ordinal: 0,
              name: "missing assistant",
              detail: "negative control",
            }),
          "not_found",
        );
        vi.setSystemTime(FIXED_NOW + 3);
        const stepId = store.startStep(accepted.assistantMessageId, {
          ordinal: 0,
          name: "real step",
          detail: "started",
        });
        expect(stepRow(db, stepId)).toEqual({
          id: stepId,
          message_id: accepted.assistantMessageId,
          ordinal: 0,
          name: "real step",
          detail: "started",
          status: "running",
          started_at: FIXED_NOW + 3,
          ended_at: null,
        });

        vi.setSystemTime(FIXED_NOW + 4);
        expect(store.finishStep(stepId, "done", "finished detail")).toBe(true);
        const terminalStep = stepRow(db, stepId);
        expect(terminalStep).toMatchObject({
          detail: "finished detail",
          status: "done",
          ended_at: FIXED_NOW + 4,
        });
        expect(store.finishStep(stepId, "failed", "must not overwrite")).toBe(false);
        expect(stepRow(db, stepId)).toEqual(terminalStep);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
      });
    });
  });

  it("atomically drains residual content and settles only still-running steps at terminal status", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const accepted = store.acceptPrompt(session.id, "u1", "terminal settlement");
        expect(store.appendDelta(accepted.assistantMessageId, "residual answer")).toBe(true);

        vi.setSystemTime(FIXED_NOW + 5);
        const alreadyFailed = store.startStep(accepted.assistantMessageId, {
          ordinal: 0,
          name: "preserve failure",
          detail: "original failure",
        });
        vi.setSystemTime(FIXED_NOW + 6);
        expect(store.finishStep(alreadyFailed, "failed")).toBe(true);
        vi.setSystemTime(FIXED_NOW + 7);
        const stillRunning = store.startStep(accepted.assistantMessageId, {
          ordinal: 1,
          name: "settle on finish",
          detail: "waiting",
        });

        vi.setSystemTime(FIXED_NOW + 8);
        expect(store.finishTurn(accepted.assistantMessageId, "done")).toBe(true);
        expect(messageRow(db, accepted.assistantMessageId)).toMatchObject({
          content: "residual answer",
          status: "done",
        });
        expect(sessionRow(db, session.id)).toMatchObject({
          status: "done",
          updated_at: FIXED_NOW + 8,
        });
        expect(stepRow(db, alreadyFailed)).toMatchObject({
          detail: "original failure",
          status: "failed",
          ended_at: FIXED_NOW + 6,
        });
        expect(stepRow(db, stillRunning)).toMatchObject({
          detail: "waiting",
          status: "done",
          ended_at: FIXED_NOW + 8,
        });
      });
    });
  });

  it("rejects stale terminal callbacks without changing a completed turn or its next admission", () => {
    withFakeClock(FIXED_NOW, () => {
      withSessionStore(({ db, store }) => {
        const session = store.create("u1");
        const first = store.acceptPrompt(session.id, "u1", "first turn");
        expect(store.appendDelta(first.assistantMessageId, "first body")).toBe(true);
        const firstStep = store.startStep(first.assistantMessageId, {
          ordinal: 0,
          name: "first step",
          detail: "first detail",
        });
        expect(store.finishTurn(first.assistantMessageId, "done")).toBe(true);

        vi.setSystemTime(FIXED_NOW + 1);
        const second = store.acceptPrompt(session.id, "u1", "second turn");
        const beforeStaleCallbacks = persistenceSnapshot(db);
        expect(store.appendDelta(first.assistantMessageId, "late body")).toBe(false);
        expect(store.finishStep(firstStep, "failed", "late detail")).toBe(false);
        expect(store.finishTurn(first.assistantMessageId, "failed")).toBe(false);
        vi.advanceTimersByTime(2_000);
        expect(persistenceSnapshot(db)).toEqual(beforeStaleCallbacks);

        expect(store.appendDelta(second.assistantMessageId, "second body")).toBe(true);
        expect(store.finishTurn(second.assistantMessageId, "failed")).toBe(true);
        expect(messageRow(db, second.assistantMessageId)).toMatchObject({
          content: "second body",
          status: "failed",
        });
        expect(sessionRow(db, session.id)).toMatchObject({ status: "failed" });
      });
    });
  });
});
