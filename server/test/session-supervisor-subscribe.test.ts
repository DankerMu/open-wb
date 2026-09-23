/**
 * Issue #103 Supervisor subscribe/replay seam over the generation-owned ring.
 * Expected IDs and payloads are recorded ring IDs, not a second sequence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetainedEvent } from "../src/sessions/stream/ring-buffer.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  closeFixture,
  completeHeldTurn,
  emitAssistantDelta,
  IDLE_MS,
  openHeldPromptSession,
  openStartHeldSession,
  startHeldTurn,
  waitFor,
  waitForContent,
  waitForTurn,
} from "./session-supervisor-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionSupervisor subscribe replay", () => {
  it("replays retained successors then delivers later live events once", {
    timeout: 15_000,
  }, async () => {
    const { fixture, session, child } = await openHeldPromptSession();
    try {
      expect(fixture.supervisor.streamCursor(session)).toEqual({ epoch: 1, seq: 2 });

      const live: RetainedEvent[] = [];
      const first = fixture.supervisor.subscribe(session, "1:1", (event) => {
        live.push(event);
      });
      expect(first.mode).toBe("replay");
      expect(first.replay.map(idOf)).toEqual(["1:2"]);
      expect(first.replay[0]).toMatchObject({
        type: "text.delta",
        data: { delta: "Hello" },
      });
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);

      emitAssistantDelta(child, "!");
      await waitForContent(fixture, session, "Hello!");
      expect(live.map(idOf)).toEqual(["1:3"]);
      expect(live[0]).toMatchObject({ type: "text.delta", data: { delta: "!" } });

      completeHeldTurn(child);
      await waitForTurn(fixture, session, "done");
      expect(live.map(idOf)).toEqual(["1:3", "1:4"]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("gaps empty, malformed, old-epoch, and no-runtime cursors without fabricating history", {
    timeout: 15_000,
  }, async () => {
    const opened = await openStartHeldSession();
    const { fixture, session } = opened;
    try {
      const idle = fixture.supervisor.subscribe(session, null, () => {
        throw new Error("idle subscriber must not receive live events");
      });
      expect(idle.mode).toBe("fresh");
      expect(idle.replay).toEqual([]);
      idle.unsubscribe();

      const missingCursor = fixture.supervisor.subscribe(session, "1:0", () => {});
      expect(missingCursor).toMatchObject({ mode: "gap", replay: [] });
      missingCursor.unsubscribe();

      await startHeldTurn(opened);

      for (const cursor of ["", "not-an-id", "2:1"]) {
        const subscription = fixture.supervisor.subscribe(session, cursor, () => {});
        expect(subscription, cursor).toMatchObject({ mode: "gap", replay: [] });
        subscription.unsubscribe();
      }

      const floor = fixture.supervisor.subscribe(session, "1:0", () => {});
      expect(floor.mode).toBe("replay");
      expect(floor.replay.map(idOf)).toEqual(["1:1", "1:2"]);
      floor.unsubscribe();

      const runningRefresh = fixture.supervisor.subscribe(session, null, () => {});
      expect(runningRefresh.mode).toBe("replay");
      expect(runningRefresh.replay.map(idOf)).toEqual(["1:1", "1:2"]);
      expect(runningRefresh.replay[0]?.type).toBe("turn.start");
      runningRefresh.unsubscribe();
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps two subscribers identical until one unsubscribes, then follows a new generation epoch", {
    timeout: 15_000,
  }, async () => {
    const opened = await openStartHeldSession();
    const { runtime, fixture, cookie, session } = opened;
    try {
      const firstLive: string[] = [];
      const secondLive: string[] = [];
      const first = fixture.supervisor.subscribe(session, null, (event) => {
        firstLive.push(event.id);
      });
      const second = fixture.supervisor.subscribe(session, null, (event) => {
        secondLive.push(event.id);
      });
      expect(first.mode).toBe("fresh");
      expect(second.mode).toBe("fresh");
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(2);

      const firstChild = await startHeldTurn(opened, "first");
      expect(firstLive).toEqual(["1:1", "1:2"]);
      expect(secondLive).toEqual(["1:1", "1:2"]);

      second.unsubscribe();
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);
      completeHeldTurn(firstChild);
      await waitForTurn(fixture, session, "done");
      expect(firstLive).toEqual(["1:1", "1:2", "1:3"]);
      expect(secondLive).toEqual(["1:1", "1:2"]);

      runtime.clock.advance(IDLE_MS);
      await waitFor(
        () => (fixture.supervisor.streamCursor(session).seq === null ? true : undefined),
        "idle generation seal",
      );

      await postPrompt(fixture.app, session, cookie, JSON.stringify({ message: "second" }));
      await waitForTurn(fixture, session, "done");
      expect(firstLive.slice(-3)).toEqual(["2:1", "2:2", "2:3"]);
      expect(firstLive).not.toContain("1:4");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("does not register a live listener after shutdown", {
    timeout: 15_000,
  }, async () => {
    const opened = await openStartHeldSession();
    const { fixture, session } = opened;
    try {
      await fixture.app.close();
      const live: string[] = [];
      const subscription = fixture.supervisor.subscribe(session, null, (event) => {
        live.push(event.id);
      });
      expect(subscription.mode).toBe("fresh");
      expect(subscription.replay).toEqual([]);
      expect(fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(0);
      expect(live).toEqual([]);
    } finally {
      fixture.db.close();
    }
  });
});

function idOf(event: RetainedEvent): string {
  return event.id;
}
