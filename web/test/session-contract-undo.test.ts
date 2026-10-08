/**
 * Issue #946 (s1f-session-list-temp-space task 10.7): chat-web「API 客户端扩展」— the scenarios
 * 「消息 undo 键严格解析」and「prompt 的 202 带 undo」, through the API client, and the value's way
 * into the chat view. Oracles are the spec's literals: the six strings of message-undo「可撤回状态」.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStateFromSnapshot } from "../src/features/chat/stream.js";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const UNDO_STATES = ["available", "too_large", "failed", "command", "unbound", "none"] as const;

const session = {
  id: SESSION_ID,
  title: "saved title",
  status: "done" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  ...NULL_SESSION_META,
};

/** A message with every key but `undo`. */
function message(id: number, role: "user" | "assistant") {
  return {
    id,
    role,
    content: role === "user" ? "问" : "答",
    thinking: null,
    status: "done" as const,
    createdAt: id,
    approvals: [],
    steps: [],
  };
}

function snapshotOf(messages: readonly unknown[]) {
  return { session, messages, streamCursor: { epoch: 1, seq: null }, todo: null };
}

function serve(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, status)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat-web 消息 undo 键严格解析 (#946)", () => {
  const accepted = snapshotOf([
    { ...message(1, "user"), undo: "available" },
    { ...message(2, "assistant"), undo: null },
    { ...message(3, "user"), undo: "none" },
    { ...message(4, "assistant"), undo: null },
  ]);

  it("accepts available and none on user messages and null on assistant messages, keeping each value", async () => {
    serve(accepted);

    const parsed = await createApiClient().getMessages(SESSION_ID);

    expect(parsed).toEqual(accepted);
    expect(parsed.messages.map((entry) => entry.undo)).toEqual(["available", null, "none", null]);
  });

  it.each(UNDO_STATES)("accepts %s on a user message", async (undo) => {
    const body = snapshotOf([{ ...message(1, "user"), undo }]);
    serve(body);

    await expect(createApiClient().getMessages(SESSION_ID)).resolves.toEqual(body);
  });

  it.each([
    ["an assistant message with available", { ...message(2, "assistant"), undo: "available" }],
    ["an assistant message without the key", message(2, "assistant")],
    ["a user message with null", { ...message(3, "user"), undo: null }],
    ["a user message without the key", message(3, "user")],
    ["a user message with an unknown string", { ...message(3, "user"), undo: "yes" }],
    ["a user message with the stored outcome ok", { ...message(3, "user"), undo: "ok" }],
    ["a user message with a non-string", { ...message(3, "user"), undo: true }],
  ])("rejects the whole snapshot for %s", async (_label, bad) => {
    // The first message is valid on its own: nothing of the snapshot is adopted.
    serve(snapshotOf([{ ...message(1, "user"), undo: "available" }, bad]));

    const error = await captureApiError(createApiClient().getMessages(SESSION_ID));

    expectRequestFailure(error, 200);
  });

  it("keeps the value in the chat view: the user message's state, null on the assistant", () => {
    const state = chatStateFromSnapshot({
      session,
      messages: [
        { ...message(1, "user"), undo: "too_large" },
        { ...message(2, "assistant"), undo: null },
      ],
      streamCursor: { epoch: 1, seq: null },
      todo: null,
    });

    expect(state.messages.map((entry) => [entry.id, entry.undo])).toEqual([
      [1, "too_large"],
      [2, null],
    ]);
  });
});

describe("chat-web prompt 的 202 带 undo (#946)", () => {
  it("returns the three values of the 202", async () => {
    serve({ userMessageId: 7, assistantMessageId: 8, undo: "available" }, 202);

    await expect(createApiClient().prompt(SESSION_ID, "你好")).resolves.toEqual({
      userMessageId: 7,
      assistantMessageId: 8,
      undo: "available",
    });
  });

  it.each(UNDO_STATES)("accepts undo %s", async (undo) => {
    serve({ userMessageId: 7, assistantMessageId: 8, undo }, 202);

    await expect(createApiClient().prompt(SESSION_ID, "你好")).resolves.toEqual({
      userMessageId: 7,
      assistantMessageId: 8,
      undo,
    });
  });

  it.each([
    ["the old two-key shape", { userMessageId: 7, assistantMessageId: 8 }],
    ["an unknown undo string", { userMessageId: 7, assistantMessageId: 8, undo: "yes" }],
    ["a null undo", { userMessageId: 7, assistantMessageId: 8, undo: null }],
    ["a fourth key", { userMessageId: 7, assistantMessageId: 8, undo: "available", files: null }],
  ])("treats %s as an invalid response", async (_label, body) => {
    serve(body, 202);

    const error = await captureApiError(createApiClient().prompt(SESSION_ID, "你好"));

    expectRequestFailure(error, 202);
  });
});
