/**
 * 知识库嵌入模型的一次探活（s2a-kb-ragflow D7；ragflow-backend「知识库模型设置」的探活）。直连嵌入上游，不经 RAGFlow：
 * `POST upstreamEndpoint(baseUrl, "embeddings")`，body `{model, input:"ping"}`，`authorization: Bearer <apiKey>`，
 * 新连接（`agent: false`），不跟随重定向（3xx 是非 2xx），不重试。期限同 `models/probe.ts`：连接 10 s、总 15 s，读正文
 * 也算在内，到期 `超时`。连接被拒、中途断开、请求建不起来是 `无法连接`。
 *
 * 2xx 且 `data[0].embedding` 是非空数字数组是 `ok`；其余 2xx（读到 1 MiB 还没完也算）是 `响应不含嵌入向量`；非 2xx 是
 * `HTTP <status>：<excerpt>`：`readErrorBody` 加 `upstreamExcerpt`，净化集是这个上游自己的密钥与地址。这里不写日志，结果不带
 * 密钥。写回、身份判定与审计都归 `kb/settings.ts`。
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { upstreamEndpoint } from "../core/base-url.js";
import { readErrorBody } from "../core/error-body.js";
import { capPoints, upstreamExcerpt, upstreamSecretList } from "../core/upstream-failure.js";
import { isRecord } from "./ragflow-client.js";

const CONNECT_DEADLINE_MS = 10_000;
const TOTAL_DEADLINE_MS = 15_000;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_EXCERPT_POINTS = 200;
const UNREACHABLE = "无法连接";
const TIMED_OUT = "超时";
const NO_VECTOR = "响应不含嵌入向量";

interface EmbeddingProbeResult {
  status: "ok" | "failed";
  message: string | null;
}

export interface EmbeddingProbeDeadlines {
  connectDeadlineMs?: number;
  totalDeadlineMs?: number;
}

interface EmbeddingUpstream {
  name: string;
  baseUrl: string;
  apiKey: string;
}

const OK: EmbeddingProbeResult = { status: "ok", message: null };
const failed = (message: string): EmbeddingProbeResult => ({ status: "failed", message });

export function probeEmbedding(
  upstream: EmbeddingUpstream,
  deadlines: EmbeddingProbeDeadlines = {},
): Promise<EmbeddingProbeResult> {
  const payload = JSON.stringify({ model: upstream.name, input: "ping" });
  return new Promise((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    let tls = false;
    const settle = (result: EmbeddingProbeResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        resolve(result);
      }
      // 先定结果再销毁：销毁引发的错误改不成「无法连接」。
      req?.destroy();
    };
    const expire = (): void => settle(failed(TIMED_OUT));
    const connectTimer = setTimeout(expire, deadlines.connectDeadlineMs ?? CONNECT_DEADLINE_MS);
    const totalTimer = setTimeout(expire, deadlines.totalDeadlineMs ?? TOTAL_DEADLINE_MS);
    try {
      ({ req, tls } = openProbe(upstream, payload, (response) => {
        clearTimeout(connectTimer);
        judge(response, upstream, settle);
      }));
    } catch {
      settle(failed(UNREACHABLE));
      return;
    }
    req.on("error", () => settle(failed(UNREACHABLE)));
    // 每次探活一条新连接：TCP（与 TLS）建好，连接期限就结束了。
    req.on("socket", (socket: Socket) => {
      socket.once(tls ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    req.end(payload);
  });
}

function openProbe(
  upstream: EmbeddingUpstream,
  payload: string,
  onResponse: (response: IncomingMessage) => void,
): { req: ClientRequest; tls: boolean } {
  const endpoint = upstreamEndpoint(upstream.baseUrl, "embeddings");
  const tls = endpoint.protocol === "https:";
  const req = (tls ? https : http).request(
    endpoint,
    {
      method: "POST",
      agent: false,
      headers: {
        authorization: `Bearer ${upstream.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
    },
    onResponse,
  );
  return { req, tls };
}

function judge(
  response: IncomingMessage,
  upstream: EmbeddingUpstream,
  settle: (result: EmbeddingProbeResult) => void,
): void {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) {
    readResult(response, settle);
    return;
  }
  const secrets = upstreamSecretList({
    apiKey: upstream.apiKey,
    baseUrl: upstream.baseUrl,
    paths: [],
  });
  void readErrorBody(response).then(({ body, cut }) => {
    const text = upstreamExcerpt(body.toString("utf8"), secrets, cut);
    settle(failed(`HTTP ${String(status)}：${capPoints(text, MAX_EXCERPT_POINTS)}`));
  });
}

function readResult(
  response: IncomingMessage,
  settle: (result: EmbeddingProbeResult) => void,
): void {
  const chunks: Buffer[] = [];
  let read = 0;
  response.on("data", (chunk: Buffer) => {
    read += chunk.length;
    if (read > MAX_RESULT_BYTES) {
      settle(failed(NO_VECTOR));
      return;
    }
    chunks.push(chunk);
  });
  response.once("end", () => {
    settle(carriesVector(Buffer.concat(chunks)) ? OK : failed(NO_VECTOR));
  });
  response.once("error", () => settle(failed(UNREACHABLE)));
  response.once("close", () => settle(failed(UNREACHABLE)));
}

function carriesVector(bytes: Buffer): boolean {
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  const data = isRecord(document) ? document.data : undefined;
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  const embedding = isRecord(first) ? first.embedding : undefined;
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((value) => typeof value === "number")
  );
}
