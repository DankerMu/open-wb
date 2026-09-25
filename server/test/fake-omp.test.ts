/**
 * Issue #87 fake-omp process contracts.
 * Protocol pin: can1357/oh-my-pi@33cc6b9a043a74e00a157e72ca909272796d8461
 * Local: resource/oh-my-pi/docs/rpc.md, packages/coding-agent/src/modes/rpc/rpc-types.ts,
 * packages/agent/src/types.ts, packages/ai/src/types.ts (AssistantMessage.stopReason/errorMessage).
 * docs/architecture/rpc.md is absent (#141); this suite does not import fake-omp.mjs.
 * call-proxy's two-round contract (#166) runs against the real #88 fake upstream;
 * fragment reassembly and malformed tool calls run against test-owned SSE stubs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  fragment,
  HANDSHAKE,
  isTextDelta,
  PROMPT,
  response,
  type Session,
  splitInside,
  sse,
  startFake,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";
import { startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const MAX_FRAME = 1_048_576;
const MAX_REASSEMBLED = 67_108_864;
const THREE_MIB = 3 * 1024 * 1024;
const TOKEN = "wb-issue87-bearer-sentinel";
const STREAMED_TEXT = "你好🌍";
const SSE_EVENT = `data: {"choices":[{"delta":{"content":"${STREAMED_TEXT}"}}]}\n\n`;
const SSE_DONE = Buffer.from(`${SSE_EVENT}data: [DONE]\n\n`, "utf8");
const PROBE_HOME = "/tmp/fake-omp home:dir";
const PROBE_AGENT = "/tmp/fake-omp agent:dir";
const PROBE_CANARY = "workbuddy-canary-secret";
const PROBE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "/usr/bin",
  HOME: PROBE_HOME,
  PI_CODING_AGENT_DIR: PROBE_AGENT,
  WORKBUDDY_CANARY_SECRET: PROBE_CANARY,
  __CF_USER_TEXT_ENCODING: "0:0:0",
};
const PROBE_ENV_KEYS =
  "HOME,PATH,PI_CODING_AGENT_DIR,WORKBUDDY_CANARY_SECRET,__CF_USER_TEXT_ENCODING";
const PARENT_UID = process.getuid?.();
const PARENT_GID = process.getgid?.();
if (typeof PARENT_UID !== "number" || typeof PARENT_GID !== "number") {
  throw new Error("posix uid/gid unavailable");
}
const PROC_ENVIRON = process.platform === "linux" ? "readable" : "ENOENT";
const MISSING_PID = "1".repeat(18);
const RESUME = "/tmp/open-wb-fake-session.jsonl";
/** #88 fake-upstream 契约的固定工具参数与回复文本（model-proxy 假上游夹具契约）。 */
const FIXTURE_TOOL_ARGS = '{"command":"echo workbuddy-smoke"}';
const FIXTURE_TEXT = "你好，这是 WorkBuddy 的第一条流式回复。";
const TOOL_OUTPUT = "workbuddy-smoke";
const ROLE_ONLY_DONE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n';
const TOOL_ONLY_DONE = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stub","type":"function","function":{"name":"bash","arguments":"{}"}}]}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`;
/** 分片工具轮：index 1 先到、id/name 只在首片、arguments 各 ≥3 片交错，首片与正文同块。 */
const ROUND1_TEXT = "Let me look. ";
const BASH_ARGS = '{"command":"echo 你好"}';
const READ_ARGS = '{"path":"/tmp/α.txt"}';
const FRAGMENTED_ROUND = sse([
  { content: ROUND1_TEXT, tool_calls: [fragment(1, "", "call_b", "read")] },
  { tool_calls: [fragment(0, '{"comm', "call_a", "bash")] },
  { tool_calls: [fragment(1, '{"pa')] },
  { tool_calls: [fragment(1, 'th":"/tmp/')] },
  { tool_calls: [fragment(0, 'and":"echo ')] },
  { tool_calls: [fragment(1, 'α.txt"}')] },
  { tool_calls: [fragment(0, '你好"}')] },
]);
const ANSWER_DELTAS = ["工具", "已跑完", "。"];
const ANSWER_ROUND = sse(ANSWER_DELTAS.map((content) => ({ content })));

