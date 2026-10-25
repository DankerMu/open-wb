/**
 * connectors/probe — one probe of a connector (s1d-connectors design D6 and its 判定细则; connectors
 * 「连接器探活」). Never logs; the result never carries a header value.
 *
 * stdio: `command` (`stat` follows symlinks) is a regular file the app process may execute
 * (`access X_OK`) → `ok`, else `命令不存在或不可执行`. Nothing is spawned.
 *
 * http: `POST` the D6 `initialize` body to the registered `url` as it is, over a fresh connection
 * (`agent: false`), with the registered headers minus any named `content-type` / `accept` (ignoring
 * case) plus those two fixed ones; no redirect is followed (a 3xx is a non-2xx), nothing is retried.
 * Deadlines: connect 10 s (until TCP, and TLS, is up), total 15 s (until settled, reading the body
 * included) → `超时`. A refused / reset connection (also while the body is read), a DNS failure or a
 * request that cannot be built → `无法连接`. Non-2xx → `HTTP <status>：<excerpt>`: `readErrorBody`, then
 * `upstreamExcerpt` with every registered header value as the secrets, capped at 200 code points.
 * 2xx: at most 64 KiB of body is read. A `text/event-stream` media type is read as SSE and judged on
 * the first dispatched event (the stream may stay open); any other is one JSON document judged at its
 * end. The judgement is the MCP initialize-result predicate; anything else, an SSE stream ending
 * before an event, or a body over the cap → `响应不是 MCP 初始化结果`. Once settled the request (and
 * so the response) is destroyed.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { readErrorBody } from "../core/error-body.js";
import { capPoints, upstreamExcerpt } from "../core/upstream-failure.js";
import type { ConnectorFields } from "./validate.js";

const CONNECT_DEADLINE_MS = 10_000;
const TOTAL_DEADLINE_MS = 15_000;
/** The most of a 2xx body read before judging it (D6). */
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_EXCERPT_POINTS = 200;
const UNREACHABLE = "无法连接";
const TIMED_OUT = "超时";
const NOT_MCP = "响应不是 MCP 初始化结果";
const NO_COMMAND = "命令不存在或不可执行";
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "workbuddy-probe", version: "1" },
  },
});
const FIXED_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

export interface ConnectorProbeResult {
  status: "ok" | "failed";
  message: string | null;
}

export interface ConnectorProbeDeadlines {
  connectDeadlineMs?: number;
  totalDeadlineMs?: number;
}

const OK: ConnectorProbeResult = { status: "ok", message: null };
const failed = (message: string): ConnectorProbeResult => ({ status: "failed", message });

export function probeConnector(
  fields: ConnectorFields,
  deadlines: ConnectorProbeDeadlines = {},
): Promise<ConnectorProbeResult> {
  return fields.type === "stdio"
    ? probeCommand(fields.command)
    : probeHttp(fields.url, fields.headers, deadlines);
}

async function probeCommand(command: string): Promise<ConnectorProbeResult> {
  try {
    if (!(await stat(command)).isFile()) {
      return failed(NO_COMMAND);
    }
    await access(command, constants.X_OK);
    return OK;
  } catch {
    return failed(NO_COMMAND);
  }
}

function probeHttp(
  url: string,
  registered: Readonly<Record<string, string>>,
  deadlines: ConnectorProbeDeadlines,
): Promise<ConnectorProbeResult> {
  const secrets = Object.values(registered);
  return new Promise((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    let tls = false;
    const settle = (result: ConnectorProbeResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        resolve(result);
      }
      // Settled first, destroyed after: the error the destroy raises cannot turn it into 无法连接.
      req?.destroy();
    };
    const expire = (): void => settle(failed(TIMED_OUT));
    const connectTimer = setTimeout(expire, deadlines.connectDeadlineMs ?? CONNECT_DEADLINE_MS);
    const totalTimer = setTimeout(expire, deadlines.totalDeadlineMs ?? TOTAL_DEADLINE_MS);
    try {
      ({ req, tls } = openProbe(url, registered, (response) => {
        clearTimeout(connectTimer);
        answer(response, secrets, settle);
      }));
    } catch {
      settle(failed(UNREACHABLE));
      return;
    }
    req.on("error", () => settle(failed(UNREACHABLE)));
    // A fresh socket per probe: the connect deadline ends once TCP (and TLS) is up.
    req.on("socket", (socket: Socket) => {
      socket.once(tls ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    req.end(INITIALIZE);
  });
}

function openProbe(
  url: string,
  registered: Readonly<Record<string, string>>,
  onResponse: (response: IncomingMessage) => void,
): { req: ClientRequest; tls: boolean } {
  const target = new URL(url);
  const tls = target.protocol === "https:";
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(registered)) {
    const lower = name.toLowerCase();
    if (lower !== "content-type" && lower !== "accept") {
      headers[name] = value;
    }
  }
  const req = (tls ? https : http).request(
    target,
    { method: "POST", agent: false, headers: { ...headers, ...FIXED_HEADERS } },
    onResponse,
  );
  return { req, tls };
}

function answer(
  response: IncomingMessage,
  secrets: readonly string[],
  settle: (result: ConnectorProbeResult) => void,
): void {
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    void readErrorBody(response).then(({ body, cut }) => {
      const excerpt = capPoints(
        upstreamExcerpt(body.toString("utf8"), secrets, cut),
        MAX_EXCERPT_POINTS,
      );
      settle(failed(`HTTP ${String(status)}：${excerpt}`));
    });
    return;
  }
  const mediaType = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  readResult(response, mediaType === "text/event-stream" ? sseReader() : jsonReader(), settle);
}

