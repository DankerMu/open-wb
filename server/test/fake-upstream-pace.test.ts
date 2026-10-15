/**
 * Issue 1437 WORKBUDDY_PACE marker of the fake upstream (omp-test-harness「受控上游节奏与闸门停点标记」,
 * scenario「节奏标记」). Expected bytes are literal strings written from the spec delta and the
 * pre-change fixture output; fixture constants are not imported. Bodies are compared as raw text
 * after pinning only the random ids and `created`. Timing uses only the spec's lower bounds: the
 * 25ms spacing is read where the fixture writes. Client arrival gaps went as low as 8.5ms in a
 * loaded `make check` (实测); the client shares the server's event loop, so neighbouring frames'
 * arrival latency can differ by more than the 5ms margin (读代码推出).
 */
import { randomUUID } from "node:crypto";
import { OutgoingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDataRecords, startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "fake";
const PACE = "WORKBUDDY_PACE";
const THINK = "WORKBUDDY_THINK";
const FAKE_ERROR = "WORKBUDDY_FAKE_ERROR";
const WALK = "WORKBUDDY_UI_WALK:";
const TOOL_RESULT = { role: "tool", content: "workbuddy-smoke" };
const WAIT_MS = 8_000;
// Localhost idle bound: frames already written are readable immediately.
const IDLE_MS = 250;
const MIN_GAP_MS = 20;
const MIN_SPAN_MS = 1_000;
const PACE_STEP_MS = 25;
const PACE_MODEL = "pace-model-x";
const CONFLICT = '{"error":{"message":"Conflict"}}';

const COMPLETION_ID = /chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const CALL_ID = /call_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const CREATED = /"created":\d+/gu;

function frame(delta: string, finish: string, model = "fake"): string {
  return `{"id":"chatcmpl-ID","object":"chat.completion.chunk","created":0,"model":"${model}","choices":[{"index":0,"delta":${delta},"finish_reason":${finish}}]}`;
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
const PACED_MODEL = PACED.map((record) =>
  record === DONE ? DONE : record.replace('"model":"fake"', `"model":"${PACE_MODEL}"`),
);
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
  completed: string;
  completedEnded: boolean;
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

describe("节奏标记: WORKBUDDY_PACE without a gate", () => {
  it("streams role, three reasoning chunks, 40 字 chunks, stop and [DONE], each ≥20ms apart and ≥1000ms first to last", async () => {
    const port = await upstream();
    // Warm the client path first: a slow first read would shorten the client-side span below.
    expect(rawOf(await chat(port, toolRound("warm up")))).toBe(body(BASH_ROUND));
    const writes = recordWrites();
    let arrivals: number[];
    let live: LiveStream;
    try {
      live = await openLive(port, answerRound(`please ${PACE}`), PACE_MODEL);
      arrivals = await readTimed(live);
    } finally {
      writes.restore();
    }
    expect(normalize(live.text)).toBe(body(PACED_MODEL));
    const ids = live.text.match(COMPLETION_ID) ?? [];
    expect(ids).toHaveLength(PACED.length - 1);
    expect(new Set(ids).size).toBe(1);
    expect(live.ended).toBe(true);
    // One write per record, in order: nothing bunched into a single write.
    expect(writes.chunks.map(normalize)).toEqual(PACED_MODEL.map((record) => body([record])));
    const gaps = writes.times.slice(1).map((at, index) => at - (writes.times[index] ?? at));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect((writes.times.at(-1) ?? 0) - (writes.times[0] ?? 0)).toBeGreaterThanOrEqual(MIN_SPAN_MS);
    // Never corked when a write starts: no record is held back to leave with the next one.
    expect(writes.corked).toEqual(writes.chunks.map(() => 0));
    // The client sees the same span; per-record arrival gaps carry client jitter and are not used.
    expect(arrivals).toHaveLength(PACED.length);
    expect((arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0)).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it("with WORKBUDDY_THINK sends the three reasoning chunks once, not twice", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(`${THINK} ${PACE}`));
    expect(rawOf(reply)).toBe(body(PACED));
  });

  it("with an unarmed walk marker is still paced", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(`${PACE} ${WALK}${randomUUID()}`));
    expect(rawOf(reply)).toBe(body(PACED));
  });

  it("leaves the tool round as the bash call", async () => {
    const port = await upstream();
    expect(rawOf(await chat(port, toolRound(PACE)))).toBe(body(BASH_ROUND));
  });

  it("yields to the error marker", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(`${FAKE_ERROR} ${PACE}`));
    expect(reply.status).toBe(500);
    expect(reply.text).toBe('{"error":{"message":"fake upstream error"}}');
  });
});

describe("节奏标记: WORKBUDDY_PACE under an armed gate is ignored", () => {
  it.each([
    ["alone", "", HELD_PREFIX],
    ["with WORKBUDDY_THINK", THINK, THINK_HELD_PREFIX],
  ])(
    "%s: hold and release are byte-identical to the same gate request without the marker",
    async (_label, extra, held) => {
      const paced = await armedGateRun(`${extra} ${PACE}`);
      const plain = await armedGateRun(extra);
      expect(paced).toEqual(plain);
      expect(paced.prefix).toBe(body(held));
      expect(paced.prefixEnded).toBe(false);
      expect(paced.completed).toBe(body([...held, ...RELEASED_REST]));
      expect(paced.completedEnded).toBe(true);
    },
  );

  it("a held gate still answers 409 Conflict to a request carrying the marker", async () => {
    const port = await upstream();
    const id = randomUUID();
    expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
    const live = await openLive(port, answerRound(`${WALK}${id}`));
    await readUntil(live, WAIT_MS, (records) => records.includes(FIRST_CONTENT));
    expect(await (await send(port, "GET", `/__control/gates/${id}`)).text()).toBe(
      '{"phase":"held"}',
    );
    const reply = await chat(port, answerRound(`${PACE} ${WALK}${id}`));
    expect(reply.status).toBe(409);
    expect(reply.text).toBe(CONFLICT);
    expect((await send(port, "POST", `/__control/gates/${id}/release`)).status).toBe(200);
    await readUntil(live, WAIT_MS, () => false);
    expect(normalize(live.text)).toBe(body([...HELD_PREFIX, ...RELEASED_REST]));
  });
});

