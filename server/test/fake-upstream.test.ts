/**
 * Issue #88 fake-upstream HTTP/CLI contracts.
 * Independent literals from approved s0b-fake-upstream and OpenAI ChatCompletionChunk
 * blob ab04eb836e0356a245e08347ca2b8e31397ca3fa. Does not import fixture output.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeUpstreamServer,
  type FakeUpstreamStartOptions,
  start,
} from "./support/fake-upstream.mjs";

const FAKE = fileURLToPath(new URL("./support/fake-upstream.mjs", import.meta.url));
const FAKE_HREF = pathToFileURL(FAKE).href;
const DEFAULT_KEY = "fake";
const OVERRIDE_KEY = "wb-issue88-override-key";
const WRONG_KEY = "wb-issue88-wrong-key";
const KEY_A = "wb-issue88-key-a";
const KEY_B = "wb-issue88-key-b";
const ERROR_MARKER = "WORKBUDDY_FAKE_ERROR";
const EXPECTED_COMMAND = "echo workbuddy-smoke";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const PATH_ROOT = "/chat/completions";
const PATH_V1 = "/v1/chat/completions";
const MOUNTS = [PATH_ROOT, PATH_V1] as const;
const USER_HELLO = { role: "user", content: "hello from workbuddy" };
const FETCH_MS = 8_000;
const CHILD_MS = 8_000;
const SECRETS = [DEFAULT_KEY, OVERRIDE_KEY, WRONG_KEY, KEY_A, KEY_B] as const;

interface ObservedResponse {
  status: number;
  contentType: string;
  text: string;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CliChild {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  waitReady: (ms?: number) => Promise<number>;
  waitExit: (ms?: number) => Promise<ChildExit>;
}

const handles: FakeUpstreamServer[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const occupiers: Server[] = [];
const childExits = new WeakMap<ChildProcessWithoutNullStreams, ChildExit>();

afterEach(async () => {
  await Promise.all(
    handles.splice(0).map((handle) =>
      handle.close().catch(() => {
        /* cleanup must continue for sibling resources */
      }),
    ),
  );
  await Promise.all(children.splice(0).map(stopChild));
  await Promise.all(occupiers.splice(0).map(closeServer));
});

describe("fake-upstream two-round streaming", () => {
  it("serves tool-first then text-second on both declared mount points", async () => {
    const handle = await startTracked();
    for (const path of MOUNTS) {
      expectToolRound(await postChat(handle.port, path, [USER_HELLO], DEFAULT_KEY));
      expectTextRound(
        await postChat(
          handle.port,
          path,
          [USER_HELLO, { role: "tool", content: "workbuddy-smoke" }],
          DEFAULT_KEY,
        ),
      );
    }
  });
});

describe("fake-upstream authentication", () => {
  it("rejects missing and wrong bearers without streaming on both mounts", async () => {
    const handle = await startTracked();
    for (const path of MOUNTS) {
      expectJsonStatus(await postChat(handle.port, path, [USER_HELLO], null), 401);
      const wrong = await postChat(handle.port, path, [USER_HELLO], WRONG_KEY);
      expectJsonStatus(wrong, 401);
      expectNoSecrets(wrong.text, [WRONG_KEY]);
    }
  });

  it("uses the configured expected key and never echoes credentials", async () => {
    const handle = await startTracked({ apiKey: OVERRIDE_KEY });
    const deniedDefault = await postChat(handle.port, PATH_V1, [USER_HELLO], DEFAULT_KEY);
    const deniedWrong = await postChat(handle.port, PATH_V1, [USER_HELLO], WRONG_KEY);
    const allowed = await postChat(handle.port, PATH_V1, [USER_HELLO], OVERRIDE_KEY);
    expectJsonStatus(deniedDefault, 401);
    expectJsonStatus(deniedWrong, 401);
    expectToolRound(allowed);
    expectNoSecrets(`${deniedDefault.text}${deniedWrong.text}${allowed.text}`, [
      OVERRIDE_KEY,
      WRONG_KEY,
    ]);
  });

  it("does not select the error marker before a valid bearer", async () => {
    const handle = await startTracked();
    expectJsonStatus(
      await postChat(handle.port, PATH_ROOT, [{ role: "user", content: ERROR_MARKER }], null),
      401,
    );
  });
});

