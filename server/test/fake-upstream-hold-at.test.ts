/**
 * Issue 1440 WORKBUDDY_HOLD_AT:<point> of the fake upstream (omp-test-harness「受控上游节奏与闸门停点
 * 标记」, scenario「闸门停点」: `empty`, `middle`, `emptyX` and the ungated case). Expected bytes are
 * literal strings written from the spec delta and the pre-change fixture output; fixture constants
 * are not imported. Bodies are compared as raw text after pinning only the random ids and
 * `created`. A hold is observed as "these records, then nothing for IDLE_MS, stream still open".
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseDataRecords, startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "fake";
const HOLD_AT = "WORKBUDDY_HOLD_AT:";
const EMPTY = `${HOLD_AT}empty`;
const THINK = "WORKBUDDY_THINK";
const PACE = "WORKBUDDY_PACE";
const WALK = "WORKBUDDY_UI_WALK:";
const TOOL_RESULT = { role: "tool", content: "workbuddy-smoke" };
const WAIT_MS = 8_000;
// Localhost idle bound: frames already written are readable immediately.
const IDLE_MS = 250;
const SHORT_TTL_MS = 600;
const CONFLICT = '{"error":{"message":"Conflict"}}';

const COMPLETION_ID = /chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const CALL_ID = /call_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const CREATED = /"created":\d+/gu;

function frame(delta: string, finish: string): string {
  return `{"id":"chatcmpl-ID","object":"chat.completion.chunk","created":0,"model":"fake","choices":[{"index":0,"delta":${delta},"finish_reason":${finish}}]}`;
}

function body(records: string[]): string {
  return records.map((record) => `data: ${record}\n\n`).join("");
}

const ROLE = frame('{"role":"assistant"}', "null");
const REASONING = [
  frame('{"reasoning_content":"先读需求，"}', "null"),
  frame('{"reasoning_content":"再列要点，"}', "null"),
  frame('{"reasoning_content":"最后作答。"}', "null"),
];
const FIRST_CONTENT = frame('{"content":"你好，"}', "null");
const CONTENT = [
  FIRST_CONTENT,
  frame('{"content":"这是 WorkBuddy 的"}', "null"),
  frame('{"content":"第一条流式回复。"}', "null"),
];
const CHAR = frame('{"content":"字"}', "null");
const STOP = frame("{}", '"stop"');
const DONE = "[DONE]";
const BASH_ROUND = [
  frame(
    String.raw`{"role":"assistant","tool_calls":[{"index":0,"id":"call_ID","type":"function","function":{"name":"bash","arguments":"{\"command\":\"echo workbuddy-smoke\"}"}}]}`,
    "null",
  ),
  frame("{}", '"tool_calls"'),
  DONE,
];
const ANSWER = [ROLE, ...CONTENT, STOP, DONE];
const THINK_ANSWER = [ROLE, ...REASONING, ...CONTENT, STOP, DONE];
const PACED = [ROLE, ...REASONING, ...Array.from({ length: 40 }, () => CHAR), STOP, DONE];
// Today's hold point (pre-change fixture): after the first content chunk.
const HELD_PREFIX = [ROLE, FIRST_CONTENT];
const THINK_HELD_PREFIX = [ROLE, ...REASONING, FIRST_CONTENT];
const RELEASED_REST = [...CONTENT.slice(1), STOP, DONE];

interface Reply {
  status: number;
  contentType: string;
  text: string;
}

interface LiveStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: AbortController;
  decoder: TextDecoder;
  text: string;
  ended: boolean;
  next: Promise<ReadableStreamReadResult<Uint8Array>> | null;
}

interface GateRun {
  prefix: string;
  prefixEnded: boolean;
  heldPhase: string;
  completed: string;
  completedEnded: boolean;
  secondRelease: number;
}

const handles: FakeUpstreamServer[] = [];
const lives: LiveStream[] = [];

afterEach(async () => {
  for (const live of lives.splice(0)) {
    live.abort.abort();
    await live.reader.cancel().catch(() => {
      /* already aborted */
    });
  }
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
});

