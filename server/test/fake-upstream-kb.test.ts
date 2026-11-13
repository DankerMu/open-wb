/**
 * Issue #1974 (s2c-kb-session 9.2): the fake upstream's `WORKBUDDY_KB_SEARCH:<kbId>` marker —
 * omp-test-harness Requirement「受控上游知识库检索标记」, Scenario「标记的三个阶段」. The count of
 * `role:"tool"` messages after the last user message picks the stage; the marker counts only when
 * the request's `tools` names `kb_search`.
 *
 * Expected arguments and reply text are literals written from the spec; fixture constants are not
 * imported. "As if there were no marker" sends the marker-free twin to the same instance and
 * compares the whole response after pinning only the random ids and `created`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { finishReason, startTrackedFakeUpstream, streamSnapshot } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer, FakeUpstreamStartOptions } from "./support/fake-upstream.mjs";

const KB = "WORKBUDDY_KB_SEARCH:";
const MARKED = `${KB}k1 工单超时`;
const KB_TOOLS = [{ type: "function", function: { name: "kb_search" } }];
const ROUND_1 = '{"question":"工单超时","kb_ids":["k1"],"i":"第 1 轮"}';
const ROUND_2 = '{"question":"工单超时 详细说明","kb_ids":["k1"],"i":"第 2 轮"}';
const ANSWER = "已根据知识库检索结果作答。";
const BASH_ARGS = '{"command":"echo workbuddy-smoke"}';
const REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const TOOL = { role: "tool", tool_call_id: "call_1", content: "切片" };
const CALL = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "call_1", type: "function", function: { name: "kb_search", arguments: "{}" } },
  ],
};
const REMINDER = { role: "user", content: "<system-reminder>今天是 2026-11-13</system-reminder>" };
const ATTACHED = {
  role: "user",
  content: [
    { type: "text", text: "Attached image(s) from tool result:" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
  ],
};

const handles: FakeUpstreamServer[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
});

async function upstream(options?: FakeUpstreamStartOptions): Promise<number> {
  return (await startTrackedFakeUpstream(handles, options)).port;
}

/** The user message, then `tools` assistant-call / tool-result pairs. */
function turn(text: string, tools: number): unknown[] {
  const messages: unknown[] = [{ role: "user", content: text }];
  for (let index = 0; index < tools; index += 1) {
    messages.push(CALL, TOOL);
  }
  return messages;
}

/** `extra` defaults to `tools` naming `kb_search`; `{ tools: undefined }` sends no `tools` key. */
async function chat(
  port: number,
  messages: unknown[],
  extra: { tools: unknown } = { tools: KB_TOOLS },
) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer fake", "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages, ...extra, stream: true }),
    signal: AbortSignal.timeout(8_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  return { status: response.status, contentType, text: await response.text() };
}

type Reply = Awaited<ReturnType<typeof chat>>;

function pinned(reply: Reply): Reply {
  const text = reply.text
    .replace(/(chatcmpl-|call_)[0-9a-f-]{36}/gu, "$1ID")
    .replace(/"created":\d+/gu, '"created":0');
  return { ...reply, text };
}

/** The stream's tool calls (`{name, arguments}`), content text and finish reason. */
function outcome(reply: Reply): { calls: unknown[]; content: string; finish: unknown } {
  expect(reply.status).toBe(200);
  expect(reply.contentType).toMatch(/text\/event-stream/u);
  const { chunks, parts, records } = streamSnapshot(reply.text);
  expect(records.at(-1)).toBe("[DONE]");
  const calls = chunks.flatMap((chunk) => {
    const delta = (chunk.choices as Array<{ delta: { tool_calls?: unknown } }>)[0]?.delta;
    const list = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    return list.map((call: { function: unknown }) => call.function);
  });
  return { calls, content: parts.join(""), finish: finishReason(chunks) };
}

function kbCall(args: string) {
  return { calls: [{ name: "kb_search", arguments: args }], content: "", finish: "tool_calls" };
}

const ANSWERED = { calls: [], content: ANSWER, finish: "stop" };

describe("the marker's three stages", () => {
  it.each([
    [0, kbCall(ROUND_1)],
    [1, kbCall(ROUND_2)],
    [2, ANSWERED],
    [3, ANSWERED],
  ])("with %i tool message(s) after the user message", async (tools, expected) => {
    const port = await upstream();
    const reply = await chat(port, turn(MARKED, tools));
    expect(outcome(reply)).toEqual(expected);
    expect(reply.text).not.toContain("reasoning_content");
  });

  it("finds kb_search anywhere in tools, not only first", async () => {
    const port = await upstream();
    const tools = [{ type: "function", function: { name: "bash" } }, ...KB_TOOLS];
    expect(outcome(await chat(port, turn(MARKED, 0), { tools }))).toEqual(kbCall(ROUND_1));
  });
});

