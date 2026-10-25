/**
 * s1d-connectors group 4 (task 4.2): an http MCP server for connector probes, on loopback. Every
 * request is recorded (method, target, headers, body parsed as JSON when it is JSON) and answered
 * by the script: `reply: "json"` (default) — 200 `application/json` with an `initialize` result;
 * `reply: "sse"` — 200 `text/event-stream` with a comment line, a CRLF line and the result split
 * over two `data:` lines, the stream then left open (a real streaming server keeps it so);
 * `status` / `contentType` / `body` override any part, `body` may be a function of the request
 * (e.g. echoing its headers). The `body` answers end the response.
 */
import { createServer } from "node:http";

const RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    serverInfo: { name: "fake-mcp-http", version: "1" },
  },
};
const SSE_EVENT =
  ': fake-mcp-http comment\r\nevent: message\ndata: {"jsonrpc":"2.0","id":1,\n' +
  `data: "result":${JSON.stringify(RESULT.result)}}\n\n`;

export async function start(options = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: { ...request.headers },
        body: parsed(text),
      };
      requests.push(recorded);
      answer(response, recorded, options);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake-mcp-http did not bind a TCP address");
  }
  return {
    port: address.port,
    requests: () => requests.map((entry) => structuredClone(entry)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function answer(response, request, options) {
  const sse = options.reply === "sse" && options.body === undefined;
  const contentType = options.contentType ?? (sse ? "text/event-stream" : "application/json");
  response.writeHead(options.status ?? 200, { "content-type": contentType });
  if (sse) {
    response.write(SSE_EVENT);
    return;
  }
  const body =
    typeof options.body === "function"
      ? options.body(request)
      : (options.body ?? JSON.stringify(RESULT));
  response.end(body);
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
