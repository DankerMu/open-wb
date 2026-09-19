/**
 * Issue #87 fake-omp process contracts.
 * Protocol pin: can1357/oh-my-pi@33cc6b9a043a74e00a157e72ca909272796d8461
 * Local: resource/oh-my-pi/docs/rpc.md, packages/coding-agent/src/modes/rpc/rpc-types.ts,
 * packages/agent/src/types.ts, packages/ai/src/types.ts (AssistantMessage.stopReason/errorMessage).
 * docs/architecture/rpc.md is absent (#141); this suite does not import the fixture.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const MAX_FRAME = 1_048_576;
const MAX_REASSEMBLED = 67_108_864;
const THREE_MIB = 3 * 1024 * 1024;
const TOKEN = "wb-issue87-bearer-sentinel";
const STREAMED_TEXT = "你好🌍";
const SSE_EVENT = `data: {"choices":[{"delta":{"content":"${STREAMED_TEXT}"}}]}\n\n`;
const SSE_DONE = Buffer.from(`${SSE_EVENT}data: [DONE]\n\n`, "utf8");
const OMP_FLAGS = [
  "--mode",
  "rpc",
  "--cwd",
  "/tmp",
  "--session-dir",
  "/tmp/sessions",
  "--model",
  "workbuddy/deepseek-v4.1-flash",
  "--approval-mode",
  "yolo",
  "--no-extensions",
  "--no-lsp",
  "--no-pty",
  "--no-title",
];
const RESUME = "/tmp/open-wb-fake-session.jsonl";
const HANDSHAKE = [
  { id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 },
  { id: "state-1", type: "get_state" },
];
const PROMPT = { id: "req_1", type: "prompt", message: "Summarize this repo" };

type Frame = Record<string, unknown>;

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fake-omp process contract", () => {
  it("advertises v1 ready, echoes ids, and completes a full prompt turn", async () => {
    const session = startFake();
    const ready = await session.wait((frame) => frame.type === "ready");
    expect(ready).toEqual({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: MAX_FRAME,
      maxReassembledFrameBytes: MAX_REASSEMBLED,
    });

    session.write(HANDSHAKE);
    session.write(PROMPT);
    const negotiate = await session.wait(response("protocol-1", "negotiate_protocol"));
    expect(negotiate).toMatchObject({
      success: true,
      data: { protocolVersion: 2 },
    });
    const state = await session.wait(response("state-1", "get_state"));
    const stateData = asRecord(state.data);
    expect(typeof stateData.sessionFile).toBe("string");
    expect(String(stateData.sessionFile).length).toBeGreaterThan(0);

    const ack = await session.wait(response("req_1", "prompt"));
    expect(ack.success).toBe(true);
    const end = await session.wait(
      (frame) => frame.type === "agent_end" && frame.isTerminal !== false,
    );
    expect(session.frames.indexOf(ack)).toBeLessThan(session.frames.indexOf(end));
    const promptIndex = session.frames.indexOf(ack);
    const endIndex = session.frames.indexOf(end);
    const turn = session.frames.slice(promptIndex + 1, endIndex + 1);
    const deltas = turn.filter(isTextDelta);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const starts = turn.filter((frame) => frame.type === "tool_execution_start");
    const ends = turn.filter((frame) => frame.type === "tool_execution_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]?.toolCallId).toBe(ends[0]?.toolCallId);
    expect(starts[0]?.toolName).toBe(ends[0]?.toolName);
    const toolOriginEnd = turn.find(
      (frame) =>
        frame.type === "message_end" &&
        asRecord(frame.message).role === "assistant" &&
        asRecord(frame.message).stopReason === "toolUse",
    );
    const finalEnd = turn.findLast(
      (frame) =>
        frame.type === "message_end" &&
        asRecord(frame.message).role === "assistant" &&
        asRecord(frame.message).stopReason === "stop",
    );
    expect(toolOriginEnd).toBeDefined();
    expect(finalEnd).toBeDefined();
    expect(turn.indexOf(toolOriginEnd as Frame)).toBeLessThan(turn.indexOf(starts[0] as Frame));
    expect(turn.indexOf(starts[0] as Frame)).toBeLessThan(turn.indexOf(ends[0] as Frame));
    expect(turn.indexOf(ends[0] as Frame)).toBeLessThan(turn.indexOf(finalEnd as Frame));
    expect(turn.indexOf(finalEnd as Frame)).toBeLessThan(turn.indexOf(end));
    session.closeStdin();
    await expect(session.waitExit()).resolves.toBe(0);
  });

  it("exits cleanly when idle stdin closes and ignores ordinary omp flags", async () => {
    const session = startFake({ extraArgs: ["--resume", RESUME] });
    await session.wait((frame) => frame.type === "ready");
    session.write([{ id: "state-resume", type: "get_state" }]);
    const state = await session.wait(response("state-resume", "get_state"));
    expect(asRecord(state.data).sessionFile).toBe(RESUME);
    session.closeStdin();
    await expect(session.waitExit()).resolves.toBe(0);
  });

  it("omits the ready frame when no-ready is selected", async () => {
    const session = startFake({ scenario: "no-ready" });
    session.write(HANDSHAKE);
    const negotiate = await session.wait(response("protocol-1", "negotiate_protocol"));
    expect(negotiate).toMatchObject({ success: true, data: { protocolVersion: 2 } });
    expect(session.frames.some((frame) => frame.type === "ready")).toBe(false);
    session.closeStdin();
    await session.waitExit();
  });

  it("omits sessionFile on get_state when missing-session is selected", async () => {
    const session = startFake({ scenario: "missing-session" });
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    const state = await session.wait(response("state-1", "get_state"));
    expect(asRecord(state.data)).not.toHaveProperty("sessionFile");
    session.closeStdin();
    await session.waitExit();
  });

  it("emits a >3MiB Unicode get_state as contiguous rpc_chunk frames", {
    timeout: 30_000,
  }, async () => {
    const session = startFake({ scenario: "chunked" });
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    await session.wait(response("protocol-1", "negotiate_protocol"));
    const sequence = await collectChunkSequence(session);
    const decoded = decodeChunks(sequence);
    expect(decoded.bytes.byteLength).toBeGreaterThan(THREE_MIB);
    expect(decoded.json).toMatchObject({
      id: "state-1",
      type: "response",
      command: "get_state",
      success: true,
    });
    expect(decoded.text).toMatch(/\P{ASCII}/u);
    await closeSession(session);
  });

  it("inserts an unrelated frame between chunks when interleaved is selected", {
    timeout: 30_000,
  }, async () => {
    const session = startFake({ scenario: "interleaved" });
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    await session.wait(response("protocol-1", "negotiate_protocol"));
    const sequence = await collectChunkSequence(session);
    expect(() => decodeChunks(sequence)).toThrow(/interleaved/u);
    await closeSession(session);
  });

  it("exits nonzero during a prompt without terminal agent_end when crash is selected", async () => {
    const session = await startPromptedSession({ scenario: "crash" });
    const code = await session.waitExit();
    expect(code).not.toBe(0);
    expect(
      session.frames.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false),
    ).toBe(false);
  });

  it("emits assistant stopReason error then terminal agent_end when error is selected", async () => {
    const session = await startPromptedSession({ scenario: "error" });
    await expectErrorTurn(session);
    await closeSession(session);
  });

  it("waits for a matching cancelled extension_ui_response before completing", async () => {
    const session = await startPromptedSession({ scenario: "extension-ui" });
    const request = await session.wait(
      (frame) => frame.type === "extension_ui_request" && frame.method === "confirm",
    );
    expect(typeof request.id).toBe("string");
    expect(session.frames.some((frame) => frame.type === "agent_end")).toBe(false);
    session.write([{ type: "extension_ui_response", id: "unrelated", cancelled: true }]);
    session.write([{ id: "probe-ui", type: "get_state" }]);
    await session.wait(response("probe-ui", "get_state"));
    expect(session.frames.some((frame) => frame.type === "agent_end")).toBe(false);
    session.write([{ type: "extension_ui_response", id: request.id, cancelled: true }]);
    await session.wait((frame) => frame.type === "agent_end" && frame.isTerminal !== false);
    await closeSession(session);
  });

  it("POSTs a bearer completion through forced fragmented UTF-8 SSE delivery", async () => {
    const captured: ProxyCapture[] = [];
    const splitAt = splitInsideEmoji(SSE_DONE);
    const proxy = await startProxy(async (request, response) => {
      captured.push({
        url: request.url ?? "",
        authorization: String(request.headers.authorization ?? ""),
        body: await collectRequest(request),
      });
      await writeFragmentedSse(response, SSE_DONE, splitAt);
    });
    const session = await startPromptedSession({
      scenario: "call-proxy",
      env: {
        PI_CODING_AGENT_DIR: tempAgentDir(
          managedYaml(`"${proxy.origin}/v1"`, "deepseek-v4.1-flash"),
        ),
        WORKBUDDY_MODEL_TOKEN: TOKEN,
      },
    });
    await session.wait((frame) => frame.type === "agent_end" && frame.isTerminal !== false);
    const text = session.frames
      .filter(isTextDelta)
      .map((frame) => String(asRecord(frame.assistantMessageEvent).delta))
      .join("");
    expect(text).toBe(STREAMED_TEXT);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("/v1/chat/completions");
    expect(captured[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(asRecord(JSON.parse(captured[0]?.body ?? "{}")).stream).toBe(true);
    expect(JSON.stringify(asRecord(JSON.parse(captured[0]?.body ?? "{}")).messages)).toContain(
      PROMPT.message,
    );
    expect(`${session.stdout}${session.stderr}`).not.toContain(TOKEN);
    await closeSession(session);
  });

  it("reports config, HTTP, and truncated-SSE failures before terminal completion", async () => {
    const missing = await startPromptedSession({
      scenario: "call-proxy",
      env: { PI_CODING_AGENT_DIR: tempAgentDir(""), WORKBUDDY_MODEL_TOKEN: TOKEN },
    });
    await expectVisibleFailure(missing);
    await closeSession(missing);

    const malformed = await startPromptedSession({
      scenario: "call-proxy",
      env: {
        PI_CODING_AGENT_DIR: tempAgentDir("providers: []\n"),
        WORKBUDDY_MODEL_TOKEN: TOKEN,
      },
    });
    await expectVisibleFailure(malformed);
    await closeSession(malformed);

    const httpProxy = await startProxy(async (_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"upstream"}');
    });
    const httpFail = await startPromptedSession({
      scenario: "call-proxy",
      env: {
        PI_CODING_AGENT_DIR: tempAgentDir(managedYaml(httpProxy.origin, "flash")),
        WORKBUDDY_MODEL_TOKEN: TOKEN,
      },
    });
    await expectVisibleFailure(httpFail);
    await closeSession(httpFail);

    const eofProxy = await startProxy(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(Buffer.from(SSE_EVENT, "utf8"));
    });
    const eof = await startPromptedSession({
      scenario: "call-proxy",
      env: {
        PI_CODING_AGENT_DIR: tempAgentDir(managedYaml(eofProxy.origin, "flash")),
        WORKBUDDY_MODEL_TOKEN: TOKEN,
      },
    });
    await expectVisibleFailure(eof);
    await closeSession(eof);
  });
});

interface Session {
  frames: Frame[];
  stdout: string;
  stderr: string;
  write(messages: Frame | Frame[]): void;
  wait(predicate: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  closeStdin(): void;
  waitExit(): Promise<number>;
}

interface StartOptions {
  scenario?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

type ProxyHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const exitStatuses = new WeakMap<ChildProcessWithoutNullStreams, number>();

function startFake(options: StartOptions = {}): Session {
  const args = [...OMP_FLAGS, ...(options.extraArgs ?? [])];
  if (options.scenario !== undefined) {
    args.push("--scenario", options.scenario);
  }
  const child = spawn(process.execPath, [FAKE, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin", ...options.env },
  });
  children.push(child);
  const frames: Frame[] = [];
  let stdout = "";
  let stderr = "";
  let pending = "";
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const recordExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitStatuses.set(child, exitStatus(code, signal));
    notify();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.length > 0) {
        frames.push(JSON.parse(line) as Frame);
      }
      newline = pending.indexOf("\n");
    }
    notify();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    notify();
  });
  child.on("exit", recordExit);
  child.on("close", recordExit);
  return {
    frames,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    write(messages: Frame | Frame[]) {
      const list = Array.isArray(messages) ? messages : [messages];
      for (const message of list) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    },
    wait(predicate, ms = 8_000) {
      return new Promise<Frame>((resolve, reject) => {
        const abort = AbortSignal.timeout(ms);
        const onAbort = (): void => {
          cleanup();
          reject(new Error(`timed out waiting for frame; got ${JSON.stringify(frames)}`));
        };
        const onChange = (): void => {
          const match = frames.find(predicate);
          if (match !== undefined) {
            cleanup();
            resolve(match);
            return;
          }
          if (observedExitStatus(child) !== undefined) {
            cleanup();
            reject(new Error(`child exited before frame; stdout=${stdout} stderr=${stderr}`));
          }
        };
        const cleanup = (): void => {
          abort.removeEventListener("abort", onAbort);
          listeners.delete(onChange);
        };
        abort.addEventListener("abort", onAbort, { once: true });
        listeners.add(onChange);
        onChange();
      });
    },
    closeStdin() {
      child.stdin.end();
    },
    waitExit() {
      return waitExit(child);
    },
  };
}

async function startPromptedSession(options: StartOptions = {}): Promise<Session> {
  const session = startFake(options);
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("protocol-1", "negotiate_protocol"));
  await session.wait(response("state-1", "get_state"));
  session.write(PROMPT);
  await session.wait(response("req_1", "prompt"));
  return session;
}

async function closeSession(session: Session): Promise<void> {
  session.closeStdin();
  await session.waitExit();
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (observedExitStatus(child) === undefined) {
    child.kill("SIGKILL");
  }
  await waitExit(child);
}

function observedExitStatus(child: ChildProcessWithoutNullStreams): number | undefined {
  const recorded = exitStatuses.get(child);
  if (recorded !== undefined) {
    return recorded;
  }
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return child.signalCode === null ? undefined : 1;
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal === null ? 0 : 1);
}

function waitExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  const observed = observedExitStatus(child);
  if (observed !== undefined) {
    return Promise.resolve(observed);
  }
  return new Promise<number>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.off("exit", onExit);
      child.off("close", onClose);
      resolve(observedExitStatus(child) ?? exitStatus(code, signal));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(code, signal);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(code, signal);
    };
    child.once("exit", onExit);
    child.once("close", onClose);
    const cached = observedExitStatus(child);
    if (cached !== undefined) {
      child.off("exit", onExit);
      child.off("close", onClose);
      resolve(cached);
    }
  });
}

function response(id: string, command: string): (frame: Frame) => boolean {
  return (frame) => frame.type === "response" && frame.id === id && frame.command === command;
}

function isTextDelta(frame: Frame): boolean {
  return (
    frame.type === "message_update" && asRecord(frame.assistantMessageEvent).type === "text_delta"
  );
}

function asRecord(value: unknown): Frame {
  return value !== null && typeof value === "object" ? (value as Frame) : {};
}

function decodeChunks(frames: Frame[]): { bytes: Buffer; text: string; json: Frame } {
  const chunks = frames.filter((frame) => frame.type === "rpc_chunk");
  if (chunks.length !== frames.length) {
    throw new Error("interleaved rpc_chunk sequence");
  }
  if (chunks.length === 0) {
    throw new Error("missing rpc_chunk frames");
  }
  const chunkId = chunks[0]?.chunkId;
  const count = chunks[0]?.count;
  const byteLength = chunks[0]?.byteLength;
  const parts: Buffer[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const serialized = Buffer.byteLength(`${JSON.stringify(chunk)}\n`, "utf8");
    expect(serialized).toBeLessThanOrEqual(MAX_FRAME);
    expect(chunk.chunkId).toBe(chunkId);
    expect(chunk.count).toBe(count);
    expect(chunk.byteLength).toBe(byteLength);
    expect(chunk.index).toBe(index);
    const bytes = Buffer.from(String(chunk.data), "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_FRAME);
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  expect(bytes.byteLength).toBe(byteLength);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { bytes, text, json: JSON.parse(text) as Frame };
}

async function collectChunkSequence(session: Session): Promise<Frame[]> {
  const first = await session.wait((frame) => frame.type === "rpc_chunk");
  const count = Number(first.count);
  await session.wait(
    () => session.frames.filter((frame) => frame.type === "rpc_chunk").length >= count,
  );
  const start = session.frames.indexOf(first);
  const sequence: Frame[] = [];
  for (const frame of session.frames.slice(start)) {
    sequence.push(frame);
    if (sequence.filter((item) => item.type === "rpc_chunk").length >= count) {
      break;
    }
  }
  return sequence;
}

async function expectErrorTurn(session: Session): Promise<void> {
  const end = await session.wait(
    (frame) => frame.type === "agent_end" && frame.isTerminal !== false,
  );
  const failed = session.frames.find(
    (frame) =>
      frame.type === "message_end" &&
      asRecord(frame.message).role === "assistant" &&
      asRecord(frame.message).stopReason === "error",
  );
  expect(failed).toBeDefined();
  const message = asRecord(failed?.message);
  expect(message).toMatchObject({ role: "assistant", stopReason: "error" });
  expect(typeof message.errorMessage).toBe("string");
  expect(String(message.errorMessage).length).toBeGreaterThan(0);
  expect(session.frames.indexOf(failed as Frame)).toBeLessThan(session.frames.indexOf(end));
}

async function expectVisibleFailure(session: Session): Promise<void> {
  await expectErrorTurn(session);
  expect(session.frames.some(isTextDelta)).toBe(false);
  expect(
    session.frames.some(
      (frame) => frame.type === "message_end" && asRecord(frame.message).stopReason === "stop",
    ),
  ).toBe(false);
  expect(`${session.stdout}${session.stderr}`).not.toContain(TOKEN);
}

interface ProxyCapture {
  url: string;
  authorization: string;
  body: string;
}

async function startProxy(handler: ProxyHandler): Promise<{ origin: string }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("proxy did not bind");
  }
  return { origin: `http://127.0.0.1:${address.port}` };
}

function collectRequest(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function writeFragmentedSse(
  response: ServerResponse,
  payload: Buffer,
  splitAt: number,
): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.socket?.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    response.write(payload.subarray(0, splitAt), (error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  response.end(payload.subarray(splitAt));
}

function splitInsideEmoji(payload: Buffer): number {
  const start = payload.indexOf(Buffer.from("🌍", "utf8"));
  if (start < 0) {
    throw new Error("missing emoji test payload");
  }
  return start + 2;
}

function tempAgentDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-omp-"));
  temps.push(dir);
  if (yaml.length > 0) {
    writeFileSync(join(dir, "models.yml"), yaml);
  }
  return dir;
}

function managedYaml(baseUrl: string, modelId: string): string {
  return [
    "providers:",
    "  workbuddy:",
    "    api: openai-completions",
    `    baseUrl: ${baseUrl}`,
    "    apiKey: WORKBUDDY_MODEL_TOKEN",
    "    models:",
    `      - id: ${modelId}`,
    "        name: flash",
    "        contextWindow: 128000",
    "        maxTokens: 8192",
    "",
  ].join("\n");
}
