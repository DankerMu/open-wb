/**
 * A stdio MCP server for the official omp connectors case (s1d-connectors group 2b, issue #1671).
 *
 * argv: `<sentinel> <markerPath>`. At startup it writes `<markerPath>` (so a case can tell whether omp
 * launched it at all), then speaks newline-delimited JSON-RPC 2.0 on stdin/stdout:
 * - `initialize` → the client's `protocolVersion` echoed, `capabilities: { tools: {} }` (omp only
 *   calls `tools/list` when `tools` is present), `serverInfo`, and `instructions: <sentinel>`;
 * - `tools/list` → exactly one tool, `echo`; `tools/call` of `echo` → its `text` argument as text
 *   content; `ping` → `{}`;
 * - any other request with an id → `-32601`; notifications (no id) get no reply.
 *
 * stdout carries JSON-RPC only (diagnostics go to stderr). No timers and no `process.exit`: once
 * stdin ends the event loop drains the pending writes and the process exits 0 by itself. The
 * process inherits omp's whole environment and does not read any of it.
 */
import { writeFileSync } from "node:fs";

const [sentinel, markerPath] = process.argv.slice(2);
if (sentinel === undefined || markerPath === undefined) {
  process.stderr.write("usage: fake-mcp-server.mjs <sentinel> <markerPath>\n");
  process.exit(2);
}
writeFileSync(markerPath, `${String(process.pid)}\n`);

const ECHO_TOOL = {
  name: "echo",
  description: "Echoes its text argument back.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The text to echo." } },
    required: ["text"],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/** The result of one request, or `undefined` when the method is unknown. */
function resultOf(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
        instructions: sentinel,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [ECHO_TOOL] };
    case "tools/call":
      if (params?.name !== ECHO_TOOL.name) {
        return { content: [{ type: "text", text: "unknown tool" }], isError: true };
      }
      return { content: [{ type: "text", text: String(params.arguments?.text ?? "") }] };
    default:
      return undefined;
  }
}

function onLine(line) {
  if (line.trim().length === 0) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-mcp-server: not JSON: ${line}\n`);
    return;
  }
  if (message === null || typeof message !== "object" || !("id" in message)) {
    return;
  }
  if (typeof message.method !== "string") {
    // A response to a request we never sent.
    return;
  }
  const result = resultOf(message.method, message.params);
  if (result === undefined) {
    send({
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
    return;
  }
  send({ id: message.id, result });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (buffer + chunk).split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    onLine(line);
  }
});
process.stdin.on("end", () => {
  onLine(buffer);
  buffer = "";
});
