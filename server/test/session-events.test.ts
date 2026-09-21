/**
 * Issue #83 pure protocol event mapping at createEventState/applyFrame/applyFailure.
 * Expected sequences are fixture literals, not production reducer logic.
 */
import { describe, expect, it } from "vitest";
import {
  applyFailure,
  applyFrame,
  type ChatEvent,
  createEventState,
} from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const MESSAGE_ID = 41;
const OTHER_MESSAGE_ID = 42;
const PROMPT_ID = "req_prompt_41";
const OTHER_PROMPT_ID = "req_prompt_42";
const GENERIC_FAILURE = "Agent execution failed";
const GENERIC_FAILURE_EVENTS: ChatEvent<string>[] = [
  { type: "error", data: { messageId: MESSAGE_ID, message: GENERIC_FAILURE } },
  { type: "turn.end", data: { messageId: MESSAGE_ID, status: "failed" } },
];
const BASH_DETAIL = '{"command":"echo workbuddy-smoke"}';
const READ_DETAIL = '{"path":"README.md"}';
const NEWLINE_RESULT_DETAIL = '{"ok":true,"stdout":"workbuddy-smoke\\n"}';
const LINE_SEPARATOR_DETAIL = '{"note":"a\\u2028b\\u2029c"}';
const ASTRAL_ARGS = {
  k: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa𝄞z",
} as const;
const ASTRAL_DETAIL_120 =
  '{"k":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa𝄞';

type EventState = ReturnType<typeof createEventState>;

function bind(messageId = MESSAGE_ID, promptRequestId = PROMPT_ID): EventState {
  return createEventState({ messageId, promptRequestId });
}

function applyAll(state: EventState, frames: readonly OmpFrame[]) {
  const events: ChatEvent<string>[] = [];
  let current = state;
  for (const frame of frames) {
    const next = applyFrame(current, frame);
    events.push(...next.events);
    current = next.state;
  }
  return { state: current, events };
}

function expectSilent(state: EventState, frame: OmpFrame): EventState {
  const before = structuredClone(state);
  const next = applyFrame(state, frame);
  expect(next.events).toEqual([]);
  expect(next.state).toEqual(before);
  return next.state;
}

function textDelta(delta: string, role?: string): OmpFrame {
  const frame: OmpFrame = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  };
  if (role !== undefined) {
    frame.message = { role, content: [] };
  }
  return frame;
}

function toolStart(toolCallId: string, toolName: string, args?: unknown): OmpFrame {
  const frame: OmpFrame = { type: "tool_execution_start", toolCallId, toolName };
  if (args !== undefined) {
    frame.args = args;
  }
  return frame;
}

function toolEnd(
  toolCallId: string,
  toolName: string,
  extra: { result?: unknown; isError?: unknown } = {},
): OmpFrame {
  const frame: OmpFrame = { type: "tool_execution_end", toolCallId, toolName };
  if ("result" in extra) {
    frame.result = extra.result;
  }
  if ("isError" in extra) {
    frame.isError = extra.isError;
  }
  return frame;
}

function assistantEnd(stopReason: string, errorMessage?: unknown): OmpFrame {
  const message: OmpFrame = { role: "assistant", stopReason };
  if (errorMessage !== undefined) {
    message.errorMessage = errorMessage;
  }
  return { type: "message_end", message };
}

