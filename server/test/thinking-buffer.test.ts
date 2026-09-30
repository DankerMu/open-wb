/**
 * Issue #519 thinking merge buffer and bounded append, module level. `ThinkingBuffers` runs on an
 * injected manual clock with recording publish/fault ports; its append port and every
 * `appendThinking` call write a real in-memory SQLite `chat_messages.thinking` column. Thresholds
 * (2048 UTF-8 bytes, 2000 ms, 32768 code points, `…（已截断）`) are the thinking-fold spec's.
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import type { ChatEvent } from "../src/sessions/events.js";
import { TRUNCATED_MARK } from "../src/sessions/events.js";
import type { Generation, Slot } from "../src/sessions/pool.js";
import { appendThinking } from "../src/sessions/store-thinking.js";
import { ThinkingBuffers } from "../src/sessions/thinking-buffer.js";
import { totalChanges } from "./session-db-helpers.js";
import { seedMessage, seedSession, sessionId } from "./session-store-helpers.js";
import { createClock, type TestClock } from "./support/omp-runtime.js";

/** Spec literals, not imported from the implementation. */
const MARK = "…（已截断）";
const CAP = 32_768;

interface Published {
  slot: Slot;
  event: ChatEvent<number>;
  generation: Generation | undefined;
  /** The column read inside the publish port: persisted before publication. */
  column: string | null;
}

interface BufferWorld {
  db: DatabaseSync;
  messageId: number;
  clock: TestClock;
  slot: Slot;
  generation: Generation;
  buffers: ThinkingBuffers;
  appends: string[];
  published: Published[];
  faults: Array<{ slot: Slot; error: Error }>;
  column(): string | null;
}

const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
});

