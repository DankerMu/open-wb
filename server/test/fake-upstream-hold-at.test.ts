/**
 * Issues 1440 / 1445 WORKBUDDY_HOLD_AT:<point> and WORKBUDDY_THINK_LONG of the fake upstream
 * (omp-test-harness「受控上游节奏与闸门停点标记」, scenarios「闸门停点」: `empty`, `thinking` with and
 * without a thinking marker, `middle`, `emptyX` and the ungated case;「长思考标记」). Expected bytes
 * are literal strings written from the spec delta and the pre-change fixture output; fixture
 * constants are not imported (the 120 long-thinking lines are rebuilt here from the spec formula).
 * Bodies are compared as raw text after pinning only the random ids and `created`. A hold is
 * observed as "these records, then nothing for IDLE_MS, stream still open".
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseDataRecords, startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "fake";
const HOLD_AT = "WORKBUDDY_HOLD_AT:";
const EMPTY = `${HOLD_AT}empty`;
const THINKING = `${HOLD_AT}thinking`;
const THINK = "WORKBUDDY_THINK";
const THINK_LONG = "WORKBUDDY_THINK_LONG";
const PACE = "WORKBUDDY_PACE";
const WALK = "WORKBUDDY_UI_WALK:";
const TOOL_RESULT = { role: "tool", content: "workbuddy-smoke" };
const WAIT_MS = 8_000;
// Localhost idle bound: frames already written are readable immediately.
const IDLE_MS = 250;
const SHORT_TTL_MS = 600;
// Wait for the TTL to end a held stream; stays under vitest's 5s test timeout, so a stream the TTL
// fails to end reaches the `ended` assertion instead of timing the test out.
const TTL_WAIT_MS = 3_000;
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
// Spec「长思考标记」: part k (k=1,2,3) is lines 40(k−1)+1 … 40k of `思考第 N 行`, joined by `\n`;
// parts 1 and 2 end with `\n`, part 3 does not.
const LONG_PARTS = [1, 2, 3].map((k) => {
  const lines = Array.from(
    { length: 40 },
    (_unused, index) => `思考第 ${40 * (k - 1) + index + 1} 行`,
  );
  return lines.join("\n") + (k < 3 ? "\n" : "");
});
const LONG_REASONING = LONG_PARTS.map((part) =>
  frame(JSON.stringify({ reasoning_content: part }), "null"),
);
const LONG_ANSWER = [ROLE, ...LONG_REASONING, ...CONTENT, STOP, DONE];

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
    await readUntil(live, TTL_WAIT_MS, () => false);
    expect(normalize(live.text)).toBe(body([ROLE]));
    expect(parseDataRecords(live.text)).not.toContain(DONE);
    expect(live.ended).toBe(true);
    expect((await send(handle.port, "GET", `/__control/gates/${id}`)).status).toBe(404);
    expect((await send(handle.port, "POST", `/__control/gates/${id}/release`)).status).toBe(404);
  });

  it("only the last user text counts: a stop point in an earlier user message is ignored", async () => {
    const run = await armedGateRun(
      (walk) => walk,
      (text) => [{ role: "user", content: EMPTY }, TOOL_RESULT, { role: "user", content: text }],
    );
    expect(run.prefix).toBe(body(HELD_PREFIX));
    expect(run.prefixEnded).toBe(false);
    expect(run.completed).toBe(body([...HELD_PREFIX, ...RELEASED_REST]));
    expect(run.completedEnded).toBe(true);
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

describe("闸门停点 thinking: an armed gate holds after the reasoning chunks", () => {
  it("with WORKBUDDY_THINK: role and three reasoning chunks before the hold, every content chunk on release", async () => {
    const run = await armedGateRun(`${THINK} ${THINKING}`);
    expect(run.prefix).toBe(body([ROLE, ...REASONING]));
    expect(run.prefixEnded).toBe(false);
    expect(run.heldPhase).toBe('{"phase":"held"}');
    expect(run.completed).toBe(body(THINK_ANSWER));
    expect(run.completedEnded).toBe(true);
    const records = parseDataRecords(run.completed);
    for (const record of THINK_ANSWER) {
      expect(records.filter((item) => item === record)).toHaveLength(1);
    }
    expect(run.secondRelease).toBe(404);
  });

  it("without a thinking marker it is the same as empty", async () => {
    const run = await armedGateRun(THINKING);
    expect(run.prefix).toBe(body([ROLE]));
    expect(run.prefixEnded).toBe(false);
    expect(run.completed).toBe(body(ANSWER));
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
    expect(run).toEqual(await armedGateRun(EMPTY));
  });

  it("with WORKBUDDY_THINK_LONG: role and the three long chunks before the hold", async () => {
    const run = await armedGateRun(`${THINK_LONG} ${THINKING}`);
    expect(run.prefix).toBe(body([ROLE, ...LONG_REASONING]));
    expect(run.prefixEnded).toBe(false);
    expect(run.completed).toBe(body(LONG_ANSWER));
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
  });

  it("WORKBUDDY_PACE stays ignored under the gate: bytes equal the same request without it", async () => {
    const paced = await armedGateRun(`${PACE} ${THINK} ${THINKING}`);
    expect(paced.prefix).toBe(body([ROLE, ...REASONING]));
    expect(paced).toEqual(await armedGateRun(`${THINK} ${THINKING}`));
  });

  it("without an armed gate it changes nothing", async () => {
    const port = await upstream();
    expect(rawOf(await chat(port, answerRound(THINKING)))).toBe(body(ANSWER));
    expect(rawOf(await chat(port, answerRound(`${THINK} ${THINKING}`)))).toBe(body(THINK_ANSWER));
    expect(rawOf(await chat(port, answerRound(`${THINK_LONG} ${THINKING}`)))).toBe(
      body(LONG_ANSWER),
    );
    expect(rawOf(await chat(port, toolRound(`${THINK} ${THINKING}`)))).toBe(body(BASH_ROUND));
  });
});

describe("长思考标记: WORKBUDDY_THINK_LONG sends 120 lines in three reasoning chunks", () => {
  it("the expected chunks follow the spec text", () => {
    expect(LONG_PARTS[0]?.startsWith("思考第 1 行\n思考第 2 行\n")).toBe(true);
    expect(LONG_PARTS[0]?.endsWith("\n思考第 40 行\n")).toBe(true);
    expect(LONG_PARTS[1]?.startsWith("思考第 41 行\n")).toBe(true);
    expect(LONG_PARTS[2]?.endsWith("\n思考第 120 行")).toBe(true);
    expect(LONG_PARTS.join("").split("\n")).toHaveLength(120);
  });

  it.each([
    ["alone", THINK_LONG],
    ["with WORKBUDDY_THINK before it", `${THINK} ${THINK_LONG}`],
    ["with WORKBUDDY_THINK after it", `${THINK_LONG} ${THINK}`],
  ])("%s: role, three long reasoning chunks, then the unchanged reply", async (_label, text) => {
    const port = await upstream();
    const raw = rawOf(await chat(port, answerRound(text)));
    expect(raw).toBe(body(LONG_ANSWER));
    const reasoning = parseDataRecords(raw)
      .filter((record) => record !== DONE)
      .map((record) => JSON.parse(record) as { choices: Array<{ delta: Record<string, unknown> }> })
      .map((chunk) => chunk.choices[0]?.delta.reasoning_content)
      .filter((part): part is string => typeof part === "string");
    expect(reasoning).toHaveLength(3);
    expect(reasoning.join("")).toBe(
      Array.from({ length: 120 }, (_unused, index) => `思考第 ${index + 1} 行`).join("\n"),
    );
  });

  it("the tool round is unchanged", async () => {
    const port = await upstream();
    expect(rawOf(await chat(port, toolRound(THINK_LONG)))).toBe(body(BASH_ROUND));
  });

  it("under an armed gate the long chunks are part of the prefix before today's hold point", async () => {
    const run = await armedGateRun(`${THINK} ${THINK_LONG}`);
    expect(run.prefix).toBe(body([ROLE, ...LONG_REASONING, FIRST_CONTENT]));
    expect(run.prefixEnded).toBe(false);
    expect(run.completed).toBe(body(LONG_ANSWER));
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
  });

  it("under an armed gate with WORKBUDDY_HOLD_AT:empty the long chunks wait for release", async () => {
    const run = await armedGateRun(`${THINK_LONG} ${EMPTY}`);
    expect(run.prefix).toBe(body([ROLE]));
    expect(run.completed).toBe(body(LONG_ANSWER));
  });

  it("WORKBUDDY_PACE keeps its own three short reasoning chunks (slice 1 unchanged)", async () => {
    const port = await upstream();
    expect(rawOf(await chat(port, answerRound(`${PACE} ${THINK_LONG}`)))).toBe(body(PACED));
  });
});

describe("无标记请求逐字节不变: requests without the new markers keep the pre-change bytes", () => {
  it.each([
    ["answering round", answerRound("你好"), ANSWER],
    ["answering round with WORKBUDDY_THINK", answerRound(`${THINK} 你好`), THINK_ANSWER],
    ["tool round", toolRound("你好"), BASH_ROUND],
    ["tool round with WORKBUDDY_THINK", toolRound(THINK), BASH_ROUND],
  ])("%s", async (_label, messages, records) => {
    const port = await upstream();
    expect(rawOf(await chat(port, messages))).toBe(body(records));
  });

  it.each([
    ["gated answering round", "", HELD_PREFIX],
    ["gated answering round with WORKBUDDY_THINK", THINK, THINK_HELD_PREFIX],
  ])("%s holds after the first content chunk", async (_label, extra, held) => {
    const run = await armedGateRun(extra);
    expect(run.prefix).toBe(body(held));
    expect(run.prefixEnded).toBe(false);
    expect(run.completed).toBe(body([...held, ...RELEASED_REST]));
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
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
 * marker; a function places the walk marker itself. `history` turns the text into the request's
 * messages (default: that text as the only user message, then a tool result).
 */
async function armedGateRun(
  extra: string | ((walk: string) => string),
  history: (text: string) => unknown[] = answerRound,
): Promise<GateRun> {
  const port = await upstream();
  const id = randomUUID();
  expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
  const walk = `${WALK}${id}`;
  const text = typeof extra === "string" ? `${extra} ${walk}`.trim() : extra(walk);
  const live = await openLive(port, history(text));
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
