import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePumpExit } from "../src/sessions/supervisor.js";
import { postPrompt } from "./session-rest-helpers.js";
import { messageRows } from "./session-store-helpers.js";
import {
  closeOnEof,
  createControlledRuntime,
  emitAssistantDelta,
  OWNER_ID,
  openBareSession,
  type SupervisorApp,
  waitFor,
} from "./session-supervisor-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

interface TestSlot {
  claimedAssistantId: number | undefined;
  pump: Promise<void> | undefined;
}

const TURN_A = 11;
const TURN_B = 12;
const PUMP_A = Promise.resolve();
const PUMP_B = Promise.resolve();

function exitPumpA(slot: TestSlot, claimed: readonly number[]): [number, TestSlot][] {
  const claims = new Map<number, TestSlot>(claimed.map((id) => [id, slot]));
  releasePumpExit(claims, slot, PUMP_A, TURN_A);
  return [...claims];
}

describe("SessionSupervisor pump-exit claim release", () => {
  it("releases the old turn's claim after a newer pump took the slot and keeps the newer turn", () => {
    const slot: TestSlot = { claimedAssistantId: TURN_B, pump: PUMP_B };

    expect(exitPumpA(slot, [TURN_A, TURN_B])).toEqual([[TURN_B, slot]]);
    expect(slot.claimedAssistantId).toBe(TURN_B);
    expect(slot.pump).toBe(PUMP_B);
  });

  it("clears its own pump registration and claim when it still owns the slot", () => {
    const slot: TestSlot = { claimedAssistantId: TURN_A, pump: PUMP_A };

    expect(exitPumpA(slot, [TURN_A])).toEqual([]);
    expect(slot.claimedAssistantId).toBeUndefined();
    expect(slot.pump).toBeUndefined();
  });

  it("never releases a newer turn claimed before its pump registered", () => {
    const slot: TestSlot = { claimedAssistantId: TURN_B, pump: PUMP_A };

    expect(exitPumpA(slot, [TURN_A, TURN_B])).toEqual([[TURN_B, slot]]);
    expect(slot.claimedAssistantId).toBe(TURN_B);
    expect(slot.pump).toBeUndefined();
  });
});

describe("SessionSupervisor same-slot sink re-entry", () => {
  it("admits and completes a turn dispatched from the previous turn.end sink, then a later prompt", {
    timeout: 15_000,
  }, async () => {
    let turns = 0;
    const runtime = createControlledRuntime((child) => {
      closeOnEof(child);
      child.onCommand("prompt", () => {
        turns += 1;
        child.emitLine({ type: "agent_start" });
        emitAssistantDelta(child, `turn ${turns}`);
        child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
      });
    });
    let fixture: SupervisorApp | undefined;
    let reentry: Promise<void> | undefined;
    let reentryError: unknown;
    const ends: number[] = [];
    const errors: Error[] = [];
    const opened = await openBareSession(runtime.runtime, {
      onError(error) {
        errors.push(error);
      },
      onEvent(sessionId, epoch, event) {
        if (event.type !== "turn.end") {
          return;
        }
        ends.push(epoch);
        const app = fixture;
        if (app === undefined) {
          throw new Error("missing supervisor fixture");
        }
        if (reentry === undefined) {
          app.store.acceptPrompt(sessionId, OWNER_ID, "sink re-entry");
          reentry = app.supervisor.prompt(sessionId, "sink re-entry");
          void reentry.catch((error: unknown) => {
            reentryError = error;
          });
        }
      },
    });
    fixture = opened.fixture;
    const { session, cookie } = opened;
    try {
      const first = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "first" }),
      );
      expect(first.statusCode).toBe(202);
      await waitFor(() => reentry, "sink re-entry admission");
      await reentry;
      expect(reentryError).toBeUndefined();
      await waitFor(() => (ends.length === 2 ? true : undefined), "re-entered turn.end");

      const third = await postPrompt(
        fixture.app,
        session,
        cookie,
        JSON.stringify({ message: "third" }),
      );
      expect(third.statusCode).toBe(202);
      await waitFor(() => (ends.length === 3 ? true : undefined), "third turn.end");

      expect(runtime.calls).toHaveLength(1);
      expect(ends).toEqual([1, 1, 1]);
      expect(
        messageRows(fixture.db)
          .filter((row) => row.session_id === session && row.role === "assistant")
          .map((row) => ({ content: row.content, status: row.status })),
      ).toEqual([
        { content: "turn 1", status: "done" },
        { content: "turn 2", status: "done" },
        { content: "turn 3", status: "done" },
      ]);
      expect(fixture.store.runtimeState(session)?.activeTurn).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await reentry?.catch(() => {});
      await fixture.close();
    }
    expect(errors).toEqual([]);
  });
});
