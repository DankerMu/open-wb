#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createFailureScript } from "./fake-upstream-failures.mjs";
import {
  INTERLEAVE_MARKER,
  PACE_MARKER,
  writeInterleavedSse,
  writePacedSse,
} from "./fake-upstream-pace.mjs";

const PATHS = new Set(["/chat/completions", "/v1/chat/completions"]);
const DEFAULT_KEY = "fake";
const ERROR_MARKER = "WORKBUDDY_FAKE_ERROR";
const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const THINK_MARKER = "WORKBUDDY_THINK";
const THINK_LONG_MARKER = "WORKBUDDY_THINK_LONG";
const WRITE_MARKER = "WORKBUDDY_WRITE";
const TODO_MARKER = "WORKBUDDY_TODO";
const HOLD_AT_MARKER = "WORKBUDDY_HOLD_AT:";
const BROWSER_OPEN_MARKER = "WORKBUDDY_BROWSER_OPEN:";
const BROWSER_SHOT_MARKER = "WORKBUDDY_BROWSER_SHOT";
const ASK_MARKER = "WORKBUDDY_ASK";
/** First text part of omp's synthetic user message carrying tool-result images (#1527). */
const ATTACHED_IMAGES_TEXT = "Attached image(s) from tool result:";
/** Hold points of `WORKBUDDY_HOLD_AT:<point>` (issues 1440, 1445); any other value is ignored. */
const HOLD_POINTS = new Set(["empty", "thinking"]);
const TOOL_ARGS = '{"command":"echo workbuddy-smoke"}';
const REPLY_PARTS = ["你好，", "这是 WorkBuddy 的", "第一条流式回复。"];
const THINK_PARTS = ["先读需求，", "再列要点，", "最后作答。"];
/** Issue 1445: `思考第 1 行` … `思考第 120 行`, 40 lines per part; parts 1 and 2 end with `\n`. */
const THINK_LONG_PARTS = [0, 1, 2].map((part) => {
  const lines = [];
  for (let line = 40 * part + 1; line <= 40 * part + 40; line += 1) {
    lines.push(`思考第 ${line} 行`);
  }
  return lines.join("\n") + (part < 2 ? "\n" : "");
});
const WRITE_ARGS = JSON.stringify({
  path: "workbuddy-report.html",
  content: "<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n",
});
const TODO_ARGS = JSON.stringify({
  op: "init",
  list: [{ phase: "走查", items: ["整理需求", "输出结论"] }],
});
// omp's `ask` schema (#1566): the call omp lacks under `ask.enabled: false`.
const ASK_ARGS = JSON.stringify({
  questions: [{ id: "q1", question: "继续吗？", options: [{ label: "是" }, { label: "否" }] }],
});
const BROWSER_SHOT_ARGS = evalArgs('await browser.tab("main").screenshot();');
const GATE_PREFIX = "/__control/gates/";
const REQUESTS_PATH = "/__control/requests";
const REQUESTS_CAP = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WALK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const DEFAULT_TTL_MS = 30_000;
const GATE_CAP = 32;
/** `toolRoundScope` values: which messages decide whether a request is a tool round (#1140). */
const TOOL_ROUND_SCOPES = new Set(["history", "turn"]);

