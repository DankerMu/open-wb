#!/usr/bin/env node
/**
 * Issue #87 fake omp subprocess. Protocol pin:
 * can1357/oh-my-pi@33cc6b9a043a74e00a157e72ca909272796d8461
 * Local oracle: resource/oh-my-pi/docs/rpc.md (docs/architecture/rpc.md tracked by #141).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MAX_FRAME = 1_048_576;
const MAX_REASSEMBLED = 67_108_864;
const CHUNK_PAYLOAD = 256 * 1024;
const THREE_MIB = 3 * 1024 * 1024;
const DEFAULT_SESSION = "/tmp/open-wb-fake-session.jsonl";
const TOOL_ID = "tool-1";
const TOOL_NAME = "bash";
const TOOL_OUTPUT = "workbuddy-smoke";
const UI_ID = "ui-confirm-1";
const DELTAS = ["Hello ", "from ", "fake-omp"];
const ABORT_SCENARIOS = new Set(["abort-ok", "abort-ignored"]);

const { scenario, resume } = parseArgs(process.argv.slice(2));
let protocol = 1;
let pendingUi = false;
/** abort-* 回合三态：idle（首个 prompt 挂起回合）→ pending（等 abort）→ done（其后 prompt 走缺省路径）。 */
let abortTurn = "idle";
let queue = Promise.resolve();

if (scenario !== "no-ready" && scenario !== "no-ready-hang") {
  queue = queue.then(() =>
    emit({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: MAX_FRAME,
      maxReassembledFrameBytes: MAX_REASSEMBLED,
    }),
  );
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  queue = queue.then(() => onLine(line));
});
rl.on("close", () => {
  if (scenario === "hang-eof" || scenario === "hang-term" || scenario === "no-ready-hang") {
    return;
  }
  queue.then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

if (scenario === "hang-eof" || scenario === "hang-term" || scenario === "no-ready-hang") {
  setInterval(() => {}, 60_000);
}
if (scenario === "hang-term" || scenario === "no-ready-hang") {
  process.on("SIGTERM", () => {});
}
if (scenario === "no-ready-hang") {
  process.stderr.write("no-ready-hang:handlers-ready\n");
}

function parseArgs(argv) {
  let selected = "normal";
  let sessionFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") {
      selected = argv[++i] ?? selected;
    } else if (argv[i] === "--resume") {
      sessionFile = argv[++i];
    }
  }
  return { scenario: selected, resume: sessionFile };
}

function emit(frame) {
  const { promise, resolve, reject } = Promise.withResolvers();
  process.stdout.write(`${JSON.stringify(frame)}\n`, (error) =>
    error ? reject(error) : resolve(),
  );
  return promise;
}

async function onLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    await emit({ type: "response", command: "parse", success: false, error: "invalid json" });
    return;
  }
  await dispatch(frame);
}

async function dispatch(frame) {
  const type = frame?.type;
  const handlers = {
    extension_ui_response: handleUi,
    negotiate_protocol: handleNegotiate,
    get_state: handleState,
    prompt: handlePrompt,
    ...(ABORT_SCENARIOS.has(scenario) ? { abort: handleAbort } : {}),
  };
  const handler = handlers[type];
  if (handler) {
    await handler(frame);
    return;
  }
  await emit({
    type: "response",
    command: String(type ?? "parse"),
    success: false,
    error: "unsupported",
  });
}

async function handleNegotiate(frame) {
  protocol = 2;
  await emit({
    id: frame.id,
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  });
}

async function handleState(frame) {
  const data = sessionState();
  if (scenario === "chunked" || scenario === "interleaved") {
    if (protocol === 2) {
      data.pad = unicodePad();
      await emitChunked({
        id: frame.id,
        type: "response",
        command: "get_state",
        success: true,
        data,
      });
      return;
    }
  }
  await emit({
    id: frame.id,
    type: "response",
    command: "get_state",
    success: true,
    data,
  });
}

function sessionState() {
  const data = {
    model: { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionId: "sess-fake",
    autoCompactionEnabled: true,
    fastModeEnabled: false,
    fastModeActive: false,
    tokensPerSecond: null,
    messageCount: 0,
    queuedMessageCount: 0,
    todoPhases: [],
  };
  if (scenario === "missing-session") {
    return data;
  }
  if (scenario === "new-session") {
    data.sessionFile = "/tmp/open-wb-new-session.jsonl";
    return data;
  }
  data.sessionFile = resume ?? DEFAULT_SESSION;
  return data;
}

function unicodePad() {
  return "你好".repeat(Math.ceil((THREE_MIB + 4096) / 6));
}

async function emitChunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / CHUNK_PAYLOAD);
  for (let index = 0; index < count; index++) {
    if (scenario === "interleaved" && index === 1) {
      await emit({ type: "notice", level: "info", message: "interleave" });
    }
    await emit({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * CHUNK_PAYLOAD, (index + 1) * CHUNK_PAYLOAD).toString("base64"),
    });
  }
}

