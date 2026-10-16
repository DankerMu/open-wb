/**
 * Issue 910 slice 3c (task 3.4): chat-web「API 客户端扩展」Scenario「消息 thinkingMs 键严格解析」,
 * through the API client, and the value's way into the chat view (chat-web「纯会话视图归约」:
 * `chatStateFromSnapshot` takes the snapshot's `thinkingMs`). Oracles are the scenario's literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStateFromSnapshot } from "../src/features/chat/stream.js";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";

const session = {
  id: SESSION_ID,
  title: "saved title",
  status: "done" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  ...NULL_SESSION_META,
};

/** A message with every key but `thinkingMs`. */
function message(id: number, role: "user" | "assistant") {
  return {
    id,
    role,
    content: role === "user" ? "问" : "答",
    thinking: role === "user" ? null : "先想",
    status: "done" as const,
    createdAt: id,
    approvals: [],
    steps: [],
    undo: role === "user" ? "available" : null,
    attachments: [],
    error: null,
    thinkingSegments: [],
  };
}

function snapshotOf(messages: readonly unknown[]) {
  return { session, messages, streamCursor: { epoch: 1, seq: null }, todo: null };
}

function serve(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat-web「消息 thinkingMs 键严格解析」 (issue 910)", () => {
  it("accepts null on a user message and null, 0 and 61500 on assistant messages, keeping each value", async () => {
    serve(
      snapshotOf([
        { ...message(1, "user"), thinkingMs: null },
        { ...message(2, "assistant"), thinkingMs: null },
        { ...message(3, "assistant"), thinkingMs: 0 },
        { ...message(4, "assistant"), thinkingMs: 61_500 },
      ]),
    );
    const snapshot = await createApiClient().getMessages(SESSION_ID);
    expect(snapshot.messages.map((item) => item.thinkingMs)).toEqual([null, null, 0, 61_500]);
    expect(chatStateFromSnapshot(snapshot).messages.map((item) => item.thinkingMs)).toEqual([
      null,
      null,
      0,
      61_500,
    ]);
  });

  const rejected: Array<[string, unknown]> = [
    ["a message without the thinkingMs key", message(2, "assistant")],
    ["thinkingMs -1", { ...message(2, "assistant"), thinkingMs: -1 }],
    ["thinkingMs 1.5", { ...message(2, "assistant"), thinkingMs: 1.5 }],
    ['thinkingMs "1500"', { ...message(2, "assistant"), thinkingMs: "1500" }],
    ["thinkingMs 2**53", { ...message(2, "assistant"), thinkingMs: 2 ** 53 }],
    ["a user message with thinkingMs 0", { ...message(3, "user"), thinkingMs: 0 }],
  ];

  it.each(rejected)("rejects the whole snapshot for %s", async (_label, bad) => {
    serve(snapshotOf([{ ...message(1, "user"), thinkingMs: null }, bad]));
    expectRequestFailure(await captureApiError(createApiClient().getMessages(SESSION_ID)), 200);
  });
});