describe("闸门停点 empty: an armed gate holds after the role chunk only", () => {
  it("holds after role; release sends every content chunk, finish and [DONE] exactly once", async () => {
    const run = await armedGateRun(EMPTY);
    expect(run.prefix).toBe(body([ROLE]));
    expect(run.prefixEnded).toBe(false);
    expect(run.heldPhase).toBe('{"phase":"held"}');
    expect(run.completed).toBe(body(ANSWER));
    expect(run.completedEnded).toBe(true);
    const records = parseDataRecords(run.completed);
    for (const record of [ROLE, ...CONTENT, STOP, DONE]) {
      expect(records.filter((item) => item === record)).toHaveLength(1);
    }
    expect(run.secondRelease).toBe(404);
  });

  it("with WORKBUDDY_THINK the reasoning chunks wait for release as well", async () => {
    const run = await armedGateRun(`${THINK} ${EMPTY}`);
    expect(run.prefix).toBe(body([ROLE]));
    expect(run.prefixEnded).toBe(false);
    expect(run.completed).toBe(body(THINK_ANSWER));
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
  });

  it.each([
    ["at the end of the text", (walk: string) => `${walk} please ${EMPTY}`],
    ["at a space", (walk: string) => `${EMPTY} please ${walk}`],
    ["at a newline", (walk: string) => `${EMPTY}\n${walk}`],
    ["at an ideographic space (U+3000)", (walk: string) => `${EMPTY}　${walk}`],
    ["at a tab", (walk: string) => `${walk}\t${EMPTY}\t`],
  ])("the value ends %s", async (_label, text) => {
    const run = await armedGateRun(text);
    expect(run.prefix).toBe(body([ROLE]));
    expect(run.completed).toBe(body(ANSWER));
  });

  it("WORKBUDDY_PACE stays ignored under the gate: bytes equal the same request without it", async () => {
    const paced = await armedGateRun(`${PACE} ${EMPTY}`);
    expect(paced.prefix).toBe(body([ROLE]));
    expect(paced.completed).toBe(body(ANSWER));
    expect(paced).toEqual(await armedGateRun(EMPTY));
  });

  it("a held gate still answers 409 Conflict and the held stream is untouched", async () => {
    const port = await upstream();
    const id = randomUUID();
    expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
    const live = await openLive(port, answerRound(`${EMPTY} ${WALK}${id}`));
    await readUntil(live, WAIT_MS, (records) => records.includes(ROLE));
    await readUntil(live, IDLE_MS, () => false);
    expect(await (await send(port, "GET", `/__control/gates/${id}`)).text()).toBe(
      '{"phase":"held"}',
    );
    const reply = await chat(port, answerRound(`${EMPTY} ${WALK}${id}`));
    expect(reply.status).toBe(409);
    expect(reply.text).toBe(CONFLICT);
    expect(normalize(live.text)).toBe(body([ROLE]));
    expect((await send(port, "POST", `/__control/gates/${id}/release`)).status).toBe(200);
    await readUntil(live, WAIT_MS, () => false);
    expect(normalize(live.text)).toBe(body(ANSWER));
  });

  it("release before the request is held is 409, and the hold still works afterwards", async () => {
    const port = await upstream();
    const id = randomUUID();
    expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
    const early = await send(port, "POST", `/__control/gates/${id}/release`);
    expect(early.status).toBe(409);
    expect(await early.text()).toBe(CONFLICT);
    const live = await openLive(port, answerRound(`${EMPTY} ${WALK}${id}`));
    await readUntil(live, WAIT_MS, (records) => records.includes(ROLE));
    await readUntil(live, IDLE_MS, () => false);
    expect(normalize(live.text)).toBe(body([ROLE]));
    expect(live.ended).toBe(false);
  });

  it("TTL expiry destroys the held stream instead of completing it", async () => {
    const handle = await startTrackedFakeUpstream(handles, { gateTtlMs: SHORT_TTL_MS });
    const id = randomUUID();
    expect((await send(handle.port, "POST", `/__control/gates/${id}`)).status).toBe(201);
    const live = await openLive(handle.port, answerRound(`${EMPTY} ${WALK}${id}`));
    await readUntil(live, WAIT_MS, (records) => records.includes(ROLE));
    await readUntil(live, WAIT_MS, () => false);
    expect(normalize(live.text)).toBe(body([ROLE]));
    expect(parseDataRecords(live.text)).not.toContain(DONE);
    expect((await send(handle.port, "GET", `/__control/gates/${id}`)).status).toBe(404);
    expect((await send(handle.port, "POST", `/__control/gates/${id}/release`)).status).toBe(404);
  });
});

describe("闸门停点 invalid values: the armed gate keeps today's hold point", () => {
  it.each([
    ["middle", `${HOLD_AT}middle`, "", HELD_PREFIX],
    ["emptyX", `${HOLD_AT}emptyX`, "", HELD_PREFIX],
    ["an empty value", `${HOLD_AT} empty`, "", HELD_PREFIX],
    ["upper case EMPTY", `${HOLD_AT}EMPTY`, "", HELD_PREFIX],
    ["middle with WORKBUDDY_THINK", `${HOLD_AT}middle`, THINK, THINK_HELD_PREFIX],
    ["emptyX with WORKBUDDY_THINK", `${HOLD_AT}emptyX`, THINK, THINK_HELD_PREFIX],
  ])("%s: bytes equal the gate request without the marker", async (_label, marker, extra, held) => {
    const marked = await armedGateRun(`${extra} ${marker}`);
    expect(marked.prefix).toBe(body(held));
    expect(marked.prefixEnded).toBe(false);
    expect(marked.completed).toBe(body([...held, ...RELEASED_REST]));
    expect(marked.completedEnded).toBe(true);
    expect(marked.secondRelease).toBe(404);
    expect(marked).toEqual(await armedGateRun(extra));
  });
});

