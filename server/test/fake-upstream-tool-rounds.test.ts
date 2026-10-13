/**
 * Issue #1140 (s1-followups-batch G12): `start({ toolRoundScope })` of the fake upstream —
 * omp-test-harness Requirement「受控上游思考与写入标记」, Scenario「按回合判定工具轮」. Under `"turn"` a
 * request is a tool round when no `tool` message follows its last `user` message, so a later turn
 * of a session (real omp resends the whole history) opens with a tool call again; omitted or
 * `"history"` keeps the rule over the whole history.
 *
 * Expected calls, arguments and reply text are literals written from the spec; fixture constants
 * are not imported. "Identical to the default scope" is checked by sending the same request to a
 * default instance and a `"turn"` instance and comparing the whole response text after pinning
 * only the random ids and `created`.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { finishReason, startTrackedFakeUpstream, streamSnapshot } from "./fake-upstream-helpers.js";
import {
  type FakeUpstreamServer,
  type FakeUpstreamStartOptions,
  start,
} from "./support/fake-upstream.mjs";

const THINK = "WORKBUDDY_THINK";
const WRITE = "WORKBUDDY_WRITE";
const TODO = "WORKBUDDY_TODO";
const FAKE_ERROR = "WORKBUDDY_FAKE_ERROR";
const WALK = "WORKBUDDY_UI_WALK:";
const BASH_ARGS = '{"command":"echo workbuddy-smoke"}';
const WRITE_ARGS =
  '{"path":"workbuddy-report.html","content":"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\\n"}';
const TODO_ARGS = '{"op":"init","list":[{"phase":"走查","items":["整理需求","输出结论"]}]}';
const REPLY = ["你好，", "这是 WorkBuddy 的", "第一条流式回复。"];
const THINKING = "先读需求，再列要点，最后作答。";
const ERROR_BODY = '{"error":{"message":"fake upstream error"}}';
const WAIT_MS = 8_000;
// Localhost idle bound: frames already written are readable immediately.
const IDLE_MS = 250;

const TURN: FakeUpstreamStartOptions = { toolRoundScope: "turn" };
const TOOL_RESULT = { role: "tool", tool_call_id: "call_2", content: "done" };
/** A finished first turn as omp resends it: prompt, tool call, tool result, answer. */
const FIRST_TURN = [
  { role: "user", content: "第一回合" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "bash", arguments: BASH_ARGS } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "workbuddy-smoke" },
  { role: "assistant", content: REPLY.join("") },
];

/** The scenario's first history: `user → assistant(tool_calls) → tool → assistant → user`. */
function laterTurn(text: string): unknown[] {
  return [...FIRST_TURN, { role: "user", content: text }];
}

interface Reply {
  status: number;
  contentType: string;
  text: string;
}

const handles: FakeUpstreamServer[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
});

describe('toolRoundScope "turn": a later turn of the same session', () => {
  it.each([
    ["WORKBUDDY_TODO", `列个清单 ${TODO}`, "todo", TODO_ARGS],
    ["WORKBUDDY_WRITE", `写一份报告 ${WRITE}`, "write", WRITE_ARGS],
    ["no marker", "跑一个命令", "bash", BASH_ARGS],
  ])("with %s opens with exactly one tool call", async (_label, text, name, args) => {
    const port = await upstream(TURN);
    const reply = await chat(port, laterTurn(text));
    expect(toolRoundOf(reply)).toEqual({ calls: [{ name, arguments: args }], content: [] });
  });

  it.each([
    ["WORKBUDDY_TODO", `列个清单 ${TODO}`],
    ["WORKBUDDY_WRITE", `写一份报告 ${WRITE}`],
    ["no marker", "跑一个命令"],
  ])(
    "with %s is the fixed reply with no tool call once that turn's tool message is appended",
    async (_label, text) => {
      const port = await upstream(TURN);
      const reply = await chat(port, [...laterTurn(text), TOOL_RESULT]);
      expect(answerOf(reply)).toEqual({ calls: [], content: REPLY, reasoning: "" });
    },
  );

  it("decides by the last user message: a tool round of the third turn follows two answered turns", async () => {
    const port = await upstream(TURN);
    const third = [
      ...laterTurn("第二回合"),
      TOOL_RESULT,
      { role: "assistant", content: "ok" },
      { role: "user", content: TODO },
    ];
    expect(toolRoundOf(await chat(port, third)).calls).toEqual([
      { name: "todo", arguments: TODO_ARGS },
    ]);
  });

  it("stays the answering round when the turn's tool message is not the last message", async () => {
    const port = await upstream(TURN);
    const messages = [...laterTurn(TODO), TOOL_RESULT, { role: "assistant", content: "ok" }];
    const reply = await chat(port, messages);
    expect(answerOf(reply)).toEqual({ calls: [], content: REPLY, reasoning: "" });
  });
});

