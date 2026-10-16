/**
 * Issue 910 slice 3c (task 3.4): chat-web「事件流消费与续流」Scenario「思考结束事件经同一游标过滤并
 * 严格解码」through the connector, and「纯会话视图归约」Scenario「思考时长与进行中标记归约」plus the
 * turn.start / turn.end rules for `thinkingMs` and `thinkingActive` through `applyChatEvent` and
 * `chatStateFromSnapshot`. Oracles are the scenarios' literals.
 */
import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { chatSnapshot, connectChat, historyUser, settle } from "./chat-stream-support.js";

/** Deep-freezes a value so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** chat-web scenario literal: the segment a `thinking.end` of 1200 ms carries (issue 1474). */
const SEGMENT = {
  bodyOffset: 5,
  thinkingOffset: 0,
  thinkingLength: 8,
  stepsBefore: 0,
  thinkingMs: 1200,
};

/** A closed segment of `ms` with no thinking text before it, at body offset `body`. */
function segmentOf(ms: number, body = 0) {
  return { bodyOffset: body, thinkingOffset: 0, thinkingLength: 0, stepsBefore: 0, thinkingMs: ms };
}

/** Connector with the `1:3` snapshot installed: one load, no events. */
async function installed() {
  const snapshot = chatSnapshot({ cursor: { epoch: 1, seq: 3 } });
  const connector = connectChat(snapshot);
  connector.source.emitOpen();
  connector.loads.at(-1)?.resolve(snapshot);
  await settle();
  expect(connector.loads).toHaveLength(1);
  return connector;
}

