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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe("Chat stream reducer", () => {
  it("projects snapshot history then reduces a bash turn to exact done text and one keyed step", () => {
    const snapshot: ChatMessageSnapshot = {
      session: {
        id: SESSION_ID,
        title: "saved title",
        status: "running",
        createdAt: 1_740_000_000_000,
        updatedAt: 1_740_000_000_023,
      },
      messages: [
        {
          id: -3,
          role: "user",
          content: USER_CONTENT,
          status: "done",
          createdAt: -1,
          steps: [],
        },
        {
          id: 0,
          role: "assistant",
          content: "",
          status: "running",
          createdAt: 0,
          steps: [],
        },
      ],
      streamCursor: { epoch: 1, seq: null },
    };
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

    const userView = {
      id: -3,
      role: "user" as const,
      content: USER_CONTENT,
      status: "done" as const,
      steps: [],
      error: null,
    };
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
});