describe('toolRoundScope omitted or "history": the whole history decides', () => {
  it.each<[string, FakeUpstreamStartOptions | undefined]>([
    ["without the option", undefined],
    ['with toolRoundScope "history"', { toolRoundScope: "history" }],
  ])("%s the same later-turn requests get the fixed reply with no tool call", async (_l, opts) => {
    const port = await upstream(opts);
    for (const text of [`列个清单 ${TODO}`, `写一份报告 ${WRITE}`, "跑一个命令"]) {
      const reply = await chat(port, laterTurn(text));
      expect(answerOf(reply)).toEqual({ calls: [], content: REPLY, reasoning: "" });
    }
  });
});

describe('toolRoundScope "turn" is identical to the default scope', () => {
  it("for the error marker, whichever round the request would be", async () => {
    const [byDefault, byTurn] = await pair();
    const marked = `${FAKE_ERROR} ${THINK} ${WRITE} ${TODO}`;
    for (const messages of [
      [{ role: "user", content: marked }],
      [{ role: "user", content: marked }, TOOL_RESULT],
      laterTurn(marked),
      [...laterTurn(marked), TOOL_RESULT],
    ]) {
      const reply = await chat(byTurn, messages);
      expect(reply).toEqual(await chat(byDefault, messages));
      expect(reply.status).toBe(500);
      expect(reply.contentType).toMatch(/application\/json/u);
      expect(reply.text).toBe(ERROR_BODY);
    }
  });

  it("for WORKBUDDY_THINK on an answering round without a gate", async () => {
    const [byDefault, byTurn] = await pair();
    for (const text of [THINK, `${THINK} ${WALK}${randomUUID()}`]) {
      const messages = [{ role: "user", content: text }, TOOL_RESULT];
      const reply = await chat(byTurn, messages);
      expect(pinned(reply)).toEqual(pinned(await chat(byDefault, messages)));
      expect(answerOf(reply)).toEqual({ calls: [], content: REPLY, reasoning: THINKING });
    }
  });

  it("for WORKBUDDY_THINK on a later turn's answering round, which reasons under both scopes", async () => {
    const [byDefault, byTurn] = await pair();
    const messages = [...laterTurn(THINK), TOOL_RESULT];
    const reply = await chat(byTurn, messages);
    expect(pinned(reply)).toEqual(pinned(await chat(byDefault, messages)));
    expect(answerOf(reply)).toEqual({ calls: [], content: REPLY, reasoning: THINKING });
  });

  it.each([
    ["with WORKBUDDY_THINK", THINK, THINKING],
    ["without a marker", "", ""],
  ])(
    "for an answering round under an armed gate %s: same held prefix, same rest after release",
    async (_label, extra, reasoning) => {
      const [byDefault, byTurn] = await pair();
      const id = randomUUID();
      const messages = [{ role: "user", content: `${extra} ${WALK}${id}`.trim() }, TOOL_RESULT];
      const turn = await gateRun(byTurn, id, messages);
      const base = await gateRun(byDefault, id, messages);
      expect(turn).toEqual(base);
      expect(turn.state).toEqual({ afterPrefix: "idle", phase: "held", secondRelease: 404 });
      const held = streamSnapshot(turn.held);
      expect(held.parts).toEqual([REPLY[0]]);
      expect(reasoningOf(held.chunks)).toBe(reasoning);
      expect(held.records).not.toContain("[DONE]");
      const full = streamSnapshot(turn.full);
      expect(full.parts).toEqual(REPLY);
      expect(full.records.at(-1)).toBe("[DONE]");
    },
  );

  it.each([
    ["no marker", "hello from workbuddy", "bash", BASH_ARGS],
    ["WORKBUDDY_WRITE", WRITE, "write", WRITE_ARGS],
    ["WORKBUDDY_TODO", TODO, "todo", TODO_ARGS],
  ])(
    "for a single-user-message history with %s: the tool round and the answering round",
    async (_label, text, name, args) => {
      const [byDefault, byTurn] = await pair();
      const toolRound = [{ role: "user", content: text }];
      const answerRound = [...toolRound, TOOL_RESULT];
      const tool = await chat(byTurn, toolRound);
      expect(pinned(tool)).toEqual(pinned(await chat(byDefault, toolRound)));
      expect(toolRoundOf(tool)).toEqual({ calls: [{ name, arguments: args }], content: [] });
      const answer = await chat(byTurn, answerRound);
      expect(pinned(answer)).toEqual(pinned(await chat(byDefault, answerRound)));
      expect(answerOf(answer)).toEqual({ calls: [], content: REPLY, reasoning: "" });
    },
  );

  // The spec names no history without a `user` message; `"turn"` then looks at the whole history.
  it.each([
    ["only a system message", [{ role: "system", content: "s" }], "tool_calls"],
    ["a tool message and no user message", [{ role: "system", content: "s" }, TOOL_RESULT], "stop"],
    ["no message at all", [], "tool_calls"],
  ])("for a history with %s", async (_label, messages, finish) => {
    const [byDefault, byTurn] = await pair();
    const reply = await chat(byTurn, messages);
    expect(pinned(reply)).toEqual(pinned(await chat(byDefault, messages)));
    expect(finishReason(streamSnapshot(reply.text).chunks)).toBe(finish);
  });

  it("in the request record", async () => {
    const byDefault = await startTrackedFakeUpstream(handles);
    const byTurn = await startTrackedFakeUpstream(handles, TURN);
    for (const handle of [byDefault, byTurn]) {
      await chat(handle.port, laterTurn(TODO), "m1");
      await chat(handle.port, [...laterTurn(TODO), TOOL_RESULT], "m2");
    }
    expect(byTurn.requests()).toEqual([
      { model: "m1", messages: 5 },
      { model: "m2", messages: 6 },
    ]);
    expect(byTurn.requests()).toEqual(byDefault.requests());
  });
});

