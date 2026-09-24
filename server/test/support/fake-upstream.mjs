#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PATHS = new Set(["/chat/completions", "/v1/chat/completions"]);
const DEFAULT_KEY = "fake";
const ERROR_MARKER = "WORKBUDDY_FAKE_ERROR";
const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const TOOL_ARGS = '{"command":"echo workbuddy-smoke"}';
const REPLY_PARTS = ["你好，", "这是 WorkBuddy 的", "第一条流式回复。"];
const GATE_PREFIX = "/__control/gates/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WALK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const DEFAULT_TTL_MS = 30_000;
const GATE_CAP = 32;

export async function start(options = {}) {
  const expectedKey = options.apiKey ?? DEFAULT_KEY;
  const requested = options.port ?? 0;
  const ttlMs =
    typeof options.gateTtlMs === "number" &&
    Number.isInteger(options.gateTtlMs) &&
    options.gateTtlMs > 0
      ? options.gateTtlMs
      : DEFAULT_TTL_MS;
  const gates = new Map();
  const server = createServer((request, response) => {
    void handleRequest(request, response, expectedKey, gates, ttlMs);
  });
  await listen(server, requested);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake-upstream did not bind a TCP address");
  }
  let closed = false;
  return {
    port: address.port,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
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

async function handleRequest(request, response, expectedKey, gates, ttlMs) {
  const path = request.url === undefined ? "" : request.url.split("?")[0];
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
  const parsed = await readChatMessages(request, response);
  if (parsed === undefined) {
    return;
  }
  serveChat(response, gates, parsed);
}

async function readChatMessages(request, response) {
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
  if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return undefined;
  }
  return { messages: body.messages, model: body.model };
}

function serveChat(response, gates, parsed) {
  if (lastUserHasMarker(parsed.messages)) {
    writeJson(response, 500, { error: { message: "fake upstream error" } });
    return;
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof parsed.model === "string" ? parsed.model : "fake";
  if (!hasToolRole(parsed.messages)) {
    writeSse(response, toolFrames(id, created, model));
    return;
  }
  serveFinal(response, gates, parsed.messages, id, created, model);
}

function serveFinal(response, gates, messages, id, created, model) {
  const walkId = walkGateId(lastUserTextFrom(messages));
  if (walkId === undefined) {
    writeSse(response, textFrames(id, created, model));
    return;
  }
  const gate = gates.get(walkId);
  if (gate !== undefined && gate.phase === "held") {
    writeJson(response, 409, { error: { message: "Conflict" } });
    return;
  }
  if (gate !== undefined && gate.phase === "armed") {
    holdFinal(response, gates, walkId, id, created, model);
    return;
  }
  writeSse(response, textFrames(id, created, model));
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

function holdFinal(response, gates, walkId, completionId, created, model) {
  const gate = gates.get(walkId);
  if (gate === undefined || gate.phase !== "armed") {
    writeSse(response, textFrames(completionId, created, model));
    return;
  }
  const remaining = [];
  for (let index = 1; index < REPLY_PARTS.length; index += 1) {
    remaining.push(chunk(completionId, created, model, { content: REPLY_PARTS[index] }, null));
  }
  remaining.push(chunk(completionId, created, model, {}, "stop"));
  gate.phase = "held";
  gate.response = response;
  gate.remaining = remaining;
  writeSseHeaders(response);
  writeSseFrames(response, [
    chunk(completionId, created, model, { role: "assistant" }, null),
    chunk(completionId, created, model, { content: REPLY_PARTS[0] }, null),
  ]);
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
    if (message === null || typeof message !== "object" || message.role !== "user") {
      continue;
    }
    return userText(message.content);
  }
  return "";
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

function toolFrames(id, created, model) {
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
            function: { name: "bash", arguments: TOOL_ARGS },
          },
        ],
      },
      null,
    ),
    chunk(id, created, model, {}, "tool_calls"),
  ];
}

function textFrames(id, created, model) {
  const frames = [chunk(id, created, model, { role: "assistant" }, null)];
  for (const part of REPLY_PARTS) {
    frames.push(chunk(id, created, model, { content: part }, null));
  }
  frames.push(chunk(id, created, model, {}, "stop"));
  return frames;
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

function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
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
