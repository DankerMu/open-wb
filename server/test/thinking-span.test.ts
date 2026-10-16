/**
 * Issue #910 slice 3b thinking spans, pure layer (thinking-fold「思考时长记录与下发」, design D3,
 * Sketch seam `createThinkingSpans`, here the class `ThinkingSpans`). Raw omp frames are fed
 * through the same three steps as the supervisor's pump: a raw `thinking_end` closes the open span
 * (`endsThinking` +
 * `DeltaCoalescer.endSpan`), then the pure reducer maps the frame and every mapped event goes
 * through `DeltaCoalescer.route`; an event it passes on is recorded as published (persistEvent's
 * stand-in; a `step.start` also seeds its step row). The spans write through the `durations` port,
 * the real `createThinkingSegmentStore` over in-memory SQLite (`thinking_ms`, 045 segment rows; body
 * length = the text port's count); thinking is saved by the real `appendThinking`. Injected clock;
 * the fault port does what the supervisor's owned error sink does (mark the slot, discard).
 * Expected milliseconds are the spec's literals.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { DeltaCoalescer } from "../src/sessions/delta-coalescer.js";
import {
  applyFailure,
  applyFrame,
  applyStop,
  type ChatEvent,
  createEventState,
} from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { Generation, Slot } from "../src/sessions/pool.js";
import { createThinkingSegmentStore } from "../src/sessions/store-segments.js";
import { appendThinking, createThinkingMsStore } from "../src/sessions/store-thinking.js";
import { endsThinking } from "../src/sessions/thinking-span.js";
import { seedMessage, seedSession, seedStep, sessionId } from "./session-store-helpers.js";
import { createClock, type TestClock } from "./support/omp-runtime.js";

/** thinking-fold spec literals. */
const MARK = "…（已截断）";
const CAP = 32_768;
const SENTINEL = "thinking_ms write sentinel";

interface Published {
  at: number;
  event: ChatEvent<number>;
  /** `chat_messages.thinking_ms` and `thinking` read inside the publication. */
  thinkingMs: number | null;
  thinking: string | null;
}

interface World {
  db: DatabaseSync;
  messageId: number;
  clock: TestClock;
  slot: Slot;
  generation: Generation;
  coalescer: DeltaCoalescer;
  mapper: ReturnType<typeof createEventState>;
  published: Published[];
  faults: Error[];
}

const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
});

function columns(db: DatabaseSync, messageId: number) {
  const row = db
    .prepare("SELECT thinking_ms, thinking FROM chat_messages WHERE id = ?")
    .get(messageId) as { thinking_ms: number | null; thinking: string | null };
  return { thinkingMs: row.thinking_ms, thinking: row.thinking };
}