function openMessageDb(): { db: DatabaseSync; messageId: number } {
  const db = openDb(":memory:");
  dbs.push(db);
  const session = sessionId("a");
  seedSession(db, {
    id: session,
    ownerId: "u1",
    title: "thinking",
    status: "running",
    ompSessionFile: null,
    streamEpoch: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const messageId = seedMessage(db, {
    sessionId: session,
    role: "assistant",
    content: "",
    status: "running",
    createdAt: 1,
  });
  return { db, messageId };
}

function thinkingOf(db: DatabaseSync, messageId: number): string | null {
  const row = db.prepare("SELECT thinking FROM chat_messages WHERE id = ?").get(messageId);
  return (row as { thinking: string | null }).thinking;
}

function openBufferWorld(): BufferWorld {
  const { db, messageId } = openMessageDb();
  const clock = createClock();
  const appends: string[] = [];
  const published: Published[] = [];
  const faults: Array<{ slot: Slot; error: Error }> = [];
  const buffers = new ThinkingBuffers({
    clock,
    append(id, chunk) {
      appends.push(chunk);
      return appendThinking(db, id, chunk);
    },
    publish(slot, event, generation) {
      published.push({ slot, event, generation, column: thinkingOf(db, messageId) });
      return true;
    },
    fault(slot, error) {
      faults.push({ slot, error });
    },
  });
  return {
    db,
    messageId,
    clock,
    slot: { sessionId: "s", infraFaulted: false } as unknown as Slot,
    generation: { epoch: 1, sealed: false } as unknown as Generation,
    buffers,
    appends,
    published,
    faults,
    column: () => thinkingOf(db, messageId),
  };
}

function add(world: BufferWorld, delta: string): boolean {
  return world.buffers.add(world.slot, world.generation, world.messageId, delta);
}

function deltas(world: BufferWorld): string[] {
  return world.published.map(({ event }) => {
    if (event.type !== "thinking.delta") {
      throw new Error(`unexpected ${event.type}`);
    }
    return event.data.delta;
  });
}

function points(text: string): number {
  return [...text].length;
}

describe("M1 byte threshold", () => {
  it("publishes the whole buffer at once when the segment crossing 2048 UTF-8 bytes merges", () => {
    const world = openBufferWorld();
    const ascii = "a".repeat(1000);
    const cjk = "思".repeat(349);
    const astral = "😀";
    expect(Buffer.byteLength(ascii + cjk, "utf8")).toBe(2047);

    expect(add(world, ascii)).toBe(true);
    expect(add(world, cjk)).toBe(true);
    expect(world.published).toEqual([]);
    expect(world.appends).toEqual([]);
    expect(world.column()).toBeNull();

    // 2047 + 4 bytes crosses the threshold while the UTF-16 length is only 1351.
    expect(add(world, astral)).toBe(true);
    const merged = ascii + cjk + astral;
    expect(world.published).toEqual([
      {
        slot: world.slot,
        event: { type: "thinking.delta", data: { messageId: world.messageId, delta: merged } },
        generation: world.generation,
        column: merged,
      },
    ]);

    expect(add(world, "后")).toBe(true);
    world.clock.advance(1999);
    expect(world.published).toHaveLength(1);
    expect(world.column()).toBe(merged);
    world.clock.advance(1);
    expect(deltas(world)).toEqual([merged, "后"]);
    expect(world.column()).toBe(`${merged}后`);
    expect(world.faults).toEqual([]);
  });
});

describe("M2 clock threshold", () => {
  it("publishes 2000 ms after the first segment, later segments do not re-arm, the next buffer re-times", () => {
    const world = openBufferWorld();
    add(world, "先");
    world.clock.advance(1000);
    add(world, "想");
    world.clock.advance(999);
    expect(world.published).toEqual([]);
    world.clock.advance(1);
    expect(deltas(world)).toEqual(["先想"]);
    expect(world.published[0]?.column).toBe("先想");

    add(world, "再");
    world.clock.advance(1999);
    expect(deltas(world)).toEqual(["先想"]);
    world.clock.advance(1);
    expect(deltas(world)).toEqual(["先想", "再"]);
    expect(world.clock.pending()).toBe(0);
    expect(world.column()).toBe("先想再");
  });
});

describe("M3 explicit flush", () => {
  it("publishes a nonempty buffer once, clears its timer, and an empty flush appends nothing", () => {
    const world = openBufferWorld();
    add(world, "abc");
    expect(world.clock.pending()).toBe(1);
    expect(world.buffers.flush(world.slot)).toBe(true);
    expect(deltas(world)).toEqual(["abc"]);
    expect(world.appends).toEqual(["abc"]);
    expect(world.clock.pending()).toBe(0);

    expect(world.buffers.flush(world.slot)).toBe(true);
    world.clock.advance(5000);
    expect(world.appends).toEqual(["abc"]);
    expect(deltas(world)).toEqual(["abc"]);
    expect(world.column()).toBe("abc");
  });

  it("returns the publish port's false", () => {
    const { db, messageId } = openMessageDb();
    const buffers = new ThinkingBuffers({
      clock: createClock(),
      append: (id, chunk) => appendThinking(db, id, chunk),
      publish: () => false,
      fault() {
        throw new Error("publish refusal is not an append fault");
      },
    });
    const slot = { infraFaulted: false } as unknown as Slot;
    buffers.add(slot, undefined, messageId, "x");
    expect(buffers.flush(slot)).toBe(false);
    expect(thinkingOf(db, messageId)).toBe("x");
  });
});

describe("M4 appendThinking cap", () => {
  it("40000 code points cut at an astral character keep 32768 whole code points plus the mark", () => {
    const { db, messageId } = openMessageDb();
    const head = "思".repeat(CAP - 1);
    const tail = `${"😀".repeat(3)}${"b".repeat(40_000 - CAP - 2)}`;
    expect(points(head) + points(tail)).toBe(40_000);

    expect(appendThinking(db, messageId, head)).toBe(head);
    // A UTF-16 cut would keep a lone high surrogate here.
    expect(appendThinking(db, messageId, tail)).toBe(`😀${MARK}`);
    const column = thinkingOf(db, messageId);
    expect(column).toBe(`${head}😀${MARK}`);
    expect(points(column ?? "")).toBe(CAP + points(MARK));

    const before = totalChanges(db);
    expect(appendThinking(db, messageId, "more")).toBe("");
    expect(totalChanges(db)).toBe(before);
    expect(thinkingOf(db, messageId)).toBe(column);
  });

  it("exactly 32768 code points stay whole; the next chunk writes only the mark, then nothing", () => {
    const { db, messageId } = openMessageDb();
    const half = "想".repeat(CAP / 2);
    expect(appendThinking(db, messageId, half)).toBe(half);
    expect(appendThinking(db, messageId, half)).toBe(half);
    expect(thinkingOf(db, messageId)).toBe(half + half);
    expect(thinkingOf(db, messageId)?.endsWith(MARK)).toBe(false);

    expect(appendThinking(db, messageId, "x")).toBe(MARK);
    expect(thinkingOf(db, messageId)).toBe(`${half}${half}${MARK}`);
    const before = totalChanges(db);
    expect(appendThinking(db, messageId, "y")).toBe("");
    expect(totalChanges(db)).toBe(before);
  });

  it("an empty chunk writes nothing and a missing message row throws", () => {
    const { db, messageId } = openMessageDb();
    const before = totalChanges(db);
    expect(appendThinking(db, messageId, "")).toBe("");
    expect(totalChanges(db)).toBe(before);
    expect(thinkingOf(db, messageId)).toBeNull();
    expect(() => appendThinking(db, messageId + 1000, "x")).toThrow();
  });
});

describe("M5 append failure", () => {
  const trigger = `CREATE TEMP TRIGGER reject_thinking
    BEFORE UPDATE OF thinking ON chat_messages
    BEGIN SELECT RAISE(ABORT, 'thinking write sentinel'); END`;

  it("a byte-threshold flush that fails faults once, publishes nothing and clears buffer and timer", () => {
    const world = openBufferWorld();
    world.db.exec(trigger);
    add(world, "a");
    expect(add(world, "b".repeat(2048))).toBe(false);
    expect(world.faults).toHaveLength(1);
    expect(world.faults[0]?.slot).toBe(world.slot);
    expect(world.faults[0]?.error.message).toContain("thinking write sentinel");
    expect(world.published).toEqual([]);
    expect(world.clock.pending()).toBe(0);

    world.db.exec("DROP TRIGGER reject_thinking");
    expect(world.buffers.flush(world.slot)).toBe(true);
    world.clock.advance(5000);
    expect(world.appends).toHaveLength(1);
    expect(world.published).toEqual([]);
    expect(world.faults).toHaveLength(1);
    expect(world.column()).toBeNull();
  });

  it("a timer flush that fails faults from the callback", () => {
    const world = openBufferWorld();
    world.db.exec(trigger);
    add(world, "a");
    world.clock.advance(2000);
    expect(world.faults).toHaveLength(1);
    expect(world.published).toEqual([]);
    expect(world.clock.pending()).toBe(0);
    expect(world.buffers.flush(world.slot)).toBe(true);
    expect(world.appends).toEqual(["a"]);
  });
});

describe("M6 discard and clearTimer", () => {
  it("discard drops buffer and timer; clearTimer keeps the buffer for the next flush", () => {
    const world = openBufferWorld();
    add(world, "a");
    world.buffers.discard(world.slot);
    world.clock.advance(3000);
    expect(world.buffers.flush(world.slot)).toBe(true);
    expect(world.appends).toEqual([]);
    expect(world.published).toEqual([]);

    add(world, "b");
    world.buffers.clearTimer(world.slot);
    expect(world.clock.pending()).toBe(0);
    world.clock.advance(3000);
    expect(world.published).toEqual([]);
    expect(world.buffers.flush(world.slot)).toBe(true);
    expect(deltas(world)).toEqual(["b"]);
    expect(world.column()).toBe("b");
  });

  it("a timer that fires on an infra-faulted slot does nothing", () => {
    const world = openBufferWorld();
    add(world, "c");
    world.slot.infraFaulted = true;
    world.clock.advance(2000);
    expect(world.appends).toEqual([]);
    expect(world.published).toEqual([]);
    expect(world.faults).toEqual([]);
  });
});

describe("M7 one truncation mark", () => {
  it("events.ts exports the step mark and store-thinking imports it instead of a copy", () => {
    expect(TRUNCATED_MARK).toBe(MARK);
    const source = readFileSync(
      new URL("../src/sessions/store-thinking.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/import \{[^}]*\bTRUNCATED_MARK\b[^}]*\} from "\.\/events\.js";/u);
    expect(source).not.toContain(MARK);
  });
});