const servers: Server[] = [];
const upstreams: FakeUpstreamServer[] = [];
const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
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
    const splitAt = splitInside(SSE_DONE, "🌍", 2);
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

    await runFailingStub(async (_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"upstream"}');
    });
    await runFailingStub(sseStub(SSE_EVENT));
  });

  it("fails an empty 200 round and a second tool-only round instead of an empty success", async () => {
    await expect(runFailingStub(sseStub(ROLE_ONLY_DONE))).resolves.toBe(1);
    await expect(runFailingStub(sseStub(TOOL_ONLY_DONE))).resolves.toBe(2);
  });

  it("fails non-JSON concatenated arguments, an index gap, and an id-less call in one request", async () => {
    const nonJson = sse([
      { tool_calls: [fragment(0, '{"command":', "call_x", "bash")] },
      { tool_calls: [fragment(0, "nope")] },
    ]);
    const gap = sse([{ tool_calls: [fragment(1, "{}", "call_y", "bash")] }]);
    const noId = sse([{ tool_calls: [fragment(0, "{}", undefined, "bash")] }]);
    await expect(runFailingStub(sseStub(nonJson))).resolves.toBe(1);
    await expect(runFailingStub(sseStub(gap))).resolves.toBe(1);
    await expect(runFailingStub(sseStub(noId))).resolves.toBe(1);
  });

  it("reassembles interleaved tool-call fragments by index and relays both calls", async () => {
    const requests: string[] = [];
    const stub = await startProxy(async (request, response) => {
      requests.push(await collectRequest(request));
      if (requests.length === 1) {
        const payload = Buffer.from(FRAGMENTED_ROUND, "utf8");
        await writeFragmentedSse(response, payload, splitInside(payload, "你", 1));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(ANSWER_ROUND);
    });
    const session = await promptThroughStub(stub.origin);
    const end = await session.wait(
      (frame) => frame.type === "agent_end" && frame.isTerminal !== false,
    );
    const calls = [
      { id: "call_a", name: "bash", args: BASH_ARGS },
      { id: "call_b", name: "read", args: READ_ARGS },
    ];
    const ofType = (type: string): Frame[] => session.frames.filter((frame) => frame.type === type);
    expect(ofType("tool_execution_start")).toEqual(
      calls.map(({ id, name, args }) => ({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: name,
        args: JSON.parse(args),
      })),
    );
    expect(ofType("tool_execution_end")).toEqual(
      calls.map(({ id, name }) => ({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: name,
        result: { output: TOOL_OUTPUT },
      })),
    );
    expect(requests).toHaveLength(2);
    expect(asRecord(JSON.parse(requests[1] ?? "{}")).messages).toEqual([
      { role: "user", content: PROMPT.message },
      {
        role: "assistant",
        content: ROUND1_TEXT,
        tool_calls: calls.map(({ id, name, args }) => ({
          id,
          type: "function",
          function: { name, arguments: args },
        })),
      },
      ...calls.map(({ id }) => ({ role: "tool", tool_call_id: id, content: TOOL_OUTPUT })),
    ]);
    const deltas = session.frames
      .filter(isTextDelta)
      .map((frame) => String(asRecord(frame.assistantMessageEvent).delta));
    expect(deltas).toEqual([ROUND1_TEXT, ...ANSWER_DELTAS]);
    await expectRelayedTail(session, end);
  });

  it("relays the #88 fixture tool round and answering round with the upstream call id", async () => {
    const upstream = await startTrackedFakeUpstream(upstreams, { apiKey: TOKEN });
    const recorded: RecordedExchange[] = [];
    const forwarder = await startProxy((request, response) =>
      forwardRecorded(upstream.port, request, response, recorded),
    );
    const session = await startPromptedSession({
      scenario: "call-proxy",
      env: {
        PI_CODING_AGENT_DIR: tempAgentDir(managedYaml(`"${forwarder.origin}/v1"`, "flash")),
        WORKBUDDY_MODEL_TOKEN: TOKEN,
      },
    });
    const end = await session.wait(
      (frame) => frame.type === "agent_end" && frame.isTerminal !== false,
    );
    expect(recorded).toHaveLength(2);
    const [first, second] = recorded.map((exchange) => asRecord(JSON.parse(exchange.request)));
    expect(first).toEqual({ stream: true, messages: [{ role: "user", content: PROMPT.message }] });
    const starts = session.frames.filter((frame) => frame.type === "tool_execution_start");
    expect(starts).toHaveLength(1);
    const start = starts[0];
    const callId = String(start?.toolCallId);
    expect(callId).toMatch(/^call_[0-9a-f-]{36}$/u);
    expect(recorded[0]?.response).toContain(`"id":"${callId}"`);
    expect(start).toEqual({
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: "bash",
      args: JSON.parse(FIXTURE_TOOL_ARGS),
    });
    expect(session.frames.filter((frame) => frame.type === "tool_execution_end")).toEqual([
      {
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: "bash",
        result: { output: TOOL_OUTPUT },
      },
    ]);
    expect(second?.stream).toBe(true);
    expect(second?.messages).toEqual([
      { role: "user", content: PROMPT.message },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: "bash", arguments: FIXTURE_TOOL_ARGS },
          },
        ],
      },
      { role: "tool", tool_call_id: callId, content: TOOL_OUTPUT },
    ]);
    const deltas = session.frames
      .filter(isTextDelta)
      .map((frame) => String(asRecord(frame.assistantMessageEvent).delta));
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.join("")).toBe(FIXTURE_TEXT);
    await expectRelayedTail(session, end);
  });

  it("reports identity, sorted env keys, HOME/agent, and probe file content", async () => {
    const writePath = join(tempAgentDir(""), "out:with spaces");
    const session = await runProbe(`${process.pid}:${writePath}`);
    await expectProbeTurn(session, expectedProbeReport(PROC_ENVIRON, "ok"));
    expect(readFileSync(writePath, "utf8")).toBe("probe");
    expect(`${session.stdout}${session.stderr}`).not.toContain(PROBE_CANARY);
    await closeSession(session);
  });

  it("reports write ENOENT independently of the actual proc-read result", async () => {
    const writePath = join(tempAgentDir(""), "missing", "probe.txt");
    const session = await runProbe(`${process.pid}:${writePath}`);
    await expectProbeTurn(session, expectedProbeReport(PROC_ENVIRON, "ENOENT"));
    expect(existsSync(writePath)).toBe(false);
    await closeSession(session);
  });

  it("reports missing-pid ENOENT independently of a successful write", async () => {
    const writePath = join(tempAgentDir(""), "missing-pid.txt");
    const session = await runProbe(`${MISSING_PID}:${writePath}`);
    await expectProbeTurn(session, expectedProbeReport("ENOENT", "ok"));
    expect(readFileSync(writePath, "utf8")).toBe("probe");
    await closeSession(session);
  });
});

type ProxyHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

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

interface RecordedExchange {
  request: string;
  response: string;
}

/** 测试自有转发器：原样转发请求体与 bearer 到 #88 夹具，并记录每轮请求/响应文本。 */
async function forwardRecorded(
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
  recorded: RecordedExchange[],
): Promise<void> {
  const body = await collectRequest(request);
  const exchange = { request: body, response: "" };
  recorded.push(exchange);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: request.method,
        path: request.url,
        headers: {
          authorization: request.headers.authorization,
          "content-type": request.headers["content-type"],
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          response.write(chunk);
        });
        upstreamResponse.once("end", () => {
          exchange.response = Buffer.concat(chunks).toString("utf8");
          response.end(resolve);
        });
        upstreamResponse.once("error", reject);
      },
    );
    upstream.once("error", reject);
    upstream.end(body);
  });
}

/** 固定 SSE 载荷的 200 stub（先读完请求体）。 */
function sseStub(payload: string): ProxyHandler {
  return async (request, response) => {
    await collectRequest(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(Buffer.from(payload, "utf8"));
  };
}

/** call-proxy 打到 stub 必须可见失败；返回 stub 收到的请求数（证明没有多余轮次）。 */
async function runFailingStub(handler: ProxyHandler): Promise<number> {
  let requests = 0;
  const stub = await startProxy(async (request, response) => {
    requests += 1;
    await handler(request, response);
  });
  const session = await promptThroughStub(stub.origin);
  await expectVisibleFailure(session);
  await closeSession(session);
  return requests;
}

function promptThroughStub(origin: string): Promise<Session> {
  return startPromptedSession({
    scenario: "call-proxy",
    env: {
      PI_CODING_AGENT_DIR: tempAgentDir(managedYaml(origin, "flash")),
      WORKBUDDY_MODEL_TOKEN: TOKEN,
    },
  });
}

/** 两轮继电器收尾：stopReason 恰为 [toolUse, stop]、agent_end 为最后一帧、输出无 token。 */
async function expectRelayedTail(session: Session, end: Frame): Promise<void> {
  const stopReasons = session.frames
    .filter((frame) => frame.type === "message_end")
    .map((frame) => asRecord(frame.message).stopReason);
  expect(stopReasons).toEqual(["toolUse", "stop"]);
  expect(session.frames.at(-1)).toBe(end);
  expect(`${session.stdout}${session.stderr}`).not.toContain(TOKEN);
  await closeSession(session);
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

function tempAgentDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-omp-"));
  temps.push(dir);
  if (yaml.length > 0) {
    writeFileSync(join(dir, "models.yml"), yaml);
  }
  return dir;
}

async function runProbe(rest: string): Promise<Session> {
  return startPromptedSession({
    env: PROBE_ENV,
    prompt: { id: "req_probe", type: "prompt", message: `probe:${rest}` },
  });
}

async function expectProbeTurn(session: Session, expectedDelta: string): Promise<void> {
  const ack = await session.wait(response("req_probe", "prompt"));
  expect(ack).toEqual({
    id: "req_probe",
    type: "response",
    command: "prompt",
    success: true,
    data: { agentInvoked: true },
  });
  const end = await session.wait(
    (frame) => frame.type === "agent_end" && frame.isTerminal === true,
  );
  expect(end).toEqual({ type: "agent_end", messages: [], isTerminal: true });
  expect(session.frames.slice(session.frames.indexOf(ack))).toEqual([
    ack,
    { type: "agent_start" },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: expectedDelta },
      message: { role: "assistant", content: [] },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop" },
    },
    end,
  ]);
}

function expectedProbeReport(environ: string, wrote: string): string {
  return `uid=${String(PARENT_UID)} gid=${String(PARENT_GID)} env=${PROBE_ENV_KEYS} home=${PROBE_HOME} agent=${PROBE_AGENT} environ=${environ} wrote=${wrote}`;
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