function openWorld(prepare?: (db: DatabaseSync) => void): World {
  const db = openDb(":memory:");
  dbs.push(db);
  const session = sessionId("b");
  seedSession(db, {
    id: session,
    ownerId: "u1",
    title: "spans",
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
  prepare?.(db);
  const clock = createClock();
  const published: Published[] = [];
  const faults: Error[] = [];
  const slot = { sessionId: "s", infraFaulted: false } as unknown as Slot;
  let body = 0; // Slice 3b: the turn's published body length, as appendDelta counts it.
  const record = (event: ChatEvent<number>) => {
    published.push({ at: clock.now(), event, ...columns(db, messageId) });
    return true;
  };
  const coalescer: DeltaCoalescer = new DeltaCoalescer({
    clock,
    save: {
      thinking: (id, chunk) => appendThinking(db, id, chunk),
      text: (_id, chunk) => {
        body += chunk.length;
        return chunk;
      },
    },
    durations: createThinkingSegmentStore(db, () => ({ publishedLength: body })),
    publish: (_slot, event) => record(event),
    fault(faulted, error) {
      faults.push(error);
      faulted.infraFaulted = true;
      coalescer.discard(faulted);
    },
  });
  return {
    db,
    messageId,
    clock,
    slot,
    generation: { epoch: 1, sealed: false } as unknown as Generation,
    coalescer,
    mapper: createEventState({ messageId, promptRequestId: "p1" }),
    published,
    faults,
  };
}

/** `#commit`: each mapped event is routed; one the coalescer passes on is published as is. */
function commit(world: World, events: ChatEvent<string>[]): boolean {
  for (const event of events) {
    const routed = world.coalescer.route(world.slot, world.generation, event);
    if (routed === false) {
      return false;
    }
    if (routed === "pass") {
      if (event.type === "step.start") {
        const ordinal = world.published.filter((p) => p.event.type === "step.start").length;
        const step = { name: "bash", detail: "{}", status: "running", endedAt: null } as const;
        seedStep(world.db, { ...step, messageId: world.messageId, ordinal, startedAt: 0 });
      }
      world.published.push({
        at: world.clock.now(),
        event: event as ChatEvent<number>,
        ...columns(world.db, world.messageId),
      });
    }
  }
  return true;
}

/** The pump's read of one raw frame at time `t` (timers due on the way fire at their due time). */
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

const AGENT_START: OmpFrame = { type: "agent_start" };
const AGENT_END: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
const THINKING_START = update({ type: "thinking_start" });
const THINKING_END = update({ type: "thinking_end", content: "" });
/** Issue 1474: thinking.end's segment of a first span at body 0 before any step. */
const first = (thinkingLength: number, thinkingMs: number) =>
  ({ bodyOffset: 0, thinkingOffset: 0, thinkingLength, stepsBefore: 0, thinkingMs }) as const;
const thinking = (delta: string) => update({ type: "thinking_delta", delta });
const text = (delta: string) => update({ type: "text_delta", delta });
const toolStart = (id: string): OmpFrame => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "bash",
  args: { command: "ls" },
});
const toolEnd = (id: string): OmpFrame => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "bash",
  result: { content: [{ type: "text", text: "ok" }] },
});

function started(prepare?: (db: DatabaseSync) => void): World {
  const world = openWorld(prepare);
  expect(feed(world, 0, AGENT_START)).toBe(true);
  return world;
}

/** [type, payload] of every publication after turn.start: the delta text or the milliseconds. */
function trace(world: World): Array<[string, string | number]> {
  return world.published.slice(1).map(({ event }) => {
    switch (event.type) {
      case "thinking.delta":
      case "text.delta":
        return [event.type, event.data.delta];
      case "thinking.end":
        return [event.type, event.data.thinkingMs];
      default:
        return [event.type, ""];
    }
  });
}

function ends(world: World): Published[] {
  return world.published.filter(({ event }) => event.type === "thinking.end");
}

/** Slice 3b: "body_offset thinking_offset thinking_length steps_before thinking_ms" per row. */
function segments(world: World): string[] {
  const sql = `SELECT body_offset, thinking_offset, thinking_length, steps_before, thinking_ms
    FROM chat_thinking_segments WHERE message_id = ? ORDER BY id`;
  return world.db
    .prepare(sql)
    .all(world.messageId)
    .map((row) => Object.values(row).map(String).join(" "));
}

describe("thinking-fold 单段思考以 thinking_end 闭合", () => {
  it("thinking from t=1000 closed by thinking_end at t=3000 records 2000 before the text", () => {
    const world = started();
    feed(world, 1000, THINKING_START);
    feed(world, 1000, thinking("甲"));
    feed(world, 1100, thinking("乙"));
    feed(world, 1300, thinking("丙"));
    // Not in the spec's frames: the window publishes 1100 at 1250 and 1300 at 1500, so two more
    // segments (the second held) show the flush at thinking_end that thinking.end follows.
    feed(world, 2900, thinking("丁"));
    feed(world, 2950, thinking("戊"));
    feed(world, 3000, THINKING_END);
    expect(ends(world).map(({ at, thinkingMs }) => [at, thinkingMs])).toEqual([[3000, 2000]]);
    feed(world, 3400, text("答"));
    feed(world, 3400, AGENT_END);

    expect(trace(world)).toEqual([
      ["thinking.delta", "甲"],
      ["thinking.delta", "乙"],
      ["thinking.delta", "丙"],
      ["thinking.delta", "丁"],
      ["thinking.delta", "戊"],
      ["thinking.end", 2000],
      ["text.delta", "答"],
      ["turn.end", ""],
    ]);
    expect(world.published.slice(1).map(({ at }) => at)).toEqual([
      1000, 1250, 1500, 2900, 3000, 3000, 3400, 3400,
    ]);
    expect(ends(world)[0]?.event).toEqual({
      type: "thinking.end",
      data: { messageId: world.messageId, thinkingMs: 2000, segment: first(5, 2000) },
    });
    expect(columns(world.db, world.messageId)).toEqual({
      thinkingMs: 2000,
      thinking: "甲乙丙丁戊",
    });
    expect(world.faults).toEqual([]);
  });

  it("the column is written before thinking.end is published, and NULL while the span is open", () => {
    const world = started((db) => {
      db.prepare("UPDATE chat_messages SET thinking_ms = 4242").run();
    });
    feed(world, 10, thinking("想"));
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
    expect(world.published.at(-1)?.thinkingMs).toBeNull();
    feed(world, 70, THINKING_END);
    expect(ends(world).map(({ thinkingMs, event }) => [thinkingMs, event.data])).toEqual([
      [60, { messageId: world.messageId, thinkingMs: 60, segment: first(1, 60) }],
    ]);
  });
});

