/**
 * Issue 1468 WORKBUDDY_INTERLEAVE marker of the fake upstream (omp-test-harness「受控上游交错标记」,
 * scenarios「交错写出」and「不改变其它请求」). Expected bytes are literal strings written from the
 * spec delta and the pre-change fixture output; fixture constants are not imported. Bodies are
 * compared as raw text after pinning only the random ids and `created`. Timing uses only the spec's
 * lower bound, read where the fixture writes (same place as the WORKBUDDY_PACE test): client
 * arrival gaps carry the shared event loop's jitter (读代码推出).
 */
import { randomUUID } from "node:crypto";
import { OutgoingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDataRecords, startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "fake";
const INTERLEAVE = "WORKBUDDY_INTERLEAVE";
const PACE = "WORKBUDDY_PACE";
const THINK = "WORKBUDDY_THINK";
const THINK_LONG = "WORKBUDDY_THINK_LONG";
const WALK = "WORKBUDDY_UI_WALK:";
const TOOL_RESULT = { role: "tool", content: "workbuddy-smoke" };
const WAIT_MS = 8_000;
// Localhost idle bound: frames already written are readable immediately.
const IDLE_MS = 250;
const MIN_GAP_MS = 20;
const STEP_MS = 25;
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
const STOP = frame("{}", '"stop"');
const DONE = "[DONE]";
const INTERLEAVED = [
  ROLE,
  frame('{"content":"先说一句，"}', "null"),
  frame('{"content":"再补一句。"}', "null"),
  frame('{"reasoning_content":"想一想"}', "null"),
  frame('{"content":"然后作答。"}', "null"),
  STOP,
  DONE,
];
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
const ANSWER = [ROLE, ...CONTENT, STOP, DONE];
const PACED = [
  ROLE,
  ...REASONING,
  ...Array.from({ length: 40 }, () => frame('{"content":"字"}', "null")),
  STOP,
  DONE,
];
const BASH_ROUND = [
  frame(
    String.raw`{"role":"assistant","tool_calls":[{"index":0,"id":"call_ID","type":"function","function":{"name":"bash","arguments":"{\"command\":\"echo workbuddy-smoke\"}"}}]}`,
    "null",
  ),
  frame("{}", '"tool_calls"'),
  DONE,
];
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

describe("交错写出: WORKBUDDY_INTERLEAVE on an answering round without an armed gate", () => {
  it("writes role, 先说一句，, 再补一句。, reasoning 想一想, 然后作答。, stop and [DONE], one write per record, each ≥20ms apart and never corked", async () => {
    const port = await upstream();
    // Warm the client path first, as the WORKBUDDY_PACE test does.
    expect(rawOf(await chat(port, toolRound("warm up")))).toBe(body(BASH_ROUND));
    const writes = recordWrites();
    let reply: Reply;
    try {
      reply = await chat(port, answerRound(`please ${INTERLEAVE}`));
    } finally {
      writes.restore();
    }
    expect(rawOf(reply)).toBe(body(INTERLEAVED));
    const ids = reply.text.match(COMPLETION_ID) ?? [];
    expect(ids).toHaveLength(INTERLEAVED.length - 1);
    expect(new Set(ids).size).toBe(1);
    // One write per record, in order: nothing bunched into a single write.
    expect(writes.chunks.map(normalize)).toEqual(INTERLEAVED.map((record) => body([record])));
    const gaps = writes.times.slice(1).map((at, index) => at - (writes.times[index] ?? at));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP_MS);
    // Never corked when a write starts: no record is held back to leave with the next one.
    expect(writes.corked).toEqual(writes.chunks.map(() => 0));
  });

  it.each([
    ["WORKBUDDY_THINK", `${THINK} ${INTERLEAVE}`],
    ["WORKBUDDY_THINK_LONG", `${INTERLEAVE} ${THINK_LONG}`],
  ])("with %s sends no reasoning besides 想一想", async (_label, text) => {
    const port = await upstream();
    expect(rawOf(await chat(port, answerRound(text)))).toBe(body(INTERLEAVED));
  });

  it("with an unarmed walk marker is still interleaved", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(`${INTERLEAVE} ${WALK}${randomUUID()}`));
    expect(rawOf(reply)).toBe(body(INTERLEAVED));
  });
});