describe("fake-upstream last-user error selection", () => {
  it("returns 500 JSON when the last user string contains the marker, even with a later tool message", async () => {
    const handle = await startTracked();
    const messages = [
      { role: "user", content: `trigger ${ERROR_MARKER}` },
      { role: "tool", content: "ignored-because-last-user-wins" },
    ];
    expectOpenAiError(
      expectJsonStatus(await postChat(handle.port, PATH_ROOT, messages, DEFAULT_KEY), 500),
    );
  });

  it("returns 500 JSON when the last user text parts contain the marker", async () => {
    const handle = await startTracked();
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "please " },
          { type: "text", text: `${ERROR_MARKER} now` },
        ],
      },
    ];
    expectOpenAiError(
      expectJsonStatus(await postChat(handle.port, PATH_V1, messages, DEFAULT_KEY), 500),
    );
  });

  it("does not let a historical user marker override a later ordinary user message", async () => {
    const handle = await startTracked();
    const messages = [{ role: "user", content: `older ${ERROR_MARKER}` }, USER_HELLO];
    expectToolRound(await postChat(handle.port, PATH_ROOT, messages, DEFAULT_KEY));
  });

  it("ignores the marker when it appears only in non-text parts", async () => {
    const handle = await startTracked();
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `https://example.invalid/${ERROR_MARKER}.png` } },
        ],
      },
    ];
    expectToolRound(await postChat(handle.port, PATH_ROOT, messages, DEFAULT_KEY));
  });
});

describe("fake-upstream mount points and recovery", () => {
  it("does not produce a successful completion on an unrelated route", async () => {
    const handle = await startTracked();
    const response = await postChat(handle.port, "/not-a-completion", [USER_HELLO], DEFAULT_KEY);
    const streamed =
      response.status === 200 &&
      /text\/event-stream/iu.test(response.contentType) &&
      parseDataRecords(response.text).includes("[DONE]");
    expect(streamed).toBe(false);
  });

  it("returns 400 JSON for malformed JSON and then serves a valid request", async () => {
    const handle = await startTracked();
    expectJsonStatus(
      await postChat(handle.port, PATH_ROOT, [USER_HELLO], DEFAULT_KEY, '{"messages":'),
      400,
    );
    expectToolRound(await postChat(handle.port, PATH_ROOT, [USER_HELLO], DEFAULT_KEY));
  });

  it("returns 400 JSON when messages is not an array and then recovers", async () => {
    const handle = await startTracked();
    expectJsonStatus(
      await postRaw(
        handle.port,
        PATH_V1,
        JSON.stringify({ messages: "not-an-array", stream: true }),
        DEFAULT_KEY,
      ),
      400,
    );
    expectToolRound(await postChat(handle.port, PATH_V1, [USER_HELLO], DEFAULT_KEY));
  });
});

describe("fake-upstream imported instance ownership", () => {
  it("starts independent instances that do not share ports or credentials", async () => {
    const first = await startTracked({ apiKey: KEY_A });
    const second = await startTracked({ apiKey: KEY_B });
    expect(first.port).not.toBe(second.port);
    expectJsonStatus(await postChat(first.port, PATH_ROOT, [USER_HELLO], KEY_B), 401);
    expectJsonStatus(await postChat(second.port, PATH_ROOT, [USER_HELLO], KEY_A), 401);
    expectToolRound(await postChat(first.port, PATH_ROOT, [USER_HELLO], KEY_A));
    expectToolRound(await postChat(second.port, PATH_V1, [USER_HELLO], KEY_B));
    await first.close();
    await first.close();
    await expectRefused(first.port);
    expectJsonStatus(await postChat(second.port, PATH_ROOT, [USER_HELLO], KEY_A), 401);
    expectToolRound(await postChat(second.port, PATH_ROOT, [USER_HELLO], KEY_B));
  });

  it("releases the listener after a client abort and repeated close", async () => {
    const handle = await startTracked();
    await abortPartialRequest(handle.port, PATH_ROOT);
    await handle.close();
    await handle.close();
    await expectRefused(handle.port);
  });

  it("rejects listen failure without installing signal listeners or stealing an occupied port", async () => {
    const occupier = await occupyLoopback();
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    await expect(start({ port: occupier.port })).rejects.toBeInstanceOf(Error);
    await expect(start({ port: 65536 })).rejects.toBeInstanceOf(Error);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    await expectAccepts(occupier.port);
  });
});

