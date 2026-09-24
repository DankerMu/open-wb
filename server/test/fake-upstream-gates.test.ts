/**
 * Issue #106 isolated fake-upstream gate HTTP contracts.
 * Independent literals from s0b-chat-ui-walk and the existing two-round reply.
 * Does not import fixture frame builders or output constants.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  collectContent,
  finishReason,
  firstChoice,
  parseDataRecords,
  type StreamSnapshot,
  startTrackedFakeUpstream,
  streamSnapshot,
} from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer, FakeUpstreamStartOptions } from "./support/fake-upstream.mjs";

const DEFAULT_KEY = "fake";
const OVERRIDE_KEY = "wb-issue106-override-key";
const WRONG_KEY = "wb-issue106-wrong-key";
const KEY_A = "wb-issue106-key-a";
const KEY_B = "wb-issue106-key-b";
const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const EXPECTED_COMMAND = "echo workbuddy-smoke";
const REPLY_PARTS = ["你好，", "这是 WorkBuddy 的", "第一条流式回复。"] as const;
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const FIRST_PART = REPLY_PARTS[0];
const PATH_V1 = "/v1/chat/completions";
const USER_HELLO = { role: "user", content: "hello from workbuddy" };
const TOOL_OK = { role: "tool", content: "workbuddy-smoke" };
const FETCH_MS = 8_000;
// Localhost idle bound: already-buffered SSE is readable immediately; fake
// timers cannot drive the real HTTP socket under test.
const PREFIX_IDLE_MS = 250;
const GATE_CAP = 32;
const SHORT_TTL_MS = 800;
const TTL_WAIT_MS = 5_000;

interface ObservedResponse {
  status: number;
  contentType: string;
  text: string;
}

interface OpenStream {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: AbortController;
  buffer: Buffer;
  ended: boolean;
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null;
}

interface HeldGate {
  handle: FakeUpstreamServer;
  id: string;
  stream: OpenStream;
}

const handles: FakeUpstreamServer[] = [];
const streams: OpenStream[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.abort.abort();
    try {
      await stream.reader.cancel();
    } catch {
      /* already closed or aborted */
    }
    if (stream.pendingRead !== null) {
      await stream.pendingRead.catch(() => {
        /* cancel/abort of an in-flight read */
      });
    }
  }
  await Promise.all(
    handles.splice(0).map((handle) =>
      handle.close().catch(() => {
        /* cleanup must continue for sibling resources */
      }),
    ),
  );
});

describe("fake-upstream gate hold and release", () => {
  it("keeps the tool round live, holds the marked prefix, and releases original remaining bytes", async () => {
    expect(REPLY_PARTS.join("")).toBe(EXPECTED_REPLY);
    const handle = await startTracked();
    const id = randomUUID();
    // Missing control is setup-only; prefix/idle/held still discriminate
    // current synchronous completion of the marked final round.
    await armGate(handle.port, id, DEFAULT_KEY);

    expectToolRound(await postChat(handle.port, [walkUser(id)], DEFAULT_KEY));
    expect(await peekPhase(handle.port, id, DEFAULT_KEY)).not.toBe("held");

    const stream = await openChatStream(handle.port, finalMessages(id), DEFAULT_KEY);
    const prefix = await waitForPrefix(stream);
    expect(prefix.parts).toEqual([FIRST_PART]);
    expect(prefix.records.includes("[DONE]")).toBe(false);
    expect(finishReason(prefix.chunks)).toBe(null);
    expect(stream.ended).toBe(false);
    expect(await pull(stream, PREFIX_IDLE_MS)).toBe("idle");
    expect(snapshot(stream).parts).toEqual([FIRST_PART]);
    expect(await peekPhase(handle.port, id, DEFAULT_KEY)).toBe("held");

    expectOk(await releaseGate(handle.port, id, DEFAULT_KEY));
    await drainUntil(stream, FETCH_MS);
    const completed = snapshot(stream);
    expect(completed.parts).toEqual([...REPLY_PARTS]);
    expect(completed.parts.join("")).toBe(EXPECTED_REPLY);
    expect(finishReason(completed.chunks)).toBe("stop");
    expect(completed.records.at(-1)).toBe("[DONE]");
    expect(stream.ended).toBe(true);
  });

  it("still completes unarmed marked requests with the original two-round script", async () => {
    const handle = await startTracked();
    const id = randomUUID();
    expectToolRound(await postChat(handle.port, [walkUser(id)], DEFAULT_KEY));
    expectTextRound(await postChat(handle.port, finalMessages(id), DEFAULT_KEY));
  });
});