describe("thinking-fold 工具参数的生成不计入", () => {
  it("thinking_end at 500 closes the span; toolcall frames until 9000 are not counted", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 500, THINKING_END);
    for (const t of [600, 3000, 8000]) {
      feed(world, t, update({ type: "toolcall_delta", delta: '{"command":' }));
    }
    feed(world, 9000, toolStart("call-1"));
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.end", 500],
      ["step.start", ""],
    ]);
    expect(ends(world)[0]?.at).toBe(500);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(500);
  });
});

describe("thinking-fold 没有 thinking_end 时以下一事件闭合", () => {
  it("thinking from t=0 and the first text at t=800: thinking.end{800} right before it", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 800, text("答"));
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.end", 800],
      ["text.delta", "答"],
    ]);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(800);
  });
});

describe("thinking-fold 多段思考累计", () => {
  it("500 ms, a 3000 ms tool, then 700 ms: two thinking.end, 500 then 1200", () => {
    const world = started();
    feed(world, 0, thinking("先想"));
    feed(world, 500, THINKING_END);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(500);
    feed(world, 500, toolStart("call-1"));
    feed(world, 3500, toolEnd("call-1"));
    feed(world, 3500, thinking("再想"));
    // The second span's opening clears the column: a snapshot now reads thinkingMs null.
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
    expect(segments(world)).toEqual(["0 0 2 0 500", "0 2 null 1 null"]);
    feed(world, 4200, THINKING_END);
    feed(world, 4300, text("答"));
    feed(world, 4300, AGENT_END);

    expect(trace(world)).toEqual([
      ["thinking.delta", "先想"],
      ["thinking.end", 500],
      ["step.start", ""],
      ["step.end", ""],
      ["thinking.delta", "再想"],
      ["thinking.end", 1200],
      ["text.delta", "答"],
      ["turn.end", ""],
    ]);
    expect(ends(world).map(({ thinkingMs }) => thinkingMs)).toEqual([500, 1200]);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(1200);
    expect(segments(world)).toEqual(["0 0 2 0 500", "0 2 2 1 700"]);
  });

  it("a new assistant message on the same slot starts from zero", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 500, THINKING_END);
    feed(world, 600, AGENT_END);
    const next = seedMessage(world.db, {
      sessionId: sessionId("b"),
      role: "assistant",
      content: "",
      status: "done",
      createdAt: 2,
    });
    const route = (event: ChatEvent<string>) =>
      world.coalescer.route(world.slot, world.generation, event);
    expect(route({ type: "thinking.delta", data: { messageId: next, delta: "新" } })).toBe("taken");
    world.clock.advance(300);
    expect(world.coalescer.endSpan(world.slot, true)).toBe(true);
    expect(world.published.at(-1)?.event).toEqual({
      type: "thinking.end",
      data: { messageId: next, thinkingMs: 300, segment: first(1, 300) },
    });
    expect(columns(world.db, next).thinkingMs).toBe(300);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(500);
  });
});