describe("toolRoundScope validation", () => {
  it.each([["session"], [""], ["TURN"], [null], [1]])(
    "start({ toolRoundScope: %j }) rejects and binds no port",
    async (value) => {
      const port = await freePort();
      const options = { port, toolRoundScope: value } as unknown as FakeUpstreamStartOptions;
      await expect(
        start(options).then((handle) => {
          handles.push(handle);
          return handle.port;
        }),
      ).rejects.toThrow(/toolRoundScope/u);
      // Nothing is left listening on the requested port: the same port can be bound right away.
      const handle = await startTrackedFakeUpstream(handles, { port });
      expect(handle.port).toBe(port);
    },
  );
});

async function upstream(options?: FakeUpstreamStartOptions): Promise<number> {
  return (await startTrackedFakeUpstream(handles, options)).port;
}

/** Ports of a default-scope instance and a `"turn"` instance. */
async function pair(): Promise<[number, number]> {
  return [await upstream(), await upstream(TURN)];
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer fake", "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(WAIT_MS),
  });
}

async function chat(port: number, messages: unknown[], model?: string): Promise<Reply> {
  const response = await post(port, "/v1/chat/completions", { model, messages, stream: true });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

/** Response text with the generated completion id, call id and timestamp pinned. */
function pin(text: string): string {
  return text
    .replace(/chatcmpl-[0-9a-f-]{36}/gu, "chatcmpl-ID")
    .replace(/call_[0-9a-f-]{36}/gu, "call_ID")
    .replace(/"created":\d+/gu, '"created":0');
}

function pinned(reply: Reply): Reply {
  return { ...reply, text: pin(reply.text) };
}

type Chunk = Record<string, unknown>;

function deltaOf(chunk: Chunk): Record<string, unknown> {
  return (chunk.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta ?? {};
}

function callsOf(chunks: Chunk[]): unknown[] {
  return chunks.flatMap((chunk) => {
    const calls = deltaOf(chunk).tool_calls;
    return Array.isArray(calls) ? calls.map((call: { function: unknown }) => call.function) : [];
  });
}

function reasoningOf(chunks: Chunk[]): string {
  return chunks
    .map((chunk) => deltaOf(chunk).reasoning_content)
    .filter((part) => typeof part === "string")
    .join("");
}

function sseOf(reply: Reply, finish: string) {
  expect(reply.status).toBe(200);
  expect(reply.contentType).toMatch(/text\/event-stream/u);
  const snapshot = streamSnapshot(reply.text);
  expect(finishReason(snapshot.chunks)).toBe(finish);
  expect(snapshot.records.at(-1)).toBe("[DONE]");
  return snapshot;
}

/** A stream that ended with `tool_calls`: its calls and (expected: no) content. */
function toolRoundOf(reply: Reply): { calls: unknown[]; content: string[] } {
  const snapshot = sseOf(reply, "tool_calls");
  expect(reply.text).not.toContain("reasoning_content");
  return { calls: callsOf(snapshot.chunks), content: snapshot.parts };
}

/** A stream that ended with `stop`: its (expected: no) calls, content parts and reasoning text. */
function answerOf(reply: Reply): { calls: unknown[]; content: string[]; reasoning: string } {
  const snapshot = sseOf(reply, "stop");
  return {
    calls: callsOf(snapshot.chunks),
    content: snapshot.parts,
    reasoning: reasoningOf(snapshot.chunks),
  };
}

interface GateRun {
  /** Pinned stream text when the first content chunk had arrived and the stream went quiet. */
  held: string;
  /** Pinned text of the whole stream. */
  full: string;
  state: { afterPrefix: string; phase: unknown; secondRelease: number };
}

/** Arms gate `id`, sends the answering round, observes the hold, releases it and drains. */
async function gateRun(port: number, id: string, messages: unknown[]): Promise<GateRun> {
  expect((await post(port, `/__control/gates/${id}`)).status).toBe(201);
  const response = await post(port, "/v1/chat/completions", { messages, stream: true });
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let next = reader.read();
  while (!(text.includes(`"content":"${REPLY[0]}"`) && text.endsWith("\n\n"))) {
    const chunk = await next;
    if (chunk.done) {
      throw new Error(`stream ended before the first content chunk: ${text}`);
    }
    text += decoder.decode(chunk.value, { stream: true });
    next = reader.read();
  }
  const afterPrefix = await Promise.race([next.then(() => "data"), sleep(IDLE_MS, "idle")]);
  const held = pin(text);
  const gate = await fetch(`http://127.0.0.1:${port}/__control/gates/${id}`, {
    headers: { authorization: "Bearer fake" },
  });
  const phase = ((await gate.json()) as { phase?: unknown }).phase;
  expect((await post(port, `/__control/gates/${id}/release`)).status).toBe(200);
  for (let chunk = await next; !chunk.done; chunk = await reader.read()) {
    text += decoder.decode(chunk.value, { stream: true });
  }
  const secondRelease = (await post(port, `/__control/gates/${id}/release`)).status;
  return { held, full: pin(text), state: { afterPrefix, phase, secondRelease } };
}