describe("fake-upstream standalone CLI", () => {
  it("imports without listening or emitting readiness", async () => {
    const cli = spawnNode(["--input-type=module", "-e", `import ${JSON.stringify(FAKE_HREF)};`]);
    const exit = await cli.waitExit();
    expect(exit.code).toBe(0);
    expect(readyPorts(`${cli.stdout()}${cli.stderr()}`)).toEqual([]);
  });

  it("binds an OS port when FAKE_UPSTREAM_PORT is unset and reclaims it on SIGTERM", async () => {
    const cli = spawnNode([FAKE]);
    const port = await cli.waitReady();
    expectToolRound(await postChat(port, PATH_ROOT, [USER_HELLO], DEFAULT_KEY));
    cli.child.kill("SIGTERM");
    const exit = await cli.waitExit();
    expect(exit.code !== null || exit.signal === "SIGTERM").toBe(true);
    await expectRefused(port);
  }, 15_000);

  it("binds an explicit FAKE_UPSTREAM_PORT and reclaims it on SIGINT", async () => {
    const requested = await reservePort();
    const cli = spawnNode([FAKE], { FAKE_UPSTREAM_PORT: String(requested) });
    const port = await cli.waitReady();
    expect(port).toBe(requested);
    expectToolRound(await postChat(port, PATH_V1, [USER_HELLO], DEFAULT_KEY));
    cli.child.kill("SIGINT");
    const exit = await cli.waitExit();
    expect(exit.code !== null || exit.signal === "SIGINT").toBe(true);
    await expectRefused(port);
  }, 15_000);

  it("fails nonzero on an invalid port without readiness or credential diagnostics", async () => {
    await expectFailedCli(spawnNode([FAKE], { FAKE_UPSTREAM_PORT: "not-a-port" }));
  }, 15_000);

  it("fails nonzero on an occupied port and leaves the occupier in place", async () => {
    const occupier = await occupyLoopback();
    await expectFailedCli(spawnNode([FAKE], { FAKE_UPSTREAM_PORT: String(occupier.port) }));
    await expectAccepts(occupier.port);
  }, 15_000);
});

async function startTracked(options?: FakeUpstreamStartOptions): Promise<FakeUpstreamServer> {
  const handle = await start(options);
  handles.push(handle);
  expect(handle.port).toBeGreaterThan(0);
  return handle;
}

async function postChat(
  port: number,
  path: string,
  messages: unknown,
  apiKey: string | null,
  rawBody?: string,
): Promise<ObservedResponse> {
  return postRaw(port, path, rawBody ?? JSON.stringify({ messages, stream: true }), apiKey);
}

async function postRaw(
  port: number,
  path: string,
  body: string,
  apiKey: string | null,
): Promise<ObservedResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== null) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_MS),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

function expectToolRound(response: ObservedResponse): void {
  const chunks = streamChunks(response);
  const call = reconstructBashCall(chunks);
  expect(call.id.length).toBeGreaterThan(0);
  expect(call.type).toBe("function");
  expect(call.name).toBe("bash");
  expect(JSON.parse(call.arguments)).toEqual({ command: EXPECTED_COMMAND });
  expect(terminalFinish(chunks)).toBe("tool_calls");
}

function expectTextRound(response: ObservedResponse): void {
  const chunks = streamChunks(response);
  const parts = collectContent(chunks);
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(parts.join("")).toBe(EXPECTED_REPLY);
  expect(terminalFinish(chunks)).toBe("stop");
}

function streamChunks(response: ObservedResponse): Array<Record<string, unknown>> {
  expect(response.status).toBe(200);
  expect(response.contentType).toMatch(/text\/event-stream/iu);
  const records = parseDataRecords(response.text);
  const doneAt = records.flatMap((record, index) => (record === "[DONE]" ? [index] : []));
  expect(doneAt).toEqual([records.length - 1]);
  const chunks = records.slice(0, -1).map((record) => asRecord(JSON.parse(record), "chunk"));
  expect(chunks.length).toBeGreaterThan(0);
  expectCanonicalChunks(chunks);
  return chunks;
}

function expectJsonStatus(response: ObservedResponse, status: number): Record<string, unknown> {
  expect(response.status).toBe(status);
  expect(response.contentType).not.toMatch(/text\/event-stream/iu);
  expect(response.contentType).toMatch(/json/iu);
  expect(response.text).not.toMatch(/^\s*data:/mu);
  expect(response.text).not.toContain("[DONE]");
  return asRecord(JSON.parse(response.text), "json body");
}

function expectOpenAiError(body: Record<string, unknown>): void {
  const error = asRecord(body.error, "error");
  expect(typeof error.message).toBe("string");
  expect(String(error.message).length).toBeGreaterThan(0);
}

