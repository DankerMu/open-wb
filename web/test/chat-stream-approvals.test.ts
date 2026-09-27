/**
 * Issue #476 snapshot `approvals` strict parsing, approval.* reduction and connector delivery
 * (parent s1c tasks 5.3), W1–W11. Parsing goes through `createApiClient().getMessages` with a
 * stubbed fetch; reduction through `chatStateFromSnapshot`/`applyChatEvent` on frozen inputs;
 * delivery through `connectSessionEvents` over the fake EventSource. Expected values are fixture
 * literals from the chat-web and tool-approval spec deltas.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import { createApiClient } from "../src/lib/api.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  chatSnapshot,
  connectChat,
  resetFakeEventSources,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const T = 1_700_000_000_000;
const E = T + 60_000;
const TITLE = "Allow tool: bash\nCommand: echo 中文 😀\u0000尾";
const UNSAFE_INTEGER = 2 ** 53;

type Snapshot = ChatMessageSnapshot;
type SnapshotMessage = Snapshot["messages"][number];
type SnapshotApproval = SnapshotMessage["approvals"][number];

function approval(
  id: number,
  decision: SnapshotApproval["decision"],
  overrides: Partial<SnapshotApproval> = {},
): SnapshotApproval {
  return { id, tool: "bash", title: TITLE, requestedAt: T, expiresAt: E, decision, ...overrides };
}

function view(id: number, decision: SnapshotApproval["decision"]) {
  return { id, tool: "bash", title: TITLE, expiresAt: E, decision };
}

function userMessage(approvals: SnapshotApproval[] = []): SnapshotMessage {
  return {
    id: -3,
    role: "user",
    content: "\u0000﻿Keep BOM 中文 😀",
    status: "done",
    createdAt: -1,
    steps: [],
    approvals,
  };
}

function assistantMessage(
  id: number,
  approvals: SnapshotApproval[],
  status: SnapshotMessage["status"] = "running",
): SnapshotMessage {
  return { id, role: "assistant", content: "", status, createdAt: id, steps: [], approvals };
}

/** W1 base: stopped session/message/step, user [], assistants with [], one pending, two rows. */
function parsedSnapshot(): Snapshot {
  return {
    session: { ...chatSnapshot().session, status: "stopped" },
    messages: [
      userMessage(),
      {
        ...assistantMessage(0, [], "stopped"),
        content: "partial",
        steps: [{ id: 2, ordinal: 0, name: "bash", detail: "ls", output: "o", status: "stopped" }],
      },
      assistantMessage(1, [approval(5, null)], "done"),
      assistantMessage(2, [approval(7, "timeout"), approval(8, null)], "done"),
    ],
    streamCursor: { epoch: 1, seq: 7 },
  };
}

/** Running session with one assistant (id 0) whose approvals are given. */
function runningSnapshot(
  approvals: SnapshotApproval[] = [],
  options: { status?: Snapshot["session"]["status"]; cursor?: Snapshot["streamCursor"] } = {},
): Snapshot {
  const status = options.status ?? "running";
  return {
    session: { ...chatSnapshot().session, status },
    messages: [
      userMessage(),
      assistantMessage(0, approvals, status === "running" ? "running" : "done"),
    ],
    streamCursor: options.cursor ?? { epoch: 1, seq: 0 },
  };
}

/** Freezes every nested object so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function frozenState(snapshot: Snapshot): ChatState {
  return deepFreeze(chatStateFromSnapshot(deepFreeze(snapshot)));
}

function requestEvent(messageId: number, approvalId: number): ChatEvent {
  return {
    type: "approval.request",
    data: { messageId, approvalId, tool: "bash", title: TITLE, expiresAt: E },
  };
}

function resolvedEvent(
  messageId: number,
  approvalId: number,
  decision: "allow" | "deny" | "timeout",
): ChatEvent {
  return { type: "approval.resolved", data: { messageId, approvalId, decision } };
}

function approvalsOf(state: ChatState, messageId = 0) {
  return state.messages.find((entry) => entry.id === messageId)?.approvals;
}

function stubFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
}

/** Replaces message `index` of the W1 base with `change(message)`. */
function withMessage(index: number, change: (message: Record<string, unknown>) => unknown) {
  const base = parsedSnapshot();
  const messages: unknown[] = base.messages.slice();
  messages[index] = change({ ...base.messages[index] });
  return { ...base, messages };
}

