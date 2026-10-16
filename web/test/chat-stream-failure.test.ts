/**
 * Issue 909 tasks 7.3 / 7.4: chat-web「事件流消费与续流」Scenario「失败与重试事件严格解码」through the
 * connector, and「纯会话视图归约」Scenario「失败对象与重试标记归约」plus the twelve-event retrying
 * rule through `applyChatEvent`. Oracles are the scenarios' literals.
 */
import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import {
  type ChatConnectContext,
  chatSnapshot,
  connectChat,
  settle,
} from "./chat-stream-support.js";

const UPSTREAM = {
  reason: "upstream_error",
  message: "上游出错：模型服务内部错误",
  status: 503,
  detail: "模型服务返回 HTTP 503",
};
const AUTH = {
  reason: "auth_failed",
  message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
  status: 401,
  detail: "401 Incorrect API key provided",
};

/** Deep-freezes a value so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Connector with the `1:2` snapshot installed: one load, no events. */
async function installed(): Promise<ChatConnectContext> {
  const snapshot = chatSnapshot({ cursor: { epoch: 1, seq: 2 } });
  const connector = connectChat(snapshot);
  connector.source.emitOpen();
  connector.loads.at(-1)?.resolve(snapshot);
  await settle();
  expect(connector.loads).toHaveLength(1);
  return connector;
}

describe("chat-web「失败与重试事件严格解码」", () => {
  it("delivers turn.retry, a five-key error with a null status and turn.end failed in order", async () => {
    const connector = await installed();
    const timeout = { ...UPSTREAM, reason: "upstream_timeout", status: null };
    connector.source.emitData("turn.retry", "1:3", { messageId: 0 });
    connector.source.emitData("error", "1:4", { messageId: 0, ...timeout });
    connector.source.emitData("turn.end", "1:5", { messageId: 0, status: "failed" });
    expect(connector.events).toStrictEqual([
      { type: "turn.retry", data: { messageId: 0 } },
      { type: "error", data: { messageId: 0, ...timeout } },
      { type: "turn.end", data: { messageId: 0, status: "failed" } },
    ]);
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  const invalid: Array<[string, string, unknown]> = [
    ["the old two-key error", "error", { messageId: 0, message: "x" }],
    ["an error with one more key", "error", { messageId: 0, ...UPSTREAM, code: "x" }],
    ['an error with status "401"', "error", { messageId: 0, ...UPSTREAM, status: "401" }],
    ["an error with status 700", "error", { messageId: 0, ...UPSTREAM, status: 700 }],
    ['an error with reason ""', "error", { messageId: 0, ...UPSTREAM, reason: "" }],
    ["a turn.retry with one more key", "turn.retry", { messageId: 0, attempt: 1 }],
  ];

  it.each(invalid)(
    "%s starts a full-snapshot resync and is not delivered",
    async (_l, type, data) => {
      const connector = await installed();
      connector.source.emitData(type, "1:3", data);
      expect(connector.events).toEqual([]);
      expect(connector.loads).toHaveLength(2);
    },
  );
});

function runningState(): ChatState {
  return deepFreeze(chatStateFromSnapshot(chatSnapshot({ content: "前文" })));
}

function assistant(state: ChatState) {
  return state.messages.find((message) => message.id === 0);
}

describe("chat-web「失败对象与重试标记归约」", () => {
  it("turn.retry raises retrying and leaves everything else; text.delta lowers it", () => {
    const before = runningState();
    const retried = applyChatEvent(before, { type: "turn.retry", data: { messageId: 0 } });
    expect(assistant(retried)).toEqual({ ...assistant(before), retrying: true });
    expect(retried.status).toBe("running");
    expect(retried.messages[0]).toBe(before.messages[0]);
    const delta = applyChatEvent(retried, {
      type: "text.delta",
      data: { messageId: 0, delta: "x" },
    });
    expect(assistant(delta)).toMatchObject({ retrying: false, content: "前文x" });
  });

  it("turn.retry, error, turn.end failed: failed, retrying false, the event's object, session failed", () => {
    let state = runningState();
    for (const event of [
      { type: "turn.retry", data: { messageId: 0 } },
      { type: "error", data: { messageId: 0, ...UPSTREAM } },
      { type: "turn.end", data: { messageId: 0, status: "failed" } },
    ] satisfies ChatEvent[]) {
      state = deepFreeze(applyChatEvent(state, event));
    }
    expect(assistant(state)).toMatchObject({ status: "failed", retrying: false, error: UPSTREAM });
    expect(state.status).toBe("failed");
  });

  it("a snapshot whose last assistant failed gives the view its error object and retrying false", () => {
    const snapshot = chatSnapshot({ assistantStatus: "failed", status: "failed" });
    const failed = {
      ...snapshot,
      messages: snapshot.messages.map((message) =>
        message.role === "assistant" ? { ...message, error: AUTH } : message,
      ),
    };
    const view = chatStateFromSnapshot(deepFreeze(failed));
    expect(assistant(view)).toMatchObject({ error: AUTH, retrying: false });
  });

  const lowering: Array<[string, ChatEvent]> = [
    ["turn.start", { type: "turn.start", data: { messageId: 0 } }],
    ["text.delta", { type: "text.delta", data: { messageId: 0, delta: "x" } }],
    ["thinking.delta", { type: "thinking.delta", data: { messageId: 0, delta: "想" } }],
    [
      "step.start",
      {
        type: "step.start",
        data: {
          messageId: 0,
          stepId: 1,
          name: "bash",
          detail: "",
          bodyOffset: 2,
          approvalId: null,
        },
      },
    ],
    ["error", { type: "error", data: { messageId: 0, ...AUTH } }],
    ["turn.end done", { type: "turn.end", data: { messageId: 0, status: "done" } }],
    ["turn.end stopped", { type: "turn.end", data: { messageId: 0, status: "stopped" } }],
  ];

  it.each(lowering)("%s of the same assistant lowers retrying", (_label, event) => {
    const retried = deepFreeze(
      applyChatEvent(runningState(), { type: "turn.retry", data: { messageId: 0 } }),
    );
    expect(assistant(applyChatEvent(retried, event))?.retrying).toBe(false);
  });

  it("an event of another message, and a repeated turn.retry, keep the mark", () => {
    const retried = deepFreeze(
      applyChatEvent(runningState(), { type: "turn.retry", data: { messageId: 0 } }),
    );
    expect(applyChatEvent(retried, { type: "turn.retry", data: { messageId: 0 } })).toBe(retried);
    const other = applyChatEvent(retried, {
      type: "text.delta",
      data: { messageId: 9, delta: "x" },
    });
    expect(assistant(other)?.retrying).toBe(true);
  });

  it("turn.retry for an assistant the view does not hold appends a running one with the mark", () => {
    const state = applyChatEvent(runningState(), { type: "turn.retry", data: { messageId: 9 } });
    expect(state.messages.at(-1)).toMatchObject({
      id: 9,
      role: "assistant",
      status: "running",
      retrying: true,
      error: null,
      content: "",
    });
  });

  it("turn.retry aimed at a user message returns the same state", () => {
    const before = runningState();
    expect(applyChatEvent(before, { type: "turn.retry", data: { messageId: -3 } })).toBe(before);
  });
});
