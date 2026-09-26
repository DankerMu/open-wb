/**
 * Issue #455 interruption reduction: message_end aborted and applyStop end the turn stopped.
 * Expected sequences are fixture literals from the turn-stopped-reduction design, not reducer logic.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  applyFailure,
  applyFrame,
  applyStop,
  type ChatEvent,
  createEventState,
} from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const M = 41;
const PROMPT = "req_prompt_41";
const STOPPED: ChatEvent<string>[] = [
  { type: "turn.end", data: { messageId: M, status: "stopped" } },
];

type State = ReturnType<typeof createEventState>;

const fresh = (): State => createEventState({ messageId: M, promptRequestId: PROMPT });
const ended = (stopReason: string, errorMessage?: string): OmpFrame => ({
  type: "message_end",
  message:
    errorMessage === undefined
      ? { role: "assistant", stopReason }
      : { role: "assistant", stopReason, errorMessage },
});

/** Feeds frames one at a time, asserting each is silent, and returns the final state. */
function feedSilently(start: State, frames: readonly OmpFrame[]): State {
  let state = start;
  for (const frame of frames) {
    const step = applyFrame(state, frame);
    expect(step.events, JSON.stringify(frame)).toEqual([]);
    state = step.state;
  }
  return state;
}

/** Every later frame/failure/stop input on a terminal state is silent and keeps the same reference. */
function expectTerminalSilence(state: State): void {
  const lateInputs: Array<() => { state: State; events: ChatEvent<string>[] }> = [
    () => applyFrame(state, { type: "response", command: "abort", success: true, id: "req_abort" }),
    () => applyFrame(state, { type: "agent_end", messages: [] }),
    () => applyFrame(state, { type: "agent_start" }),
    () => applyFailure(state, "late supervisor"),
    () => applyStop(state),
  ];
  for (const late of lateInputs) {
    const result = late();
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  }
}

describe("session event reduction — aborted turn ends stopped", () => {
  it("stays silent through maintenance after aborted, then emits exactly one turn.end stopped", () => {
    let state = feedSilently(applyFrame(fresh(), { type: "agent_start" }).state, [
      ended("aborted"),
      { type: "agent_end", messages: [], isTerminal: false },
      { type: "agent_start" },
      ended("stop"),
    ]);
    const terminal = applyFrame(state, { type: "agent_end", messages: [] });
    expect(terminal.events).toEqual(STOPPED);
    state = terminal.state;
    expectTerminalSilence(state);
  });

  it("lets an earlier aborted outcome win over a later error: turn.end stopped without error", () => {
    const state = feedSilently(applyFrame(fresh(), { type: "agent_start" }).state, [
      ended("aborted", "user abort"),
      ended("error", "second failure"),
    ]);
    const terminal = applyFrame(state, { type: "agent_end", messages: [], isTerminal: true });
    expect(terminal.events).toEqual(STOPPED);
    expectTerminalSilence(terminal.state);
  });

  it("guard: an earlier error wins over a later aborted and still fails with its message", () => {
    const state = feedSilently(applyFrame(fresh(), { type: "agent_start" }).state, [
      ended("error", "upstream 500"),
      ended("aborted"),
    ]);
    expect(applyFrame(state, { type: "agent_end", messages: [] }).events).toEqual([
      { type: "error", data: { messageId: M, message: "upstream 500" } },
      { type: "turn.end", data: { messageId: M, status: "failed" } },
    ]);
  });

  it("guard: a turn with nothing remembered ends done", () => {
    const state = feedSilently(applyFrame(fresh(), { type: "agent_start" }).state, [ended("stop")]);
    expect(applyFrame(state, { type: "agent_end", messages: [] }).events).toEqual([
      { type: "turn.end", data: { messageId: M, status: "done" } },
    ]);
  });
});

describe("session event reduction — applyStop fallback", () => {
  const started = (): State => applyFrame(fresh(), { type: "agent_start" }).state;
  const cases: Array<{ name: string; build: () => State }> = [
    { name: "fresh state", build: fresh },
    { name: "only agent_start", build: started },
    { name: "remembered error", build: () => applyFrame(started(), ended("error", "boom")).state },
    { name: "remembered aborted", build: () => applyFrame(started(), ended("aborted")).state },
    {
      name: "running tool",
      build: () =>
        applyFrame(started(), {
          type: "tool_execution_start",
          toolCallId: "call_run",
          toolName: "bash",
          args: { command: "sleep 9" },
        }).state,
    },
  ];

  it.each(cases)("emits exactly one turn.end stopped without error from $name", ({ build }) => {
    const input = build();
    expect(Object.isFrozen(input)).toBe(true);
    const snapshot = structuredClone(input);

    const stopped = applyStop(input);
    expect(stopped.events).toEqual(STOPPED);
    expect(input).toEqual(snapshot);
    expect(stopped.state).not.toBe(input);
    expect(stopped.state.ended).toBe(true);
    expect(Object.isFrozen(stopped.state)).toBe(true);
    expectTerminalSilence(stopped.state);

    const [event] = stopped.events;
    if (event?.type !== "turn.end") {
      throw new Error("expected turn.end");
    }
    (event.data as { status: string }).status = "mutated";
    expect(applyStop(input).events).toEqual(STOPPED);
    expect(input).toEqual(snapshot);
  });
});

describe("session event reduction — approval frames stay out of the reducer", () => {
  it("guard: approval-shaped and confirm extension UI requests are filtered with unchanged state", () => {
    const state = applyFrame(fresh(), { type: "agent_start" }).state;
    const frames: OmpFrame[] = [
      {
        type: "extension_ui_request",
        id: "ui_approval",
        method: "select",
        title: "Allow tool: bash…",
        options: ["Approve", "Deny"],
      },
      { type: "extension_ui_request", id: "ui_confirm", method: "confirm" },
    ];
    for (const frame of frames) {
      const before = structuredClone(state);
      const result = applyFrame(state, frame);
      expect(result.events).toEqual([]);
      expect(result.state).toEqual(before);
    }
  });
});

describe("session event reduction — turn.end status contract", () => {
  it("widens turn.end status to done | failed | stopped", () => {
    type TurnEndStatus = Extract<ChatEvent, { type: "turn.end" }>["data"]["status"];
    expectTypeOf<TurnEndStatus>().toEqualTypeOf<"done" | "failed" | "stopped">();
    const status: TurnEndStatus = "stopped";
    expect(status).toBe("stopped");
  });
});