describe("fake-upstream gate last-user selection", () => {
  it("binds only the last user text marker, including concatenated text parts", async () => {
    const handle = await startTracked();
    const owned = randomUUID();
    const ignored = randomUUID();
    await armGate(handle.port, owned, DEFAULT_KEY);
    await armGate(handle.port, ignored, DEFAULT_KEY);

    expectTextRound(
      await postChat(handle.port, [walkUser(ignored), USER_HELLO, TOOL_OK], DEFAULT_KEY),
    );
    expect(await peekPhase(handle.port, ignored, DEFAULT_KEY)).toBe("armed");

    expectTextRound(
      await postChat(
        handle.port,
        [USER_HELLO, TOOL_OK, { role: "assistant", content: `${WALK_MARKER}${owned}` }],
        DEFAULT_KEY,
      ),
    );
    expect(await peekPhase(handle.port, owned, DEFAULT_KEY)).toBe("armed");

    const stream = await openChatStream(
      handle.port,
      finalMessages(owned, {
        role: "user",
        content: [
          { type: "text", text: "please " },
          { type: "text", text: `${WALK_MARKER}${owned}` },
        ],
      }),
      DEFAULT_KEY,
    );
    expect((await waitForPrefix(stream)).parts).toEqual([FIRST_PART]);
    expect(await peekPhase(handle.port, owned, DEFAULT_KEY)).toBe("held");
    expectOk(await releaseGate(handle.port, owned, DEFAULT_KEY));
    await drainUntil(stream, FETCH_MS);
    expect(snapshot(stream).parts).toEqual([...REPLY_PARTS]);
    expect(await peekPhase(handle.port, ignored, DEFAULT_KEY)).toBe("armed");
  });
});

describe("fake-upstream gate control identity", () => {
  it("rejects missing/wrong bearer, invalid ids, duplicates, unknown ids, and armed release", async () => {
    const handle = await startTracked({ apiKey: OVERRIDE_KEY });
    const id = randomUUID();
    const unknown = randomUUID();

    expect((await armGate(handle.port, id, null)).status).toBe(401);
    expect((await armGate(handle.port, id, WRONG_KEY)).status).toBe(401);
    expect((await gateGet(handle.port, id, OVERRIDE_KEY)).status).toBe(404);

    expectOk(await armGate(handle.port, id, OVERRIDE_KEY));
    expect(await readPhase(await gateGet(handle.port, id, OVERRIDE_KEY))).toBe("armed");
    expect((await armGate(handle.port, id, OVERRIDE_KEY)).status).toBe(409);
    expect((await releaseGate(handle.port, id, OVERRIDE_KEY)).status).toBe(409);
    expect(await readPhase(await gateGet(handle.port, id, OVERRIDE_KEY))).toBe("armed");

    expect((await gateGet(handle.port, unknown, OVERRIDE_KEY)).status).toBe(404);
    expect((await releaseGate(handle.port, unknown, OVERRIDE_KEY)).status).toBe(404);
    expect((await deleteGate(handle.port, unknown, OVERRIDE_KEY)).status).toBe(404);

    for (const invalid of ["not-a-uuid", "abc", "00000000-0000-0000-0000-0000000000zz"]) {
      expect((await armGate(handle.port, invalid, OVERRIDE_KEY)).status).toBe(400);
      expect((await gateGet(handle.port, invalid, OVERRIDE_KEY)).status).toBe(400);
      expect((await releaseGate(handle.port, invalid, OVERRIDE_KEY)).status).toBe(400);
      expect((await deleteGate(handle.port, invalid, OVERRIDE_KEY)).status).toBe(400);
    }

    const stream = await openChatStream(handle.port, finalMessages(id), OVERRIDE_KEY);
    expect((await waitForPrefix(stream)).parts).toEqual([FIRST_PART]);
    expect((await releaseGate(handle.port, id, WRONG_KEY)).status).toBe(401);
    expect((await releaseGate(handle.port, id, null)).status).toBe(401);
    expect((await deleteGate(handle.port, id, WRONG_KEY)).status).toBe(401);
    expect(await pull(stream, PREFIX_IDLE_MS)).toBe("idle");
    expect(snapshot(stream).parts).toEqual([FIRST_PART]);
    expect(await readPhase(await gateGet(handle.port, id, OVERRIDE_KEY))).toBe("held");
    expectOk(await releaseGate(handle.port, id, OVERRIDE_KEY));
    await drainUntil(stream, FETCH_MS);
    expect(snapshot(stream).parts).toEqual([...REPLY_PARTS]);
  });
});

