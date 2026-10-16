/**
 * Issue 1472 (chat-interleaved-segments 3b, design D3/D4) at the pure seam: `DeltaCoalescer` and its
 * thinking spans on an injected clock, wired as `SessionSupervisor` wires them over a real
 * `SessionStore` (in-memory SQLite, a real turn from `acceptPrompt`): thinking saved by
 * `appendThinking`, text by `appendDelta` (which counts the published body length), spans written
 * through the store. Raw omp frames go through the pump's three steps (`endSpan` on a raw
 * `thinking_end`, the pure reducer, `route`); an event `route` passes on is persisted by the real
 * `persistEvent` (`step.start` inserts the step row) and then recorded as published, as `#commit`
 * does. An approval publication outside the pump is `flush` then push, as `#publish` does.
 * Oracles: the recorded ring order and the raw `chat_thinking_segments` / `chat_steps` rows; the
 * expected values are the chat-stream「分段位置的记录与下发」literals.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { PumpSteps } from "../src/sessions/approval-pairing.js";
import { DeltaCoalescer } from "../src/sessions/delta-coalescer.js";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { Generation, Slot } from "../src/sessions/pool.js";
import { createSessionStore, type SessionStore } from "../src/sessions/store.js";
import { endsThinking } from "../src/sessions/thinking-span.js";
import { persistEvent } from "../src/sessions/turn-control.js";
import { TEST_COMPOSER } from "./session-meta-fixtures.js";
import { createClock, type TestClock } from "./support/omp-runtime.js";

const OWNER = "u1";

interface World {
  db: DatabaseSync;
  store: SessionStore;
  session: string;
  messageId: number;
  clock: TestClock;
  slot: Slot;
  generation: Generation;
  coalescer: DeltaCoalescer;
  mapper: ReturnType<typeof createEventState>;
  steps: PumpSteps;
  published: Array<{ at: number; event: ChatEvent<number> }>;
  faults: Error[];
}

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    close();
  }
});

function openWorld(): World {
  const db = openDb(":memory:");
  const store = createSessionStore(db, { onFlushError() {}, composer: TEST_COMPOSER });
  closers.push(() => db.close());
  closers.push(() => store.close());
  const session = store.create(OWNER).id;
  const { assistantMessageId: messageId } = store.acceptPrompt(session, OWNER, "问");
  const clock = createClock();
  const published: World["published"] = [];
  const faults: Error[] = [];
  const coalescer: DeltaCoalescer = new DeltaCoalescer({
    clock,
    save: {
      thinking: (id, chunk) => store.appendThinking(id, chunk),
      text: (id, chunk) => {
        store.appendDelta(id, chunk);
        return chunk;
      },
    },
    durations: store,
    publish: (_slot, event) => {
      published.push({ at: clock.now(), event });
      return true;
    },
    fault(slot, error) {
      faults.push(error);
      slot.infraFaulted = true;
      coalescer.discard(slot);
    },
  });
  return {
    db,
    store,
    session,
    messageId,
    clock,
    slot: { sessionId: session, infraFaulted: false } as unknown as Slot,
    generation: { epoch: 1, sealed: false } as unknown as Generation,
    coalescer,
    mapper: createEventState({ messageId, promptRequestId: "p1" }),
    steps: new PumpSteps(messageId),
    published,
    faults,
  };
}

/** `#commit`: route, then persist a passed event (`persistEvent`) and record it as published. */
function commit(world: World, events: ChatEvent<string>[]): boolean {
  for (const event of events) {
    const routed = world.coalescer.route(world.slot, world.generation, event);
    if (routed === false) {
      return false;
    }
    if (routed === "pass") {
      const persisted = persistEvent(
        world.store,
        world.messageId,
        event,
        world.steps,
        [],
        null,
        (text) => text,
      );
      if (persisted !== undefined) {
        world.published.push({ at: world.clock.now(), event: persisted });
      }
    }
  }
  return true;
}

/** The pump's read of one raw frame at time `t`. */
function feed(world: World, t: number, frame: OmpFrame): boolean {
  world.clock.advance(t - world.clock.now());
  if (!world.coalescer.endSpan(world.slot, endsThinking(frame))) {
    return false;
  }
  const applied = applyFrame(world.mapper, frame);
  world.mapper = applied.state;
  return commit(world, applied.events);
}

function update(event: Record<string, unknown>): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { contentIndex: 0, ...event },
    message: { role: "assistant", content: [] },
  };
}

const thinking = (delta: string) => update({ type: "thinking_delta", delta });
const text = (delta: string) => update({ type: "text_delta", delta });
const TOOL_START: OmpFrame = {
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "ls" },
};

function started(): World {
  const world = openWorld();
  expect(feed(world, 0, { type: "agent_start" })).toBe(true);
  return world;
}

/** [type, delta or ""] of every publication after turn.start, and when it was published. */
function trace(world: World): Array<[string, string, number]> {
  return world.published.slice(1).map(({ at, event }) => {
    const delta =
      event.type === "text.delta" || event.type === "thinking.delta" ? event.data.delta : "";
    return [event.type, delta, at];
  });
}

function segments(world: World) {
  return world.db
    .prepare(
      "SELECT body_offset, thinking_offset, thinking_length, steps_before, thinking_ms FROM chat_thinking_segments WHERE message_id = ? ORDER BY id",
    )
    .all(world.messageId);
}