function expectNoSecrets(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

async function expectFailedCli(cli: CliChild): Promise<void> {
  const exit = await cli.waitExit();
  expect(exit.signal !== null || (exit.code !== null && exit.code !== 0)).toBe(true);
  const output = `${cli.stdout()}${cli.stderr()}`;
  expect(readyPorts(output)).toEqual([]);
  expectNoSecrets(output, SECRETS);
}

function expectCanonicalChunks(chunks: Array<Record<string, unknown>>): void {
  const first = chunks[0];
  if (first === undefined) {
    throw new Error("stream has no JSON chunks");
  }
  expect(typeof first.id).toBe("string");
  expect(String(first.id).length).toBeGreaterThan(0);
  expect(typeof first.created).toBe("number");
  expect(Number.isInteger(first.created)).toBe(true);
  for (const chunk of chunks) {
    expect(chunk.id).toBe(first.id);
    expect(chunk.created).toBe(first.created);
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(typeof chunk.model).toBe("string");
    const choice = firstChoice(chunk);
    expect(choice.index).toBe(0);
    asRecord(choice.delta, "delta");
    expect(choice.finish_reason === null || typeof choice.finish_reason === "string").toBe(true);
  }
}

interface ReconstructedCall {
  id: string;
  type: string;
  name: string;
  arguments: string;
}

function reconstructBashCall(chunks: Array<Record<string, unknown>>): ReconstructedCall {
  const byIndex = new Map<number, ReconstructedCall>();
  for (const chunk of chunks) {
    const toolCalls = toolCallsOf(chunk);
    if (toolCalls === undefined) {
      continue;
    }
    for (const item of toolCalls) {
      const call = asRecord(item, "tool_call");
      if (typeof call.index !== "number") {
        throw new Error("tool_call.index is not a number");
      }
      let current = byIndex.get(call.index);
      if (current === undefined) {
        current = { id: "", type: "", name: "", arguments: "" };
        byIndex.set(call.index, current);
      }
      mergeToolCall(current, call);
    }
  }
  expect(byIndex.size).toBe(1);
  const only = byIndex.get(0);
  if (only === undefined) {
    throw new Error("expected a function tool call at index 0");
  }
  expect(only.id.length).toBeGreaterThan(0);
  expect(only.type).toBe("function");
  return only;
}

function toolCallsOf(chunk: Record<string, unknown>): unknown[] | undefined {
  const toolCalls = asRecord(firstChoice(chunk).delta, "delta").tool_calls;
  if (toolCalls === undefined) {
    return undefined;
  }
  if (!Array.isArray(toolCalls)) {
    throw new Error("delta.tool_calls is not an array");
  }
  return toolCalls;
}

function mergeToolCall(current: ReconstructedCall, call: Record<string, unknown>): void {
  if (typeof call.id === "string") {
    expect(call.id.length).toBeGreaterThan(0);
    if (current.id.length > 0) {
      expect(call.id).toBe(current.id);
    }
    current.id = call.id;
  }
  if (call.type !== undefined) {
    expect(call.type).toBe("function");
    current.type = "function";
  }
  appendFunctionDelta(current, call.function);
}

function appendFunctionDelta(current: ReconstructedCall, value: unknown): void {
  if (value === undefined) {
    return;
  }
  const fn = asRecord(value, "function");
  if (typeof fn.name === "string") {
    current.name += fn.name;
  }
  if (typeof fn.arguments === "string") {
    current.arguments += fn.arguments;
  }
}

function collectContent(chunks: Array<Record<string, unknown>>): string[] {
  const parts: string[] = [];
  for (const chunk of chunks) {
    const content = asRecord(firstChoice(chunk).delta, "delta").content;
    if (typeof content === "string" && content.length > 0) {
      parts.push(content);
    }
  }
  return parts;
}

function terminalFinish(chunks: Array<Record<string, unknown>>): unknown {
  const last = chunks[chunks.length - 1];
  if (last === undefined) {
    throw new Error("stream has no terminal chunk");
  }
  return firstChoice(last).finish_reason;
}

function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    throw new Error("chunk.choices must be a nonempty array");
  }
  return asRecord(chunk.choices[0], "choice");
}

function parseDataRecords(text: string): string[] {
  const records: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    if (event.trim().length === 0) {
      continue;
    }
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/u)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) {
      records.push(dataLines.join("\n"));
    }
  }
  return records;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonRecord(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value;
}

