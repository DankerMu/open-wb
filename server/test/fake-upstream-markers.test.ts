/**
 * Issue #528 fake-upstream WORKBUDDY_THINK / WORKBUDDY_WRITE marker contracts, and the issue #863
 * WORKBUDDY_TODO marker (a `todo` tool call in the tool round; WORKBUDDY_WRITE wins over it).
 * Expected SSE records are literal strings written from the omp-test-harness
 * spec delta and the pre-change fixture output; fixture constants are not imported.
 * Raw data records are compared after pinning only the random ids and `created`.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseDataRecords, startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const KEY = "fake";
const THINK = "WORKBUDDY_THINK";
const WRITE = "WORKBUDDY_WRITE";
const TODO = "WORKBUDDY_TODO";
const FAKE_ERROR = "WORKBUDDY_FAKE_ERROR";
const WALK = "WORKBUDDY_UI_WALK:";
const TOOL_RESULT = { role: "tool", content: "workbuddy-smoke" };
const EXPECTED_THINKING = "先读需求，再列要点，最后作答。";
const EXPECTED_WRITE_ARGS =
  '{"path":"workbuddy-report.html","content":"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\\n"}';
const EXPECTED_TODO_ARGS =
  '{"op":"init","list":[{"phase":"走查","items":["整理需求","输出结论"]}]}';
const WAIT_MS = 8_000;
// Localhost idle bound: frames already written are readable immediately.
const IDLE_MS = 250;

const COMPLETION_ID = /chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const CALL_ID = /call_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const CREATED = /"created":\d+/gu;

function frame(delta: string, finish: string): string {
  return `{"id":"chatcmpl-ID","object":"chat.completion.chunk","created":0,"model":"fake","choices":[{"index":0,"delta":${delta},"finish_reason":${finish}}]}`;
}

const ROLE = frame('{"role":"assistant"}', "null");
const REASONING = [
  frame('{"reasoning_content":"先读需求，"}', "null"),
  frame('{"reasoning_content":"再列要点，"}', "null"),
  frame('{"reasoning_content":"最后作答。"}', "null"),
];
const CONTENT = [
  frame('{"content":"你好，"}', "null"),
  frame('{"content":"这是 WorkBuddy 的"}', "null"),
  frame('{"content":"第一条流式回复。"}', "null"),
];
const STOP = frame("{}", '"stop"');
const DONE = "[DONE]";
const BASH_CALL = frame(
  String.raw`{"role":"assistant","tool_calls":[{"index":0,"id":"call_ID","type":"function","function":{"name":"bash","arguments":"{\"command\":\"echo workbuddy-smoke\"}"}}]}`,
  "null",
);
const WRITE_CALL = frame(
  String.raw`{"role":"assistant","tool_calls":[{"index":0,"id":"call_ID","type":"function","function":{"name":"write","arguments":"{\"path\":\"workbuddy-report.html\",\"content\":\"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\\n\"}"}}]}`,
  "null",
);
const TODO_CALL = frame(
  String.raw`{"role":"assistant","tool_calls":[{"index":0,"id":"call_ID","type":"function","function":{"name":"todo","arguments":"{\"op\":\"init\",\"list\":[{\"phase\":\"走查\",\"items\":[\"整理需求\",\"输出结论\"]}]}"}}]}`,
  "null",
);
const TOOL_STOP = frame("{}", '"tool_calls"');

const BASH_ROUND = [BASH_CALL, TOOL_STOP, DONE];
const WRITE_ROUND = [WRITE_CALL, TOOL_STOP, DONE];
const TODO_ROUND = [TODO_CALL, TOOL_STOP, DONE];
const ANSWER = [ROLE, ...CONTENT, STOP, DONE];
const THINK_ANSWER = [ROLE, ...REASONING, ...CONTENT, STOP, DONE];
const HELD_PREFIX = [ROLE, CONTENT[0]];
const THINK_HELD_PREFIX = [ROLE, ...REASONING, CONTENT[0]];
const RELEASED_REST = [CONTENT[1], CONTENT[2], STOP, DONE];

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
  prefix: string[];
  prefixEnded: boolean;
  heldPhase: number | string;
  completed: string[];
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

describe("WORKBUDDY_THINK answering round", () => {
  it("(a) without a walk marker sends role, three reasoning chunks, unchanged content, stop and [DONE]", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(`please ${THINK}`));
    expect(recordsOf(reply)).toEqual(THINK_ANSWER);
    expect(reasoningText(reply.text)).toBe(EXPECTED_THINKING);
  });

  it("(b) with an unarmed walk marker takes the same reasoning path", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(`${THINK} ${WALK}${randomUUID()}`));
    expect(recordsOf(reply)).toEqual(THINK_ANSWER);
    expect(reasoningText(reply.text)).toBe(EXPECTED_THINKING);
  });

  it("leaves the tool round as the bash call", async () => {
    const port = await upstream();
    const reply = await chat(port, toolRound(THINK));
    expect(recordsOf(reply)).toEqual(BASH_ROUND);
    expect(reply.text).not.toContain("reasoning_content");
  });
});

describe("WORKBUDDY_THINK under an armed gate", () => {
  it("sends role, reasoning and the first content before the hold, then the unchanged rest once", async () => {
    const run = await armedGateRun(THINK);
    expect(run.prefix).toEqual(THINK_HELD_PREFIX);
    expect(run.prefixEnded).toBe(false);
    expect(run.heldPhase).toBe("held");
    expect(run.completed).toEqual([...THINK_HELD_PREFIX, ...RELEASED_REST]);
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
  });
});

describe("WORKBUDDY_WRITE tool round", () => {
  it("replaces the bash call with one exact write call", async () => {
    const port = await upstream();
    const reply = await chat(port, toolRound(`make a report ${WRITE}`));
    expect(recordsOf(reply)).toEqual(WRITE_ROUND);
    expect(toolFunctions(reply.text)).toEqual([{ name: "write", arguments: EXPECTED_WRITE_ARGS }]);
    expect(reply.text).not.toContain("bash");
  });

  it("keeps the bash call when the same request drops the marker", async () => {
    const port = await upstream();
    const reply = await chat(port, toolRound("make a report"));
    expect(recordsOf(reply)).toEqual(BASH_ROUND);
    expect(toolFunctions(reply.text)).toEqual([
      { name: "bash", arguments: '{"command":"echo workbuddy-smoke"}' },
    ]);
  });

  it("leaves the answering round unchanged", async () => {
    const port = await upstream();
    expect(recordsOf(await chat(port, answerRound(WRITE)))).toEqual(ANSWER);
  });
});

describe("WORKBUDDY_THINK and WORKBUDDY_WRITE combined", () => {
  it("writes in the tool round without reasoning and thinks in the answering round", async () => {
    const port = await upstream();
    const markers = `${THINK} ${WRITE}`;
    const tool = await chat(port, toolRound(markers));
    expect(recordsOf(tool)).toEqual(WRITE_ROUND);
    expect(tool.text).not.toContain("reasoning_content");
    const answer = await chat(port, answerRound(markers));
    expect(recordsOf(answer)).toEqual(THINK_ANSWER);
    expect(reasoningText(answer.text)).toBe(EXPECTED_THINKING);
  });
});

describe("WORKBUDDY_TODO tool round", () => {
  it("replaces the bash call with one exact todo call", async () => {
    const port = await upstream();
    const reply = await chat(port, toolRound(`plan it ${TODO}`));
    expect(recordsOf(reply)).toEqual(TODO_ROUND);
    expect(toolFunctions(reply.text)).toEqual([{ name: "todo", arguments: EXPECTED_TODO_ARGS }]);
    expect(reply.text).not.toContain("bash");
  });

  it.each([
    ["WRITE before TODO", `${WRITE} ${TODO}`],
    ["TODO before WRITE", `${TODO} ${WRITE}`],
  ])(
    "WORKBUDDY_WRITE wins: %s streams the unchanged write call and no todo call",
    async (_label, markers) => {
      const port = await upstream();
      const reply = await chat(port, toolRound(markers));
      expect(recordsOf(reply)).toEqual(WRITE_ROUND);
      expect(toolFunctions(reply.text)).toEqual([
        { name: "write", arguments: EXPECTED_WRITE_ARGS },
      ]);
      expect(reply.text).not.toContain('"todo"');
    },
  );

  it("leaves the answering round as the fixed reply with no tool call", async () => {
    const port = await upstream();
    const reply = await chat(port, answerRound(TODO));
    expect(recordsOf(reply)).toEqual(ANSWER);
    expect(toolFunctions(reply.text)).toEqual([]);
  });

  it("combines with WORKBUDDY_THINK: todo in the tool round, reasoning in the answering round", async () => {
    const port = await upstream();
    const markers = `${THINK} ${TODO}`;
    const tool = await chat(port, toolRound(markers));
    expect(recordsOf(tool)).toEqual(TODO_ROUND);
    expect(tool.text).not.toContain("reasoning_content");
    const answer = await chat(port, answerRound(markers));
    expect(recordsOf(answer)).toEqual(THINK_ANSWER);
  });

  it.each([
    ["alone", TODO, HELD_PREFIX],
    ["with WORKBUDDY_THINK", `${THINK} ${TODO}`, THINK_HELD_PREFIX],
  ])(
    "under an armed gate %s holds and releases exactly as without the marker",
    async (_label, markers, held) => {
      const run = await armedGateRun(markers);
      expect(run.prefix).toEqual(held);
      expect(run.prefixEnded).toBe(false);
      expect(run.heldPhase).toBe("held");
      expect(run.completed).toEqual([...held, ...RELEASED_REST]);
      expect(run.completedEnded).toBe(true);
      expect(run.secondRelease).toBe(404);
    },
  );
});

describe("unmarked requests stay byte-identical", () => {
  it("tool round is the original bash call", async () => {
    const port = await upstream();
    const reply = await chat(port, toolRound("hello from workbuddy"));
    expect(recordsOf(reply)).toEqual(BASH_ROUND);
    expect(toolFunctions(reply.text).map((fn) => fn.name)).toEqual(["bash"]);
    expect(reply.text).not.toContain("reasoning_content");
  });

  it("answering round without and with an unarmed walk marker is the fixed reply", async () => {
    const port = await upstream();
    for (const text of ["hello from workbuddy", `${WALK}${randomUUID()}`]) {
      const reply = await chat(port, answerRound(text));
      expect(recordsOf(reply)).toEqual(ANSWER);
      expect(reply.text).not.toContain("reasoning_content");
    }
  });

  it("armed gate holds the original prefix and releases the original rest once", async () => {
    const run = await armedGateRun("");
    expect(run.prefix).toEqual(HELD_PREFIX);
    expect(run.prefixEnded).toBe(false);
    expect(run.heldPhase).toBe("held");
    expect(run.completed).toEqual([...HELD_PREFIX, ...RELEASED_REST]);
    expect(run.completedEnded).toBe(true);
    expect(run.secondRelease).toBe(404);
    expect(run.completed.join("\n")).not.toContain("reasoning_content");
  });
});

describe("error marker precedence", () => {
  it("returns the 500 error even when THINK, WRITE and TODO are present", async () => {
    const port = await upstream();
    const markers = `${FAKE_ERROR} ${THINK} ${WRITE} ${TODO}`;
    for (const messages of [toolRound(markers), answerRound(markers)]) {
      const reply = await chat(port, messages);
      expect(reply.status).toBe(500);
      expect(reply.contentType).toMatch(/application\/json/u);
      expect(reply.text).toBe('{"error":{"message":"fake upstream error"}}');
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

function normalize(records: string[]): string[] {
  return records.map((record) =>
    record
      .replace(COMPLETION_ID, "chatcmpl-ID")
      .replace(CALL_ID, "call_ID")
      .replace(CREATED, '"created":0'),
  );
}

function recordsOf(reply: Reply): string[] {
  expect(reply.status).toBe(200);
  expect(reply.contentType).toMatch(/text\/event-stream/u);
  return normalize(parseDataRecords(reply.text));
}

function deltasOf(text: string): Array<Record<string, unknown>> {
  return parseDataRecords(text)
    .filter((record) => record !== DONE)
    .map((record) => JSON.parse(record).choices[0].delta as Record<string, unknown>);
}

function reasoningText(text: string): string {
  return deltasOf(text)
    .map((delta) => delta.reasoning_content)
    .filter((part): part is string => typeof part === "string")
    .join("");
}

function toolFunctions(text: string): Array<{ name: unknown; arguments: unknown }> {
  const found: Array<{ name: unknown; arguments: unknown }> = [];
  for (const delta of deltasOf(text)) {
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        found.push({ name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return found;
}

async function send(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  signal: AbortSignal = AbortSignal.timeout(WAIT_MS),
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
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
  const firstContent = CONTENT[0];
  await readUntil(live, WAIT_MS, (records) => records.includes(firstContent ?? ""));
  await readUntil(live, IDLE_MS, () => false);
  const prefix = normalize(parseDataRecords(live.text));
  const prefixEnded = live.ended;
  const phase = await send(port, "GET", `/__control/gates/${id}`);
  const heldPhase = phase.status === 200 ? String((await phase.json()).phase) : phase.status;
  expect((await send(port, "POST", `/__control/gates/${id}/release`)).status).toBe(200);
  await readUntil(live, WAIT_MS, () => false);
  const secondRelease = (await send(port, "POST", `/__control/gates/${id}/release`)).status;
  return {
    prefix,
    prefixEnded,
    heldPhase,
    completed: normalize(parseDataRecords(live.text)),
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

async function readUntil(
  live: LiveStream,
  ms: number,
  done: (records: string[]) => boolean,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!live.ended && !done(normalize(parseDataRecords(live.text)))) {
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
