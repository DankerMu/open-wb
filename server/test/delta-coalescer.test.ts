/**
 * Issue #910 delta coalescer, module level (chat-stream「正文与思考增量的时间窗合并」, thinking-fold
 * 「thinking.delta 合并发布与持久化」). `DeltaCoalescer` runs on an injected manual clock with
 * recording ports: the thinking save port is the real bounded `appendThinking` on an in-memory
 * SQLite `chat_messages.thinking` column, the text save port a recording stand-in for the store's
 * text buffer. Only what the coalescer layer sees is asserted: the cut, the order and the stored
 * prefix at each publication; `thinking.end` and snapshots belong to the supervisor-level files.
 * The M1–M7 cases migrated from the deleted thinking-buffer.test.ts keep their labels.
 * Thresholds (250 ms, 32768 code points, `…（已截断）`) are the specs' literals.
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { TRUNCATED_MARK } from "../src/core/upstream-failure.js";
import { DeltaCoalescer, type DeltaKind } from "../src/sessions/delta-coalescer.js";
import type { ChatEvent } from "../src/sessions/events.js";
import type { Generation, Slot } from "../src/sessions/pool.js";
import { appendThinking } from "../src/sessions/store-thinking.js";
import { totalChanges } from "./session-db-helpers.js";
import { seedMessage, seedSession, sessionId } from "./session-store-helpers.js";
import { createClock, type TestClock } from "./support/omp-runtime.js";

/** Spec literals, not imported from the implementation. */
const MARK = "…（已截断）";
const CAP = 32_768;
const WINDOW = 250;

interface Published {
  at: number;
  event: ChatEvent<number>;
  generation: Generation | undefined;
  /** The thinking column and the text store read inside the publish port. */
  column: string | null;
  texts: string[];
}