describe("as if there were no marker", () => {
  it.each<[string, unknown]>([
    ["tools without kb_search", [{ type: "function", function: { name: "bash" } }]],
    ["tools omitted", undefined],
    ["tools a string", "kb_search"],
    ["tools an object", { type: "function", function: { name: "kb_search" } }],
    ["a null item", [null]],
    ["an item without function", [{ type: "function" }]],
    ["an item whose function is a string", [{ type: "function", function: "kb_search" }]],
  ])("%s: the default rounds, byte for byte", async (_label, tools) => {
    const port = await upstream();
    for (const [count, expected] of [
      [0, { calls: [{ name: "bash", arguments: BASH_ARGS }], content: "", finish: "tool_calls" }],
      [2, { calls: [], content: REPLY, finish: "stop" }],
    ] as const) {
      const reply = await chat(port, turn(MARKED, count), { tools });
      expect(pinned(reply)).toEqual(pinned(await chat(port, turn("工单超时", count), { tools })));
      expect(outcome(reply)).toEqual(expected);
    }
  });

  it.each([
    ["an empty kbId", `${KB} 工单超时`],
    ["an empty kbId at the end of the text", `工单超时 ${KB}`],
  ])("%s, with kb_search in tools", async (_label, text) => {
    const port = await upstream();
    for (const count of [0, 2]) {
      const reply = await chat(port, turn(text, count));
      expect(pinned(reply)).toEqual(pinned(await chat(port, turn("工单超时", count))));
    }
    expect(outcome(await chat(port, turn(text, 0))).calls).toEqual([
      { name: "bash", arguments: BASH_ARGS },
    ]);
  });
});

describe("the question and the kbId", () => {
  it.each([
    [
      "mid-sentence",
      `前文 ${KB}k1 后文`,
      '{"question":"前文  后文","kb_ids":["k1"],"i":"第 1 轮"}',
    ],
    ["ending at U+3000", `${KB}k1　工单`, '{"question":"工单","kb_ids":["k1"],"i":"第 1 轮"}'],
    ["a kbId ending the text, the question trimmed", `工单超时 ${KB}k1`, ROUND_1],
    [
      "the first occurrence deciding",
      `${KB}k1 工单 ${KB}k2`,
      '{"question":"工单 WORKBUDDY_KB_SEARCH:k2","kb_ids":["k1"],"i":"第 1 轮"}',
    ],
  ])("%s", async (_label, text, args) => {
    const port = await upstream();
    expect(outcome(await chat(port, turn(text, 0)))).toEqual(kbCall(args));
  });

  it("mid-sentence on the second round", async () => {
    const port = await upstream();
    expect(outcome(await chat(port, turn(`前文 ${KB}k1 后文`, 1)))).toEqual(
      kbCall('{"question":"前文  后文 详细说明","kb_ids":["k1"],"i":"第 2 轮"}'),
    );
  });
});

describe("the count", () => {
  it.each([
    ["a reminder-only user message", REMINDER],
    ["omp's image attachment message", ATTACHED],
  ])("does not restart at %s after a tool message", async (_label, skipped) => {
    const port = await upstream();
    const reply = await chat(port, [...turn(MARKED, 1), skipped]);
    expect(outcome(reply)).toEqual(kbCall(ROUND_2));
  });

  it.each<[string, FakeUpstreamStartOptions | undefined]>([
    ["the default scope", undefined],
    ['toolRoundScope "turn"', { toolRoundScope: "turn" }],
  ])("starts again at a later turn under %s", async (_label, options) => {
    const port = await upstream(options);
    const history = [...turn("第一回合", 1), { role: "assistant", content: "好的" }];
    const reply = await chat(port, [...history, { role: "user", content: MARKED }]);
    expect(outcome(reply)).toEqual(kbCall(ROUND_1));
  });
});

describe("precedence", () => {
  it("WORKBUDDY_FAKE_ERROR still answers 500", async () => {
    const port = await upstream();
    const reply = await chat(port, turn(`WORKBUDDY_FAKE_ERROR ${MARKED}`, 0));
    expect(reply.status).toBe(500);
    expect(reply.text).toBe('{"error":{"message":"fake upstream error"}}');
  });

  it("WORKBUDDY_FAKE_STATUS=503 still answers 503", async () => {
    const port = await upstream();
    const reply = await chat(port, turn(`WORKBUDDY_FAKE_STATUS=503 ${MARKED}`, 0));
    expect(reply.status).toBe(503);
    expect(reply.text).toBe(
      '{"error":{"message":"scripted upstream 503","type":"scripted_error"}}',
    );
  });

  it("the kb_search call wins over WORKBUDDY_WRITE, which stays in the question", async () => {
    const port = await upstream();
    const reply = await chat(port, turn(`${MARKED} WORKBUDDY_WRITE`, 0));
    expect(outcome(reply)).toEqual(
      kbCall('{"question":"工单超时 WORKBUDDY_WRITE","kb_ids":["k1"],"i":"第 1 轮"}'),
    );
  });

  it("the answer wins over WORKBUDDY_THINK: no reasoning", async () => {
    const port = await upstream();
    const reply = await chat(port, turn(`${MARKED} WORKBUDDY_THINK`, 2));
    expect(outcome(reply)).toEqual(ANSWERED);
    expect(reply.text).not.toContain("reasoning_content");
  });
});
