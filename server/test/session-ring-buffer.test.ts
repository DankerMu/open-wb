/**
 * Issue #91 pure epoch event ring at RingBuffer.push / RingBuffer.since.
 * Expected ids and payloads are fixture literals, not production ring logic.
 */
import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import { RingBuffer } from "../src/sessions/stream/ring-buffer.js";

const EPOCH = 7;

const FIRST: ChatEvent<number> = {
  type: "turn.start",
  data: { messageId: 41 },
};
const SECOND: ChatEvent<number> = {
  type: "text.delta",
  data: { messageId: 41, delta: "hello" },
};

describe("RingBuffer", () => {
  it("replays the suffix after the first retained id with the original payload", () => {
    const ring = new RingBuffer(EPOCH);
    const firstId = ring.push(FIRST);
    ring.push(SECOND);

    const replay = ring.since(firstId, { turnRunning: false });

    expect(firstId).toBe("7:1");
    expect(replay).toEqual({
      mode: "replay",
      events: [{ id: "7:2", type: "text.delta", data: { messageId: 41, delta: "hello" } }],
    });
  });

  it("replays from the predecessor of the oldest retained event after 1001 pushes", () => {
    const ring = new RingBuffer(1);
    let cursor1 = "";
    for (let n = 1; n <= 1001; n += 1) {
      const id = ring.push({ type: "text.delta", data: { messageId: 9, delta: `n${n}` } });
      if (n === 1) {
        cursor1 = id;
      }
    }

    const replay = ring.since("1:1", { turnRunning: false });
    const below = ring.since("1:0", { turnRunning: true });

    expect(cursor1).toBe("1:1");
    expect(replay.mode).toBe("replay");
    expect(replay.events).toHaveLength(1000);
    expect(replay.events.every((event, index) => event.id === `1:${index + 2}`)).toBe(true);
    expect(replay.events[0]).toEqual({
      id: "1:2",
      type: "text.delta",
      data: { messageId: 9, delta: "n2" },
    });
    expect(replay.events[500]).toEqual({
      id: "1:502",
      type: "text.delta",
      data: { messageId: 9, delta: "n502" },
    });
    expect(replay.events[999]).toEqual({
      id: "1:1001",
      type: "text.delta",
      data: { messageId: 9, delta: "n1001" },
    });
    expect(below).toEqual({ mode: "gap", events: [] });
  });

  it("gaps cursor 1 after the 1002nd push evicts its accepted predecessor", () => {
    const ring = new RingBuffer(1);
    for (let n = 1; n <= 1002; n += 1) {
      ring.push({ type: "text.delta", data: { messageId: 9, delta: `n${n}` } });
    }

    const result = ring.since("1:1", { turnRunning: true });
    const kept = ring.since("1:2", { turnRunning: false });

    expect(result).toEqual({ mode: "gap", events: [] });
    expect(kept.mode).toBe("replay");
    expect(kept.events).toHaveLength(1000);
    expect(kept.events.every((event, index) => event.id === `1:${index + 3}`)).toBe(true);
    expect(kept.events[0]).toEqual({
      id: "1:3",
      type: "text.delta",
      data: { messageId: 9, delta: "n3" },
    });
    expect(kept.events.at(-1)).toEqual({
      id: "1:1002",
      type: "text.delta",
      data: { messageId: 9, delta: "n1002" },
    });
  });

  it("gaps malformed and foreign-epoch cursors while a new instance still starts at sequence 1", () => {
    const ring = new RingBuffer(4);
    ring.push({ type: "turn.start", data: { messageId: 3 } });
    const next = new RingBuffer(5);

    const malformed = [
      "",
      "4:",
      ":1",
      "4:01",
      "04:1",
      "4:1 ",
      " 4:1",
      "+4:1",
      "4:-1",
      "4:1.0",
      "4:1e2",
      "4:1:2",
      "abc",
    ];
    for (const cursor of malformed) {
      expect(ring.since(cursor, { turnRunning: true })).toEqual({ mode: "gap", events: [] });
    }
    expect(ring.since("9:1", { turnRunning: true })).toEqual({ mode: "gap", events: [] });
    expect(next.push({ type: "error", data: { messageId: 3, message: "fresh" } })).toBe("5:1");
  });

  it("accepts the largest safe integer cursor and gaps the next integer", () => {
    const ring = new RingBuffer(1);
    ring.push({ type: "error", data: { messageId: 1, message: "bound" } });
    const max = "9007199254740991";

    expect(ring.since(`1:${max}`, { turnRunning: true })).toEqual({ mode: "replay", events: [] });
    expect(ring.since("1:9007199254740992", { turnRunning: true })).toEqual({
      mode: "gap",
      events: [],
    });
    expect(ring.since(`1:${max}0`, { turnRunning: true })).toEqual({ mode: "gap", events: [] });
    expect(ring.push({ type: "error", data: { messageId: 1, message: "next" } })).toBe("1:2");
  });

  it("retains step start, step end, and error payloads in push order", () => {
    const ring = new RingBuffer(11);
    ring.push({
      type: "step.start",
      data: { messageId: 4, stepId: 12, name: "read", detail: "README.md" },
    });
    ring.push({
      type: "step.end",
      data: { messageId: 4, stepId: 12, status: "failed", detail: "missing" },
    });
    ring.push({ type: "error", data: { messageId: 4, message: "stopped" } });

    expect(ring.since("11:0", { turnRunning: false })).toEqual({
      mode: "replay",
      events: [
        {
          id: "11:1",
          type: "step.start",
          data: { messageId: 4, stepId: 12, name: "read", detail: "README.md" },
        },
        {
          id: "11:2",
          type: "step.end",
          data: { messageId: 4, stepId: 12, status: "failed", detail: "missing" },
        },
        { id: "11:3", type: "error", data: { messageId: 4, message: "stopped" } },
      ],
    });
  });

  it("replays nothing for an empty-ring floor, the current tail, or a valid cursor ahead of the tail", () => {
    const ring = new RingBuffer(2);

    expect(ring.since("2:0", { turnRunning: true })).toEqual({ mode: "replay", events: [] });
    expect(ring.since("2:1", { turnRunning: true })).toEqual({ mode: "replay", events: [] });

    const first = ring.push({ type: "text.delta", data: { messageId: 8, delta: "a" } });
    const second = ring.push({ type: "text.delta", data: { messageId: 8, delta: "b" } });
    const ahead = ring.since("2:9", { turnRunning: false });
    const tail = ring.since(second, { turnRunning: true });
    const afterRead = ring.push({ type: "text.delta", data: { messageId: 8, delta: "c" } });

    expect(first).toBe("2:1");
    expect(second).toBe("2:2");
    expect(ahead).toEqual({ mode: "replay", events: [] });
    expect(tail).toEqual({ mode: "replay", events: [] });
    expect(afterRead).toBe("2:3");
    expect(ring.since(null, { turnRunning: false })).toEqual({ mode: "fresh", events: [] });
  });

  it("exposes the last assigned sequence without advancing it on reads", () => {
    const ring = new RingBuffer(3);
    expect(ring.sequence).toBe(0);
    expect(ring.push(FIRST)).toBe("3:1");
    expect(ring.sequence).toBe(1);
    expect(ring.push(SECOND)).toBe("3:2");
    expect(ring.sequence).toBe(2);
    expect(ring.since("3:1", { turnRunning: false }).events.map((event) => event.id)).toEqual([
      "3:2",
    ]);
    expect(ring.sequence).toBe(2);
    expect(ring.push({ type: "turn.end", data: { messageId: 41, status: "done" } })).toBe("3:3");
    expect(ring.sequence).toBe(3);
  });

  it("refreshes a running connection from the active turn.start through its successors", () => {
    const ring = new RingBuffer(6);
    ring.push({ type: "turn.start", data: { messageId: 1 } });
    ring.push({ type: "turn.end", data: { messageId: 1, status: "done" } });
    ring.push({ type: "turn.start", data: { messageId: 2 } });
    ring.push({ type: "text.delta", data: { messageId: 2, delta: "live" } });
    ring.push({
      type: "step.start",
      data: { messageId: 2, stepId: 11, name: "read", detail: "README.md" },
    });

    expect(ring.since(null, { turnRunning: true })).toEqual({
      mode: "replay",
      events: [
        { id: "6:3", type: "turn.start", data: { messageId: 2 } },
        { id: "6:4", type: "text.delta", data: { messageId: 2, delta: "live" } },
        {
          id: "6:5",
          type: "step.start",
          data: { messageId: 2, stepId: 11, name: "read", detail: "README.md" },
        },
      ],
    });
  });

  it("gaps a running refresh when the turn has ended, never started, or its start was evicted", () => {
    const completed = new RingBuffer(6);
    completed.push({ type: "turn.start", data: { messageId: 1 } });
    completed.push({ type: "text.delta", data: { messageId: 1, delta: "old" } });
    completed.push({ type: "turn.end", data: { messageId: 1, status: "done" } });
    expect(completed.since(null, { turnRunning: true })).toEqual({ mode: "gap", events: [] });

    const unstarted = new RingBuffer(6);
    unstarted.push({ type: "text.delta", data: { messageId: 4, delta: "orphan" } });
    expect(unstarted.since(null, { turnRunning: true })).toEqual({ mode: "gap", events: [] });

    const evicted = new RingBuffer(6);
    evicted.push({ type: "turn.start", data: { messageId: 5 } });
    for (let n = 0; n < 1000; n += 1) {
      evicted.push({ type: "text.delta", data: { messageId: 5, delta: `e${n}` } });
    }
    expect(evicted.since(null, { turnRunning: true })).toEqual({ mode: "gap", events: [] });
  });

  it("lets a present cursor win over an active-turn refresh", () => {
    const ring = new RingBuffer(6);
    ring.push({ type: "turn.start", data: { messageId: 2 } });
    ring.push({ type: "text.delta", data: { messageId: 2, delta: "first" } });
    const cursor = ring.push({ type: "text.delta", data: { messageId: 2, delta: "second" } });
    ring.push({ type: "text.delta", data: { messageId: 2, delta: "third" } });

    expect(ring.since(cursor, { turnRunning: true })).toEqual({
      mode: "replay",
      events: [{ id: "6:4", type: "text.delta", data: { messageId: 2, delta: "third" } }],
    });
  });

  it("does not refresh a newly accepted turn from the previous completed start", () => {
    const ring = new RingBuffer(6);
    ring.push({ type: "turn.start", data: { messageId: 1 } });
    ring.push({ type: "text.delta", data: { messageId: 1, delta: "old" } });
    ring.push({ type: "turn.end", data: { messageId: 1, status: "failed" } });

    expect(ring.since(null, { turnRunning: true })).toEqual({ mode: "gap", events: [] });

    ring.push({ type: "turn.start", data: { messageId: 2 } });
    expect(ring.since(null, { turnRunning: true })).toEqual({
      mode: "replay",
      events: [{ id: "6:4", type: "turn.start", data: { messageId: 2 } }],
    });
  });

  it("keeps instances and repeated reads independent", () => {
    const left = new RingBuffer(8);
    const right = new RingBuffer(8);
    left.push({ type: "turn.start", data: { messageId: 1 } });
    right.push({ type: "text.delta", data: { messageId: 2, delta: "only-right" } });
    const first = left.since("8:0", { turnRunning: false });
    const second = left.since("8:0", { turnRunning: false });

    expect(first).toEqual({
      mode: "replay",
      events: [{ id: "8:1", type: "turn.start", data: { messageId: 1 } }],
    });
    expect(second).toEqual(first);
    expect(right.since(null, { turnRunning: false })).toEqual({ mode: "fresh", events: [] });
    expect(right.since("8:0", { turnRunning: true })).toEqual({
      mode: "replay",
      events: [{ id: "8:1", type: "text.delta", data: { messageId: 2, delta: "only-right" } }],
    });
    expect(left.since(null, { turnRunning: true })).toEqual(first);
  });

  it("keeps later replay stable after the caller mutates an input or a returned array", () => {
    const ring = new RingBuffer(3);
    const input: ChatEvent<number> = { type: "text.delta", data: { messageId: 15, delta: "kept" } };
    const id = ring.push(input);
    input.data.delta = "changed-input";
    input.data.messageId = 99;

    const returned = ring.since("3:0", { turnRunning: false });
    const owned = returned.events[0];
    if (owned === undefined || owned.type !== "text.delta") {
      throw new Error("expected the retained text delta");
    }
    const edited = { ...owned, data: { ...owned.data, delta: "changed-result" } };
    returned.events[0] = edited;
    returned.events.pop();

    expect(id).toBe("3:1");
    expect(input).toEqual({ type: "text.delta", data: { messageId: 99, delta: "changed-input" } });
    expect(ring.since("3:0", { turnRunning: false })).toEqual({
      mode: "replay",
      events: [{ id: "3:1", type: "text.delta", data: { messageId: 15, delta: "kept" } }],
    });
  });
});
