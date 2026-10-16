/**
 * Issue 1474 (chat-interleaved-segments 5.3, design D8): the web side of the segment positions.
 * Through the connector: chat-web「步骤开始事件的两个新字段严格解码」「审批请求事件的 stepId 严格解码」
 * and「思考结束事件经同一游标过滤并严格解码」(the `segment` part). Through `applyChatEvent` and
 * `chatStateFromSnapshot`: 「分段位置归约」, the `stepId` part of「审批请求与结算归约」and the view part
 * of「实时与快照切段一致」. Through `convertMessage`: the rewritten「convertMessage 映射」(new fields
 * passed through, part order unchanged). Oracles are the scenarios' literals.
 */
import { describe, expect, it } from "vitest";
import { convertMessage, messageCustom } from "../src/features/chat/runtime-convert.js";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { chatSnapshot, connectChat, runningSession, settle } from "./chat-stream-support.js";

const TITLE = "Allow tool: bash";

/** Connector with the snapshot at `1:seq` installed: one load, no events. */
async function installed(seq: number) {
  const snapshot = chatSnapshot({ cursor: { epoch: 1, seq } });
  const connector = connectChat(snapshot);
  connector.source.emitOpen();
  connector.loads.at(-1)?.resolve(snapshot);
  await settle();
  expect(connector.loads).toHaveLength(1);
  return connector;
}