describe("session event mapping — normal stream and noise filter", () => {
  it("maps three deltas and two interleaved tools, dropping thinking/toolcall/turn/UI/ACK/malformed frames", () => {
    const { events } = applyAll(bind(), [
      { type: "response", id: PROMPT_ID, command: "prompt", success: true },
      { type: "thinking_delta", delta: "scratch" },
      { type: "toolcall_delta", delta: "partial(" },
      { type: "turn_start" },
      {
        type: "extension_ui_request",
        id: "ui_1",
        method: "confirm",
      },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "agent_start" },
      textDelta("Hel", "assistant"),
      toolStart("call_bash", "bash", { command: "echo workbuddy-smoke" }),
      textDelta("lo "),
      {
        type: "tool_execution_update",
        toolCallId: "call_bash",
        toolName: "bash",
        args: { command: "echo workbuddy-smoke" },
        partialResult: "work",
      },
      toolStart("call_read", "read", { path: "README.md" }),
      toolEnd("call_bash", "wrong-end-name", {
        result: { ok: true, stdout: "workbuddy-smoke\n" },
      }),
      textDelta("world", "assistant"),
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
        message: { role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", delta: "{" },
        message: { role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: 7 },
        message: { role: "assistant", content: [] },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "user-noise" },
        message: { role: "user", content: [] },
      },
      { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
      { type: "prompt_result", id: PROMPT_ID, agentInvoked: false },
      toolEnd("call_read", "read", { result: { text: "# Open WorkBuddy" } }),
      { type: "agent_end", messages: [], isTerminal: true },
    ]);

    expect(events).toEqual([
      { type: "turn.start", data: { messageId: MESSAGE_ID } },
      { type: "text.delta", data: { messageId: MESSAGE_ID, delta: "Hel" } },
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_bash",
          name: "bash",
          detail: BASH_DETAIL,
        },
      },
      { type: "text.delta", data: { messageId: MESSAGE_ID, delta: "lo " } },
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_read",
          name: "read",
          detail: READ_DETAIL,
        },
      },
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_bash",
          status: "done",
          detail: NEWLINE_RESULT_DETAIL,
        },
      },
      { type: "text.delta", data: { messageId: MESSAGE_ID, delta: "world" } },
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_read",
          status: "done",
          detail: '{"text":"# Open WorkBuddy"}',
        },
      },
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "done" } },
    ]);
  });
});

describe("session event mapping — first failure through maintenance", () => {
  it("keeps the first assistant error through nonterminal end, duplicate start, and later success until omitted isTerminal", () => {
    let state = bind();
    ({ state } = applyFrame(state, { type: "agent_start" }));
    const remembered = applyFrame(state, assistantEnd("error", "upstream 500"));
    expect(remembered.events).toEqual([]);
    state = remembered.state;

    const maintenance = applyFrame(state, {
      type: "agent_end",
      messages: [],
      isTerminal: false,
    });
    expect(maintenance.events).toEqual([]);
    state = maintenance.state;

    const restart = applyFrame(state, { type: "agent_start" });
    expect(restart.events).toEqual([]);
    state = restart.state;

    const laterSuccess = applyFrame(state, assistantEnd("stop"));
    expect(laterSuccess.events).toEqual([]);
    state = laterSuccess.state;

    const laterAborted = applyFrame(state, assistantEnd("aborted", "later abort"));
    expect(laterAborted.events).toEqual([]);
    state = laterAborted.state;

    const terminal = applyFrame(state, { type: "agent_end", messages: [] });
    expect(terminal.events).toEqual([
      { type: "error", data: { messageId: MESSAGE_ID, message: "upstream 500" } },
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "failed" } },
    ]);
    state = terminal.state;

    expect(applyFrame(state, { type: "agent_start" }).events).toEqual([]);
    expect(applyFrame(state, { type: "agent_end", messages: [], isTerminal: true }).events).toEqual(
      [],
    );
    expect(applyFailure(state, "late supervisor").events).toEqual([]);
  });

  it("emits the first aborted generic fallback once isTerminal is true, ignoring a later errorMessage", () => {
    let state = bind();
    ({ state } = applyFrame(state, { type: "agent_start" }));
    ({ state } = applyFrame(state, assistantEnd("aborted", "")));
    ({ state } = applyFrame(state, assistantEnd("error", "second failure")));
    ({ state } = applyFrame(state, { type: "agent_end", messages: [], isTerminal: false }));
    const terminal = applyFrame(state, { type: "agent_end", messages: [], isTerminal: true });
    expect(terminal.events).toEqual(GENERIC_FAILURE_EVENTS);
  });

  it("does not fail the turn for a tool isError or a non-assistant error stopReason", () => {
    const { events } = applyAll(bind(), [
      { type: "agent_start" },
      toolStart("call_fail", "bash", { command: "false" }),
      toolEnd("call_fail", "bash", { result: { stderr: "boom" }, isError: true }),
      {
        type: "message_end",
        message: { role: "user", stopReason: "error", errorMessage: "user poison" },
      },
      {
        type: "message_end",
        message: { role: "tool", stopReason: "error", errorMessage: "tool poison" },
      },
      { type: "agent_end", messages: [], isTerminal: true },
    ]);
    expect(events).toEqual([
      { type: "turn.start", data: { messageId: MESSAGE_ID } },
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_fail",
          name: "bash",
          detail: '{"command":"false"}',
        },
      },
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_fail",
          status: "failed",
          detail: '{"stderr":"boom"}',
        },
      },
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "done" } },
    ]);
  });
});