describe("thinking-fold 停止与失败", () => {
  it("a stop 900 ms after the first thinking: thinking.end{900} before turn.end stopped", () => {
    const world = started();
    feed(world, 100, thinking("想"));
    world.clock.advance(900);
    expect(commit(world, applyStop(world.mapper).events)).toBe(true);
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.end", 900],
      ["turn.end", ""],
    ]);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(900);
    expect(segments(world)).toEqual(["0 0 1 0 900"]);
  });

  it("an omp crash 600 ms after the first thinking: thinking.end{600} before the error", () => {
    const world = started();
    feed(world, 100, thinking("想"));
    world.clock.advance(600);
    expect(commit(world, applyFailure(world.mapper, "omp exited").events)).toBe(true);
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.end", 600],
      ["error", ""],
      ["turn.end", ""],
    ]);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(600);
    expect(segments(world)).toEqual(["0 0 1 0 600"]);
  });
});

describe("thinking-fold 中断后无法恢复", () => {
  it("killed inside the first span: the column the span cleared stays NULL, no thinking.end", () => {
    const world = started((db) => {
      db.prepare("UPDATE chat_messages SET thinking_ms = 4242").run();
    });
    feed(world, 0, thinking("想"));
    world.clock.advance(5000);
    // The host process dies here: nothing else runs.
    expect(ends(world)).toEqual([]);
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
    expect(segments(world)).toEqual(["0 0 null 0 null"]);
  });

  it("killed inside the second span: the first span's 500 is cleared, no thinking.end", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 500, THINKING_END);
    feed(world, 600, toolStart("call-1"));
    feed(world, 700, toolEnd("call-1"));
    feed(world, 700, thinking("再想"));
    world.clock.advance(5000);
    expect(ends(world).map(({ thinkingMs }) => thinkingMs)).toEqual([500]);
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
    expect(segments(world)).toEqual(["0 0 1 0 500", "0 1 null 1 null"]);
  });

  it("an infra fault inside a span writes nothing later and publishes no thinking.end", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 10, thinking("held"));
    // The supervisor's owned error sink: the slot is marked and the coalescer discards.
    world.slot.infraFaulted = true;
    world.coalescer.discard(world.slot);
    const before = world.published.length;
    world.clock.advance(400);
    expect(world.coalescer.endSpan(world.slot, true)).toBe(true);
    expect(commit(world, applyFailure(world.mapper, "late").events)).toBe(true);
    expect(world.published.slice(before).map(({ event }) => event.type)).toEqual([
      "error",
      "turn.end",
    ]);
    expect(ends(world)).toEqual([]);
    expect(columns(world.db, world.messageId)).toEqual({ thinkingMs: null, thinking: "想" });
  });

  it("a thinking delta reaching an infra-faulted slot opens no span and writes nothing", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 500, THINKING_END);
    world.slot.infraFaulted = true;
    world.coalescer.discard(world.slot);
    expect(feed(world, 600, thinking("再想"))).toBe(true);
    world.clock.advance(400);
    expect(world.coalescer.endSpan(world.slot, true)).toBe(true);
    expect(ends(world).map(({ thinkingMs }) => thinkingMs)).toEqual([500]);
    expect(columns(world.db, world.messageId)).toEqual({ thinkingMs: 500, thinking: "想" });
  });
});

describe("thinking-fold 墙钟回拨", () => {
  it("a clock stepped back 5000 ms inside the first span records 0, never a negative", () => {
    const world = started();
    feed(world, 6000, thinking("想"));
    world.clock.nowMs = 1000;
    feed(world, 1000, THINKING_END);
    expect(ends(world).map(({ event }) => event.data)).toEqual([
      { messageId: world.messageId, thinkingMs: 0, segment: first(1, 0) },
    ]);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(0);
  });

  it("stepped back inside the second span: thinking.end repeats the earlier total", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 500, THINKING_END);
    feed(world, 6000, thinking("再想"));
    world.clock.nowMs = 1000;
    feed(world, 1000, THINKING_END);
    expect(ends(world).map(({ thinkingMs }) => thinkingMs)).toEqual([500, 500]);
    expect(columns(world.db, world.messageId).thinkingMs).toBe(500);
  });
});

