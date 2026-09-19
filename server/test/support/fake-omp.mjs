#!/usr/bin/env node
/**
 * Issue #87 fake omp subprocess. Protocol pin:
 * can1357/oh-my-pi@33cc6b9a043a74e00a157e72ca909272796d8461
 * Local oracle: resource/oh-my-pi/docs/rpc.md (docs/architecture/rpc.md tracked by #141).
 */
import { readFileSync } from "node:fs";
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
const UI_ID = "ui-confirm-1";
const DELTAS = ["Hello ", "from ", "fake-omp"];

const { scenario, resume } = parseArgs(process.argv.slice(2));
let protocol = 1;
let pendingUi = false;
let queue = Promise.resolve();

if (scenario !== "no-ready") {
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
  queue.then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

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
  if (scenario !== "missing-session") {
    data.sessionFile = resume ?? DEFAULT_SESSION;
  }
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
    error: () => failTurn("fake omp scripted error"),
    "extension-ui": () => requestConfirm(),
    "call-proxy": () => runProxy(frame.message),
  };
  const turn = turns[scenario];
  if (turn) {
    await turn();
    return;
  }
  await completeTurn(DELTAS, true);
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

async function completeTurn(deltas, tools) {
  await emit({ type: "agent_start" });
  for (const delta of deltas) {
    await emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
      message: { role: "assistant", content: [] },
    });
  }
  if (tools) {
    await emit({
      type: "tool_execution_start",
      toolCallId: TOOL_ID,
      toolName: TOOL_NAME,
      args: { command: "echo workbuddy-smoke" },
    });
    await emit({
      type: "tool_execution_end",
      toolCallId: TOOL_ID,
      toolName: TOOL_NAME,
      result: { output: "workbuddy-smoke" },
    });
  }
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

async function runProxy(message) {
  try {
    const baseUrl = loadBaseUrl();
    const token = process.env.WORKBUDDY_MODEL_TOKEN;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("config");
    }
    const deltas = await postChat(baseUrl, token, message);
    await completeTurn(deltas, false);
  } catch {
    await failTurn("proxy failed");
  }
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

function postChat(baseUrl, token, message) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = new URL("chat/completions", root);
  const payload = Buffer.from(
    JSON.stringify({ stream: true, messages: [{ role: "user", content: message }] }),
  );
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
      readSseContent(response).then(resolve, reject);
    },
  );
  req.on("error", reject);
  req.end(payload);
  return promise;
}

async function readSseContent(stream) {
  const deltas = [];
  let bytes = Buffer.alloc(0);
  let text = "";
  for await (const chunk of stream) {
    bytes = Buffer.concat([bytes, chunk]);
    const taken = takeUtf8(bytes);
    bytes = taken.rest;
    text += taken.text;
    const parts = text.split("\n\n");
    text = parts.pop() ?? "";
    for (const event of parts) {
      const data = eventData(event);
      if (data === "[DONE]") {
        return deltas;
      }
      if (data.length === 0) {
        continue;
      }
      const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        deltas.push(content);
      }
    }
  }
  return deltas;
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

function takeUtf8(buffer) {
  let end = buffer.length;
  if (end === 0) {
    return { text: "", rest: buffer };
  }
  let i = end - 1;
  if ((buffer[i] & 0x80) !== 0) {
    while (i > 0 && (buffer[i] & 0xc0) === 0x80) {
      i--;
    }
    const lead = buffer[i];
    const need = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (end - i < need) {
      end = i;
    }
  }
  if (end === 0) {
    return { text: "", rest: buffer };
  }
  return { text: buffer.subarray(0, end).toString("utf8"), rest: buffer.subarray(end) };
}