describe("fake-upstream gate isolation", () => {
  it("holds two gates independently and refuses a duplicate final claim", async () => {
    const handle = await startTracked();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await armGate(handle.port, firstId, DEFAULT_KEY);
    await armGate(handle.port, secondId, DEFAULT_KEY);

    const first = await openChatStream(handle.port, finalMessages(firstId), DEFAULT_KEY);
    expect((await waitForPrefix(first)).parts).toEqual([FIRST_PART]);

    const duplicate = await openChatStream(handle.port, finalMessages(firstId), DEFAULT_KEY);
    expect(duplicate.response.status).toBe(409);

    const second = await openChatStream(handle.port, finalMessages(secondId), DEFAULT_KEY);
    expect((await waitForPrefix(second)).parts).toEqual([FIRST_PART]);
    expect(await peekPhase(handle.port, firstId, DEFAULT_KEY)).toBe("held");
    expect(await peekPhase(handle.port, secondId, DEFAULT_KEY)).toBe("held");

    expect((await releaseGate(handle.port, randomUUID(), DEFAULT_KEY)).status).toBe(404);
    expect(await pull(first, PREFIX_IDLE_MS)).toBe("idle");
    expect(await pull(second, PREFIX_IDLE_MS)).toBe("idle");

    expectOk(await releaseGate(handle.port, firstId, DEFAULT_KEY));
    await drainUntil(first, FETCH_MS);
    expect(snapshot(first).parts).toEqual([...REPLY_PARTS]);
    expect(finishReason(snapshot(first).chunks)).toBe("stop");
    expect(await pull(second, PREFIX_IDLE_MS)).toBe("idle");
    expect(snapshot(second).parts).toEqual([FIRST_PART]);
    expect(await peekPhase(handle.port, secondId, DEFAULT_KEY)).toBe("held");

    expectOk(await releaseGate(handle.port, secondId, DEFAULT_KEY));
    await drainUntil(second, FETCH_MS);
    expect(snapshot(second).parts).toEqual([...REPLY_PARTS]);
  });

  it("keeps the same UUID independent across imported instances", async () => {
    const first = await startTracked({ apiKey: KEY_A });
    const second = await startTracked({ apiKey: KEY_B });
    const id = randomUUID();
    await armGate(first.port, id, KEY_A);
    await armGate(second.port, id, KEY_B);

    const heldA = await openChatStream(first.port, finalMessages(id), KEY_A);
    const heldB = await openChatStream(second.port, finalMessages(id), KEY_B);
    expect((await waitForPrefix(heldA)).parts).toEqual([FIRST_PART]);
    expect((await waitForPrefix(heldB)).parts).toEqual([FIRST_PART]);

    expectOk(await releaseGate(first.port, id, KEY_A));
    await drainUntil(heldA, FETCH_MS);
    expect(snapshot(heldA).parts).toEqual([...REPLY_PARTS]);
    expect(await pull(heldB, PREFIX_IDLE_MS)).toBe("idle");
    expect(snapshot(heldB).parts).toEqual([FIRST_PART]);
    expect(await peekPhase(second.port, id, KEY_B)).toBe("held");

    expectOk(await releaseGate(second.port, id, KEY_B));
    await drainUntil(heldB, FETCH_MS);
    expect(snapshot(heldB).parts).toEqual([...REPLY_PARTS]);
  });
});