/** How a 2xx body becomes one document to judge; `readResult` feeds it at most `MAX_RESULT_BYTES`. */
interface Reader {
  /** More decoded text: the document once it can be judged, else `UNDECIDED`. */
  push(text: string): unknown;
  /** The clean end of the body: the document (`null` when there is none). */
  end(): unknown;
}
const UNDECIDED = Symbol("undecided");

function readResult(
  response: IncomingMessage,
  reader: Reader,
  settle: (result: ConnectorProbeResult) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let read = 0;
  const judge = (document: unknown): boolean => {
    if (document === UNDECIDED) {
      return false;
    }
    settle(isInitializeResult(document) ? OK : failed(NOT_MCP));
    return true;
  };
  response.on("data", (chunk: Buffer) => {
    const room = MAX_RESULT_BYTES - read;
    read += chunk.length;
    if (room > 0 && judge(reader.push(decoder.write(chunk.subarray(0, room))))) {
      return;
    }
    if (read > MAX_RESULT_BYTES) {
      settle(failed(NOT_MCP));
    }
  });
  response.once("end", () => {
    if (!judge(reader.push(decoder.end()))) {
      judge(reader.end());
    }
  });
  response.once("error", () => settle(failed(UNREACHABLE)));
  // A close without `end` is a reset mid-body; after a judgement `settle` is a no-op.
  response.once("close", () => settle(failed(UNREACHABLE)));
}

/** The whole body as one JSON document; a parse failure is a document that is no result. */
function jsonReader(): Reader {
  let text = "";
  return {
    push(more) {
      text += more;
      return UNDECIDED;
    },
    end: () => parsed(text),
  };
}

/**
 * SSE per D6: lines split at CRLF / LF / CR, `:` lines are comments, `data:` minus one leading space
 * is appended (joined by `\n`), a blank line dispatches, an event without `data` is skipped, other
 * fields are ignored. The first dispatched event's data is parsed; ending before one → no result.
 */
function sseReader(): Reader {
  let pending = "";
  const data: string[] = [];
  const feed = (text: string, final: boolean): unknown => {
    pending += text;
    // Before the end a trailing CR may be the first half of a CRLF: it waits for the next chunk.
    const held = !final && pending.endsWith("\r") ? "\r" : "";
    const lines = pending.slice(0, pending.length - held.length).split(/\r\n|\r|\n/u);
    pending = (lines.pop() ?? "") + held;
    for (const line of lines) {
      if (line === "" && data.length > 0) {
        return parsed(data.join("\n"));
      }
      const value = dataValue(line);
      if (value !== undefined) {
        data.push(value);
      }
    }
    return UNDECIDED;
  };
  return {
    push: (text) => feed(text, false),
    end: () => {
      const document = feed("", true);
      return document === UNDECIDED ? null : document;
    },
  };
}

/** A `data` field line's value minus one leading space; `undefined` for any other line. */
function dataValue(line: string): string | undefined {
  if (line !== "data" && !line.startsWith("data:")) {
    return undefined;
  }
  const value = line.slice("data:".length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** D6: a plain object with `jsonrpc === "2.0"` and an own `result` that is a non-null object. */
function isInitializeResult(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return false;
  }
  const record = document as Record<string, unknown>;
  return (
    record.jsonrpc === "2.0" &&
    Object.hasOwn(record, "result") &&
    typeof record.result === "object" &&
    record.result !== null
  );
}
