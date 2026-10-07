/**
 * Issue #985 (s1g task 1.4): the fake upstream's request record — omp-test-harness Requirement
 * 「受控上游请求记录」 and Scenario「记录模型名与消息条数」. The expected completions bytes below were
 * captured from the fixture before the record existed (run of this file against the unchanged
 * fixture); the only parts that differ between any two calls — the completion id, the tool call id
 * and `created` — are replaced by fixed tokens on both sides.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "wb-issue985-upstream-key";
const WRONG_KEY = "wb-issue985-wrong-key";
const SECRET_TEXT = "wb-issue985-distinctive-message-text";
const PATH_ROOT = "/chat/completions";
const PATH_V1 = "/v1/chat/completions";
const CONTROL = "/__control/requests";
const UNAUTHORIZED = '{"error":{"message":"Unauthorized"}}';
const INVALID = '{"error":{"message":"Invalid request"}}';

const USER = { role: "user", content: SECRET_TEXT };
const ASSISTANT = { role: "assistant", content: "ok" };
const TOOL = { role: "tool", content: "workbuddy-smoke" };

/** The three requests of the scenario: `m1` / 1 message, `m3` / 3 messages, no model / 2. */
const SCENARIO: Array<{ path: string; body: Record<string, unknown> }> = [
  { path: PATH_ROOT, body: { model: "m1", messages: [USER] } },
  { path: PATH_V1, body: { model: "m3", messages: [USER, ASSISTANT, TOOL] } },
  { path: PATH_ROOT, body: { messages: [USER, TOOL] } },
];

function sse(records: string[]): string {
  return records.map((record) => `data: ${record}\n\n`).join("");
}

function textRound(model: string): string {
  const head = `{"id":"chatcmpl-ID","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":`;
  return sse([
    `${head}{"role":"assistant"},"finish_reason":null}]}`,
    `${head}{"content":"你好，"},"finish_reason":null}]}`,
    `${head}{"content":"这是 WorkBuddy 的"},"finish_reason":null}]}`,
    `${head}{"content":"第一条流式回复。"},"finish_reason":null}]}`,
    `${head}{},"finish_reason":"stop"}]}`,
    "[DONE]",
  ]);
}

/** What the fixture answered to `SCENARIO` before the record existed, ids and `created` fixed. */
const BEFORE: Observed[] = [
  {
    status: 200,
    contentType: "text/event-stream",
    cacheControl: null,
    text: sse([
      '{"id":"chatcmpl-ID","object":"chat.completion.chunk","created":0,"model":"m1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_ID","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"echo workbuddy-smoke\\"}"}}]},"finish_reason":null}]}',
      '{"id":"chatcmpl-ID","object":"chat.completion.chunk","created":0,"model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      "[DONE]",
    ]),
  },
  { status: 200, contentType: "text/event-stream", cacheControl: null, text: textRound("m3") },
  { status: 200, contentType: "text/event-stream", cacheControl: null, text: textRound("fake") },
];

interface Observed {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  text: string;
}

