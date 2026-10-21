/**
 * Issue #909 groups 4 and 5 at the pure reducer: omp's session-level retry frames (chat-stream
 * 「纯协议事件归约」, design D11) and the classified failure payload of the mapper's `error` event.
 * Frame shapes are omp v18.0.10's (design Context, 实测 c06r: `auto_retry_start{attempt,
 * maxAttempts,delayMs,errorMessage}`, `auto_retry_end{success,attempt,finalError}`；v18.12.3 同
 * （omp-official-upstream-failure.test.ts 在翻转后仍绿）). Expected sequences and payloads are
 * fixture literals of the chat-stream scenarios, not reducer logic.
 */
import { describe, expect, it } from "vitest";
import {
  applyFailure,
  applyFrame,
  type ChatEvent,
  createEventState,
} from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";

const M = 41;
const PROMPT = "req_prompt_41";
const BUSY =
  "502 模型服务返回 HTTP 503：busy\n模型服务返回 HTTP 503：busy (type=wb_upstream param=status.503)";
const KEY_401 =
  "401 Incorrect API key provided\nIncorrect API key provided (type=invalid_request_error)";

type State = ReturnType<typeof createEventState>;

const fresh = (): State => createEventState({ messageId: M, promptRequestId: PROMPT });

const START: OmpFrame = { type: "agent_start" };
const TURN_END: OmpFrame = { type: "turn_end" };
const TERMINAL: OmpFrame = { type: "agent_end", messages: [], isTerminal: true };
const RETRY_START: OmpFrame = {
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 1,
  delayMs: 431,
  errorMessage: BUSY,
};

function failedEnd(errorStatus: number, errorMessage: string): OmpFrame {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorStatus, errorMessage },
  };
}

function ended(stopReason: string): OmpFrame {
  return { type: "message_end", message: { role: "assistant", stopReason } };
}

function delta(text: string): OmpFrame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
    message: { role: "assistant", content: [] },
  };
}

function feed(start: State, frames: readonly OmpFrame[]) {
  const events: ChatEvent<string>[] = [];
  let state = start;
  for (const frame of frames) {
    const next = applyFrame(state, frame);
    events.push(...next.events);
    state = next.state;
  }
  return { state, events };
}

const retry: ChatEvent<string> = { type: "turn.retry", data: { messageId: M } };
const turnStart: ChatEvent<string> = { type: "turn.start", data: { messageId: M } };
const endedAs = (status: "done" | "failed" | "stopped"): ChatEvent<string> => ({
  type: "turn.end",
  data: { messageId: M, status },
});

describe("chat-stream「Retry that succeeds ends done」", () => {
  it("emits one turn.start, one turn.retry, the three deltas and turn.end done without error", () => {
    const { events } = feed(fresh(), [
      START,
      failedEnd(502, BUSY),
      TURN_END,
      RETRY_START,
      START,
      delta("a"),
      delta("b"),
      delta("c"),
      ended("stop"),
      { type: "auto_retry_end", success: true, attempt: 1 },
      TERMINAL,
    ]);
    expect(events).toEqual([
      turnStart,
      retry,
      { type: "text.delta", data: { messageId: M, delta: "a" } },
      { type: "text.delta", data: { messageId: M, delta: "b" } },
      { type: "text.delta", data: { messageId: M, delta: "c" } },
      endedAs("done"),
    ]);
    expect(events.filter((event) => event.type === "turn.start")).toHaveLength(1);
  });

  it("a successful tool round after the retry clears the failure; its later error is remembered anew", () => {
    const { events } = feed(fresh(), [
      START,
      failedEnd(502, BUSY),
      RETRY_START,
      START,
      ended("toolUse"),
      failedEnd(401, KEY_401),
      ended("stop"),
      TERMINAL,
    ]);
    expect(events).toEqual([
      turnStart,
      retry,
      {
        type: "error",
        data: {
          messageId: M,
          message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
          reason: "auth_failed",
          status: 401,
          detail: KEY_401,
        },
      },
      endedAs("failed"),
    ]);
  });
});