interface World {
  db: DatabaseSync;
  messageId: number;
  clock: TestClock;
  slot: Slot;
  generation: Generation;
  coalescer: DeltaCoalescer;
  /** Every chunk handed to a save port, in call order. */
  saves: Array<[DeltaKind, string]>;
  /** The text save port's store: what the supervisor's appendDelta would have received. */
  texts: string[];
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
    title: "deltas",
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

/** `kinds` limits the save ports: the supervisor of slice 2a passes only `thinking`. */
function openWorld(kinds: DeltaKind[] = ["thinking", "text"], refuse = false): World {
  const { db, messageId } = openMessageDb();
  const clock = createClock();
  const saves: Array<[DeltaKind, string]> = [];
  const texts: string[] = [];
  const published: Published[] = [];
  const faults: Array<{ slot: Slot; error: Error }> = [];
  const ports = {
    thinking(id: number, chunk: string) {
      saves.push(["thinking", chunk]);
      return appendThinking(db, id, chunk);
    },
    text(_id: number, chunk: string) {
      saves.push(["text", chunk]);
      texts.push(chunk);
      return chunk;
    },
  };
  const coalescer = new DeltaCoalescer({
    clock,
    save: Object.fromEntries(kinds.map((kind) => [kind, ports[kind]])),
    publish(_slot, event, generation) {
      const column = thinkingOf(db, messageId);
      published.push({ at: clock.now(), event, generation, column, texts: [...texts] });
      return !refuse;
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
    coalescer,
    saves,
    texts,
    published,
    faults,
    column: () => thinkingOf(db, messageId),
  };
}

function send(world: World, kind: DeltaKind, delta: string, messageId = world.messageId) {
  const type = kind === "thinking" ? "thinking.delta" : "text.delta";
  return world.coalescer.route(world.slot, world.generation, {
    type,
    data: { messageId, delta },
  } as ChatEvent<string>);
}

/** A non-delta event of the turn; the caller publishes it when `route` answers `pass`. */
function other(world: World, event: ChatEvent<string>) {
  return world.coalescer.route(world.slot, world.generation, event);
}

function stepStart(world: World): ChatEvent<string> {
  return {
    type: "step.start",
    data: { messageId: world.messageId, stepId: "t1", name: "bash", detail: "" },
  };
}

function turnEnd(world: World): ChatEvent<string> {
  return { type: "turn.end", data: { messageId: world.messageId, status: "done" } };
}

/** [type, delta] of every publication, in order. */
function cuts(world: World): Array<[string, string]> {
  return world.published.map(({ event }) => {
    if (event.type !== "thinking.delta" && event.type !== "text.delta") {
      throw new Error(`unexpected ${event.type}`);
    }
    return [event.type, event.data.delta];
  });
}

function deltas(world: World): string[] {
  return cuts(world).map(([, delta]) => delta);
}

function points(text: string): number {
  return [...text].length;
}

/** Advances the clock to `t` (timers due on the way fire at their due time). */
function at(world: World, t: number): void {
  world.clock.advance(t - world.clock.now());
}

describe("chat-stream 首段立即、之后按时间窗", () => {
  it("100 text segments 10 ms apart publish at 0, 250, 500, 750 and the terminal flush", () => {
    const world = openWorld();
    const segments = Array.from({ length: 100 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    for (const [index, segment] of segments.entries()) {
      at(world, index * 10);
      expect(send(world, "text", segment)).toBe("taken");
    }
    at(world, 1000);
    expect(other(world, turnEnd(world))).toBe("pass");

    expect(world.published.map(({ at: time }) => time)).toEqual([0, 250, 500, 750, 1000]);
    expect(deltas(world)[0]).toBe(segments[0]);
    expect(deltas(world).join("")).toBe(segments.join(""));
    expect(cuts(world).every(([type]) => type === "text.delta")).toBe(true);
    // Saved before publication: the text store holds each chunk when the chunk is published.
    for (const [index, entry] of world.published.entries()) {
      expect(entry.texts).toEqual(deltas(world).slice(0, index + 1));
    }
    expect(world.clock.pending()).toBe(0);
  });
});

describe("thinking-fold 字节阈值与时钟阈值", () => {
  it("segments at 0, 90…450 ms publish three thinking.delta at 0, 250 and 500 ms", () => {
    const world = openWorld();
    for (const [t, segment] of [
      [0, "零"],
      [90, "九十"],
      [180, "一八"],
      [270, "二七"],
      [360, "三六"],
      [450, "四五"],
    ] as const) {
      at(world, t);
      expect(send(world, "thinking", segment)).toBe("taken");
    }
    at(world, 600);
    expect(other(world, turnEnd(world))).toBe("pass");

    // The t=270 segment waits for 250 + 250 = 500 ms, not for 270 + 250.
    expect(world.published.map(({ at: time }) => time)).toEqual([0, 250, 500]);
    expect(deltas(world)).toEqual(["零", "九十一八", "二七三六四五"]);
    expect(world.published.map(({ column }) => column)).toEqual([
      "零",
      "零九十一八",
      "零九十一八二七三六四五",
    ]);
    expect(world.column()).toBe(deltas(world).join(""));
  });

  it("a segment arriving 250 ms or more after the last publication with nothing held is immediate", () => {
    const world = openWorld();
    send(world, "thinking", "a");
    at(world, 250);
    expect(send(world, "thinking", "b")).toBe("taken");
    expect(deltas(world)).toEqual(["a", "b"]);
    expect(world.clock.pending()).toBe(0);
    at(world, 400);
    send(world, "thinking", "c");
    expect(deltas(world)).toEqual(["a", "b"]);
    at(world, 499);
    expect(deltas(world)).toEqual(["a", "b"]);
    at(world, 500);
    expect(deltas(world)).toEqual(["a", "b", "c"]);
  });

  it("M1 不设字节阈值: 6000 UTF-8 bytes within 100 ms after the first publish as one at 250 ms", () => {
    const world = openWorld();
    send(world, "thinking", "首");
    const ascii = "a".repeat(1000);
    const cjk = "思".repeat(349);
    const astral = "😀";
    // Old M1: these three crossed the 2048-byte threshold together (2047 + 4 bytes).
    expect(Buffer.byteLength(ascii + cjk, "utf8")).toBe(2047);
    const rest = "b".repeat(6000 - Buffer.byteLength(ascii + cjk + astral, "utf8"));
    for (const [t, segment] of [
      [10, ascii],
      [20, cjk],
      [30, astral],
      [100, rest],
    ] as const) {
      at(world, t);
      send(world, "thinking", segment);
    }
    expect(Buffer.byteLength(ascii + cjk + astral + rest, "utf8")).toBe(6000);
    expect(deltas(world)).toEqual(["首"]);
    expect(world.saves).toEqual([["thinking", "首"]]);
    at(world, 249);
    expect(deltas(world)).toEqual(["首"]);
    at(world, 250);
    const merged = ascii + cjk + astral + rest;
    expect(deltas(world)).toEqual(["首", merged]);
    expect(world.published[1]?.column).toBe(`首${merged}`);
    expect(world.faults).toEqual([]);
  });

  it("M2 time window: later segments do not re-arm and the next buffer is timed from the last publication", () => {
    const world = openWorld();
    send(world, "thinking", "先");
    at(world, 100);
    send(world, "thinking", "想");
    expect(world.clock.pending()).toBe(1);
    at(world, 200);
    send(world, "thinking", "再");
    expect(world.clock.pending()).toBe(1);
    at(world, 249);
    expect(deltas(world)).toEqual(["先"]);
    at(world, 250);
    expect(deltas(world)).toEqual(["先", "想再"]);
    expect(world.published[1]?.column).toBe("先想再");

    at(world, 300);
    send(world, "thinking", "后");
    at(world, 499);
    expect(deltas(world)).toEqual(["先", "想再"]);
    at(world, 500);
    expect(deltas(world)).toEqual(["先", "想再", "后"]);
    expect(world.clock.pending()).toBe(0);
    expect(world.column()).toBe("先想再后");
  });

  it("a new turn (another assistant message) publishes its first segment at once", () => {
    const world = openWorld();
    const next = world.messageId + 1; // The text port never touches the message row.
    send(world, "text", "旧");
    expect(send(world, "text", "回", next)).toBe("taken");
    expect(world.published.map(({ event }) => event.data.messageId)).toEqual([
      world.messageId,
      next,
    ]);
    expect(world.clock.pending()).toBe(0);
  });
});

describe("chat-stream 两类交错保持次序", () => {
  it("thinking a b, text c d, thinking e at one instant keep their arrival order", () => {
    const world = openWorld();
    for (const [kind, delta] of [
      ["thinking", "a"],
      ["thinking", "b"],
      ["text", "c"],
      ["text", "d"],
      ["thinking", "e"],
    ] as const) {
      expect(send(world, kind, delta)).toBe("taken");
      // One kind is held at a time, with at most one timer.
      expect(world.clock.pending()).toBeLessThanOrEqual(1);
    }
    expect(other(world, turnEnd(world))).toBe("pass");
    // Slice 2a has no thinking.end: the coalescer's cut and order only.
    expect(cuts(world)).toEqual([
      ["thinking.delta", "a"],
      ["thinking.delta", "b"],
      ["text.delta", "c"],
      ["text.delta", "d"],
      ["thinking.delta", "e"],
    ]);
    expect(world.column()).toBe("abe");
    expect(world.texts).toEqual(["c", "d"]);
    expect(world.clock.pending()).toBe(0);
  });

  it("a kind without a save port passes through after flushing the held kind (slice 2a text)", () => {
    const world = openWorld(["thinking"]);
    send(world, "thinking", "a");
    send(world, "thinking", "b");
    expect(send(world, "text", "c")).toBe("pass");
    expect(cuts(world)).toEqual([
      ["thinking.delta", "a"],
      ["thinking.delta", "b"],
    ]);
    expect(world.texts).toEqual([]);
    expect(world.clock.pending()).toBe(0);
  });
});

describe("chat-stream 非增量事件前冲刷", () => {
  it("held text xy is published and stored before the step.start passes on", () => {
    const world = openWorld();
    send(world, "text", "w");
    send(world, "text", "x");
    send(world, "text", "y");
    expect(deltas(world)).toEqual(["w"]);
    expect(other(world, stepStart(world))).toBe("pass");
    expect(cuts(world)).toEqual([
      ["text.delta", "w"],
      ["text.delta", "xy"],
    ]);
    expect(world.texts).toEqual(["w", "xy"]);
    expect(world.clock.pending()).toBe(0);
  });

  it("every non-delta event of the turn flushes held thinking first", () => {
    const messageId = 0; // Overwritten per world below; the events only need the shape.
    const events: ChatEvent<string>[] = [
      { type: "turn.start", data: { messageId } },
      { type: "step.start", data: { messageId, stepId: "t", name: "bash", detail: "" } },
      { type: "files.changed", data: { messageId, stepId: "t", files: [] } },
      { type: "step.end", data: { messageId, stepId: "t", status: "done", output: "" } },
      { type: "todo.updated", data: { messageId, todo: null } },
      { type: "turn.retry", data: { messageId } },
      { type: "turn.end", data: { messageId, status: "stopped" } },
    ];
    for (const event of events) {
      const world = openWorld();
      send(world, "thinking", "先");
      send(world, "thinking", "想");
      expect(other(world, event)).toBe("pass");
      expect(deltas(world)).toEqual(["先", "想"]);
      expect(world.clock.pending()).toBe(0);
    }
  });
});

describe("M3 explicit flush", () => {
  it("publishes a held buffer once, clears its timer, and an empty flush saves nothing", () => {
    const world = openWorld();
    send(world, "thinking", "a");
    send(world, "thinking", "bc");
    expect(world.clock.pending()).toBe(1);
    expect(world.coalescer.flush(world.slot)).toBe(true);
    expect(deltas(world)).toEqual(["a", "bc"]);
    expect(world.saves).toEqual([
      ["thinking", "a"],
      ["thinking", "bc"],
    ]);
    expect(world.clock.pending()).toBe(0);

    expect(world.coalescer.flush(world.slot)).toBe(true);
    world.clock.advance(5000);
    expect(world.saves).toHaveLength(2);
    expect(deltas(world)).toEqual(["a", "bc"]);
    expect(world.column()).toBe("abc");
  });

  it("a flush after the column is capped calls save, publishes nothing and returns true", () => {
    const world = openWorld();
    const full = "想".repeat(CAP);
    expect(appendThinking(world.db, world.messageId, full)).toBe(full);
    expect(appendThinking(world.db, world.messageId, "x")).toBe(MARK);
    const capped = `${full}${MARK}`;
    expect(world.column()).toBe(capped);

    // The leading-edge publication takes the same path.
    expect(send(world, "thinking", "前")).toBe("taken");
    expect(send(world, "thinking", "后")).toBe("taken");
    expect(world.coalescer.flush(world.slot)).toBe(true);
    expect(world.saves).toEqual([
      ["thinking", "前"],
      ["thinking", "后"],
    ]);
    expect(world.published).toEqual([]);
    expect(world.column()).toBe(capped);
    expect(world.clock.pending()).toBe(0);
    expect(world.faults).toEqual([]);
  });

  it("returns the publish port's false and does not publish the refused chunk again", () => {
    const world = openWorld(["thinking", "text"], true);
    expect(send(world, "thinking", "x")).toBe(false);
    expect(world.column()).toBe("x");
    send(world, "thinking", "y");
    expect(world.coalescer.flush(world.slot)).toBe(false);
    expect(other(world, stepStart(world))).toBe("pass");
    expect(deltas(world)).toEqual(["x", "y"]);
    expect(world.faults).toEqual([]);
    expect(world.column()).toBe("xy");
  });
});

describe("thinking-fold 上限与截断标记 (stored prefix)", () => {
  it("the publication crossing the cap carries the prefix plus the mark; later ones publish nothing", () => {
    const world = openWorld();
    const head = `${"😀".repeat(10)}${"思".repeat(CAP - 12)}`;
    expect(send(world, "thinking", head)).toBe("taken");
    // Held: crosses the cap at an astral character when the window ends.
    send(world, "thinking", `${"😀".repeat(3)}${"b".repeat(40_000 - CAP - 1)}`);
    at(world, WINDOW);
    expect(deltas(world)).toEqual([head, `😀😀${MARK}`]);
    expect(world.published[1]?.column).toBe(`${head}😀😀${MARK}`);
    expect(points(world.column() ?? "")).toBe(CAP + points(MARK));

    at(world, 2 * WINDOW);
    expect(send(world, "thinking", "more")).toBe("taken");
    send(world, "thinking", "and more");
    expect(other(world, turnEnd(world))).toBe("pass");
    expect(deltas(world)).toHaveLength(2);
    expect(deltas(world).join("")).toBe(world.column());
  });
});

describe("M4 appendThinking cap", () => {
  it("40000 code points cut at an astral character keep 32768 whole code points plus the mark", () => {
    const { db, messageId } = openMessageDb();
    // Astral characters below the cap: counting the stored text in UTF-16 units would already
    // read it as over the cap and store nothing more.
    const head = `${"😀".repeat(100)}${"思".repeat(CAP - 101)}`;
    expect(head.length).toBe(CAP + 99);
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
    const half = `😀${"想".repeat(CAP / 2 - 1)}`;
    expect(points(half)).toBe(CAP / 2);
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

describe("M5 save failure", () => {
  const trigger = `CREATE TEMP TRIGGER reject_thinking
    BEFORE UPDATE OF thinking ON chat_messages
    BEGIN SELECT RAISE(ABORT, 'thinking write sentinel'); END`;

  it("a leading-edge save that fails faults once, publishes nothing and holds nothing", () => {
    const world = openWorld();
    world.db.exec(trigger);
    expect(send(world, "thinking", "a")).toBe(false);
    expect(world.faults).toHaveLength(1);
    expect(world.faults[0]?.slot).toBe(world.slot);
    expect(world.faults[0]?.error.message).toContain("thinking write sentinel");
    expect(world.published).toEqual([]);
    expect(world.clock.pending()).toBe(0);

    world.db.exec("DROP TRIGGER reject_thinking");
    expect(world.coalescer.flush(world.slot)).toBe(true);
    world.clock.advance(5000);
    expect(world.saves).toHaveLength(1);
    expect(world.published).toEqual([]);
    expect(world.faults).toHaveLength(1);
    expect(world.column()).toBeNull();
  });

  it("a timer flush that fails faults from the callback", () => {
    const world = openWorld();
    send(world, "thinking", "a");
    world.db.exec(trigger);
    send(world, "thinking", "b");
    world.clock.advance(WINDOW);
    expect(world.faults).toHaveLength(1);
    expect(deltas(world)).toEqual(["a"]);
    expect(world.clock.pending()).toBe(0);
    expect(world.coalescer.flush(world.slot)).toBe(true);
    expect(world.saves).toEqual([
      ["thinking", "a"],
      ["thinking", "b"],
    ]);
    expect(world.column()).toBe("a");
  });

  it("a text save that throws faults and publishes nothing", () => {
    const world = openWorld(["thinking"]);
    const faults: Error[] = [];
    const coalescer = new DeltaCoalescer({
      clock: world.clock,
      save: {
        text() {
          throw new Error("text buffer sentinel");
        },
      },
      publish() {
        throw new Error("nothing is published after a failed save");
      },
      fault(_slot, error) {
        faults.push(error);
      },
    });
    const event: ChatEvent<string> = { type: "text.delta", data: { messageId: 1, delta: "x" } };
    expect(coalescer.route(world.slot, undefined, event)).toBe(false);
    expect(faults.map((error) => error.message)).toEqual(["text buffer sentinel"]);
  });
});

describe("M6 discard and clearTimer", () => {
  it("discard drops buffer and timer; clearTimer keeps the buffer for the next flush", () => {
    const world = openWorld();
    send(world, "thinking", "a");
    send(world, "thinking", "b");
    world.coalescer.discard(world.slot);
    expect(world.clock.pending()).toBe(0);
    world.clock.advance(3000);
    expect(world.coalescer.flush(world.slot)).toBe(true);
    expect(world.saves).toEqual([["thinking", "a"]]);
    expect(deltas(world)).toEqual(["a"]);

    send(world, "thinking", "c");
    send(world, "thinking", "d");
    world.coalescer.clearTimer(world.slot);
    expect(world.clock.pending()).toBe(0);
    world.clock.advance(3000);
    expect(deltas(world)).toEqual(["a", "c"]);
    expect(world.coalescer.flush(world.slot)).toBe(true);
    expect(deltas(world)).toEqual(["a", "c", "d"]);
    expect(world.column()).toBe("acd");
  });

  it("a timer that fires on an infra-faulted slot does nothing", () => {
    const world = openWorld();
    send(world, "thinking", "c");
    send(world, "thinking", "d");
    world.slot.infraFaulted = true;
    world.clock.advance(WINDOW);
    expect(world.saves).toEqual([["thinking", "c"]]);
    expect(deltas(world)).toEqual(["c"]);
    expect(world.faults).toEqual([]);
  });

  it("a delta reaching an infra-faulted slot is neither saved nor published", () => {
    const world = openWorld();
    world.slot.infraFaulted = true;
    expect(send(world, "thinking", "x")).toBe("taken");
    expect(send(world, "text", "y")).toBe("taken");
    expect(world.saves).toEqual([]);
    expect(world.published).toEqual([]);
    expect(world.clock.pending()).toBe(0);
  });

  it("a held chunk is published with the generation of its first delta", () => {
    const world = openWorld();
    send(world, "thinking", "a");
    const first = world.generation;
    send(world, "thinking", "b");
    world.generation = { epoch: 2, sealed: false } as unknown as Generation;
    send(world, "thinking", "c");
    world.coalescer.flush(world.slot);
    expect(world.published.map(({ generation }) => generation)).toEqual([first, first]);
  });
});

describe("M7 one truncation mark", () => {
  // #909 moved the mark to core/upstream-failure.ts (upstream text is cut with it too).
  it("core exports the mark and events.ts and store-thinking import it instead of a copy", () => {
    expect(TRUNCATED_MARK).toBe(MARK);
    for (const file of ["events.ts", "store-thinking.ts"]) {
      const source = readFileSync(new URL(`../src/sessions/${file}`, import.meta.url), "utf8");
      expect(source).toMatch(
        /import \{[^}]*\bTRUNCATED_MARK\b[^}]*\} from "\.\.\/core\/upstream-failure\.js";/u,
      );
      expect(source).not.toContain(MARK);
    }
  });
});