const handles: FakeUpstreamServer[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function open(): Promise<FakeUpstreamServer> {
  return startTrackedFakeUpstream(handles, { apiKey: KEY });
}

async function send(
  handle: FakeUpstreamServer,
  method: "GET" | "POST",
  path: string,
  bearer: string | null,
  body?: string,
): Promise<Observed> {
  const response = await fetch(`http://127.0.0.1:${String(handle.port)}${path}`, {
    method,
    headers: {
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    text: await response.text(),
  };
}

function chat(
  handle: FakeUpstreamServer,
  path: string,
  body: unknown,
  bearer: string | null = KEY,
) {
  return send(handle, "POST", path, bearer, typeof body === "string" ? body : JSON.stringify(body));
}

function record(handle: FakeUpstreamServer, bearer: string | null = KEY) {
  return send(handle, "GET", CONTROL, bearer);
}

/** The per-call parts of a completions body replaced by fixed tokens. */
function stable(observed: Observed): Observed {
  const text = observed.text
    .replace(/chatcmpl-[0-9a-f-]{36}/gu, "chatcmpl-ID")
    .replace(/call_[0-9a-f-]{36}/gu, "call_ID")
    .replace(/"created":\d+/gu, '"created":0');
  return { ...observed, text };
}

describe("fake-upstream request record", () => {
  it("记录模型名与消息条数: three accepted requests are listed in order to the bearer, and their responses are what the fixture answered before", async () => {
    const handle = await open();

    const completions: Observed[] = [];
    for (const { path, body } of SCENARIO) {
      completions.push(stable(await chat(handle, path, body)));
    }
    const listed = await record(handle);
    const anonymous = await record(handle, null);

    expect(completions).toEqual(BEFORE);
    expect(listed).toEqual({
      status: 200,
      contentType: "application/json",
      cacheControl: "no-store",
      text: '{"requests":[{"model":"m1","messages":1},{"model":"m3","messages":3},{"model":null,"messages":2}]}',
    });
    expect(handle.requests()).toEqual([
      { model: "m1", messages: 1 },
      { model: "m3", messages: 3 },
      { model: null, messages: 2 },
    ]);
    expect(anonymous).toEqual({
      status: 401,
      contentType: "application/json",
      cacheControl: null,
      text: UNAUTHORIZED,
    });
  });

  it("answers 401 to a wrong bearer exactly as gate control does, and only GET reads the record", async () => {
    const handle = await open();
    await chat(handle, PATH_ROOT, { model: "m1", messages: [USER] });

    const wrong = await record(handle, WRONG_KEY);
    const gate = await send(
      handle,
      "GET",
      "/__control/gates/00000000-0000-4000-8000-000000000000",
      WRONG_KEY,
    );
    const posted = await send(handle, "POST", CONTROL, KEY, "{}");

    expect(wrong).toEqual({
      status: 401,
      contentType: "application/json",
      cacheControl: null,
      text: UNAUTHORIZED,
    });
    expect(wrong).toEqual(gate);
    expect(wrong.text).not.toContain("m1");
    expect(posted.status).toBe(404);
    expect(handle.requests()).toEqual([{ model: "m1", messages: 1 }]);
  });

  it("records a request the fixture then rejects for its messages, with messages 0 and a non-string model as null", async () => {
    const handle = await open();

    const noMessages = await chat(handle, PATH_V1, { model: "m1" });
    const notAnArray = await chat(handle, PATH_ROOT, { model: 7, messages: "three" });

    for (const rejected of [noMessages, notAnArray]) {
      expect(rejected).toEqual({
        status: 400,
        contentType: "application/json",
        cacheControl: null,
        text: INVALID,
      });
    }
    expect(handle.requests()).toEqual([
      { model: "m1", messages: 0 },
      { model: null, messages: 0 },
    ]);
  });

  it("does not record a body that is not a JSON object, an unauthenticated request or another route", async () => {
    const handle = await open();
    const body = { model: "m1", messages: [USER] };

    const answers = [
      await chat(handle, PATH_ROOT, '{"model":"m1","messages":'),
      await chat(handle, PATH_ROOT, "[1,2]"),
      await chat(handle, PATH_V1, '"m1"'),
      await chat(handle, PATH_V1, "null"),
      await chat(handle, PATH_ROOT, body, null),
      await chat(handle, PATH_V1, body, WRONG_KEY),
      await chat(handle, "/not-a-completion", body),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400, 400, 401, 401, 404]);
    expect(handle.requests()).toEqual([]);
    expect((await record(handle)).text).toBe('{"requests":[]}');
  });

  it("keeps the latest 1000 entries: the oldest of 1001 is dropped", async () => {
    const handle = await open();

    for (let index = 0; index <= 1000; index += 1) {
      await chat(handle, PATH_ROOT, { model: `m${String(index)}`, messages: [USER, TOOL] });
    }

    const kept = handle.requests();
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toEqual({ model: "m1", messages: 2 });
    expect(kept[999]).toEqual({ model: "m1000", messages: 2 });
    expect(JSON.parse((await record(handle)).text)).toEqual({ requests: kept });
  }, 60_000);

  it("holds the two keys only: no message text, header or key, and the accessor hands out a copy", async () => {
    const handle = await open();
    await chat(handle, PATH_ROOT, {
      model: "m1",
      messages: [USER],
      temperature: 0.5,
      user: SECRET_TEXT,
    });

    const listed = await record(handle);
    const copy = handle.requests();
    for (const entry of copy) {
      entry.model = "tampered";
    }
    copy.push({ model: "extra", messages: 9 });

    expect(listed.text).toBe('{"requests":[{"model":"m1","messages":1}]}');
    expect(listed.text).not.toContain(SECRET_TEXT);
    expect(listed.text).not.toContain(KEY);
    expect(JSON.stringify(copy)).not.toContain(SECRET_TEXT);
    expect(handle.requests()).toEqual([{ model: "m1", messages: 1 }]);
  });
});