describe("session event mapping — correlated runtime failure", () => {
  it("fails immediately on the bound prompt response even before agent_start", () => {
    const next = applyFrame(bind(), {
      type: "response",
      id: PROMPT_ID,
      command: "prompt",
      success: false,
      error: "async schedule failed",
    });
    expect(next.events).toEqual([
      {
        type: "error",
        data: { messageId: MESSAGE_ID, message: "async schedule failed" },
      },
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "failed" } },
    ]);
  });

  it("uses the generic fallback for empty matching prompt errors and leaves ACKs and prompt_result unchanged", () => {
    let state = bind();
    state = expectSilent(state, {
      type: "response",
      id: PROMPT_ID,
      command: "prompt",
      success: true,
    });
    state = expectSilent(state, {
      type: "response",
      id: PROMPT_ID,
      command: "prompt",
      success: true,
      data: { agentInvoked: false },
    });
    state = expectSilent(state, {
      type: "response",
      id: PROMPT_ID,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    state = expectSilent(state, {
      type: "prompt_result",
      id: PROMPT_ID,
      agentInvoked: false,
    });
    state = expectSilent(state, {
      type: "response",
      id: OTHER_PROMPT_ID,
      command: "prompt",
      success: false,
      error: "other request",
    });
    state = expectSilent(state, {
      type: "response",
      id: PROMPT_ID,
      command: "abort",
      success: false,
      error: "wrong command",
    });
    state = expectSilent(state, {
      type: "response",
      command: "prompt",
      success: false,
      error: "missing id",
    });

    const failed = applyFrame(state, {
      type: "response",
      id: PROMPT_ID,
      command: "prompt",
      success: false,
      error: "",
    });
    expect(failed.events).toEqual(GENERIC_FAILURE_EVENTS);
  });

  it("closes with applyFailure before start and ignores later frames", () => {
    const failed = applyFailure(bind(), "child exited");
    expect(failed.events).toEqual([
      { type: "error", data: { messageId: MESSAGE_ID, message: "child exited" } },
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "failed" } },
    ]);
    expect(applyFrame(failed.state, { type: "agent_start" }).events).toEqual([]);
    expect(applyFailure(failed.state, "second exit").events).toEqual([]);
  });

  it("uses the generic fallback for empty applyFailure after start, then fences terminal", () => {
    let state = bind();
    ({ state } = applyFrame(state, { type: "agent_start" }));
    const failed = applyFailure(state, "");
    expect(failed.events).toEqual(GENERIC_FAILURE_EVENTS);
    expect(applyFrame(failed.state, textDelta("late", "assistant")).events).toEqual([]);
  });
});