describe("requests without WORKBUDDY_PACE keep the pre-change bytes", () => {
  it.each([
    ["tool round", toolRound("hello from workbuddy"), BASH_ROUND],
    ["answering round", answerRound("hello from workbuddy"), ANSWER],
    ["answering round with WORKBUDDY_THINK", answerRound(`please ${THINK}`), THINK_ANSWER],
    ["answering round with an unarmed walk marker", answerRound(`${WALK}${randomUUID()}`), ANSWER],
  ])("%s", async (_label, messages, records) => {
    const port = await upstream();
    const reply = await chat(port, messages);
    expect(reply.contentType).toBe("text/event-stream");
    expect(rawOf(reply)).toBe(body(records));
  });

  it("armed gate holds the original prefix and releases the original rest", async () => {
    const run = await armedGateRun("");
    expect(run.prefix).toBe(body(HELD_PREFIX));
    expect(run.completed).toBe(body([...HELD_PREFIX, ...RELEASED_REST]));
    expect(run.completedEnded).toBe(true);
  });
});

describe("WORKBUDDY_PACE client leaving mid-stream", () => {
  it("stops scheduling writes and leaves no unhandled rejection or exception", async () => {
    const faults: unknown[] = [];
    const onFault = (error: unknown) => {
      faults.push(error);
    };
    process.on("unhandledRejection", onFault);
    process.on("uncaughtException", onFault);
    // The pace writer's next step is a 25ms timer: after the client left none may be scheduled.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const steps = () => timers.mock.calls.filter((call) => call[1] === PACE_STEP_MS).length;
    try {
      const handle = await startTrackedFakeUpstream(handles);
      const live = await openLive(handle.port, answerRound(PACE));
      await readUntil(live, WAIT_MS, (records) => records.length >= 6);
      expect(live.ended).toBe(false);
      expect(steps()).toBeGreaterThan(0);
      live.abort.abort();
      await live.reader.cancel().catch(() => undefined);
      await pause(IDLE_MS);
      const settled = steps();
      // Past the ~1.1s the whole paced stream would have taken.
      await pause(1_200);
      expect(steps()).toBe(settled);
      expect(faults).toEqual([]);
      expect(rawOf(await chat(handle.port, answerRound("hello")))).toBe(body(ANSWER));
      await handle.close();
    } finally {
      timers.mockRestore();
      process.off("unhandledRejection", onFault);
      process.off("uncaughtException", onFault);
    }
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

async function armedGateRun(extra: string): Promise<GateRun> {
  const port = await upstream();
  const id = randomUUID();
  expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
  const live = await openLive(port, answerRound(`${extra} ${WALK}${id}`.trim()));
  await readUntil(live, WAIT_MS, (records) => records.includes(FIRST_CONTENT));
  await readUntil(live, IDLE_MS, () => false);
  const prefix = normalize(live.text);
  const prefixEnded = live.ended;
  expect((await send(port, "POST", `/__control/gates/${id}/release`)).status).toBe(200);
  await readUntil(live, WAIT_MS, () => false);
  return { prefix, prefixEnded, completed: normalize(live.text), completedEnded: live.ended };
}

async function openLive(port: number, messages: unknown[], model?: string): Promise<LiveStream> {
  const abort = new AbortController();
  const response = await send(
    port,
    "POST",
    "/v1/chat/completions",
    { messages, stream: true, ...(model === undefined ? {} : { model }) },
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

interface WriteLog {
  chunks: string[];
  times: number[];
  corked: number[];
  restore(): void;
}

/**
 * Stamps every server-side `response.write` (the fixture runs in this process) until `restore()`.
 * `end()` without data does not go through `write`, so each stamp is one written record. `corked`
 * is `writableCorked` on entry: a cork still held from an earlier write would ship that record
 * together with this one, which the 25ms write gaps alone cannot show.
 */
function recordWrites(): WriteLog {
  const proto = OutgoingMessage.prototype as unknown as { write: (...args: unknown[]) => boolean };
  const original = proto.write;
  const log: WriteLog = {
    chunks: [],
    times: [],
    corked: [],
    restore: () => {
      proto.write = original;
    },
  };
  proto.write = function (this: OutgoingMessage, ...args: unknown[]): boolean {
    log.times.push(performance.now());
    log.corked.push(this.writableCorked);
    log.chunks.push(String(args[0]));
    return original.apply(this, args);
  };
  return log;
}

/** Reads to the end; each record is stamped with the time of the read that completed it. */
async function readTimed(live: LiveStream): Promise<number[]> {
  const arrivals: number[] = [];
  const deadline = Date.now() + WAIT_MS;
  while (!live.ended && Date.now() < deadline) {
    const result = await live.reader.read();
    const now = performance.now();
    if (result.done) {
      live.ended = true;
      break;
    }
    live.text += live.decoder.decode(result.value, { stream: true });
    const complete = live.text.split("\n\n").length - 1;
    while (arrivals.length < complete) {
      arrivals.push(now);
    }
  }
  return arrivals;
}

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
    const result = await Promise.race([live.next, idle]);
    clearTimeout(timer);
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
