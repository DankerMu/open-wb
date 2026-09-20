#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PATHS = new Set(["/chat/completions", "/v1/chat/completions"]);
const DEFAULT_KEY = "fake";
const ERROR_MARKER = "WORKBUDDY_FAKE_ERROR";
const TOOL_ARGS = '{"command":"echo workbuddy-smoke"}';
const REPLY_PARTS = ["你好，", "这是 WorkBuddy 的", "第一条流式回复。"];

export async function start(options = {}) {
  const expectedKey = options.apiKey ?? DEFAULT_KEY;
  const requested = options.port ?? 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response, expectedKey);
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
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(request, response, expectedKey) {
  const path = request.url === undefined ? "" : request.url.split("?")[0];
  if (request.method !== "POST" || !PATHS.has(path)) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (!bearerMatches(request.headers.authorization, expectedKey)) {
    writeJson(response, 401, { error: { message: "Unauthorized" } });
    return;
  }
  let raw;
  try {
    raw = await readBody(request);
  } catch {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return;
  }
  if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) {
    writeJson(response, 400, { error: { message: "Invalid request" } });
    return;
  }
  if (lastUserHasMarker(body.messages)) {
    writeJson(response, 500, { error: { message: "fake upstream error" } });
    return;
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === "string" ? body.model : "fake";
  const frames = hasToolRole(body.messages)
    ? textFrames(id, created, model)
    : toolFrames(id, created, model);
  writeSse(response, frames);
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== "object" || message.role !== "user") {
      continue;
    }
    return userText(message.content).includes(ERROR_MARKER);
  }
  return false;
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
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
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
