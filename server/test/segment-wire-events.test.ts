/**
 * Issue 1474 (chat-interleaved-segments 5.2b, design D8) at the pure seam of coalescer-world.ts: the
 * published `thinking.end` carries its closed segment row and the published `step.start` its stored
 * body offset and paired approval, and the store's snapshot view carries the segment rows. The
 * expected values are the literals of chat-stream「分段位置的记录与下发」and thinking-fold「思考时长
 * 记录与下发」(injected clock, so every millisecond is exact); "equal to the row" is read with the
 * test's own SQL (`segments`), never through the code under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  closeWorlds,
  feed,
  OWNER,
  segments,
  started,
  TOOL_START,
  text,
  thinking,
  update,
  type World,
} from "./coalescer-world.js";

afterEach(closeWorlds);

/** thinking-fold: the truncation mark appended at the 32768-code-point cap. */
const MARK = "…（已截断）";
const CAP = 32_768;
const THINKING_END = update({ type: "thinking_end", content: "" });
const TOOL_END: OmpFrame = {
  type: "tool_execution_end",
  toolCallId: "call-1",
  toolName: "bash",
  result: { content: [{ type: "text", text: "ok" }], details: {} },
};

type Published = ChatEvent<number>;

function published<K extends Published["type"]>(world: World, type: K) {
  return world.published
    .map(({ event }) => event)
    .filter((event): event is Extract<Published, { type: K }> => event.type === type);
}

/** The store's snapshot view of the world's assistant message (and its user message). */
function views(world: World) {
  const messages = world.store.getMessages(world.session, OWNER)?.messages ?? [];
  const assistant = messages.find((message) => message.id === world.messageId);
  const user = messages.find((message) => message.role === "user");
  if (assistant === undefined || user === undefined) {
    throw new Error("missing snapshot messages");
  }
  return { assistant, user };
}

/** The raw rows (test SQL) in the published camelCase shape. */
function rows(world: World) {
  return segments(world).map((row) => {
    const raw = row as Record<string, number | null>;
    return {
      bodyOffset: raw.body_offset,
      thinkingOffset: raw.thinking_offset,
      thinkingLength: raw.thinking_length,
      stepsBefore: raw.steps_before,
      thinkingMs: raw.thinking_ms,
    };
  });
}

describe("chat-stream「合并器缓冲着正文时开段」: the snapshot part", () => {
  it("看 at 0, 一下 held at 100, 想 at 120: content 看一下, the open last segment at 3", () => {
    const world = started();
    feed(world, 0, text("看"));
    feed(world, 100, text("一下"));
    feed(world, 120, thinking("想"));

    const { assistant, user } = views(world);
    expect(assistant.content).toBe("看一下");
    expect(assistant.thinkingSegments).toStrictEqual([
      { bodyOffset: 3, thinkingOffset: 0, thinkingLength: null, stepsBefore: 0, thinkingMs: null },
    ]);
    expect(assistant.thinkingMs).toBeNull();
    expect(user.thinkingSegments).toStrictEqual([]);
    expect(world.faults).toEqual([]);
  });
});