export async function start(options = {}) {
  const scope = options.toolRoundScope === undefined ? "history" : options.toolRoundScope;
  if (!TOOL_ROUND_SCOPES.has(scope)) {
    throw new Error('fake-upstream toolRoundScope must be "history" or "turn"');
  }
  const expectedKey = options.apiKey ?? DEFAULT_KEY;
  const requested = options.port ?? 0;
  const ttlMs =
    typeof options.gateTtlMs === "number" &&
    Number.isInteger(options.gateTtlMs) &&
    options.gateTtlMs > 0
      ? options.gateTtlMs
      : DEFAULT_TTL_MS;
  const gates = new Map();
  /** Chat-completions requests in arrival order: `{model, messages, maxTokens}`, latest 1000. */
  const requests = [];
  const failures = createFailureScript(expectedKey);
  const server = createServer((request, response) => {
    void handleRequest(request, response, expectedKey, gates, ttlMs, requests, {
      scope,
      failures,
    });
  });
  await listen(server, requested);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake-upstream did not bind a TCP address");
  }
  let closed = false;
  return {
    port: address.port,
    requests() {
      return requests.map((entry) => ({ ...entry }));
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      failures.close();
      for (const id of [...gates.keys()]) {
        destroyGate(gates, id);
      }
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(request, response, expectedKey, gates, ttlMs, requests, script) {
  const path = request.url === undefined ? "" : request.url.split("?")[0];
  if (path === REQUESTS_PATH) {
    readRequests(request, response, expectedKey, requests);
    return;
  }
  if (path.startsWith(GATE_PREFIX)) {
    handleControl(request, response, path, expectedKey, gates, ttlMs);
    return;
  }
  if (request.method !== "POST" || !PATHS.has(path)) {
    notFound(response);
    return;
  }
  if (!bearerMatches(request.headers.authorization, expectedKey)) {
    writeJson(response, 401, { error: { message: "Unauthorized" } });
    return;
  }
  const parsed = await readChatMessages(request, response, requests);
  if (parsed === undefined) {
    return;
  }
  serveChat(response, gates, parsed, script);
}

function readRequests(request, response, expectedKey, requests) {
  if (!bearerMatches(request.headers.authorization, expectedKey)) {
    writeJson(response, 401, { error: { message: "Unauthorized" } });
    return;
  }
  if (request.method !== "GET") {
    notFound(response);
    return;
  }
  writeJson(response, 200, { requests }, { "cache-control": "no-store" });
}

/** Records a body that parsed as a JSON object, before `messages` is validated; no text is kept. */
function recordRequest(requests, body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return;
  }
  requests.push({
    model: typeof body.model === "string" ? body.model : null,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    maxTokens:
      [body.max_tokens, body.max_completion_tokens].find((v) => typeof v === "number") ?? null,
  });
  if (requests.length > REQUESTS_CAP) {
    requests.shift();
  }
}

async function readChatMessages(request, response, requests) {
  let raw;
  try {
    raw = await readBody(request);
  } catch {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return undefined;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return undefined;
  }
  recordRequest(requests, body);
  if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return undefined;
  }
  return { messages: body.messages, model: body.model };
}

