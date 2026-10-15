/**
 * Issue 909 task 7.2: chat-web「API 客户端扩展」Scenario「消息 error 键严格解析」, through the API
 * client, and the value's way into the chat view (chat-web「纯会话视图归约」: `chatStateFromSnapshot`
 * takes the snapshot's `error`, `retrying` false). Oracles are the scenario's literals.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStateFromSnapshot } from "../src/features/chat/stream.js";
import { createApiClient } from "../src/lib/api.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const AUTH = {
  reason: "auth_failed",
  message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
  status: 401,
  detail: "401 bad key",
};
const TIMEOUT = {
  reason: "upstream_timeout",
  message: "上游超时：模型服务没有及时响应",
  status: null,
  detail: "",
};

const session = {
  id: SESSION_ID,
  title: "saved title",
  status: "failed" as const,
  createdAt: 1_740_000_000_000,
  updatedAt: 1_740_000_000_023,
  ...NULL_SESSION_META,
};

/** A message with every key but `error` (`thinkingMs` null, issue 910). */
function message(id: number, role: "user" | "assistant") {
  return {
    id,
    role,
    content: role === "user" ? "问" : "",
    thinking: null,
    status: role === "user" ? ("done" as const) : ("failed" as const),
    createdAt: id,
    approvals: [],
    steps: [],
    undo: role === "user" ? "available" : null,
    attachments: [],
    thinkingMs: null,
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

describe("chat-web「消息 error 键严格解析」 (issue 909)", () => {
  const accepted = snapshotOf([
    { ...message(1, "user"), error: null },
    { ...message(2, "assistant"), error: null },
    { ...message(3, "user"), error: null },
    { ...message(4, "assistant"), error: AUTH },
    { ...message(5, "user"), error: null },
    { ...message(6, "assistant"), error: TIMEOUT },
  ]);

  it("accepts null, the four-key object, a null status and an empty detail, keeping each value", async () => {
    serve(accepted);
    const snapshot = await createApiClient().getMessages(SESSION_ID);
    expect(snapshot.messages.map((item) => item.error)).toEqual([
      null,
      null,
      null,
      AUTH,
      null,
      TIMEOUT,
    ]);
    // The view takes the snapshot's object as is and starts with no retrying mark.
    const view = chatStateFromSnapshot(snapshot);
    expect(view.messages.map((item) => item.error)).toEqual([
      null,
      null,
      null,
      AUTH,
      null,
      TIMEOUT,
    ]);
    expect(view.messages.map((item) => item.retrying)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  const rejected: Array<[string, unknown]> = [
    ["a message without the error key", message(2, "assistant")],
    [
      "an error object with one more key",
      { ...message(2, "assistant"), error: { ...AUTH, code: 1 } },
    ],
    [
      "an error object without detail",
      { ...message(2, "assistant"), error: { ...AUTH, detail: undefined } },
    ],
    ['status "401"', { ...message(2, "assistant"), error: { ...AUTH, status: "401" } }],
    ["status 700", { ...message(2, "assistant"), error: { ...AUTH, status: 700 } }],
    ["status 401.5", { ...message(2, "assistant"), error: { ...AUTH, status: 401.5 } }],
    ["detail null", { ...message(2, "assistant"), error: { ...AUTH, detail: null } }],
    ['reason ""', { ...message(2, "assistant"), error: { ...AUTH, reason: "" } }],
    ["a user message carrying the legal object", { ...message(1, "user"), error: AUTH }],
  ];

  it.each(rejected)("rejects the whole snapshot for %s", async (_label, bad) => {
    serve(snapshotOf([{ ...message(1, "user"), error: null }, bad]));
    expectRequestFailure(await captureApiError(createApiClient().getMessages(SESSION_ID)), 200);
  });
});