describe("session event mapping — step identity and stale inputs", () => {
  it("ignores text and tools until agent_start, then correlates only known running IDs including prototype keys", () => {
    let state = bind();
    state = expectSilent(state, textDelta("too-early", "assistant"));
    state = expectSilent(state, toolStart("early", "bash", { command: "echo early" }));
    state = expectSilent(state, toolEnd("early", "bash", { result: "nope" }));

    ({ state } = applyFrame(state, { type: "agent_start" }));

    const protoStart = applyFrame(state, toolStart("__proto__", "bash", { command: "echo proto" }));
    expect(protoStart.events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "__proto__",
          name: "bash",
          detail: '{"command":"echo proto"}',
        },
      },
    ]);
    state = protoStart.state;

    const ctorStart = applyFrame(state, toolStart("constructor", "read", { path: "package.json" }));
    expect(ctorStart.events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "constructor",
          name: "read",
          detail: '{"path":"package.json"}',
        },
      },
    ]);
    state = ctorStart.state;

    const duplicateProto = applyFrame(
      state,
      toolStart("__proto__", "other", { command: "overwrite" }),
    );
    expect(duplicateProto.events).toEqual([]);
    state = duplicateProto.state;

    state = expectSilent(state, toolStart("", "bash", { command: "empty-id" }));
    state = expectSilent(state, toolStart("no-name", "", { command: "empty-name" }));
    state = expectSilent(state, toolEnd("unknown", "bash", { result: "ghost" }));

    const protoEnd = applyFrame(
      state,
      toolEnd("__proto__", "ignored-name", {
        result: { ok: true },
        isError: true,
      }),
    );
    expect(protoEnd.events).toEqual([
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "__proto__",
          status: "failed",
          detail: '{"ok":true}',
        },
      },
    ]);
    state = protoEnd.state;

    const duplicateEnd = applyFrame(
      state,
      toolEnd("__proto__", "bash", { result: { ok: false }, isError: true }),
    );
    expect(duplicateEnd.events).toEqual([]);
    state = duplicateEnd.state;

    const truthyError = applyFrame(
      state,
      toolEnd("constructor", "read", { result: { text: "pkg" }, isError: 1 }),
    );
    expect(truthyError.events).toEqual([
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "constructor",
          status: "done",
          detail: '{"text":"pkg"}',
        },
      },
    ]);
    state = truthyError.state;

    const done = applyFrame(state, { type: "agent_end", messages: [] });
    expect(done.events).toEqual([
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "done" } },
    ]);
  });

  it("preserves initial detail when result is absent, summarizes explicit null, and truncates at 120 Unicode points", () => {
    let state = bind();
    ({ state } = applyFrame(state, { type: "agent_start" }));
    ({ state } = applyFrame(state, toolStart("call_keep", "bash", { command: "keep" })));
    const missingResult = applyFrame(state, toolEnd("call_keep", "bash"));
    expect(missingResult.events).toEqual([
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_keep",
          status: "done",
          detail: '{"command":"keep"}',
        },
      },
    ]);
    state = missingResult.state;

    ({ state } = applyFrame(state, toolStart("call_null", "bash", { command: "nullish" })));
    const nullResult = applyFrame(state, toolEnd("call_null", "bash", { result: null }));
    expect(nullResult.events).toEqual([
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_null",
          status: "done",
          detail: "null",
        },
      },
    ]);
    state = nullResult.state;

    const separators = applyFrame(
      state,
      toolStart("call_sep", "note", { note: "a\u2028b\u2029c" }),
    );
    expect(separators.events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_sep",
          name: "note",
          detail: LINE_SEPARATOR_DETAIL,
        },
      },
    ]);
    state = separators.state;

    const astral = applyFrame(state, toolStart("call_astral", "wide", ASTRAL_ARGS));
    expect(astral.events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_astral",
          name: "wide",
          detail: ASTRAL_DETAIL_120,
        },
      },
    ]);

    const missingArgs = applyFrame(astral.state, toolStart("call_empty", "bash"));
    expect(missingArgs.events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_empty",
          name: "bash",
          detail: "",
        },
      },
    ]);
  });

  it("keeps independent prompts isolated when they reuse the same toolCallId", () => {
    let first = bind();
    ({ state: first } = applyFrame(first, { type: "agent_start" }));
    ({ state: first } = applyFrame(first, toolStart("shared", "bash", { command: "first" })));

    let second = bind(OTHER_MESSAGE_ID, OTHER_PROMPT_ID);
    ({ state: second } = applyFrame(second, { type: "agent_start" }));
    ({ state: second } = applyFrame(second, toolStart("shared", "read", { path: "other.md" })));

    const firstEnd = applyFrame(first, toolEnd("shared", "bash", { result: { from: "first" } }));
    expect(firstEnd.events).toEqual([
      {
        type: "step.end",
        data: {
          messageId: MESSAGE_ID,
          stepId: "shared",
          status: "done",
          detail: '{"from":"first"}',
        },
      },
    ]);

    const secondEnd = applyFrame(second, toolEnd("shared", "read", { result: { from: "second" } }));
    expect(secondEnd.events).toEqual([
      {
        type: "step.end",
        data: {
          messageId: OTHER_MESSAGE_ID,
          stepId: "shared",
          status: "done",
          detail: '{"from":"second"}',
        },
      },
    ]);

    const firstFailed = applyFailure(firstEnd.state, "first child died");
    expect(firstFailed.events).toEqual([
      {
        type: "error",
        data: { messageId: MESSAGE_ID, message: "first child died" },
      },
      { type: "turn.end", data: { messageId: MESSAGE_ID, status: "failed" } },
    ]);
    expect(applyFrame(secondEnd.state, { type: "agent_end", messages: [] }).events).toEqual([
      { type: "turn.end", data: { messageId: OTHER_MESSAGE_ID, status: "done" } },
    ]);
  });
});

