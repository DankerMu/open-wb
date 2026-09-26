/**
 * fake-omp call-proxy 上游客户端（#461 拆出）：读 models.yml 的 workbuddy base URL、POST 一轮 SSE、重组 tool_calls。
 * 无模块级状态、不发帧；只依赖 node: 内建，绝不导入 fake-omp.mjs（它有 argv/ready/stdin 模块级副作用）。
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

export function parseToolCall(call) {
  if (call === undefined || call.id.length === 0 || call.name.length === 0) {
    throw new Error("incomplete tool call");
  }
  const args = JSON.parse(call.arguments);
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tool arguments");
  }
  return { ...call, args };
}

export function loadBaseUrl() {
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

export function postChat(baseUrl, token, messages) {
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