function withoutKey(record: Record<string, unknown>, key: string) {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** Replaces the approvals of assistant C (index 3) with `approvals`. */
function withApprovals(approvals: unknown) {
  return withMessage(3, (message) => ({ ...message, approvals }));
}

async function connectInstalled(snapshot: Snapshot) {
  const context = connectChat(snapshot);
  context.source.emitOpen();
  context.loads[0]?.resolve(snapshot);
  await settle();
  expect(context.snapshots).toHaveLength(1);
  return context;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetFakeEventSources();
});

describe("snapshot approvals strict parsing", () => {
  it("W1 keeps [], a single pending and two ascending approvals value for value", async () => {
    const snapshot = parsedSnapshot();
    stubFetch(snapshot);

    await expect(createApiClient().getMessages(SESSION_ID)).resolves.toEqual(snapshot);
  });

  const rejected: Array<[string, () => unknown]> = [
    ["a user message without approvals", () => withMessage(0, (m) => withoutKey(m, "approvals"))],
    [
      "an assistant message without approvals",
      () => withMessage(1, (m) => withoutKey(m, "approvals")),
    ],
    ["approvals null", () => withApprovals(null)],
    ["approvals as an object", () => withApprovals({})],
    [
      "an element with an extra decidedAt",
      () => withApprovals([{ ...approval(7, null), decidedAt: T }]),
    ],
    [
      "an element without requestedAt",
      () => withApprovals([withoutKey({ ...approval(7, null) }, "requestedAt")]),
    ],
    ["an unknown decision", () => withApprovals([{ ...approval(7, null), decision: "maybe" }])],
    ["a non-string tool", () => withApprovals([{ ...approval(7, null), tool: 1 }])],
    ["an unsafe element id", () => withApprovals([approval(UNSAFE_INTEGER, null)])],
    ["ids out of order", () => withApprovals([approval(8, null), approval(7, "timeout")])],
    ["a duplicated id", () => withApprovals([approval(7, "timeout"), approval(7, null)])],
    [
      "a user message with an approval",
      () => withMessage(0, (m) => ({ ...m, approvals: [approval(4, null)] })),
    ],
  ];

  it.each(rejected)("W2 rejects the whole snapshot for %s", async (_name, build) => {
    stubFetch(build());

    expectRequestFailure(await captureApiError(createApiClient().getMessages(SESSION_ID)), 200);
  });
});