describe("fake-upstream gate cleanup", () => {
  it("destroys a held response on delete and allows the id to be re-armed", async () => {
    const held = await armHeldFinal();
    expectOk(await deleteGate(held.handle.port, held.id, DEFAULT_KEY));
    const text = await drainUntil(held.stream, FETCH_MS);
    expect(isSuccessfulTextCompletion(text)).toBe(false);
    expect((await gateGet(held.handle.port, held.id, DEFAULT_KEY)).status).toBe(404);
    expectOk(await armGate(held.handle.port, held.id, DEFAULT_KEY));
    expect(await readPhase(await gateGet(held.handle.port, held.id, DEFAULT_KEY))).toBe("armed");
  });

  it("clears a held gate when the client disconnects", async () => {
    const held = await armHeldFinal();
    held.stream.abort.abort();
    const text = await drainUntil(held.stream, FETCH_MS);
    expect(isSuccessfulTextCompletion(text)).toBe(false);
    await expect
      .poll(() =>
        gateGet(held.handle.port, held.id, DEFAULT_KEY).then((response) => response.status),
      )
      .toBe(404);
    expectOk(await armGate(held.handle.port, held.id, DEFAULT_KEY));
  });

  it("destroys unfinished held responses when the imported server closes", async () => {
    const held = await armHeldFinal();
    await held.handle.close();
    const text = await drainUntil(held.stream, FETCH_MS);
    expect(isSuccessfulTextCompletion(text)).toBe(false);
  }, 10_000);

  it("expires an unfinished gate by injected TTL without forging completion", async () => {
    const held = await armHeldFinal({ gateTtlMs: SHORT_TTL_MS });
    const deadline = Date.now() + TTL_WAIT_MS;
    let expired = false;
    while (Date.now() < deadline) {
      if ((await gateGet(held.handle.port, held.id, DEFAULT_KEY)).status === 404) {
        expired = true;
        break;
      }
      await delay(50);
    }
    expect(expired).toBe(true);
    const text = await drainUntil(held.stream, FETCH_MS);
    expect(isSuccessfulTextCompletion(text)).toBe(false);
    expectOk(await armGate(held.handle.port, held.id, DEFAULT_KEY));
  }, 10_000);

  it("rejects a 33rd arm until cleanup frees a slot", async () => {
    const handle = await startTracked();
    const ids = Array.from({ length: GATE_CAP }, () => randomUUID());
    for (const id of ids) {
      expectOk(await armGate(handle.port, id, DEFAULT_KEY));
    }
    const overflow = await armGate(handle.port, randomUUID(), DEFAULT_KEY);
    expect(overflow.status).toBeGreaterThanOrEqual(400);
    expect(overflow.status).not.toBe(401);

    const first = ids[0];
    if (first === undefined) {
      throw new Error("expected a first armed id");
    }
    expectOk(await deleteGate(handle.port, first, DEFAULT_KEY));
    expectOk(await armGate(handle.port, randomUUID(), DEFAULT_KEY));
  });
});

async function startTracked(options?: FakeUpstreamStartOptions): Promise<FakeUpstreamServer> {
  return startTrackedFakeUpstream(handles, options);
}

async function armHeldFinal(options?: FakeUpstreamStartOptions): Promise<HeldGate> {
  const handle = await startTracked(options);
  const id = randomUUID();
  await armGate(handle.port, id, DEFAULT_KEY);
  const stream = await openChatStream(handle.port, finalMessages(id), DEFAULT_KEY);
  expect((await waitForPrefix(stream)).parts).toEqual([FIRST_PART]);
  return { handle, id, stream };
}

function walkUser(id: string): { role: "user"; content: string } {
  return { role: "user", content: `${WALK_MARKER}${id}` };
}

function finalMessages(id: string, user: unknown = walkUser(id)): unknown[] {
  return [user, TOOL_OK];
}

function gatePath(id: string, action?: "release"): string {
  return action === "release" ? `/__control/gates/${id}/release` : `/__control/gates/${id}`;
}

async function armGate(port: number, id: string, apiKey: string | null): Promise<ObservedResponse> {
  return control(port, "POST", gatePath(id), apiKey);
}

async function gateGet(port: number, id: string, apiKey: string | null): Promise<ObservedResponse> {
  return control(port, "GET", gatePath(id), apiKey);
}

async function releaseGate(
  port: number,
  id: string,
  apiKey: string | null,
): Promise<ObservedResponse> {
  return control(port, "POST", gatePath(id, "release"), apiKey);
}

async function deleteGate(
  port: number,
  id: string,
  apiKey: string | null,
): Promise<ObservedResponse> {
  return control(port, "DELETE", gatePath(id), apiKey);
}

async function peekPhase(port: number, id: string, apiKey: string): Promise<string | undefined> {
  const response = await gateGet(port, id, apiKey);
  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }
  return readPhase(response);
}

function readPhase(response: ObservedResponse): string {
  expectOk(response);
  expect(response.contentType).toMatch(/json/iu);
  const body = asRecord(JSON.parse(response.text), "gate");
  expect(typeof body.phase).toBe("string");
  return String(body.phase);
}

function expectOk(response: ObservedResponse): void {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
}