function serveChat(response, gates, parsed, { scope, failures }) {
  if (lastUserHasMarker(parsed.messages)) {
    writeJson(response, 500, { error: { message: "fake upstream error" } });
    return;
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof parsed.model === "string" ? parsed.model : "fake";
  const contentChunk = (delta) => chunk(id, created, model, delta, null);
  if (failures.serve(response, lastUserTextFrom(parsed.messages), contentChunk)) {
    return;
  }
  const answered =
    scope === "turn" ? toolFollowsLastUser(parsed.messages) : hasToolRole(parsed.messages);
  if (!answered) {
    const call = toolRoundCall(lastUserTextFrom(parsed.messages));
    writeSse(response, toolFrames(id, created, model, call));
    return;
  }
  serveFinal(response, gates, parsed.messages, id, created, model);
}

function serveFinal(response, gates, messages, id, created, model) {
  const text = lastUserTextFrom(messages);
  const think = thinkPartsOf(text);
  const walkId = walkGateId(text);
  // Issue 1437: WORKBUDDY_PACE replaces only the ungated writes; held / armed gates are untouched.
  // It keeps THINK_PARTS even with WORKBUDDY_THINK_LONG: the spec names its three parts literally.
  // Issue 1468: WORKBUDDY_INTERLEAVE likewise, yielding to WORKBUDDY_PACE and ignoring `think`.
  const reply = () => {
    const frame = (delta, finish) => chunk(id, created, model, delta, finish);
    if (text.includes(PACE_MARKER)) {
      writePacedSse(response, frame, THINK_PARTS);
      return;
    }
    if (text.includes(INTERLEAVE_MARKER)) {
      writeInterleavedSse(response, frame);
      return;
    }
    writeSse(response, textFrames(id, created, model, think));
  };
  if (walkId === undefined) {
    reply();
    return;
  }
  const gate = gates.get(walkId);
  if (gate !== undefined && gate.phase === "held") {
    writeJson(response, 409, { error: { message: "Conflict" } });
    return;
  }
  if (gate !== undefined && gate.phase === "armed") {
    holdFinal(response, gates, walkId, id, created, model, think, holdPointOf(text));
    return;
  }
  reply();
}

function handleControl(request, response, path, expectedKey, gates, ttlMs) {
  if (!bearerMatches(request.headers.authorization, expectedKey)) {
    writeJson(response, 401, { error: { message: "Unauthorized" } });
    return;
  }
  const parsed = parseGatePath(path);
  if (parsed === undefined) {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return;
  }
  if (parsed.action === "release") {
    if (request.method !== "POST") {
      notFound(response);
      return;
    }
    releaseHeld(response, gates, parsed.id);
    return;
  }
  routeGateResource(request.method, response, gates, parsed.id, ttlMs);
}

function parseGatePath(path) {
  const rest = path.slice(GATE_PREFIX.length);
  const slash = rest.indexOf("/");
  const rawId = slash === -1 ? rest : rest.slice(0, slash);
  const action = slash === -1 ? "" : rest.slice(slash + 1);
  if (rawId.length === 0 || !UUID_PATTERN.test(rawId)) {
    return undefined;
  }
  if (action !== "" && action !== "release") {
    return { id: "", action: "missing" };
  }
  return { id: rawId.toLowerCase(), action };
}

function routeGateResource(method, response, gates, id, ttlMs) {
  if (id.length === 0) {
    notFound(response);
    return;
  }
  if (method === "POST") {
    armGate(response, gates, id, ttlMs);
    return;
  }
  if (method === "GET") {
    readGate(response, gates, id);
    return;
  }
  if (method === "DELETE") {
    deleteOwnedGate(response, gates, id);
    return;
  }
  notFound(response);
}

function readGate(response, gates, id) {
  const gate = gates.get(id);
  if (gate === undefined) {
    notFound(response);
    return;
  }
  writeJson(response, 200, { phase: gate.phase });
}

function deleteOwnedGate(response, gates, id) {
  if (!gates.has(id)) {
    notFound(response);
    return;
  }
  destroyGate(gates, id);
  response.writeHead(204);
  response.end();
}

function notFound(response) {
  response.writeHead(404);
  response.end();
}

function armGate(response, gates, id, ttlMs) {
  if (gates.has(id)) {
    writeJson(response, 409, { error: { message: "Conflict" } });
    return;
  }
  if (gates.size >= GATE_CAP) {
    writeJson(response, 503, { error: { message: "Capacity exceeded" } });
    return;
  }
  const timer = setTimeout(() => {
    destroyGate(gates, id);
  }, ttlMs);
  timer.unref();
  gates.set(id, { phase: "armed", response: null, remaining: [], timer });
  writeJson(response, 201, { phase: "armed" });
}

function releaseHeld(controlResponse, gates, id) {
  const gate = gates.get(id);
  if (gate === undefined) {
    controlResponse.writeHead(404);
    controlResponse.end();
    return;
  }
  if (gate.phase !== "held" || gate.response === null) {
    writeJson(controlResponse, 409, { error: { message: "Conflict" } });
    return;
  }
  const held = gate.response;
  const remaining = gate.remaining;
  gates.delete(id);
  clearTimeout(gate.timer);
  gate.response = null;
  try {
    writeSseFrames(held, remaining);
    writeSseDone(held);
    held.end();
  } catch {
    if (!held.writableEnded) {
      held.destroy();
    }
  }
  writeJson(controlResponse, 200, { phase: "released" });
}

/**
 * Splits the unchanged answering frames at the hold point: the prefix is written now, the rest is
 * kept for `releaseHeld`. Without a hold point the prefix runs to the first content chunk;
 * `empty` stops after the role chunk; `thinking` after the reasoning chunks, so with no thinking
 * marker it is `empty`.
 */
function holdFinal(response, gates, walkId, completionId, created, model, think, point) {
  const gate = gates.get(walkId);
  if (gate === undefined || gate.phase !== "armed") {
    writeSse(response, textFrames(completionId, created, model, think));
    return;
  }
  const frames = textFrames(completionId, created, model, think);
  const reasoned = 1 + think.length;
  const cut = point === "empty" ? 1 : point === "thinking" ? reasoned : reasoned + 1;
  gate.phase = "held";
  gate.response = response;
  gate.remaining = frames.slice(cut);
  writeSseHeaders(response);
  writeSseFrames(response, frames.slice(0, cut));
  const onClose = () => {
    if (response.writableEnded) {
      return;
    }
    const current = gates.get(walkId);
    if (current === undefined || current.response !== response) {
      return;
    }
    destroyGate(gates, walkId);
  };
  response.on("close", onClose);
  response.on("error", onClose);
}

function destroyGate(gates, id) {
  const gate = gates.get(id);
  if (gate === undefined) {
    return;
  }
  gates.delete(id);
  clearTimeout(gate.timer);
  const held = gate.response;
  gate.response = null;
  if (held !== null && !held.writableEnded) {
    held.destroy();
  }
}

function bearerMatches(header, expectedKey) {
  if (typeof header !== "string") {
    return false;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  return header.slice(prefix.length) === expectedKey;
}

function lastUserHasMarker(messages) {
  return lastUserTextFrom(messages).includes(ERROR_MARKER);
}

function lastUserTextFrom(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || isImageAttachment(messages, index)) {
      continue;
    }
    return userText(message.content);
  }
  return "";
}