describe("thinking-fold 写库失败", () => {
  const rejectClose = (db: DatabaseSync) => {
    db.exec(`CREATE TEMP TRIGGER reject_thinking_ms BEFORE UPDATE OF thinking_ms ON chat_messages
      WHEN NEW.thinking_ms IS NOT NULL BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
  };

  it("a failing close write publishes no thinking.end and stops the triggering text", () => {
    const world = started(rejectClose);
    feed(world, 0, thinking("想"));
    const before = world.published.length;
    expect(feed(world, 800, text("答"))).toBe(false);
    expect(world.published.length).toBe(before);
    expect(world.faults.map((fault) => fault.message)).toEqual([expect.stringContaining(SENTINEL)]);
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
  });

  it("a failing open write (the NULL) takes the sink and publishes no thinking.delta", () => {
    const world = started((db) => {
      db.exec(`CREATE TEMP TRIGGER reject_clear BEFORE UPDATE OF thinking_ms ON chat_messages
        WHEN NEW.thinking_ms IS NULL BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
    });
    expect(feed(world, 0, thinking("想"))).toBe(false);
    expect(trace(world)).toEqual([]);
    expect(world.faults).toHaveLength(1);
    expect(columns(world.db, world.messageId).thinking).toBeNull();
  });

  it("both duration writes throw for a message id that names no row", () => {
    const world = openWorld();
    const store = createThinkingMsStore(world.db);
    const missing = world.messageId + 1;
    const receipt = "thinking duration must change exactly 1 row";
    expect(() => store.setThinkingMs(missing, 500)).toThrow(receipt);
    expect(() => store.clearThinkingMs(missing)).toThrow(receipt);
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
  });
});

describe("thinking-fold 段行（chat-interleaved-segments 3b）", () => {
  it("相邻的两段不合并: 300 ms, thinking_end, at once 400 ms more: two rows, two thinking.end", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 300, THINKING_END);
    feed(world, 300, thinking("再"));
    feed(world, 700, text("答"));
    expect(ends(world).map(({ thinkingMs }) => thinkingMs)).toEqual([300, 700]);
    expect(segments(world)).toEqual(["0 0 1 0 300", "0 1 1 0 400"]);
  });

  it("上限之后的段: offsets in UTF-16 units of the stored text, the mark included; length 0", () => {
    const world = started();
    feed(world, 0, thinking(`😀${"思".repeat(CAP - 1)}`));
    feed(world, 300, thinking("考考"));
    feed(world, 500, THINKING_END);
    feed(world, 600, toolStart("call-1"));
    feed(world, 700, toolEnd("call-1"));
    feed(world, 800, thinking("后"));
    feed(world, 1000, THINKING_END);
    // 32768 code points stored, the mark appended: 😀 is two UTF-16 units, so one more unit.
    const units = String(CAP + 1 + MARK.length);
    expect(columns(world.db, world.messageId).thinking).toBe(`😀${"思".repeat(CAP - 1)}${MARK}`);
    expect(trace(world).filter(([type]) => type === "thinking.delta")).toHaveLength(2);
    expect(ends(world).map(({ thinkingMs }) => thinkingMs)).toEqual([500, 700]);
    expect(segments(world)).toEqual([`0 0 ${units} 0 500`, `0 ${units} 0 1 200`]);
  });

  it("写库失败: a failing row insert publishes no thinking.delta and keeps thinking_ms", () => {
    const world = started((db) => {
      db.prepare("UPDATE chat_messages SET thinking_ms = 4242").run();
      db.exec(`CREATE TEMP TRIGGER reject_open BEFORE INSERT ON chat_thinking_segments
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
    });
    expect(feed(world, 0, thinking("想"))).toBe(false);
    expect(trace(world)).toEqual([]);
    expect(world.faults.map((fault) => fault.message)).toEqual([expect.stringContaining(SENTINEL)]);
    expect(columns(world.db, world.messageId)).toEqual({ thinkingMs: 4242, thinking: null });
    expect(segments(world)).toEqual([]);
  });

  it("写库失败: a failing row close publishes no thinking.end and writes no total", () => {
    const world = started((db) => {
      db.exec(`CREATE TEMP TRIGGER reject_close BEFORE UPDATE ON chat_thinking_segments
        BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
    });
    feed(world, 0, thinking("想"));
    expect(feed(world, 800, text("答"))).toBe(false);
    expect(ends(world)).toEqual([]);
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
    expect(segments(world)).toEqual(["0 0 null 0 null"]);
  });
});