describe("thinking-fold「思考时长记录与下发」: thinking.end carries its segment row", () => {
  it("单段思考以 thinking_end 闭合: thinking.end{2000, segment {0,0,6,0,2000}} equals the row", () => {
    const world = started();
    feed(world, 1000, thinking("先读"));
    feed(world, 1100, thinking("需求"));
    feed(world, 1300, thinking("再想"));
    feed(world, 3000, THINKING_END);
    feed(world, 3400, text("好"));

    const segment = { bodyOffset: 0, thinkingOffset: 0, thinkingLength: 6, stepsBefore: 0 };
    expect(published(world, "thinking.end").map((event) => event.data)).toStrictEqual([
      { messageId: world.messageId, thinkingMs: 2000, segment: { ...segment, thinkingMs: 2000 } },
    ]);
    expect(rows(world)).toStrictEqual([{ ...segment, thinkingMs: 2000 }]);
    expect(views(world).assistant.thinkingSegments).toStrictEqual([
      { ...segment, thinkingMs: 2000 },
    ]);
    expect(world.faults).toEqual([]);
  });

  it("多段思考累计: segments 500 and 700, the second after one step; snapshot nulls while open", () => {
    const world = started();
    feed(world, 0, thinking("一二"));
    feed(world, 500, THINKING_END);
    feed(world, 500, TOOL_START);
    feed(world, 3500, TOOL_END);
    feed(world, 3500, thinking("三四五"));

    const open = views(world).assistant;
    expect(open.thinkingMs).toBeNull();
    expect(open.thinkingSegments).toStrictEqual([
      { bodyOffset: 0, thinkingOffset: 0, thinkingLength: 2, stepsBefore: 0, thinkingMs: 500 },
      { bodyOffset: 0, thinkingOffset: 2, thinkingLength: null, stepsBefore: 1, thinkingMs: null },
    ]);

    feed(world, 4200, THINKING_END);
    feed(world, 4200, text("好"));

    const ends = published(world, "thinking.end").map((event) => event.data);
    expect(ends.map((end) => end.thinkingMs)).toEqual([500, 1200]);
    expect(ends.map((end) => end.segment)).toStrictEqual([
      { bodyOffset: 0, thinkingOffset: 0, thinkingLength: 2, stepsBefore: 0, thinkingMs: 500 },
      { bodyOffset: 0, thinkingOffset: 2, thinkingLength: 3, stepsBefore: 1, thinkingMs: 700 },
    ]);
    const done = views(world).assistant;
    expect(done.thinkingMs).toBe(1200);
    expect(done.thinkingSegments).toStrictEqual(ends.map((end) => end.segment));
    expect(rows(world)).toStrictEqual(ends.map((end) => end.segment));
  });

  it("相邻的两段不合并: 300 then 400 ms, both at body 0 before any step", () => {
    const world = started();
    feed(world, 0, thinking("甲"));
    feed(world, 300, THINKING_END);
    feed(world, 300, thinking("乙"));
    feed(world, 700, text("好"));

    const expected = [
      { bodyOffset: 0, thinkingOffset: 0, thinkingLength: 1, stepsBefore: 0, thinkingMs: 300 },
      { bodyOffset: 0, thinkingOffset: 1, thinkingLength: 1, stepsBefore: 0, thinkingMs: 400 },
    ];
    expect(published(world, "thinking.end").map((event) => event.data.segment)).toStrictEqual(
      expected,
    );
    expect(views(world).assistant.thinkingSegments).toStrictEqual(expected);
  });

  it("上限之后的段: the first segment counts the stored mark, the later one is 0 long", () => {
    const world = started();
    feed(world, 0, thinking("a".repeat(CAP + 2)));
    feed(world, 100, THINKING_END);
    feed(world, 100, TOOL_START);
    feed(world, 200, TOOL_END);
    feed(world, 200, thinking("b"));
    feed(world, 250, THINKING_END);

    const stored = CAP + MARK.length;
    const expected = [
      { bodyOffset: 0, thinkingOffset: 0, thinkingLength: stored, stepsBefore: 0, thinkingMs: 100 },
      { bodyOffset: 0, thinkingOffset: stored, thinkingLength: 0, stepsBefore: 1, thinkingMs: 50 },
    ];
    expect(published(world, "thinking.end").map((event) => event.data.segment)).toStrictEqual(
      expected,
    );
    expect(rows(world)).toStrictEqual(expected);
    expect(views(world).assistant.thinking).toBe(`${"a".repeat(CAP)}${MARK}`);
  });
});

describe("chat-stream「步骤的正文偏移」: the published step.start", () => {
  it("码元而非码点: after a😀 the step.start carries bodyOffset 3 and approvalId null", () => {
    const world = started();
    feed(world, 0, text("a😀"));
    feed(world, 10, TOOL_START);

    const [start] = published(world, "step.start");
    expect(Object.keys(start?.data ?? {}).sort()).toEqual([
      "approvalId",
      "bodyOffset",
      "detail",
      "messageId",
      "name",
      "stepId",
    ]);
    expect(start?.data).toMatchObject({ name: "bash", bodyOffset: 3, approvalId: null });
    const [step] = views(world).assistant.steps;
    expect(step?.id).toBe(start?.data.stepId);
    expect(step?.bodyOffset).toBe(3);
  });
});