describe("闸门停点 without an armed gate: WORKBUDDY_HOLD_AT:empty changes nothing", () => {
  it.each([
    ["answering round", answerRound(EMPTY), ANSWER],
    ["answering round with WORKBUDDY_THINK", answerRound(`${THINK} ${EMPTY}`), THINK_ANSWER],
    [
      "answering round with an unarmed walk marker",
      answerRound(`${EMPTY} ${WALK}${randomUUID()}`),
      ANSWER,
    ],
    ["answering round with WORKBUDDY_PACE", answerRound(`${PACE} ${EMPTY}`), PACED],
    ["tool round", toolRound(EMPTY), BASH_ROUND],
  ])("%s", async (_label, messages, records) => {
    const port = await upstream();
    expect(rawOf(await chat(port, messages))).toBe(body(records));
  });

  it("tool round of a gated request: the gate stays armed and the bash call is unchanged", async () => {
    const port = await upstream();
    const id = randomUUID();
    expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
    expect(rawOf(await chat(port, toolRound(`${EMPTY} ${WALK}${id}`)))).toBe(body(BASH_ROUND));
    expect(await (await send(port, "GET", `/__control/gates/${id}`)).text()).toBe(
      '{"phase":"armed"}',
    );
  });
});

async function upstream(): Promise<number> {
  return (await startTrackedFakeUpstream(handles)).port;
}

function toolRound(text: string): unknown[] {
  return [{ role: "user", content: text }];
}

function answerRound(text: string): unknown[] {
  return [{ role: "user", content: text }, TOOL_RESULT];
}

function normalize(text: string): string {
  return text
    .replace(COMPLETION_ID, "chatcmpl-ID")
    .replace(CALL_ID, "call_ID")
    .replace(CREATED, '"created":0');
}

function rawOf(reply: Reply): string {
  expect(reply.status).toBe(200);
  expect(reply.contentType).toBe("text/event-stream");
  return normalize(reply.text);
}

async function send(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
  signal: AbortSignal = AbortSignal.timeout(WAIT_MS),
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: payload === undefined ? null : JSON.stringify(payload),
    signal,
  });
}

async function chat(port: number, messages: unknown[]): Promise<Reply> {
  const response = await send(port, "POST", "/v1/chat/completions", { messages, stream: true });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

/**
 * Arms a gate, sends the answering round and waits out the hold. A string is followed by the walk
 * marker; a function places the walk marker itself.
 */
async function armedGateRun(extra: string | ((walk: string) => string)): Promise<GateRun> {
  const port = await upstream();
  const id = randomUUID();
  expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
  const walk = `${WALK}${id}`;
  const text = typeof extra === "string" ? `${extra} ${walk}`.trim() : extra(walk);
  const live = await openLive(port, answerRound(text));
  await readUntil(live, WAIT_MS, (records) => records.includes(ROLE));
  await readUntil(live, IDLE_MS, () => false);
  const prefix = normalize(live.text);
  const prefixEnded = live.ended;
  const heldPhase = await (await send(port, "GET", `/__control/gates/${id}`)).text();
  expect((await send(port, "POST", `/__control/gates/${id}/release`)).status).toBe(200);
  await readUntil(live, WAIT_MS, () => false);
  const secondRelease = (await send(port, "POST", `/__control/gates/${id}/release`)).status;
  return {
    prefix,
    prefixEnded,
    heldPhase,
    completed: normalize(live.text),
    completedEnded: live.ended,
    secondRelease,
  };
}

async function openLive(port: number, messages: unknown[]): Promise<LiveStream> {
  const abort = new AbortController();
  const response = await send(
    port,
    "POST",
    "/v1/chat/completions",
    { messages, stream: true },
    abort.signal,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  if (response.body === null) {
    throw new Error("chat stream has no body");
  }
  const live: LiveStream = {
    reader: response.body.getReader(),
    abort,
    decoder: new TextDecoder(),
    text: "",
    ended: false,
    next: null,
  };
  lives.push(live);
  return live;
}

/** Reads until `done(records)`, the stream ends, a read fails, or `ms` pass without completion. */
async function readUntil(
  live: LiveStream,
  ms: number,
  done: (records: string[]) => boolean,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!live.ended && !done(parseDataRecords(normalize(live.text)))) {
    const left = deadline - Date.now();
    if (left <= 0) {
      return;
    }
    if (live.next === null) {
      live.next = live.reader.read();
      live.next.catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), left);
    });
    let result: ReadableStreamReadResult<Uint8Array> | null;
    try {
      result = await Promise.race([live.next, idle]);
    } catch {
      // A destroyed held response (TTL / close) surfaces as a failed read: the stream is over.
      live.next = null;
      live.ended = true;
      return;
    } finally {
      clearTimeout(timer);
    }
    if (result === null) {
      return;
    }
    live.next = null;
    if (result.done) {
      live.ended = true;
    } else {
      live.text += live.decoder.decode(result.value, { stream: true });
    }
  }
}