describe("不改变其它请求: WORKBUDDY_INTERLEAVE leaves other requests byte-identical", () => {
  it("a request without the marker keeps the pre-change answering bytes", async () => {
    const port = await upstream();
    expect(rawOf(await chat(port, answerRound("hello from workbuddy")))).toBe(body(ANSWER));
  });

  it.each([
    ["after", `${PACE} ${INTERLEAVE}`],
    ["before", `${INTERLEAVE} ${PACE}`],
  ])("with WORKBUDDY_PACE (marker %s it) WORKBUDDY_PACE decides", async (_label, text) => {
    const port = await upstream();
    const both = rawOf(await chat(port, answerRound(text)));
    expect(both).toBe(rawOf(await chat(port, answerRound(PACE))));
    expect(both).toBe(body(PACED));
  });

  it.each([
    ["alone", "", HELD_PREFIX],
    ["with WORKBUDDY_THINK", THINK, THINK_HELD_PREFIX],
  ])(
    "under an armed gate (%s) hold and release are byte-identical to the gate request without the marker",
    async (_label, extra, held) => {
      const marked = await armedGateRun(`${extra} ${INTERLEAVE}`);
      const plain = await armedGateRun(extra);
      expect(marked).toEqual(plain);
      expect(marked.prefix).toBe(body(held));
      expect(marked.prefixEnded).toBe(false);
      expect(marked.completed).toBe(body([...held, ...RELEASED_REST]));
      expect(marked.completedEnded).toBe(true);
    },
  );

  it("a held gate still answers 409 Conflict to a request carrying the marker", async () => {
    const port = await upstream();
    const id = randomUUID();
    expect((await send(port, "POST", `/__control/gates/${id}`)).status).toBe(201);
    const live = await openLive(port, answerRound(`${WALK}${id}`));
    await readUntil(live, WAIT_MS, (records) => records.includes(FIRST_CONTENT));
    const reply = await chat(port, answerRound(`${INTERLEAVE} ${WALK}${id}`));
    expect(reply.status).toBe(409);
    expect(reply.text).toBe(CONFLICT);
    expect((await send(port, "POST", `/__control/gates/${id}/release`)).status).toBe(200);
    await readUntil(live, WAIT_MS, () => false);
    expect(normalize(live.text)).toBe(body([...HELD_PREFIX, ...RELEASED_REST]));
  });

  it("the tool round still sends only the bash call", async () => {
    const port = await upstream();
    expect(rawOf(await chat(port, toolRound(INTERLEAVE)))).toBe(body(BASH_ROUND));
  });
});

describe("WORKBUDDY_INTERLEAVE client leaving mid-stream", () => {
  it("stops scheduling writes and leaves no unhandled rejection or exception", async () => {
    const faults: unknown[] = [];
    const onFault = (error: unknown) => {
      faults.push(error);
    };
    process.on("unhandledRejection", onFault);
    process.on("uncaughtException", onFault);
    // The writer's next record is a 25ms timer: after the client left none may be scheduled.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const steps = () => timers.mock.calls.filter((call) => call[1] === STEP_MS).length;
    try {
      const handle = await startTrackedFakeUpstream(handles);
      const live = await openLive(handle.port, answerRound(INTERLEAVE));
      await readUntil(live, WAIT_MS, (records) => records.length >= 2);
      expect(live.ended).toBe(false);
      expect(steps()).toBeGreaterThan(0);
      live.abort.abort();
      await live.reader.cancel().catch(() => undefined);
      // Past the ~150ms the whole interleaved stream would have taken: a writer that kept going
      // would have scheduled all six steps (one per record after the first) by now.
      await pause(IDLE_MS);
      const settled = steps();
      expect(settled).toBeLessThan(INTERLEAVED.length - 1);
      await pause(IDLE_MS);
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

function send(
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

interface WriteLog {
  chunks: string[];
  times: number[];
  corked: number[];
  restore(): void;
}

/**
 * Stamps every server-side `response.write` (the fixture runs in this process) until `restore()`.
 * `corked` is `writableCorked` on entry: a cork still held from an earlier write would ship that
 * record together with this one, which the write gaps alone cannot show.
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