function spawnNode(args: string[], env: Record<string, string> = {}): CliChild {
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin", ...env },
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    childExits.set(child, { code, signal });
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitReady(ms = CHILD_MS) {
      return waitForReady(
        child,
        () => stdout,
        () => stderr,
        ms,
      );
    },
    waitExit(ms = CHILD_MS) {
      return waitChildExit(child, ms);
    },
  };
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
  stdout: () => string,
  stderr: () => string,
  ms: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const abort = AbortSignal.timeout(ms);
    const onAbort = (): void => {
      cleanup();
      reject(new Error(`timed out waiting for readiness; stdout=${stdout()} stderr=${stderr()}`));
    };
    const onChange = (): void => {
      const ports = readyPorts(stdout());
      if (ports.length === 1 && ports[0] !== undefined) {
        cleanup();
        resolve(ports[0]);
        return;
      }
      if (ports.length > 1) {
        cleanup();
        reject(new Error(`multiple readiness ports: ${ports.join(",")}`));
        return;
      }
      if (childExits.get(child) !== undefined) {
        cleanup();
        reject(new Error(`child exited before ready; stdout=${stdout()} stderr=${stderr()}`));
      }
    };
    const cleanup = (): void => {
      abort.removeEventListener("abort", onAbort);
      child.stdout.off("data", onChange);
      child.stderr.off("data", onChange);
      child.off("exit", onChange);
    };
    abort.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", onChange);
    child.stderr.on("data", onChange);
    child.on("exit", onChange);
    onChange();
  });
}

function waitChildExit(child: ChildProcessWithoutNullStreams, ms = CHILD_MS): Promise<ChildExit> {
  const observed = childExits.get(child);
  if (observed !== undefined) {
    return Promise.resolve(observed);
  }
  return new Promise((resolve, reject) => {
    const abort = AbortSignal.timeout(ms);
    const onAbort = (): void => {
      child.off("exit", onExit);
      reject(new Error("timed out waiting for child exit"));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      abort.removeEventListener("abort", onAbort);
      resolve(childExits.get(child) ?? { code, signal });
    };
    abort.addEventListener("abort", onAbort, { once: true });
    child.once("exit", onExit);
    const raced = childExits.get(child);
    if (raced !== undefined) {
      abort.removeEventListener("abort", onAbort);
      child.off("exit", onExit);
      resolve(raced);
    }
  });
}

function readyPorts(text: string): number[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    const port = portFromLine(line);
    return port === undefined ? [] : [port];
  });
}

function portFromLine(line: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(line.trim());
    if (!isJsonRecord(parsed)) {
      return undefined;
    }
    const port = parsed.port;
    if (typeof port === "number" && Number.isInteger(port) && port > 0) {
      return port;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function occupyLoopback(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  occupiers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("occupier did not bind a TCP address");
  }
  return { port: address.port, server };
}

async function reservePort(): Promise<number> {
  const occupier = await occupyLoopback();
  await closeServer(occupier.server);
  occupiers.splice(occupiers.indexOf(occupier.server), 1);
  return occupier.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function abortPartialRequest(port: number, path: string): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await waitSocket(socket, "connect");
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 80\r\n\r\n{"messages":',
  );
  socket.destroy();
  await waitSocket(socket, "close");
}

function waitSocket(socket: Socket, event: "connect" | "close"): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = AbortSignal.timeout(2_000);
    const onAbort = (): void => {
      socket.destroy();
      reject(new Error(`timed out waiting for socket ${event}`));
    };
    abort.addEventListener("abort", onAbort, { once: true });
    socket.once(event, () => {
      abort.removeEventListener("abort", onAbort);
      resolve();
    });
    socket.once("error", (error: Error) => {
      abort.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function expectRefused(port: number): Promise<void> {
  return probePort(port, "refuse");
}

function expectAccepts(port: number): Promise<void> {
  return probePort(port, "accept");
}

function probePort(port: number, expected: "accept" | "refuse"): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const abort = AbortSignal.timeout(2_000);
    const onAbort = (): void => {
      socket.destroy();
      reject(new Error(`timed out probing ${port}`));
    };
    abort.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      abort.removeEventListener("abort", onAbort);
      socket.destroy();
      if (expected === "accept") {
        resolve();
        return;
      }
      reject(new Error(`port ${port} still accepts connections`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      abort.removeEventListener("abort", onAbort);
      if (expected === "refuse" && error.code === "ECONNREFUSED") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (childExits.get(child) === undefined) {
    child.kill("SIGKILL");
  }
  await waitChildExit(child).catch(() => undefined);
}
