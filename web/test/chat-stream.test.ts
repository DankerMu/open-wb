import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const USER_CONTENT = "\u0000\uFEFFKeep BOM 中文 😀";
const BASH_START_DETAIL = '{"command":"echo workbuddy-smoke"}';
const BASH_RESULT_DETAIL = '{"output":"workbuddy-smoke"}';
const STREAMED_BODY = "Hello \u0000\uFEFF中文 😀";
const AGENT_FAILURE = "Agent execution failed";

const runningSession = {
  id: SESSION_ID,
  title: "saved title",
  status: "running" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
};

const historyUser = {
  id: -3,
  role: "user" as const,
  content: USER_CONTENT,
  status: "done" as const,
  createdAt: -1,
  steps: [] as [],
};

const userView = {
  id: -3,
  role: "user" as const,
  content: USER_CONTENT,
  status: "done" as const,
  steps: [] as [],
  error: null,
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function reducerSnapshot(
  options: {
    sessionStatus?: "idle" | "running" | "done" | "failed";
    content?: string;
    assistantStatus?: "running" | "done" | "failed";
    steps?: ChatMessageSnapshot["messages"][number]["steps"];
    includeAssistant?: boolean;
    cursor?: { epoch: number; seq: number | null };
  } = {},
): ChatMessageSnapshot {
  const messages: ChatMessageSnapshot["messages"] = [historyUser];
  if (options.includeAssistant !== false) {
    messages.push({
      id: 0,
      role: "assistant",
      content: options.content ?? "",
      status: options.assistantStatus ?? "running",
      createdAt: 0,
      steps: options.steps ?? [],
    });
  }
  return {
    session: { ...runningSession, status: options.sessionStatus ?? "running" },
    messages,
    streamCursor: options.cursor ?? { epoch: 1, seq: null },
  };
}

const runningBashStep = {
  id: 11,
  ordinal: 0,
  name: "bash",
  detail: BASH_START_DETAIL,
  status: "running" as const,
};

describe("Chat stream reducer", () => {
  it("projects snapshot history then reduces a bash turn to exact done text and one keyed step", () => {
    const snapshot = reducerSnapshot();
    const events: ChatEvent[] = [
      { type: "turn.start", data: { messageId: 0 } },
      {
        type: "step.start",
        data: { messageId: 0, stepId: 11, name: "bash", detail: BASH_START_DETAIL },
      },
      { type: "text.delta", data: { messageId: 0, delta: "Hel" } },
      { type: "text.delta", data: { messageId: 0, delta: "lo " } },
      { type: "text.delta", data: { messageId: 0, delta: "\u0000\uFEFF中文 😀" } },
      {
        type: "step.end",
        data: { messageId: 0, stepId: 11, status: "done", detail: BASH_RESULT_DETAIL },
      },
      { type: "turn.end", data: { messageId: 0, status: "done" } },
    ];
    deepFreeze(events);

    const expected: ChatState = {
      status: "done",
      messages: [
        userView,
        {
          id: 0,
          role: "assistant",
          content: STREAMED_BODY,
          status: "done",
          steps: [
            {
              id: 11,
              name: "bash",
              detail: BASH_RESULT_DETAIL,
              status: "done",
            },
          ],
          error: null,
        },
      ],
    };

    const reduce = (source: ChatMessageSnapshot): ChatState => {
      const input = deepFreeze(structuredClone(source));
      let state = deepFreeze(chatStateFromSnapshot(input));
      expect(state).toEqual({
        status: "running",
        messages: [
          userView,
          {
            id: 0,
            role: "assistant",
            content: "",
            status: "running",
            steps: [],
            error: null,
          },
        ],
      });
      for (const event of events) {
        state = deepFreeze(applyChatEvent(state, event));
      }
      expect(input).toEqual(source);
      return state;
    };

    const first = reduce(snapshot);
    expect(first).toEqual(expected);
    expect(reduce(snapshot)).toEqual(first);
  });

  it("keeps session generating on business error then settles remaining running step on failed turn.end", () => {
    const snapshot = reducerSnapshot({
      content: STREAMED_BODY,
      steps: [runningBashStep],
    });
    const frozenSnapshot = deepFreeze(structuredClone(snapshot));
    const afterError = deepFreeze(
      applyChatEvent(deepFreeze(chatStateFromSnapshot(frozenSnapshot)), {
        type: "error",
        data: { messageId: 0, message: AGENT_FAILURE },
      }),
    );

    expect(afterError).toEqual({
      status: "running",
      messages: [
        userView,
        {
          id: 0,
          role: "assistant",
          content: STREAMED_BODY,
          status: "failed",
          steps: [
            {
              id: 11,
              name: "bash",
              detail: BASH_START_DETAIL,
              status: "running",
            },
          ],
          error: AGENT_FAILURE,
        },
      ],
    });

    const afterEnd = deepFreeze(
      applyChatEvent(afterError, { type: "turn.end", data: { messageId: 0, status: "failed" } }),
    );
    expect(afterEnd).toEqual({
      status: "failed",
      messages: [
        userView,
        {
          id: 0,
          role: "assistant",
          content: STREAMED_BODY,
          status: "failed",
          steps: [
            {
              id: 11,
              name: "bash",
              detail: BASH_START_DETAIL,
              status: "failed",
            },
          ],
          error: AGENT_FAILURE,
        },
      ],
    });
    expect(frozenSnapshot).toEqual(snapshot);
  });

  it("resets a failed assistant and session to running without rewriting user history", () => {
    const snapshot = reducerSnapshot({
      content: STREAMED_BODY,
      steps: [runningBashStep],
    });
    const frozenSnapshot = deepFreeze(structuredClone(snapshot));
    const afterError = applyChatEvent(deepFreeze(chatStateFromSnapshot(frozenSnapshot)), {
      type: "error",
      data: { messageId: 0, message: AGENT_FAILURE },
    });
    const dirty = deepFreeze(
      applyChatEvent(afterError, { type: "turn.end", data: { messageId: 0, status: "failed" } }),
    );
    expect(dirty.status).toBe("failed");
    expect(dirty.messages[0]).toEqual(userView);
    expect(dirty.messages[1]).toEqual({
      id: 0,
      role: "assistant",
      content: STREAMED_BODY,
      status: "failed",
      steps: [
        {
          id: 11,
          name: "bash",
          detail: BASH_START_DETAIL,
          status: "failed",
        },
      ],
      error: AGENT_FAILURE,
    });

    const reset = applyChatEvent(dirty, { type: "turn.start", data: { messageId: 0 } });
    expect(reset.status).toBe("running");
    expect(reset.messages[0]).toEqual(userView);
    expect(reset.messages[1]).toEqual({
      id: 0,
      role: "assistant",
      content: "",
      status: "running",
      steps: [],
      error: null,
    });
    expect(frozenSnapshot).toEqual(snapshot);
  });

  it("materializes an absent assistant for a lone terminal without rewriting history", () => {
    const snapshot = reducerSnapshot({
      sessionStatus: "idle",
      includeAssistant: false,
    });

    for (const status of ["done", "failed"] as const) {
      const frozenSnapshot = deepFreeze(structuredClone(snapshot));
      const initial = deepFreeze(chatStateFromSnapshot(frozenSnapshot));
      const final = applyChatEvent(initial, {
        type: "turn.end",
        data: { messageId: 0, status },
      });

      expect(final.status).toBe(status);
      expect(final.messages).toEqual([
        userView,
        {
          id: 0,
          role: "assistant",
          content: "",
          status,
          steps: [],
          error: null,
        },
      ]);
      expect(initial.messages).toHaveLength(1);
      expect(frozenSnapshot).toEqual(snapshot);
    }
  });

  it("keeps the session generating after a pre-start error until the failed terminal", () => {
    const snapshot = reducerSnapshot({
      sessionStatus: "idle",
      includeAssistant: false,
    });
    const frozenSnapshot = deepFreeze(structuredClone(snapshot));
    const afterError = applyChatEvent(deepFreeze(chatStateFromSnapshot(frozenSnapshot)), {
      type: "error",
      data: { messageId: 0, message: " exact error \u0000\uFEFF中文 😀 " },
    });

    expect(afterError.status).toBe("running");
    expect(afterError.messages).toEqual([
      userView,
      {
        id: 0,
        role: "assistant",
        content: "",
        status: "failed",
        steps: [],
        error: " exact error \u0000\uFEFF中文 😀 ",
      },
    ]);

    const afterEnd = applyChatEvent(afterError, {
      type: "turn.end",
      data: { messageId: 0, status: "failed" },
    });
    expect(afterEnd.status).toBe("failed");
    expect(afterEnd.messages).toHaveLength(2);
    expect(afterEnd.messages[1]?.error).toBe(" exact error \u0000\uFEFF中文 😀 ");
    expect(frozenSnapshot).toEqual(snapshot);
  });

  it("leaves the whole state unchanged when events target a user message", () => {
    const snapshot = reducerSnapshot({
      sessionStatus: "done",
      includeAssistant: false,
    });
    const initial = deepFreeze(chatStateFromSnapshot(deepFreeze(structuredClone(snapshot))));
    const events: ChatEvent[] = [
      { type: "turn.start", data: { messageId: -3 } },
      { type: "text.delta", data: { messageId: -3, delta: "bad" } },
      {
        type: "step.start",
        data: { messageId: -3, stepId: 1, name: "bad", detail: "bad" },
      },
      {
        type: "step.end",
        data: { messageId: -3, stepId: 1, status: "failed", detail: "bad" },
      },
      { type: "error", data: { messageId: -3, message: "bad" } },
      { type: "turn.end", data: { messageId: -3, status: "failed" } },
    ];

    for (const event of events) {
      expect(applyChatEvent(initial, event)).toBe(initial);
    }
    expect(
      applyChatEvent(initial, {
        type: "future.event",
        data: { messageId: -3 },
      } as unknown as ChatEvent),
    ).toBe(initial);
  });

  it("settles only remaining running steps and continues a snapshot step by id", () => {
    const snapshot = reducerSnapshot({
      content: STREAMED_BODY,
      cursor: { epoch: 1, seq: 1 },
      steps: [
        { id: 3, ordinal: 0, name: "first", detail: "done", status: "done" },
        { id: 4, ordinal: 1, name: "second", detail: "running", status: "running" },
        { id: 5, ordinal: 2, name: "third", detail: "failed", status: "failed" },
      ],
    });
    const frozenSnapshot = deepFreeze(structuredClone(snapshot));
    const initial = deepFreeze(chatStateFromSnapshot(frozenSnapshot));
    const continued = applyChatEvent(initial, {
      type: "step.end",
      data: { messageId: 0, stepId: 4, status: "done", detail: "result 世界" },
    });
    expect(continued.messages[1]?.steps).toEqual([
      { id: 3, name: "first", detail: "done", status: "done" },
      { id: 4, name: "second", detail: "result 世界", status: "done" },
      { id: 5, name: "third", detail: "failed", status: "failed" },
    ]);

    const started = applyChatEvent(continued, {
      type: "step.start",
      data: { messageId: 0, stepId: 4, name: "second", detail: "duplicate" },
    });
    expect(started.messages[1]?.steps).toHaveLength(3);
    expect(
      applyChatEvent(started, {
        type: "step.end",
        data: { messageId: 0, stepId: 999, status: "failed", detail: "unknown" },
      }),
    ).toEqual(started);

    const ended = applyChatEvent(started, {
      type: "turn.end",
      data: { messageId: 0, status: "failed" },
    });
    expect(ended.messages[1]?.content).toBe(STREAMED_BODY);
    expect(ended.messages[1]?.steps.map((step) => step.status)).toEqual(["done", "done", "failed"]);
    expect(ended.status).toBe("failed");
    expect(frozenSnapshot).toEqual(snapshot);
  });

  it("clears a prior error on a successful terminal", () => {
    const snapshot = reducerSnapshot({ includeAssistant: false });
    const afterError = applyChatEvent(chatStateFromSnapshot(snapshot), {
      type: "error",
      data: { messageId: 0, message: AGENT_FAILURE },
    });
    const done = applyChatEvent(afterError, {
      type: "turn.end",
      data: { messageId: 0, status: "done" },
    });
    expect(done.status).toBe("done");
    expect(done.messages[1]).toEqual({
      id: 0,
      role: "assistant",
      content: "",
      status: "done",
      steps: [],
      error: null,
    });
  });
});