async function handlePrompt(frame) {
  await emit({
    id: frame.id,
    type: "response",
    command: "prompt",
    success: true,
    data: { agentInvoked: true },
  });
  const turns = {
    crash: () => process.exit(2),
    "crash-after-deltas": () => crashAfterDeltas(),
    error: () => failTurn("fake omp scripted error"),
    "extension-ui": () => requestConfirm(),
    "call-proxy": () => runProxy(frame.message),
    "hang-prompt": () => {},
  };
  if (ABORT_SCENARIOS.has(scenario) && abortTurn === "idle") {
    await holdTurn();
    return;
  }
  const turn = turns[scenario];
  if (turn) {
    await turn();
    return;
  }
  const report = probeReport(frame.message);
  if (report !== undefined) {
    await completeTurn([report], false);
    return;
  }
  await completeTurn(DELTAS, true);
}

function probeReport(message) {
  const text = String(message ?? "");
  if (!text.startsWith("probe:")) {
    return undefined;
  }
  const rest = text.slice(6);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const pid = rest.slice(0, colon);
  const writePath = rest.slice(colon + 1);
  if (!/^[0-9]+$/u.test(pid) || writePath.length === 0) {
    return undefined;
  }
  let wrote = "ok";
  try {
    writeFileSync(writePath, "probe", "utf8");
  } catch (error) {
    wrote = error.code;
  }
  let environ = "readable";
  try {
    readFileSync(`/proc/${pid}/environ`);
  } catch (error) {
    environ = error.code;
  }
  const env = Object.keys(process.env).sort().join(",");
  return `uid=${process.getuid()} gid=${process.getgid()} env=${env} home=${process.env.HOME ?? ""} agent=${process.env.PI_CODING_AGENT_DIR ?? ""} environ=${environ} wrote=${wrote}`;
}

async function requestConfirm() {
  pendingUi = true;
  await emit({
    type: "extension_ui_request",
    id: UI_ID,
    method: "confirm",
    title: "Confirm",
    message: "Continue?",
  });
}

async function handleUi(frame) {
  if (!pendingUi || frame.id !== UI_ID || frame.cancelled !== true) {
    return;
  }
  pendingUi = false;
  await completeTurn(DELTAS, true);
}

/**
 * 发完 agent_start 与两段 delta 后返回：回合只记在 abortTurn，不 await abort，
 * 否则串行队列里的 abort 行永远排不到。
 */
async function holdTurn() {
  await emit({ type: "agent_start" });
  await emitDeltas(DELTAS.slice(0, 2));
  abortTurn = "pending";
}

async function handleAbort(frame) {
  if (scenario !== "abort-ok" || abortTurn !== "pending") {
    return;
  }
  await emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "aborted" },
  });
  await emit({ type: "agent_end", messages: [], isTerminal: true });
  await emit({ id: frame.id, type: "response", command: "abort", success: true });
  abortTurn = "done";
}

async function crashAfterDeltas() {
  await emit({ type: "agent_start" });
  await emitDeltas(DELTAS.slice(0, 2));
  process.exit(2);
}

async function completeTurn(deltas, tools) {
  await emit({ type: "agent_start" });
  await emitDeltas(deltas);
  if (tools) {
    await emitToolRound([
      { id: TOOL_ID, name: TOOL_NAME, args: { command: "echo workbuddy-smoke" } },
    ]);
  }
  await finishTurn();
}

async function emitDeltas(deltas) {
  for (const delta of deltas) {
    await emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
      message: { role: "assistant", content: [] },
    });
  }
}

async function emitToolRound(calls) {
  await emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "toolUse" },
  });
  for (const call of calls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.args,
    });
    await emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result: { content: [{ type: "text", text: TOOL_OUTPUT }], details: { exitCode: 0 } },
    });
  }
}

async function finishTurn() {
  await emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "stop" },
  });
  await emit({ type: "agent_end", messages: [], isTerminal: true });
}

async function failTurn(errorMessage) {
  await emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  });
  await emit({ type: "agent_end", messages: [], isTerminal: true });
}

/**
 * 有界两轮继电器（#166）：第一轮带 tool_calls 时报告工具帧并发唯一一次第二轮；
 * 回答轮没有内容（空 200、第二轮仍只有 tool_calls）一律可见失败，绝不空回合成功。
 */
async function runProxy(message) {
  try {
    const baseUrl = loadBaseUrl();
    const token = process.env.WORKBUDDY_MODEL_TOKEN;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("config");
    }
    const user = { role: "user", content: message };
    const first = await postChat(baseUrl, token, [user]);
    if (first.calls.length > 0) {
      await relayToolRound(baseUrl, token, user, first);
      return;
    }
    if (first.deltas.length === 0) {
      throw new Error("empty round");
    }
    await completeTurn(first.deltas, false);
  } catch {
    await failTurn("proxy failed");
  }
}

