/**
 * Issue #514 thinking reduction: an assistant `thinking_delta` update maps one-to-one to
 * `thinking.delta`, behind the same agent_start and assistant-role gates as `text_delta`.
 * Expected sequences are fixture literals from the thinking-delta-reduction design, not reducer
 * logic; frame shapes follow omp v18.0.10 (ai/src/types.ts thinking events).
 */
import { describe, expect, it } from "vitest";
import { applyFrame, type ChatEvent, createEventState } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const M = 41;
const PROMPT = "req_prompt_41";
const ASSISTANT: OmpFrame = { role: "assistant", content: [] };

type State = ReturnType<typeof createEventState>;

const bound = (): State => createEventState({ messageId: M, promptRequestId: PROMPT });

/** A `message_update`; `message: null` omits the key entirely. */
function update(event: OmpFrame, message: OmpFrame | null = ASSISTANT): OmpFrame {
  return message === null
    ? { type: "message_update", assistantMessageEvent: event }
    : { type: "message_update", assistantMessageEvent: event, message };
}

const thinking = (delta: unknown, message?: OmpFrame | null): OmpFrame =>
  update({ type: "thinking_delta", contentIndex: 0, delta }, message);

const thought = (delta: string) => ({ type: "thinking.delta", data: { messageId: M, delta } });

/** A bound state past agent_start (which itself emits only turn.start). */
function started(): State {
  const next = applyFrame(bound(), { type: "agent_start" });
  expect(next.events).toEqual([{ type: "turn.start", data: { messageId: M } }]);
  return next.state;
}

/** Folds frames in order and collects every emitted event. */
function fold(start: State, frames: readonly OmpFrame[]) {
  let state = start;
  const events: ChatEvent<string>[] = [];
  for (const frame of frames) {
    const next = applyFrame(state, frame);
    events.push(...next.events);
    state = next.state;
  }
  return { state, events };
}

/** One frame alone: no event and the very same state reference back. */
function expectInert(state: State, frame: OmpFrame): void {
  const next = applyFrame(state, frame);
  expect(next.events, JSON.stringify(frame)).toEqual([]);
  expect(next.state, JSON.stringify(frame)).toBe(state);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe("thinking reduction — one event per nonempty assistant thinking_delta", () => {
  it("emits thinking.delta 先, thinking.delta 想, then text.delta 答 for the bound message", () => {
    const state = started();
    const thinkingStart = update({ type: "thinking_start", contentIndex: 0 });
    const empty = thinking("");
    const thinkingEnd = update({ type: "thinking_end", contentIndex: 0, content: "先想" });
    const frames = [
      thinkingStart,
      thinking("先"),
      thinking("想"),
      empty,
      thinkingEnd,
      update({ type: "text_delta", contentIndex: 1, delta: "答" }),
    ];

    expect(fold(state, frames).events).toEqual([
      thought("先"),
      thought("想"),
      { type: "text.delta", data: { messageId: M, delta: "答" } },
    ]);
    for (const frame of [thinkingStart, empty, thinkingEnd]) {
      expectInert(state, frame);
    }
  });

  it("drops a thinking_delta that arrives before agent_start in an independent state", () => {
    const fresh = bound();
    expectInert(fresh, thinking("早"));
    expectInert(fresh, update({ type: "thinking_start", contentIndex: 0 }));
  });
});

describe("thinking reduction — the text_delta role gate", () => {
  it("drops thinking from a non-assistant message role", () => {
    const state = started();
    expectInert(state, thinking("用户", { role: "user", content: [] }));
    expectInert(state, thinking("工具", { role: "toolResult", content: [] }));
  });

  it("emits when message is absent or carries no role, exactly as text_delta does", () => {
    const state = started();
    const cases: Array<[string, OmpFrame | null]> = [
      ["缺省", null],
      ["无角色", { content: [] }],
      ["助手", { role: "assistant", content: [] }],
    ];
    for (const [delta, message] of cases) {
      expect(applyFrame(state, thinking(delta, message)).events, delta).toEqual([thought(delta)]);
      expect(
        applyFrame(state, update({ type: "text_delta", delta }, message)).events,
        delta,
      ).toEqual([{ type: "text.delta", data: { messageId: M, delta } }]);
    }
  });
});

describe("thinking reduction — filtered shapes", () => {
  it("drops non-string thinking deltas", () => {
    const state = started();
    expectInert(state, thinking(7));
    expectInert(state, thinking(null));
    expectInert(state, thinking({ text: "对象" }));
    expectInert(state, update({ type: "thinking_delta", contentIndex: 0 }));
  });

  it("ignores thinking blocks inside message_end content and thinking after the terminal", () => {
    const withThinking: OmpFrame = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "先想" },
          { type: "redactedThinking", data: "opaque-signature" },
          { type: "text", text: "答" },
        ],
      },
    };
    const plain: OmpFrame = {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "答" }] },
    };
    const terminal: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
    const state = started();
    expectInert(state, withThinking);

    const thinkingRun = fold(state, [withThinking, terminal]);
    expect(thinkingRun.events).toEqual(fold(state, [plain, terminal]).events);
    expect(thinkingRun.events).toEqual([
      { type: "turn.end", data: { messageId: M, status: "done" } },
    ]);
    expectInert(thinkingRun.state, thinking("晚"));
  });
});

describe("thinking reduction — no accumulation, frozen inputs, unaliased output", () => {
  it("keeps state byte-identical across many deltas and returns fresh event data", () => {
    const MARK = "思考标记514";
    const state = started();
    const before = JSON.stringify(state);
    const events: ChatEvent<string>[] = [];
    for (let n = 0; n < 256; n += 1) {
      const next = applyFrame(state, deepFreeze(thinking(`${MARK}${n}`)));
      expect(next.state).toBe(state);
      events.push(...next.events);
    }
    expect(JSON.stringify(state)).toBe(before);
    expect(JSON.stringify(state)).not.toContain(MARK);
    expect(events).toHaveLength(256);
    expect(events[255]).toEqual(thought(`${MARK}255`));

    const frame = deepFreeze(thinking("别名"));
    const [first] = applyFrame(state, frame).events;
    expect(first).toEqual(thought("别名"));
    expect(first?.data).not.toBe(frame.assistantMessageEvent);
    Object.assign(first?.data ?? {}, { delta: "改写" });
    expect(applyFrame(state, frame).events).toEqual([thought("别名")]);
    expect(frame.assistantMessageEvent).toEqual({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "别名",
    });
  });
});
