/**
 * The pure seam of chat-interleaved-segments slices 3b and 5 (issue 1472, issue 1474): moved
 * verbatim out of delta-coalescer-segments.test.ts so the slice-5 payload tests share it. A
 * `DeltaCoalescer` and its thinking spans on an injected clock, wired as `SessionSupervisor` wires
 * them over a real `SessionStore` (in-memory SQLite, a real turn from `acceptPrompt`); raw omp
 * frames go through the pump's three steps and a passed event is persisted by the real
 * `persistEvent`, then recorded as published.
 */
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
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

export const OWNER = "u1";

export interface World {
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

/** For the test file's `afterEach`: closes every world opened since the last call. */
export function closeWorlds(): void {
  for (const close of closers.splice(0).reverse()) {
    close();
  }
}

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
export function feed(world: World, t: number, frame: OmpFrame): boolean {
  world.clock.advance(t - world.clock.now());
  if (!world.coalescer.endSpan(world.slot, endsThinking(frame))) {
    return false;
  }
  const applied = applyFrame(world.mapper, frame);
  world.mapper = applied.state;
  return commit(world, applied.events);
}

export function update(event: Record<string, unknown>): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { contentIndex: 0, ...event },
    message: { role: "assistant", content: [] },
  };
}

export const thinking = (delta: string) => update({ type: "thinking_delta", delta });
export const text = (delta: string) => update({ type: "text_delta", delta });
export const TOOL_START: OmpFrame = {
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "ls" },
};

export function started(): World {
  const world = openWorld();
  expect(feed(world, 0, { type: "agent_start" })).toBe(true);
  return world;
}

/** [type, delta or ""] of every publication after turn.start, and when it was published. */
export function trace(world: World): Array<[string, string, number]> {
  return world.published.slice(1).map(({ at, event }) => {
    const delta =
      event.type === "text.delta" || event.type === "thinking.delta" ? event.data.delta : "";
    return [event.type, delta, at];
  });
}

export function segments(world: World) {
  return world.db
    .prepare(
      "SELECT body_offset, thinking_offset, thinking_length, steps_before, thinking_ms FROM chat_thinking_segments WHERE message_id = ? ORDER BY id",
    )
    .all(world.messageId);
}