async function relayToolRound(baseUrl, token, user, first) {
  const calls = Array.from(first.calls, parseToolCall);
  await emit({ type: "agent_start" });
  await emitDeltas(first.deltas);
  await emitToolRound(calls);
  const second = await postChat(baseUrl, token, [
    user,
    {
      role: "assistant",
      content: first.deltas.length > 0 ? first.deltas.join("") : null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: TOOL_OUTPUT })),
  ]);
  if (second.calls.length > 0 || second.deltas.length === 0) {
    throw new Error("no answering content");
  }
  await emitDeltas(second.deltas);
  await finishTurn();
}

function parseToolCall(call) {
  if (call === undefined || call.id.length === 0 || call.name.length === 0) {
    throw new Error("incomplete tool call");
  }
  const args = JSON.parse(call.arguments);
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tool arguments");
  }
  return { ...call, args };
}

function loadBaseUrl() {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("config");
  }
  let text;
  try {
    text = readFileSync(join(dir, "models.yml"), "utf8");
  } catch {
    throw new Error("config");
  }
  return parseWorkbuddyBaseUrl(text);
}

function parseWorkbuddyBaseUrl(text) {
  if (/^providers:\s*\[/mu.test(text)) {
    throw new Error("config");
  }
  const fields = collectWorkbuddyFields(text);
  const { api, apiKey, baseUrl, hasModel } = fields;
  if (
    api !== "openai-completions" ||
    apiKey !== "WORKBUDDY_MODEL_TOKEN" ||
    typeof baseUrl !== "string" ||
    !/^https?:\/\//u.test(baseUrl) ||
    !hasModel
  ) {
    throw new Error("config");
  }
  return baseUrl;
}

function collectWorkbuddyFields(text) {
  const fields = { hasModel: false };
  let section = "";
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const indent = raw.match(/^ */u)[0].length;
    section = nextSection(section, indent, line);
    applyWorkbuddyLine(fields, section, indent, line);
  }
  return fields;
}

function nextSection(section, indent, line) {
  if (indent === 0) {
    return line === "providers:" ? "providers" : "";
  }
  if (section.startsWith("providers") && indent === 2) {
    return line === "workbuddy:" ? "workbuddy" : "providers";
  }
  return section;
}

function applyWorkbuddyLine(fields, section, indent, line) {
  if (section !== "workbuddy") {
    return;
  }
  if (indent === 4) {
    const match = /^([A-Za-z]+):\s*(.*)$/u.exec(line);
    if (match && match[1] !== "models") {
      fields[match[1]] = unquote(match[2]);
    }
    return;
  }
  if (indent >= 6 && /(^-\s*id:|^id:)/u.test(line)) {
    fields.hasModel = true;
  }
}

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function postChat(baseUrl, token, messages) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = new URL("chat/completions", root);
  const payload = Buffer.from(JSON.stringify({ stream: true, messages }));
  const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
  const req = send(
    endpoint,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
      },
    },
    (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("http"));
        return;
      }
      readSseRound(response).then(resolve, reject);
    },
  );
  req.on("error", reject);
  req.end(payload);
  return promise;
}

/** 一轮 SSE：字节安全的 delta.content 与按 index 重组的 delta.tool_calls 分片。 */
async function readSseRound(stream) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state = { buffer: "", deltas: [], calls: [] };
  for await (const chunk of stream) {
    if (consumeSseText(state, decoder.decode(chunk, { stream: true }))) {
      return state;
    }
  }
  if (consumeSseText(state, decoder.decode())) {
    return state;
  }
  throw new Error("SSE ended before [DONE]");
}

function consumeSseText(state, text) {
  state.buffer += text;
  let boundary = state.buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const data = eventData(state.buffer.slice(0, boundary));
    state.buffer = state.buffer.slice(boundary + 2);
    if (data === "[DONE]") {
      return true;
    }
    appendSseDelta(state, data);
    boundary = state.buffer.indexOf("\n\n");
  }
  return false;
}

function appendSseDelta(state, data) {
  if (data.length === 0) {
    return;
  }
  const delta = JSON.parse(data)?.choices?.[0]?.delta;
  const content = delta?.content;
  if (typeof content === "string" && content.length > 0) {
    state.deltas.push(content);
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const fragment of delta.tool_calls) {
      appendToolFragment(state.calls, fragment);
    }
  }
}

/** 首个分片携带 id 与 function.name；function.arguments 按到达顺序拼接。 */
function appendToolFragment(calls, fragment) {
  const index = fragment?.index;
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("tool call index");
  }
  calls[index] ??= { id: "", name: "", arguments: "" };
  const call = calls[index];
  if (typeof fragment.id === "string" && fragment.id.length > 0) {
    call.id = fragment.id;
  }
  const fn = fragment.function;
  if (typeof fn?.name === "string" && fn.name.length > 0) {
    call.name = fn.name;
  }
  if (typeof fn?.arguments === "string") {
    call.arguments += fn.arguments;
  }
}

function eventData(event) {
  const lines = [];
  for (const line of event.split("\n")) {
    if (line.startsWith("data:")) {
      lines.push(line.slice(5).trimStart());
    }
  }
  return lines.join("\n");
}