describe("thinking-fold 上限与截断标记（计时）", () => {
  it("the cap crossed at 300 ms does not stop the clock: thinking_end at 1000 records 1000", () => {
    const world = started();
    feed(world, 0, thinking("思".repeat(30_000)));
    feed(world, 300, thinking("考".repeat(5_000)));
    for (const t of [500, 700, 900]) {
      feed(world, t, thinking("后".repeat(1_000)));
    }
    feed(world, 1000, THINKING_END);
    const deltas = trace(world).filter(([type]) => type === "thinking.delta");
    expect(deltas).toHaveLength(2);
    expect(String(deltas[1]?.[1]).endsWith(MARK)).toBe(true);
    expect(trace(world).at(-1)).toEqual(["thinking.end", 1000]);
    const stored = columns(world.db, world.messageId);
    expect(stored.thinkingMs).toBe(1000);
    expect([...(stored.thinking ?? "")].length).toBe(CAP + [...MARK].length);
  });
});

describe("chat-stream 两类交错保持次序", () => {
  it("thinking a b, text c d, thinking e at one instant: thinking.end after b and after e", () => {
    const world = started();
    for (const frame of [thinking("a"), thinking("b"), text("c"), text("d"), thinking("e")]) {
      feed(world, 0, frame);
    }
    feed(world, 0, AGENT_END);
    expect(trace(world)).toEqual([
      ["thinking.delta", "a"],
      ["thinking.delta", "b"],
      ["thinking.end", 0],
      ["text.delta", "c"],
      ["text.delta", "d"],
      ["thinking.delta", "e"],
      ["thinking.end", 0],
      ["turn.end", ""],
    ]);
  });
});

describe("thinking-fold 其它事件前冲刷", () => {
  it("held thinking without thinking_end: thinking.delta, thinking.end, step.start adjacent", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 0, thinking("一想"));
    feed(world, 40, toolStart("call-1"));
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.delta", "一想"],
      ["thinking.end", 40],
      ["step.start", ""],
    ]);
  });

  it("held thinking at turn.end stopped: thinking.delta and thinking.end first, content saved", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 0, thinking("一想"));
    world.clock.advance(30);
    expect(commit(world, applyStop(world.mapper).events)).toBe(true);
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.delta", "一想"],
      ["thinking.end", 30],
      ["turn.end", ""],
    ]);
    expect(columns(world.db, world.messageId)).toEqual({ thinkingMs: 30, thinking: "想一想" });
  });

  it("a publication outside the pump (an approval) closes the span through flush", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 0, thinking("后"));
    world.clock.advance(70);
    expect(world.coalescer.flush(world.slot)).toBe(true);
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.delta", "后"],
      ["thinking.end", 70],
    ]);
  });

  it("the window's own timer publishes held thinking without closing the span", () => {
    const world = started();
    feed(world, 0, thinking("想"));
    feed(world, 10, thinking("后"));
    world.clock.advance(500);
    expect(trace(world)).toEqual([
      ["thinking.delta", "想"],
      ["thinking.delta", "后"],
    ]);
    expect(columns(world.db, world.messageId).thinkingMs).toBeNull();
  });
});

describe("thinking_end frame recognition", () => {
  it("only a message_update whose assistant event is thinking_end ends a span", () => {
    expect(endsThinking(THINKING_END)).toBe(true);
    expect(
      endsThinking({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }),
    ).toBe(true);
    for (const frame of [
      THINKING_START,
      thinking("想"),
      text("答"),
      { type: "thinking_end" },
      { type: "message_end", assistantMessageEvent: { type: "thinking_end" } },
      { type: "message_update" },
    ]) {
      expect(endsThinking(frame)).toBe(false);
    }
  });

  it("a thinking_end with no open span publishes nothing and leaves held text held", () => {
    const world = started();
    feed(world, 0, text("答"));
    feed(world, 10, text("后"));
    feed(world, 20, THINKING_END);
    expect(trace(world)).toEqual([["text.delta", "答"]]);
    expect(world.clock.pending()).toBe(1);
  });
});
