/**
 * Issue #1150: the two invariants `SubscriberTable.subscribe` documents — a failed replay read
 * unregisters the subscriber it just registered and rethrows the same error; the subscriber is
 * registered before the replay is read, so an event published during the read reaches it.
 * The table is driven directly through its `read` seam; expected values are fixture literals.
 */
import { describe, expect, it } from "vitest";
import type { RetainedEvent, RingRead } from "../src/sessions/stream/ring-buffer.js";
import { SubscriberTable } from "../src/sessions/supervisor-subscribers.js";

const SESSION = "session-1150";
const EVENT: RetainedEvent = {
  id: "1:1",
  type: "text.delta",
  data: { messageId: 41, delta: "hello" },
};
const FRESH: RingRead = { mode: "fresh", events: [] };

/** Runs `subscribe` with a read that throws `error`; returns whatever `subscribe` threw. */
function subscribeFailing(
  table: SubscriberTable,
  deliver: (event: RetainedEvent) => void,
  error: Error,
): unknown {
  try {
    table.subscribe(SESSION, deliver, undefined, () => {
      throw error;
    });
  } catch (caught) {
    return caught;
  }
  return undefined;
}

describe("SubscriberTable.subscribe", () => {
  it("(a) rethrows the read's own error instance and leaves no subscriber behind", () => {
    const table = new SubscriberTable();
    const error = new Error("replay read failed");
    const received: RetainedEvent[] = [];
    expect(table.count(SESSION)).toBe(0);

    const caught = subscribeFailing(table, (event) => received.push(event), error);

    expect(caught).toBe(error);
    expect(table.count(SESSION)).toBe(0);
    table.fanout(SESSION, EVENT);
    expect(received).toEqual([]);
  });

  it("(a) unregisters only the failed subscriber: an earlier one stays and still gets fanout", () => {
    const table = new SubscriberTable();
    const error = new Error("replay read failed");
    const earlier: RetainedEvent[] = [];
    const failed: RetainedEvent[] = [];
    table.subscribe(
      SESSION,
      (event) => earlier.push(event),
      undefined,
      () => FRESH,
    );
    expect(table.count(SESSION)).toBe(1);

    const caught = subscribeFailing(table, (event) => failed.push(event), error);

    expect(caught).toBe(error);
    expect(table.count(SESSION)).toBe(1);
    table.fanout(SESSION, EVENT);
    expect(earlier).toEqual([EVENT]);
    expect(failed).toEqual([]);
  });

  it("(b) delivers an event published while the replay is being read, exactly once", () => {
    const table = new SubscriberTable();
    const received: RetainedEvent[] = [];

    const subscription = table.subscribe(
      SESSION,
      (event) => received.push(event),
      undefined,
      () => {
        table.fanout(SESSION, EVENT);
        return { mode: "fresh", events: [] };
      },
    );

    expect(received).toEqual([EVENT]);
    expect(received[0]).toBe(EVENT);
    expect(subscription.mode).toBe("fresh");
    expect(subscription.replay).toEqual([]);
    expect(table.count(SESSION)).toBe(1);
  });
});