function stepOffsets(world: World): unknown[] {
  return world.db
    .prepare("SELECT body_offset FROM chat_steps WHERE message_id = ? ORDER BY ordinal")
    .all(world.messageId)
    .map((row) => (row as { body_offset: unknown }).body_offset);
}

function content(world: World): string | undefined {
  return world.store
    .getMessages(world.session, OWNER)
    ?.messages.find((message) => message.id === world.messageId)?.content;
}

describe("chat-stream「分段位置的记录与下发」边界前冲刷", () => {
  it("合并器缓冲着正文时开段: 看 at 0, 一下 held at 100, 想 at 120 → body_offset 3", () => {
    const world = started();
    feed(world, 0, text("看"));
    feed(world, 100, text("一下"));
    expect(trace(world)).toEqual([["text.delta", "看", 0]]);
    feed(world, 120, thinking("想"));

    expect(trace(world)).toEqual([
      ["text.delta", "看", 0],
      ["text.delta", "一下", 120],
      ["thinking.delta", "想", 120],
    ]);
    expect(segments(world)).toEqual([
      {
        body_offset: 3,
        thinking_offset: 0,
        thinking_length: null,
        steps_before: 0,
        thinking_ms: null,
      },
    ]);
    expect(content(world)).toBe("看一下");
    expect(world.faults).toEqual([]);
  });

  it("the same when the opening thinking delta is itself held: c flushed at 200, offset 2", () => {
    const world = started();
    feed(world, 0, thinking("a"));
    feed(world, 100, text("b"));
    feed(world, 150, text("c"));
    feed(world, 200, thinking("d"));

    // `d` falls inside the thinking window opened by `a` at 0: held, not yet published.
    expect(trace(world)).toEqual([
      ["thinking.delta", "a", 0],
      ["thinking.end", "", 100],
      ["text.delta", "b", 100],
      ["text.delta", "c", 200],
    ]);
    expect(world.clock.pending()).toBe(1);
    expect(segments(world)).toEqual([
      { body_offset: 0, thinking_offset: 0, thinking_length: 1, steps_before: 0, thinking_ms: 100 },
      {
        body_offset: 2,
        thinking_offset: 1,
        thinking_length: null,
        steps_before: 0,
        thinking_ms: null,
      },
    ]);
  });

  it("thinking deltas before a step do not move its body_offset: text only is counted", () => {
    const world = started();
    feed(world, 0, text("ab"));
    feed(world, 10, thinking("想想想"));
    feed(world, 20, thinking("再想"));
    feed(world, 30, TOOL_START);

    expect(trace(world).map(([type, delta]) => [type, delta])).toEqual([
      ["text.delta", "ab"],
      ["thinking.delta", "想想想"],
      ["thinking.delta", "再想"],
      ["thinking.end", ""],
      ["step.start", ""],
    ]);
    expect(stepOffsets(world)).toEqual([2]);
    expect(segments(world)).toEqual([
      { body_offset: 2, thinking_offset: 0, thinking_length: 5, steps_before: 0, thinking_ms: 20 },
    ]);
  });

  it("a text delta held inside the window before a tool start is counted in the step's offset", () => {
    const world = started();
    feed(world, 0, text("看"));
    feed(world, 100, text("一下"));
    feed(world, 100, TOOL_START);
    expect(trace(world)).toEqual([
      ["text.delta", "看", 0],
      ["text.delta", "一下", 100],
      ["step.start", "", 100],
    ]);
    expect(stepOffsets(world)).toEqual([3]);
  });
});

describe("chat-stream「分段位置的记录与下发」闭段时长度含缓冲的思考", () => {
  it("先 at 0, 想想 held at 100, text 好 at 150: thinking.end before 好, thinking_length 3", () => {
    const world = started();
    feed(world, 0, thinking("先"));
    feed(world, 100, thinking("想想"));
    feed(world, 150, text("好"));

    expect(trace(world)).toEqual([
      ["thinking.delta", "先", 0],
      ["thinking.delta", "想想", 150],
      ["thinking.end", "", 150],
      ["text.delta", "好", 150],
    ]);
    expect(segments(world)).toEqual([
      { body_offset: 0, thinking_offset: 0, thinking_length: 3, steps_before: 0, thinking_ms: 150 },
    ]);
  });

  it("the same with an approval.request at 150: flushed and closed before it is pushed", () => {
    const world = started();
    feed(world, 0, thinking("先"));
    feed(world, 100, thinking("想想"));
    world.clock.advance(50);
    // `#publish`: flush first, then the ring push, in one synchronous segment.
    expect(world.coalescer.flush(world.slot)).toBe(true);
    world.published.push({
      at: world.clock.now(),
      event: {
        type: "approval.request",
        data: {
          messageId: world.messageId,
          approvalId: 1,
          tool: "bash",
          title: "Allow tool: bash",
          expiresAt: 60_150,
        },
      },
    });

    expect(trace(world).map(([type, delta]) => [type, delta])).toEqual([
      ["thinking.delta", "先"],
      ["thinking.delta", "想想"],
      ["thinking.end", ""],
      ["approval.request", ""],
    ]);
    expect(segments(world)).toEqual([
      { body_offset: 0, thinking_offset: 0, thinking_length: 3, steps_before: 0, thinking_ms: 150 },
    ]);
  });
});