describe("chat-web「思考结束事件经同一游标过滤并严格解码」", () => {
  it("drops thinking.end 1:3 at the 1:3 snapshot cursor and delivers 1:4 with its payload", async () => {
    const connector = await installed();
    connector.source.emitData("thinking.end", "1:3", {
      messageId: 7,
      thinkingMs: 900,
      segment: { ...SEGMENT, thinkingMs: 900 },
    });
    connector.source.emitData("thinking.end", "1:4", {
      messageId: 7,
      thinkingMs: 1200,
      segment: SEGMENT,
    });
    expect(connector.events).toStrictEqual([
      { type: "thinking.end", data: { messageId: 7, thinkingMs: 1200, segment: SEGMENT } },
    ]);
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  it("delivers thinking.end with thinkingMs 0 verbatim and starts no resync (0 is in range)", async () => {
    const connector = await installed();
    const zero = { ...SEGMENT, thinkingMs: 0 };
    connector.source.emitData("thinking.end", "1:4", {
      messageId: 7,
      thinkingMs: 0,
      segment: zero,
    });
    expect(connector.events).toStrictEqual([
      { type: "thinking.end", data: { messageId: 7, thinkingMs: 0, segment: zero } },
    ]);
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  const invalid: Array<[string, unknown]> = [
    ["thinkingMs -1", { messageId: 7, thinkingMs: -1, segment: SEGMENT }],
    ["thinkingMs 1.5", { messageId: 7, thinkingMs: 1.5, segment: SEGMENT }],
    ['thinkingMs "1200"', { messageId: 7, thinkingMs: "1200", segment: SEGMENT }],
    ["a missing thinkingMs", { messageId: 7, segment: SEGMENT }],
    ["one more key", { messageId: 7, thinkingMs: 1200, segment: SEGMENT, total: 1200 }],
    ["messageId 7.5", { messageId: 7.5, thinkingMs: 1200, segment: SEGMENT }],
    ["messageId 2**53", { messageId: 2 ** 53, thinkingMs: 1200, segment: SEGMENT }],
  ];

  it.each(invalid)("%s starts a full-snapshot resync and is not delivered", async (_l, data) => {
    const connector = await installed();
    connector.source.emitData("thinking.end", "1:4", data);
    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(2);
  });
});

function assistant(state: ChatState, messageId = 0) {
  return state.messages.find((message) => message.id === messageId);
}

/** The running assistant 0 (`thinking` null, `thinkingMs` null) behind user -3. */
function runningState(): ChatState {
  return deepFreeze(chatStateFromSnapshot(chatSnapshot({ content: "前文" })));
}

const STEP: ChatEvent = {
  type: "step.start",
  data: { messageId: 0, stepId: 1, name: "bash", detail: "", bodyOffset: 2, approvalId: null },
};

describe("chat-web「思考时长与进行中标记归约」", () => {
  it("delta, end 400, step, delta, end 1200, turn.end: active and duration after each event", () => {
    const sequence: ChatEvent[] = [
      { type: "thinking.delta", data: { messageId: 0, delta: "先" } },
      {
        type: "thinking.end",
        data: {
          messageId: 0,
          thinkingMs: 400,
          segment: { ...segmentOf(400, 2), thinkingLength: 1 },
        },
      },
      STEP,
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
      {
        type: "thinking.end",
        data: {
          messageId: 0,
          thinkingMs: 1200,
          segment: {
            bodyOffset: 2,
            thinkingOffset: 1,
            thinkingLength: 1,
            stepsBefore: 1,
            thinkingMs: 800,
          },
        },
      },
      { type: "turn.end", data: { messageId: 0, status: "done" } },
    ];
    let state = runningState();
    const active: boolean[] = [];
    const durations: Array<number | null> = [];
    for (const event of sequence) {
      const before = assistant(state);
      state = deepFreeze(applyChatEvent(state, event));
      const after = assistant(state);
      active.push(after?.thinkingActive === true);
      durations.push(after === undefined ? -1 : after.thinkingMs);
      if (event.type === "thinking.end") {
        // Body, thinking, steps and session status are untouched by thinking.end.
        expect(after?.content).toBe(before?.content);
        expect(after?.thinking).toBe(before?.thinking);
        expect(after?.steps).toBe(before?.steps);
        expect(state.status).toBe("running");
      }
    }
    expect(active).toEqual([true, false, false, true, false, false]);
    expect(durations).toEqual([null, 400, 400, 400, 1200, 1200]);
    expect(assistant(state)).toMatchObject({ thinking: "先想", content: "前文", status: "done" });
    expect(assistant(state)?.steps.map((step) => step.id)).toEqual([1]);
  });

  it("from a snapshot: active only for a running message with thinking and a null thinkingMs", () => {
    const base = chatSnapshot();
    const [, template] = base.messages;
    if (template === undefined) throw new Error("missing assistant template");
    const assistants: ChatMessageSnapshot["messages"] = [
      { ...template, id: 1, status: "running", thinking: "先", thinkingMs: null },
      { ...template, id: 2, status: "running", thinking: "先", thinkingMs: 400 },
      { ...template, id: 3, status: "done", thinking: "先", thinkingMs: null },
      { ...template, id: 4, status: "running", thinking: "", thinkingMs: null },
      { ...template, id: 5, status: "running", thinking: null, thinkingMs: null },
    ];
    const view = chatStateFromSnapshot(
      deepFreeze({ ...base, messages: [historyUser, ...assistants] }),
    );
    expect(view.messages.map((message) => [message.thinkingActive, message.thinkingMs])).toEqual([
      [false, null],
      [true, null],
      [false, 400],
      [false, null],
      [false, null],
      [false, null],
    ]);
  });

  it("thinking.end for an unknown id appends a running assistant; aimed at a user it is a no-op", () => {
    const before = runningState();
    const appended = applyChatEvent(before, {
      type: "thinking.end",
      data: { messageId: 9, thinkingMs: 900, segment: segmentOf(900) },
    });
    expect(appended.messages.at(-1)).toMatchObject({
      id: 9,
      role: "assistant",
      status: "running",
      thinkingMs: 900,
      thinkingActive: false,
      thinking: null,
      content: "",
    });
    expect(appended.messages.slice(0, -1)).toEqual(before.messages);
    expect(
      applyChatEvent(before, {
        type: "thinking.end",
        data: { messageId: -3, thinkingMs: 900, segment: segmentOf(900) },
      }),
    ).toBe(before);
  });

  it("turn.start resets thinkingMs to null and thinkingActive to false", () => {
    let state = runningState();
    for (const event of [
      { type: "thinking.end", data: { messageId: 0, thinkingMs: 400, segment: segmentOf(400, 2) } },
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
    ] satisfies ChatEvent[]) {
      state = deepFreeze(applyChatEvent(state, event));
    }
    expect(assistant(state)).toMatchObject({ thinkingMs: 400, thinkingActive: true });
    const restarted = applyChatEvent(state, { type: "turn.start", data: { messageId: 0 } });
    expect(assistant(restarted)).toMatchObject({
      thinking: null,
      thinkingMs: null,
      thinkingActive: false,
    });
  });

  it.each(["done", "failed", "stopped"] as const)(
    "turn.end %s while thinking is active lowers the mark and keeps thinkingMs",
    (status) => {
      const thinking = deepFreeze(
        applyChatEvent(runningState(), {
          type: "thinking.delta",
          data: { messageId: 0, delta: "想" },
        }),
      );
      expect(assistant(thinking)?.thinkingActive).toBe(true);
      const ended = applyChatEvent(thinking, { type: "turn.end", data: { messageId: 0, status } });
      expect(assistant(ended)).toMatchObject({ status, thinkingActive: false, thinkingMs: null });
    },
  );

  it("thinking.end leaves the retrying mark as it was", () => {
    const retried = deepFreeze(
      applyChatEvent(runningState(), { type: "turn.retry", data: { messageId: 0 } }),
    );
    const ended = applyChatEvent(retried, {
      type: "thinking.end",
      data: { messageId: 0, thinkingMs: 400, segment: segmentOf(400, 2) },
    });
    expect(assistant(ended)).toMatchObject({ retrying: true, thinkingMs: 400 });
  });

  it.each(["idle", "done", "failed"] as const)(
    "thinking.end on a view whose session is %s leaves the session status unchanged",
    (status) => {
      const settled = deepFreeze(
        chatStateFromSnapshot(chatSnapshot({ status, assistantStatus: "done", content: "答" })),
      );
      const ended = applyChatEvent(settled, {
        type: "thinking.end",
        data: { messageId: 0, thinkingMs: 400, segment: segmentOf(400, 1) },
      });
      expect(ended.status).toBe(status);
      expect(assistant(ended)).toMatchObject({ status: "done", thinkingMs: 400 });
    },
  );
});