/**
 * `WORKBUDDY_HOLD_AT:<point>`: the value runs from the colon to the next whitespace (`\s`, so also
 * U+3000) or the end of the text, and counts only when it is exactly a known point. The first
 * occurrence decides (no spec sentence covers several; this fixture's choice).
 */
function holdPointOf(text) {
  const index = text.indexOf(HOLD_AT_MARKER);
  if (index === -1) {
    return undefined;
  }
  const [value] = text.slice(index + HOLD_AT_MARKER.length).split(/\s/u, 1);
  return HOLD_POINTS.has(value) ? value : undefined;
}

/** Reasoning parts of the answering round: THINK_LONG wins over THINK (which it contains). */
function thinkPartsOf(text) {
  if (text.includes(THINK_LONG_MARKER)) {
    return THINK_LONG_PARTS;
  }
  return text.includes(THINK_MARKER) ? THINK_PARTS : [];
}

function walkGateId(text) {
  const index = text.lastIndexOf(WALK_MARKER);
  if (index === -1) {
    return undefined;
  }
  const match = WALK_ID_PATTERN.exec(text.slice(index + WALK_MARKER.length));
  if (match === null) {
    return undefined;
  }
  return match[0].toLowerCase();
}

function userText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const part of content) {
    if (
      part !== null &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      text += part.text;
    }
  }
  return text;
}

function hasToolRole(messages) {
  return messages.some(
    (message) => message !== null && typeof message === "object" && message.role === "tool",
  );
}

/**
 * `toolRoundScope: "turn"`：最后一条 user 消息之后有没有 tool 消息。历史里没有 user 消息时
 * 看的就是整段历史，与缺省判定同一结果（规格条文没有点名这种历史；实测三种这样的历史两种
 * 判定逐字节相同，见 fake-upstream-tool-rounds.test.ts 的「for a history with …」）。
 */
function toolFollowsLastUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== "object") {
      continue;
    }
    if (message.role === "tool") {
      return true;
    }
    if (message.role === "user" && !isImageAttachment(messages, index)) {
      return false;
    }
  }
  return false;
}

/**
 * omp v18.12.3 appends, after tool results carrying images, a `user` message whose content starts
 * with the text `Attached image(s) from tool result:` (openai-completions.ts:2830). It belongs to the
 * tool results: the round rule and the last-user-text lookup skip it (#1527, design D9).
 */
function isImageAttachment(messages, index) {
  const first = Array.isArray(messages[index].content) ? messages[index].content[0] : undefined;
  return (
    messages[index - 1]?.role === "tool" &&
    first?.type === "text" &&
    first.text === ATTACHED_IMAGES_TEXT
  );
}

/** `WORKBUDDY_BROWSER_OPEN:<url>`: the url runs to the next whitespace; empty is no marker. */
function browserOpenUrl(text) {
  const index = text.indexOf(BROWSER_OPEN_MARKER);
  if (index === -1) {
    return undefined;
  }
  const [url] = text.slice(index + BROWSER_OPEN_MARKER.length).split(/\s/u, 1);
  return url === "" ? undefined : url;
}

/** omp v18.12.3 drives its browser from the `eval` tool's JS prelude (#1570): one js cell. */
function evalArgs(code) {
  return JSON.stringify({ language: "js", code });
}

/** 工具轮只发一个调用：WRITE、TODO、ASK（#1566）、浏览器 OPEN、SHOT（#1527）依次优先，都没有即缺省 bash。 */
function toolRoundCall(text) {
  if (text.includes(WRITE_MARKER)) {
    return { name: "write", arguments: WRITE_ARGS };
  }
  if (text.includes(TODO_MARKER)) {
    return { name: "todo", arguments: TODO_ARGS };
  }
  if (text.includes(ASK_MARKER)) {
    return { name: "ask", arguments: ASK_ARGS };
  }
  const url = browserOpenUrl(text);
  if (url !== undefined) {
    const code = `await browser.open({ name: "main", url: ${JSON.stringify(url)} });`;
    return { name: "eval", arguments: evalArgs(code) };
  }
  if (text.includes(BROWSER_SHOT_MARKER)) {
    return { name: "eval", arguments: BROWSER_SHOT_ARGS };
  }
  return { name: "bash", arguments: TOOL_ARGS };
}

function toolFrames(id, created, model, call) {
  const callId = `call_${randomUUID()}`;
  return [
    chunk(
      id,
      created,
      model,
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: call,
          },
        ],
      },
      null,
    ),
    chunk(id, created, model, {}, "tool_calls"),
  ];
}

function textFrames(id, created, model, think) {
  const frames = [
    chunk(id, created, model, { role: "assistant" }, null),
    ...thinkFrames(id, created, model, think),
  ];
  for (const part of REPLY_PARTS) {
    frames.push(chunk(id, created, model, { content: part }, null));
  }
  frames.push(chunk(id, created, model, {}, "stop"));
  return frames;
}

function thinkFrames(id, created, model, think) {
  return think.map((part) => chunk(id, created, model, { reasoning_content: part }, null));
}

function chunk(id, created, model, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(response, frames) {
  writeSseHeaders(response);
  writeSseFrames(response, frames);
  writeSseDone(response);
  response.end();
}

function writeSseHeaders(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
}

function writeSseFrames(response, frames) {
  for (const frame of frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
}

function writeSseDone(response) {
  response.write("data: [DONE]\n\n");
}

function writeJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

if (import.meta.main) {
  const raw = process.env.FAKE_UPSTREAM_PORT;
  const port = raw === undefined || raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.exit(1);
  }
  start({ port })
    .then((handle) => {
      process.stdout.write(`${JSON.stringify({ port: handle.port })}\n`);
      const shutdown = () => {
        void handle.close().finally(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch(() => {
      process.exit(1);
    });
}