describe("approval snapshot and event reduction", () => {
  it("W3 maps snapshot approvals to views without requestedAt, in order", () => {
    const snapshot = deepFreeze(parsedSnapshot());
    const before = structuredClone(snapshot);

    const state = chatStateFromSnapshot(snapshot);

    expect(state.messages.map((entry) => entry.approvals)).toStrictEqual([
      [],
      [],
      [view(5, null)],
      [view(7, "timeout"), view(8, null)],
    ]);
    expect(snapshot).toEqual(before);
  });

  it("W4 appends a pending approval then settles only its decision", () => {
    const state = frozenState(runningSnapshot());

    const requested = applyChatEvent(state, requestEvent(0, 7));
    expect(approvalsOf(requested)).toStrictEqual([view(7, null)]);
    expect(requested.status).toBe("running");
    expect(requested.messages[0]).toBe(state.messages[0]);

    const resolved = applyChatEvent(deepFreeze(requested), resolvedEvent(0, 7, "allow"));
    expect(approvalsOf(resolved)).toStrictEqual([view(7, "allow")]);
    expect(resolved.status).toBe("running");
    expect(resolved.messages[0]).toBe(state.messages[0]);
  });

  it("W5 unknown targets and replays keep the same state reference", () => {
    const empty = frozenState(runningSnapshot());
    const pendingState = deepFreeze(applyChatEvent(empty, requestEvent(0, 7)));
    const allowed = deepFreeze(applyChatEvent(pendingState, resolvedEvent(0, 7, "allow")));

    const unchanged: Array<[ChatState, ChatEvent]> = [
      [pendingState, resolvedEvent(0, 8, "deny")],
      [empty, resolvedEvent(0, 7, "allow")],
      [pendingState, resolvedEvent(99, 7, "allow")],
      [pendingState, requestEvent(-3, 7)],
      [pendingState, resolvedEvent(-3, 7, "allow")],
      [pendingState, requestEvent(0, 7)],
      [allowed, requestEvent(0, 7)],
      [allowed, resolvedEvent(0, 7, "allow")],
    ];
    for (const [input, event] of unchanged) {
      const next = applyChatEvent(input, event);
      expect(next).toBe(input);
      expect(next.messages).toHaveLength(2);
    }
    expect(approvalsOf(allowed)).toStrictEqual([view(7, "allow")]);
  });

  it("W5 a request for an unknown assistant creates it with that single pending entry", () => {
    const state = frozenState(runningSnapshot([], { status: "done" }));

    const next = applyChatEvent(state, requestEvent(99, 7));

    expect(next).not.toBe(state);
    expect(next.messages).toHaveLength(3);
    expect(next.messages.at(-1)).toStrictEqual({
      id: 99,
      role: "assistant",
      content: "",
      status: "running",
      steps: [],
      approvals: [view(7, null)],
      error: null,
    });
    expect(next.status).toBe("done");
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.messages[1]).toBe(state.messages[1]);
  });

  it("W6 turn.start clears the assistant approvals", () => {
    const state = frozenState(runningSnapshot());
    const settled = deepFreeze(
      applyChatEvent(applyChatEvent(state, requestEvent(0, 7)), resolvedEvent(0, 7, "allow")),
    );

    const restarted = applyChatEvent(settled, { type: "turn.start", data: { messageId: 0 } });

    expect(approvalsOf(restarted)).toStrictEqual([]);
    expect(restarted.messages[0]).toBe(settled.messages[0]);
  });

  it("W7 approval.request never changes the session status", () => {
    const state = frozenState(runningSnapshot([approval(7, null)], { status: "done" }));

    expect(applyChatEvent(state, requestEvent(0, 7))).toBe(state);
    const next = applyChatEvent(state, requestEvent(0, 9));

    expect(next.status).toBe("done");
    expect(approvalsOf(next)?.map((entry) => entry.id)).toEqual([7, 9]);
  });

  it("W8 parallel requests keep id order, never overwrite, and replay idempotently", () => {
    const state = frozenState(runningSnapshot());
    const events = [requestEvent(0, 8), requestEvent(0, 7), resolvedEvent(0, 8, "deny")];

    const first = deepFreeze(applyChatEvent(state, requestEvent(0, 8)));
    const second = deepFreeze(applyChatEvent(first, requestEvent(0, 7)));
    expect(approvalsOf(second)).toStrictEqual([view(7, null), view(8, null)]);
    expect(approvalsOf(second)?.[1]).toBe(approvalsOf(first)?.[0]);
    const third = deepFreeze(applyChatEvent(second, resolvedEvent(0, 8, "deny")));
    expect(approvalsOf(third)).toStrictEqual([view(7, null), view(8, "deny")]);
    expect(approvalsOf(third)?.[0]).toBe(approvalsOf(second)?.[0]);
    expect(third.status).toBe("running");

    for (const event of events) {
      expect(applyChatEvent(third, event)).toBe(third);
    }
    const fromSnapshot = chatStateFromSnapshot(
      runningSnapshot([approval(7, null), approval(8, "deny")]),
    );
    expect(approvalsOf(third)).toStrictEqual(approvalsOf(fromSnapshot));
  });
});