describe("chat-stream「Retry that fails reports the last failure」", () => {
  it("replaces the first round's status.503 with the retry round's 401", () => {
    const { events } = feed(fresh(), [
      START,
      failedEnd(502, BUSY),
      TURN_END,
      RETRY_START,
      START,
      failedEnd(401, KEY_401),
      TURN_END,
      { type: "auto_retry_end", success: false, attempt: 1, finalError: KEY_401 },
      TERMINAL,
    ]);
    expect(events).toEqual([
      turnStart,
      retry,
      {
        type: "error",
        data: {
          messageId: M,
          message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
          reason: "auth_failed",
          status: 401,
          detail: KEY_401,
        },
      },
      endedAs("failed"),
    ]);
  });

  it("an aborted retry round replaces the failure with interruption", () => {
    const { events } = feed(fresh(), [
      START,
      failedEnd(502, BUSY),
      RETRY_START,
      START,
      ended("aborted"),
      TERMINAL,
    ]);
    expect(events).toEqual([turnStart, retry, endedAs("stopped")]);
  });
});

describe("chat-stream「Cancelled retry ends stopped」", () => {
  it("Retry cancelled replaces the remembered failure: exactly one turn.end stopped, no error", () => {
    const before = feed(fresh(), [START, failedEnd(502, BUSY), TURN_END, RETRY_START]);
    expect(before.events).toEqual([turnStart, retry]);
    const after = feed(before.state, [
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
      TERMINAL,
    ]);
    expect(after.events).toEqual([endedAs("stopped")]);
  });
});

describe("chat-stream「Retry frames outside a running turn」", () => {
  it("auto_retry_start before agent_start changes nothing", () => {
    const state = fresh();
    const result = applyFrame(state, RETRY_START);
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });

  it("auto_retry_start after a terminal transition changes nothing", () => {
    const { state } = feed(fresh(), [START, failedEnd(401, KEY_401), TERMINAL]);
    expect(state.ended).toBe(true);
    const result = applyFrame(state, RETRY_START);
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });

  it('auto_retry_end{success:false,finalError:"other"} in a running turn without a retry changes nothing', () => {
    const { state } = feed(fresh(), [START, failedEnd(401, KEY_401)]);
    const result = applyFrame(state, {
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "other",
    });
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
    // The remembered 401 still decides the terminal.
    expect(applyFrame(result.state, TERMINAL).events.map((event) => event.type)).toEqual([
      "error",
      "turn.end",
    ]);
  });

  it("a successful auto_retry_end changes nothing", () => {
    const { state } = feed(fresh(), [START, failedEnd(502, BUSY), RETRY_START]);
    const result = applyFrame(state, { type: "auto_retry_end", success: true, attempt: 1 });
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });

  // design D11: only success:false with "Retry cancelled" is an interruption; every other
  // auto_retry_end changes nothing, so the remembered 503 still decides the terminal.
  it('auto_retry_end{success:true,finalError:"Retry cancelled"} changes nothing; the turn still fails', () => {
    const { state } = feed(fresh(), [START, failedEnd(502, BUSY), RETRY_START]);
    const result = applyFrame(state, {
      type: "auto_retry_end",
      success: true,
      attempt: 1,
      finalError: "Retry cancelled",
    });
    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
    expect(applyFrame(result.state, TERMINAL).events.map((event) => event.type)).toEqual([
      "error",
      "turn.end",
    ]);
  });
});

describe("chat-stream「Classified failure payload」", () => {
  it("a 401 message_end before a terminal agent_end carries auth_failed, 401 and the errorMessage", () => {
    const { events } = feed(fresh(), [START, failedEnd(401, KEY_401), TERMINAL]);
    expect(events).toEqual([
      turnStart,
      {
        type: "error",
        data: {
          messageId: M,
          message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
          reason: "auth_failed",
          status: 401,
          detail: KEY_401,
        },
      },
      endedAs("failed"),
    ]);
  });

  it("a matching prompt failure response is agent_failed with the runtime text", () => {
    const { events } = feed(fresh(), [
      { type: "response", id: PROMPT, command: "prompt", success: false, error: "boom" },
    ]);
    expect(events).toEqual([
      {
        type: "error",
        data: {
          messageId: M,
          message: "Agent 运行失败",
          reason: "agent_failed",
          status: null,
          detail: "boom",
        },
      },
      endedAs("failed"),
    ]);
  });

  it("applyFailure is agent_failed too; an empty text falls back to the generic message", () => {
    expect(applyFailure(fresh(), "").events[0]).toEqual({
      type: "error",
      data: {
        messageId: M,
        message: "Agent 运行失败",
        reason: "agent_failed",
        status: null,
        detail: "Agent execution failed",
      },
    });
  });
});