function without(value: Record<string, unknown>, key: string) {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

describe("chat-web「步骤开始事件的两个新字段严格解码」", () => {
  const start = { messageId: 7, stepId: 5, name: "bash", detail: "{}", bodyOffset: 12 };

  it("delivers both step.start payloads in arrival order, every value kept", async () => {
    const connector = await installed(2);
    connector.source.emitData("step.start", "1:3", { ...start, approvalId: 9 });
    connector.source.emitData("step.start", "1:4", { ...start, stepId: 6, approvalId: null });
    expect(connector.events).toStrictEqual([
      { type: "step.start", data: { ...start, approvalId: 9 } },
      { type: "step.start", data: { ...start, stepId: 6, approvalId: null } },
    ]);
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  const full = { ...start, approvalId: 9 };
  const invalid: Array<[string, unknown]> = [
    ["the old four keys", { messageId: 7, stepId: 5, name: "bash", detail: "{}" }],
    ["a missing bodyOffset", without(full, "bodyOffset")],
    ["a missing approvalId", without(full, "approvalId")],
    ["bodyOffset null", { ...full, bodyOffset: null }],
    ["bodyOffset -1", { ...full, bodyOffset: -1 }],
    ["bodyOffset 1.5", { ...full, bodyOffset: 1.5 }],
    ['approvalId "9"', { ...full, approvalId: "9" }],
    ["one more key", { ...full, ordinal: 0 }],
  ];

  it.each(invalid)("%s starts a full-snapshot resync and is not delivered", async (_l, data) => {
    const connector = await installed(2);
    connector.source.emitData("step.start", "1:3", data);
    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(2);
  });
});

describe("chat-web「审批请求事件的 stepId 严格解码」", () => {
  const request = { messageId: 7, approvalId: 9, tool: "bash", title: TITLE, expiresAt: 1000 };

  it("delivers both approval.request payloads, stepId 5 and null", async () => {
    const connector = await installed(2);
    connector.source.emitData("approval.request", "1:3", { ...request, stepId: 5 });
    connector.source.emitData("approval.request", "1:4", {
      ...request,
      approvalId: 10,
      stepId: null,
    });
    expect(connector.events).toStrictEqual([
      { type: "approval.request", data: { ...request, stepId: 5 } },
      { type: "approval.request", data: { ...request, approvalId: 10, stepId: null } },
    ]);
    expect(connector.loads).toHaveLength(1);
  });

  const invalid: Array<[string, unknown]> = [
    ["the old five keys", request],
    ['stepId "5"', { ...request, stepId: "5" }],
    ["stepId 1.5", { ...request, stepId: 1.5 }],
    ["one more key", { ...request, stepId: 5, extra: 1 }],
  ];

  it.each(invalid)("%s starts a resync like any other known event", async (_l, data) => {
    const connector = await installed(2);
    connector.source.emitData("approval.request", "1:3", data);
    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(2);
  });
});

describe("chat-web「思考结束事件经同一游标过滤并严格解码」: the segment", () => {
  const segment = {
    bodyOffset: 5,
    thinkingOffset: 0,
    thinkingLength: 8,
    stepsBefore: 0,
    thinkingMs: 1200,
  };
  const end = { messageId: 7, thinkingMs: 1200, segment };

  it("drops thinking.end 1:3 at the 1:3 cursor and delivers 1:4 with its segment", async () => {
    const connector = await installed(3);
    connector.source.emitData("thinking.end", "1:3", end);
    connector.source.emitData("thinking.end", "1:4", end);
    expect(connector.events).toStrictEqual([{ type: "thinking.end", data: end }]);
    expect(connector.loads).toHaveLength(1);
  });

  const invalid: Array<[string, unknown]> = [
    ["the old two keys", { messageId: 7, thinkingMs: 1200 }],
    ["segment null", { ...end, segment: null }],
    ["a segment with one more key", { ...end, segment: { ...segment, extra: 1 } }],
    ["a segment missing a key", { ...end, segment: without(segment, "stepsBefore") }],
    ["segment thinkingLength null", { ...end, segment: { ...segment, thinkingLength: null } }],
    ["segment thinkingMs null", { ...end, segment: { ...segment, thinkingMs: null } }],
    ["segment bodyOffset -1", { ...end, segment: { ...segment, bodyOffset: -1 } }],
    ["segment thinkingOffset 1.5", { ...end, segment: { ...segment, thinkingOffset: 1.5 } }],
  ];

  it.each(invalid)("%s starts a full-snapshot resync and is not delivered", async (_l, data) => {
    const connector = await installed(3);
    connector.source.emitData("thinking.end", "1:4", data);
    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(2);
  });
});

/** Deep-freezes a value so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type Assistant = ChatMessageSnapshot["messages"][number];

/** A one-assistant snapshot (id 0) with the given fields over an empty running assistant. */
function snapshotWith(fields: Partial<Assistant> = {}): ChatMessageSnapshot {
  return {
    session: runningSession(fields.status === "done" ? "done" : "running"),
    messages: [
      {
        id: 0,
        role: "assistant",
        undo: null,
        attachments: [],
        approvals: [],
        content: "",
        status: "running",
        createdAt: 0,
        steps: [],
        thinking: null,
        error: null,
        thinkingMs: null,
        thinkingSegments: [],
        ...fields,
      },
    ],
    streamCursor: { epoch: 1, seq: 0 },
    todo: null,
  };
}

function assistant(state: ChatState) {
  const found = state.messages.find((message) => message.id === 0);
  if (found === undefined) throw new Error("missing assistant 0");
  return found;
}

/** Applies `events` in order, returning the state after each one. */
function run(state: ChatState, events: ChatEvent[]): ChatState[] {
  const states: ChatState[] = [];
  let current = state;
  for (const event of events) {
    current = applyChatEvent(current, event);
    states.push(current);
  }
  return states;
}

const M = { messageId: 0 };
const request = (approvalId: number, stepId: number | null): ChatEvent => ({
  type: "approval.request",
  data: { ...M, approvalId, tool: "bash", title: TITLE, expiresAt: 1000, stepId },
});
const stepStart = (stepId: number, bodyOffset: number, approvalId: number | null): ChatEvent => ({
  type: "step.start",
  data: { ...M, stepId, name: "bash", detail: "{}", bodyOffset, approvalId },
});
const thinkingEnd = (segment: {
  bodyOffset: number;
  thinkingOffset: number;
  thinkingLength: number;
  stepsBefore: number;
  thinkingMs: number;
}): ChatEvent => ({
  type: "thinking.end",
  data: { ...M, thinkingMs: segment.thinkingMs, segment },
});
const text = (delta: string): ChatEvent => ({ type: "text.delta", data: { ...M, delta } });
const think = (delta: string): ChatEvent => ({ type: "thinking.delta", data: { ...M, delta } });

describe("chat-web「分段位置归约」", () => {
  it("a temp segment at the first thinking.delta, replaced at thinking.end; step and approval linked", () => {
    const input = deepFreeze(chatStateFromSnapshot(snapshotWith()));
    const closed = {
      bodyOffset: 3,
      thinkingOffset: 0,
      thinkingLength: 3,
      stepsBefore: 0,
      thinkingMs: 900,
    };
    const states = run(input, [
      text("看一下"),
      think("先想"),
      think("想"),
      thinkingEnd(closed),
      request(7, null),
      stepStart(5, 3, 7),
      text("好了"),
      think("再想"),
    ]);
    const segments = states.map((state) => assistant(state).thinkingSegments);
    const open = { thinkingLength: null, thinkingMs: null };
    expect(segments[1]).toStrictEqual([
      { bodyOffset: 3, thinkingOffset: 0, stepsBefore: 0, ...open },
    ]);
    expect(segments[2]).toStrictEqual(segments[1]);
    expect(segments[3]).toStrictEqual([closed]);
    const linked = assistant(states[5] as ChatState);
    expect(linked.steps.map((step) => [step.id, step.bodyOffset])).toEqual([[5, 3]]);
    expect(linked.approvals.map((entry) => [entry.id, entry.stepId])).toEqual([[7, 5]]);
    expect(segments[7]).toStrictEqual([
      closed,
      { bodyOffset: 5, thinkingOffset: 3, stepsBefore: 1, ...open },
    ]);
    expect(assistant(input).thinkingSegments).toStrictEqual([]);
  });

  it("step.start without an approval, then approval.request with stepId 5: same as select-time pairing", () => {
    const input = deepFreeze(chatStateFromSnapshot(snapshotWith()));
    const [started, requested] = run(input, [stepStart(5, 0, null), request(7, 5)]);
    expect(assistant(started as ChatState).approvals).toEqual([]);
    expect(assistant(started as ChatState).steps.map((step) => step.bodyOffset)).toEqual([0]);
    const snapshotView = chatStateFromSnapshot(
      snapshotWith({
        steps: [{ ...STEP, id: 5, status: "running", bodyOffset: 0 }],
        approvals: [{ ...APPROVAL, id: 7, decision: null, stepId: 5 }],
      }),
    );
    expect(assistant(requested as ChatState).approvals).toStrictEqual(
      assistant(snapshotView).approvals,
    );
  });

  it("thinking.end on no segments appends; an unknown approvalId is ignored; turn.start clears", () => {
    const input = deepFreeze(chatStateFromSnapshot(snapshotWith()));
    const zero = {
      bodyOffset: 0,
      thinkingOffset: 0,
      thinkingLength: 0,
      stepsBefore: 0,
      thinkingMs: 300,
    };
    const [ended, , restarted] = run(input, [
      thinkingEnd(zero),
      stepStart(5, 0, 99),
      { type: "turn.start", data: M },
    ]);
    expect(assistant(ended as ChatState).thinkingSegments).toStrictEqual([zero]);

    const withApproval = deepFreeze(
      chatStateFromSnapshot(snapshotWith({ approvals: [{ ...APPROVAL, id: 7, decision: null }] })),
    );
    const [unknown] = run(withApproval, [stepStart(5, 0, 99)]);
    expect(assistant(unknown as ChatState).steps.map((step) => step.id)).toEqual([5]);
    expect(assistant(unknown as ChatState).approvals).toBe(assistant(withApproval).approvals);
    expect(assistant(restarted as ChatState).thinkingSegments).toStrictEqual([]);
  });
});

const STEP = {
  id: 4,
  ordinal: 0,
  name: "bash",
  detail: "{}",
  output: "ok",
  changes: null,
  status: "done" as const,
  bodyOffset: 5,
};
const APPROVAL = {
  id: 9,
  tool: "bash",
  title: TITLE,
  requestedAt: 0,
  expiresAt: 1000,
  decision: "allow" as const,
  stepId: null,
};

describe("chat-web「审批请求与结算归约」: the event's stepId", () => {
  it("approval.request with stepId null adds the pending entry with stepId null; resolved keeps it", () => {
    const input = deepFreeze(chatStateFromSnapshot(snapshotWith()));
    const [requested, resolved] = run(input, [
      request(7, null),
      { type: "approval.resolved", data: { ...M, approvalId: 7, decision: "allow" } },
    ]);
    const pending = { id: 7, tool: "bash", title: TITLE, expiresAt: 1000, stepId: null };
    expect(assistant(requested as ChatState).approvals).toStrictEqual([
      { ...pending, decision: null },
    ]);
    expect(assistant(resolved as ChatState).approvals).toStrictEqual([
      { ...pending, decision: "allow" },
    ]);
  });
});

describe("chat-web「实时与快照切段一致」: the view part", () => {
  const segment = {
    bodyOffset: 5,
    thinkingOffset: 0,
    thinkingLength: 1,
    stepsBefore: 0,
    thinkingMs: 600,
  };
  const head: ChatEvent[] = [text("先看一下。"), think("想")];
  const tail: ChatEvent[] = [
    thinkingEnd(segment),
    request(9, null),
    stepStart(4, 5, 9),
    { type: "approval.resolved", data: { ...M, approvalId: 9, decision: "allow" } },
    { type: "step.end", data: { ...M, stepId: 4, status: "done", output: "ok" } },
    text("好了"),
    { type: "turn.end", data: { ...M, status: "done" } },
  ];
  const finalSnapshot = snapshotWith({
    content: "先看一下。好了",
    thinking: "想",
    status: "done",
    thinkingMs: 600,
    thinkingSegments: [segment],
    steps: [STEP],
    approvals: [{ ...APPROVAL, stepId: 4 }],
  });
  const midSnapshot = snapshotWith({
    content: "先看一下。",
    thinking: "想",
    thinkingSegments: [{ ...segment, thinkingLength: null, thinkingMs: null }],
  });

  it("the reduced view equals the snapshot's view value by value at the turn's end", () => {
    const states = run(chatStateFromSnapshot(snapshotWith()), [...head, ...tail]);
    const live = assistant(states.at(-1) as ChatState);
    expect(live).toStrictEqual(assistant(chatStateFromSnapshot(finalSnapshot)));
    expect(live.thinkingSegments).toStrictEqual([segment]);
    expect(live.steps.map((step) => step.bodyOffset)).toEqual([5]);
    expect(live.approvals.map((entry) => entry.stepId)).toEqual([4]);
    // Mid-turn, the live view after thinking.delta equals the view of the snapshot read there.
    expect(assistant(states[1] as ChatState)).toStrictEqual(
      assistant(chatStateFromSnapshot(midSnapshot)),
    );
  });

  it("a snapshot read while the segment is open, resumed with the rest, ends at the same view", () => {
    const mid = assistant(chatStateFromSnapshot(midSnapshot));
    expect(mid.thinkingSegments).toStrictEqual(midSnapshot.messages[0]?.thinkingSegments);
    const resumed = run(chatStateFromSnapshot(midSnapshot), tail).at(-1) as ChatState;
    expect(assistant(resumed)).toStrictEqual(assistant(chatStateFromSnapshot(finalSnapshot)));
    expect(assistant(resumed).thinkingSegments).toStrictEqual([segment]);
  });
});

describe("chat-web「convertMessage 映射」: the segment fields pass through", () => {
  it("custom carries thinkingSegments, step bodyOffset and approval stepId; parts keep their order", () => {
    const view = assistant(
      chatStateFromSnapshot(
        snapshotWith({
          content: "先看一下。好了",
          thinking: "想",
          status: "done",
          thinkingMs: 600,
          thinkingSegments: [
            {
              bodyOffset: 5,
              thinkingOffset: 0,
              thinkingLength: 1,
              stepsBefore: 0,
              thinkingMs: 600,
            },
          ],
          steps: [STEP],
          approvals: [{ ...APPROVAL, stepId: 4 }],
        }),
      ),
    );
    const frozen = structuredClone(view);
    const converted = convertMessage(view);
    const custom = messageCustom(converted.metadata?.custom ?? {});
    expect(custom.thinkingSegments).toBe(view.thinkingSegments);
    expect(custom.steps.map((step) => step.bodyOffset)).toEqual([5]);
    expect(custom.approvals.map((entry) => entry.stepId)).toEqual([4]);
    const parts = Array.isArray(converted.content) ? converted.content : [];
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool-call"]);
    expect(view).toStrictEqual(frozen);
  });
});
