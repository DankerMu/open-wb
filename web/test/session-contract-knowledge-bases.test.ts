/**
 * Issue #1972 (s2c-kb-session tasks 7.6 / 7.7, design D9): chat-web「API 客户端扩展」Scenario
 * 「知识库引用的解析与发送」through the API client — a snapshot message's `knowledgeBases` (strict
 * `{id, name}` elements, `[]` on every assistant message) and the `knowledgeBases` of a prompt body.
 * The snapshot is `chatSnapshot()` of chat-stream-support.ts with its two messages overridden; the
 * oracles are the scenario's literals and the raw request body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import { chatSnapshot, SESSION_ID } from "./chat-stream-support.js";
import { captureApiError, expectRequestFailure, jsonResponse } from "./support.js";

const K1 = { id: "k1", name: "产品文档" };
const K2 = { id: "k2", name: "运维手册" };
const ACCEPTED = { userMessageId: 1, assistantMessageId: 2, undo: "available" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `chatSnapshot()` whose user message, then assistant message, take the given fields. */
function snapshotWith(user: Record<string, unknown>, assistant: Record<string, unknown> = {}) {
  const snapshot = chatSnapshot();
  const [first, second] = snapshot.messages;
  return {
    ...snapshot,
    messages: [
      { ...first, ...user },
      { ...second, ...assistant },
    ],
  };
}

/** `getMessages` answered 200 with this body. */
function getMessages(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
  return createApiClient().getMessages(SESSION_ID);
}

describe("知识库引用的解析与发送: the snapshot (#1972)", () => {
  it("keeps a user message's references value for value, in order, and an assistant's []", async () => {
    const snapshot = snapshotWith({ knowledgeBases: [K1, K2] });

    const parsed = await getMessages(snapshot);

    expect(parsed.messages.map((message) => message.knowledgeBases)).toStrictEqual([[K1, K2], []]);
    expect(parsed).toStrictEqual(snapshot);
  });

  it("rejects the whole snapshot when a message has no knowledgeBases key", async () => {
    const snapshot = snapshotWith({});
    const [user, assistant] = snapshot.messages;
    const bare = Object.fromEntries(
      Object.entries(user ?? {}).filter(([k]) => k !== "knowledgeBases"),
    );

    const error = await captureApiError(getMessages({ ...snapshot, messages: [bare, assistant] }));

    expectRequestFailure(error, 200);
  });

  it.each([
    ["an element with an extra key", [{ ...K1, extra: 1 }]],
    ["an element without name", [{ id: "k1" }]],
    ["an element without id", [{ name: "产品文档" }]],
    ["an empty id", [{ id: "", name: "产品文档" }]],
    ["an empty name", [{ id: "k1", name: "" }]],
    ["a numeric id", [{ id: 1, name: "产品文档" }]],
    ["a null name", [{ id: "k1", name: null }]],
    ["a bare id string", ["k1"]],
    ["null in place of the list", null],
    ["an object in place of the list", { 0: K1 }],
    ["a string in place of the list", "k1"],
  ])("rejects the whole snapshot when a user message has %s", async (_label, knowledgeBases) => {
    const error = await captureApiError(getMessages(snapshotWith({ knowledgeBases })));

    expectRequestFailure(error, 200);
  });

  it("rejects the whole snapshot when an assistant message carries references", async () => {
    const snapshot = snapshotWith({ knowledgeBases: [K1] }, { knowledgeBases: [K1] });

    expectRequestFailure(await captureApiError(getMessages(snapshot)), 200);
  });
});

describe("知识库引用的解析与发送: the prompt body (#1972)", () => {
  it.each([
    [
      "adds a non-empty list after the message",
      { knowledgeBases: ["k1"] },
      '{"message":"查一下","knowledgeBases":["k1"]}',
    ],
    ["omits an empty list", { knowledgeBases: [] }, '{"message":"查一下"}'],
    ["sends no key without the option", {}, '{"message":"查一下"}'],
    [
      "puts the list after the attachments",
      { attachments: ["uploads/a.pdf"], knowledgeBases: ["k1"] },
      '{"message":"查一下","attachments":["uploads/a.pdf"],"knowledgeBases":["k1"]}',
    ],
  ])("%s", async (_label, options, body) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ACCEPTED, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createApiClient().prompt(SESSION_ID, "查一下", options)).resolves.toEqual(
      ACCEPTED,
    );

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
      [`/api/sessions/${SESSION_ID}/prompt`, body],
    ]);
  });
});
