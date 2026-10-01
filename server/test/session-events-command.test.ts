/**
 * Issue #554 command_output reduction (s1c 10.3, design D15): a built-in slash command answers with
 * id-less `command_output{text}` frames and no agent_start/agent_end. Expected sequences are fixture
 * literals from chat-stream「Command output becomes assistant text」, not reducer logic; the `/todo`
 * text is omp v18.0.10's (todo.ts:246-260), copied, not imported.
 */
import { describe, expect, it } from "vitest";
import {
  applyFailure,
  applyFrame,
  applyStop,
  type ChatEvent,
  createEventState,
} from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const M = 41;
const OTHER_M = 42;
const PROMPT = "req_prompt_41";
const OTHER_PROMPT = "req_prompt_42";
const TODO_TEXT = "No todos. Use /todo append <task> to start one.";
const AGENT_START: OmpFrame = { type: "agent_start" };
/** omp's local-only receipt of a built-in command (rpc-mode.ts:1019-1054). */
const LOCAL_ACK: OmpFrame = {
  type: "response",
  id: PROMPT,
  command: "prompt",
  success: true,
  data: { agentInvoked: false },
};

type State = ReturnType<typeof createEventState>;
type Events = ChatEvent<string>[];

const fresh = (): State => createEventState({ messageId: M, promptRequestId: PROMPT });
const output = (text: unknown): OmpFrame => ({ type: "command_output", text });
const start = (messageId = M): ChatEvent<string> => ({ type: "turn.start", data: { messageId } });
const text = (delta: string, messageId = M): ChatEvent<string> => ({
  type: "text.delta",
  data: { messageId, delta },
});

/** Feeds frames one at a time and returns each frame's own events plus the final state. */
function feed(initial: State, frames: readonly OmpFrame[]): { state: State; perFrame: Events[] } {
  const perFrame: Events[] = [];
  let state = initial;
  for (const frame of frames) {
    const step = applyFrame(state, frame);
    perFrame.push(step.events);
    state = step.state;
  }
  return { state, perFrame };
}

describe("command output becomes assistant text", () => {
  it("P1 emits turn.start once and newline-joined text deltas, without any agent_start", () => {
    const { state, perFrame } = feed(fresh(), [
      output(TODO_TEXT),
      output("second"),
      { type: "command_output", output: "x" },
      LOCAL_ACK,
      AGENT_START,
    ]);
    expect(perFrame).toEqual([[start(), text(TODO_TEXT)], [text("\nsecond")], [], [], []]);
    expect(state.ended).toBe(false);
    expect(state.started).toBe(true);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(TODO_TEXT);
    expect(serialized).not.toContain("second");
  });

  it("P2 does not repeat turn.start when agent_start arrived before the command output", () => {
    const { perFrame } = feed(fresh(), [AGENT_START, output(TODO_TEXT), output("second")]);
    expect(perFrame).toEqual([[start()], [text(TODO_TEXT)], [text("\nsecond")]]);
  });

  it("P2 maps an empty-string text: first delta empty, the next a bare newline", () => {
    const { state, perFrame } = feed(fresh(), [output(""), output("")]);
    expect(perFrame).toEqual([[start(), text("")], [text("\n")]]);
    expect(state.ended).toBe(false);
  });
});

describe("command output filtering", () => {
  const MALFORMED: Array<[string, OmpFrame]> = [
    ["a number", output(7)],
    ["an object", output({ text: TODO_TEXT })],
    ["null", output(null)],
    ["missing", { type: "command_output" }],
  ];

  it.each(MALFORMED)("P2 filters a command_output whose text is %s", (_name, frame) => {
    for (const state of [fresh(), applyFrame(fresh(), AGENT_START).state]) {
      const result = applyFrame(state, frame);
      expect(result.events).toEqual([]);
      expect(result.state).toBe(state);
    }
  });

  const TERMINALS: Array<[string, (state: State) => { state: State; events: Events }]> = [
    ["applyStop", (state) => applyStop(state)],
    ["a terminal agent_end", (state) => applyFrame(state, { type: "agent_end", messages: [] })],
    [
      "the matching prompt failure",
      (state) =>
        applyFrame(state, {
          type: "response",
          id: PROMPT,
          command: "prompt",
          success: false,
          error: "compaction failed",
        }),
    ],
    ["applyFailure", (state) => applyFailure(state, "child exited")],
  ];

  it.each(TERMINALS)("P3 emits nothing for a command_output after %s", (_name, terminate) => {
    const running = feed(fresh(), [AGENT_START, output("before the end")]).state;
    const terminal = terminate(running);
    expect(terminal.events.at(-1)?.type).toBe("turn.end");
    expect(terminal.state.ended).toBe(true);
    for (const late of [output(TODO_TEXT), output("")]) {
      const result = applyFrame(terminal.state, late);
      expect(result.events).toEqual([]);
      expect(result.state).toBe(terminal.state);
    }
  });
});

describe("command output state isolation", () => {
  it("P3 keeps two independent states apart: each gets its own turn.start and first delta", () => {
    const other = createEventState({ messageId: OTHER_M, promptRequestId: OTHER_PROMPT });
    const first = applyFrame(fresh(), output("a1"));
    expect(first.events).toEqual([start(), text("a1")]);
    const second = applyFrame(other, output("b1"));
    expect(second.events).toEqual([start(OTHER_M), text("b1", OTHER_M)]);
    expect(applyFrame(first.state, output("a2")).events).toEqual([text("\na2")]);
    expect(applyFrame(second.state, output("b2")).events).toEqual([text("\nb2", OTHER_M)]);
    // The untouched initial state still starts its own turn.
    expect(applyFrame(other, output("b1")).events).toEqual([start(OTHER_M), text("b1", OTHER_M)]);
  });

  it("P3 returned events do not alias state: caller edits leave later output unchanged", () => {
    const frame = Object.freeze(output(TODO_TEXT)) as OmpFrame;
    const first = applyFrame(fresh(), frame);
    expect(first.events).toEqual([start(), text(TODO_TEXT)]);
    for (const event of first.events) {
      Object.assign(event.data, { messageId: 999, delta: "tampered" });
    }
    first.events.length = 0;
    expect(applyFrame(first.state, output("second")).events).toEqual([text("\nsecond")]);
    expect(applyFrame(first.state, AGENT_START).events).toEqual([]);
    expect(applyFrame(fresh(), frame).events).toEqual([start(), text(TODO_TEXT)]);
  });
});