async function control(
  port: number,
  method: string,
  path: string,
  apiKey: string | null,
): Promise<ObservedResponse> {
  const headers: Record<string, string> = {};
  if (apiKey !== null) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(FETCH_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

async function postChat(
  port: number,
  messages: unknown,
  apiKey: string,
): Promise<ObservedResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${PATH_V1}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ messages, stream: true }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

async function openChatStream(
  port: number,
  messages: unknown,
  apiKey: string,
): Promise<OpenStream> {
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${PATH_V1}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ messages, stream: true }),
    signal: abort.signal,
  });
  if (response.body === null) {
    abort.abort();
    throw new Error("response has no body");
  }
  const stream: OpenStream = {
    response,
    reader: response.body.getReader(),
    abort,
    buffer: Buffer.alloc(0),
    ended: false,
    pendingRead: null,
  };
  streams.push(stream);
  return stream;
}

async function waitForPrefix(stream: OpenStream): Promise<StreamSnapshot> {
  const deadline = Date.now() + FETCH_MS;
  while (Date.now() < deadline) {
    const current = snapshot(stream);
    if (current.parts.length > 0) {
      return current;
    }
    if (stream.ended) {
      throw new Error("stream ended before the first content prefix");
    }
    await pull(stream, Math.max(1, deadline - Date.now()));
  }
  throw new Error("timed out waiting for content prefix");
}

async function drainUntil(stream: OpenStream, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  try {
    while (!stream.ended && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const outcome = await pull(stream, Math.max(1, remaining));
      if (outcome === "idle") {
        break;
      }
    }
  } catch {
    /* abort, reset, or destroy is the cleanup under test */
  }
  return stream.buffer.toString("utf8");
}

async function pull(stream: OpenStream, idleMs?: number): Promise<"data" | "end" | "idle"> {
  if (stream.pendingRead === null) {
    const next = stream.reader.read();
    void next.catch(() => {
      /* cancel/abort of an in-flight read */
    });
    stream.pendingRead = next;
  }
  const pending = stream.pendingRead;
  if (idleMs === undefined) {
    const result = await pending;
    stream.pendingRead = null;
    applyRead(stream, result);
    return result.done ? "end" : "data";
  }
  const winner = await Promise.race([
    pending.then((result) => ({ kind: "read" as const, result })),
    delay(idleMs).then(() => ({ kind: "idle" as const })),
  ]);
  if (winner.kind === "idle") {
    return "idle";
  }
  stream.pendingRead = null;
  applyRead(stream, winner.result);
  return winner.result.done ? "end" : "data";
}

function applyRead(stream: OpenStream, result: ReadableStreamReadResult<Uint8Array>): void {
  if (result.done) {
    stream.ended = true;
    return;
  }
  if (result.value !== undefined) {
    stream.buffer = Buffer.concat([stream.buffer, Buffer.from(result.value)]);
  }
}

function snapshot(stream: OpenStream): StreamSnapshot {
  return streamSnapshot(stream.buffer.toString("utf8"));
}

function expectToolRound(response: ObservedResponse): void {
  const chunks = completedChunks(response);
  expect(finishReason(chunks)).toBe("tool_calls");
  const names: string[] = [];
  const args: string[] = [];
  for (const chunk of chunks) {
    const calls = asRecord(firstChoice(chunk).delta, "delta").tool_calls;
    if (!Array.isArray(calls)) {
      continue;
    }
    for (const item of calls) {
      const fn = asRecord(asRecord(item, "call").function, "function");
      if (typeof fn.name === "string") {
        names.push(fn.name);
      }
      if (typeof fn.arguments === "string") {
        args.push(fn.arguments);
      }
    }
  }
  expect(names.join("")).toBe("bash");
  expect(JSON.parse(args.join(""))).toEqual({ command: EXPECTED_COMMAND });
}

function expectTextRound(response: ObservedResponse): void {
  const chunks = completedChunks(response);
  expect(collectContent(chunks)).toEqual([...REPLY_PARTS]);
  expect(finishReason(chunks)).toBe("stop");
}

function completedChunks(response: ObservedResponse): Array<Record<string, unknown>> {
  expect(response.status).toBe(200);
  expect(response.contentType).toMatch(/text\/event-stream/iu);
  const records = parseDataRecords(response.text);
  expect(records.at(-1)).toBe("[DONE]");
  return records.slice(0, -1).map((record) => asRecord(JSON.parse(record), "chunk"));
}

function isSuccessfulTextCompletion(text: string): boolean {
  const records = parseDataRecords(text);
  if (records.at(-1) !== "[DONE]") {
    return false;
  }
  let chunks: Array<Record<string, unknown>>;
  try {
    chunks = records.slice(0, -1).map((record) => asRecord(JSON.parse(record), "chunk"));
  } catch {
    return false;
  }
  return collectContent(chunks).join("") === EXPECTED_REPLY && finishReason(chunks) === "stop";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