describe("session event mapping — frozen inputs and output isolation", () => {
  it("does not mutate frozen state or frames, and caller edits to returned events do not change later results", () => {
    const initial = Object.freeze(bind());
    const startFrame = Object.freeze({ type: "agent_start" }) as OmpFrame;
    const started = applyFrame(initial, startFrame);
    expect(startFrame).toEqual({ type: "agent_start" });
    expect(started.events).toEqual([{ type: "turn.start", data: { messageId: MESSAGE_ID } }]);

    const deltaFrame = Object.freeze(textDelta("Hel", "assistant")) as OmpFrame;
    const firstDelta = applyFrame(Object.freeze(started.state), deltaFrame);
    expect(firstDelta.events).toEqual([
      { type: "text.delta", data: { messageId: MESSAGE_ID, delta: "Hel" } },
    ]);
    firstDelta.events[0] = {
      type: "error",
      data: { messageId: MESSAGE_ID, message: "mutated" },
    };

    const replay = applyFrame(started.state, deltaFrame);
    expect(replay.events).toEqual([
      { type: "text.delta", data: { messageId: MESSAGE_ID, delta: "Hel" } },
    ]);
    expect(deltaFrame).toEqual(textDelta("Hel", "assistant"));

    const toolFrame = Object.freeze(
      toolStart("call_bash", "bash", { command: "echo workbuddy-smoke" }),
    ) as OmpFrame;
    const withTool = applyFrame(Object.freeze(firstDelta.state), toolFrame);
    expect(withTool.events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_bash",
          name: "bash",
          detail: BASH_DETAIL,
        },
      },
    ]);
    withTool.events.push({
      type: "turn.end",
      data: { messageId: MESSAGE_ID, status: "failed" },
    });
    expect(applyFrame(firstDelta.state, toolFrame).events).toEqual([
      {
        type: "step.start",
        data: {
          messageId: MESSAGE_ID,
          stepId: "call_bash",
          name: "bash",
          detail: BASH_DETAIL,
        },
      },
    ]);
  });
});