describe("approval events through the connector", () => {
  it("W9 approval events are filtered by the same stream cursor", async () => {
    const context = await connectInstalled(runningSnapshot([], { cursor: { epoch: 1, seq: 5 } }));

    context.source.emitData("approval.request", "1:5", {
      messageId: 0,
      approvalId: 6,
      tool: "bash",
      title: TITLE,
      expiresAt: E,
    });
    context.source.emitData("approval.resolved", "1:6", {
      messageId: 0,
      approvalId: 7,
      decision: "allow",
    });
    context.source.emitData("turn.end", "1:7", { messageId: 0, status: "stopped" });

    expect(context.events).toStrictEqual([
      { type: "approval.resolved", data: { messageId: 0, approvalId: 7, decision: "allow" } },
      { type: "turn.end", data: { messageId: 0, status: "stopped" } },
    ]);
    expect(context.loads).toHaveLength(1);
    expect(context.errors).toEqual([]);
  });

  it("W10 decoded approval events reach onEvent and the reduced view", async () => {
    const context = await connectInstalled(runningSnapshot([], { cursor: { epoch: 1, seq: 5 } }));
    const requestData = { messageId: 0, approvalId: 7, tool: "bash", title: TITLE, expiresAt: E };

    context.source.emitData("approval.request", "1:6", requestData);
    context.source.emitData("approval.resolved", "1:7", {
      messageId: 0,
      approvalId: 7,
      decision: "deny",
    });

    expect(context.events).toStrictEqual([
      { type: "approval.request", data: requestData },
      { type: "approval.resolved", data: { messageId: 0, approvalId: 7, decision: "deny" } },
    ]);
    expect(approvalsOf(context.state)).toStrictEqual([view(7, "deny")]);
    expect(context.loads).toHaveLength(1);
  });

  const validRequest = { messageId: 0, approvalId: 7, tool: "bash", title: TITLE, expiresAt: E };
  const invalid: Array<[string, string, string, unknown]> = [
    ["request with an extra key", "approval.request", "1:6", { ...validRequest, extra: 1 }],
    [
      "request without expiresAt",
      "approval.request",
      "1:6",
      withoutKey({ ...validRequest }, "expiresAt"),
    ],
    ["request approvalId 1.5", "approval.request", "1:6", { ...validRequest, approvalId: 1.5 }],
    [
      "request unsafe approvalId",
      "approval.request",
      "1:6",
      { ...validRequest, approvalId: UNSAFE_INTEGER },
    ],
    ["request string messageId", "approval.request", "1:6", { ...validRequest, messageId: "0" }],
    ["request numeric title", "approval.request", "1:6", { ...validRequest, title: 1 }],
    [
      "resolved decision null",
      "approval.resolved",
      "1:6",
      { messageId: 0, approvalId: 7, decision: null },
    ],
    [
      "resolved decision maybe",
      "approval.resolved",
      "1:6",
      { messageId: 0, approvalId: 7, decision: "maybe" },
    ],
    [
      "resolved decision Allow",
      "approval.resolved",
      "1:6",
      { messageId: 0, approvalId: 7, decision: "Allow" },
    ],
    [
      "resolved with an extra key",
      "approval.resolved",
      "1:6",
      { messageId: 0, approvalId: 7, decision: "allow", extra: 1 },
    ],
    ["a valid request with id 1:01", "approval.request", "1:01", validRequest],
  ];

  it.each(invalid)("W11 %s triggers a snapshot resync", async (_name, type, id, data) => {
    const context = await connectInstalled(runningSnapshot([], { cursor: { epoch: 1, seq: 5 } }));

    context.source.emitData(type, id, data);

    expect(context.loads).toHaveLength(2);
    expect(context.events).toEqual([]);
    expect(context.errors).toEqual([]);
  });
});
