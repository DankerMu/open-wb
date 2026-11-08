/**
 * 知识库模型的一次探活，两种目标：嵌入（s2a-kb-ragflow D7）与重排（s2b-kb-retrieval D7）；ragflow-backend「知识库模型设置」的
 * 探活。直连上游，不经 RAGFlow：`POST upstreamEndpoint(baseUrl, <path>)`，`authorization: Bearer <apiKey>`，新连接
 * （`agent: false`），不跟随重定向（3xx 是非 2xx），不重试。期限同 `models/probe.ts`：连接 10 s、总 15 s，读正文也算在内，
 * 到期 `超时`。连接被拒、中途断开、请求建不起来是 `无法连接`。
 *
 * 按目标取路径、body 与 2xx 判定（`TARGETS`）：
 * - 嵌入：`embeddings`，`{model, input:"ping"}`；`data[0].embedding` 是非空数字数组是 `ok`，否则 `响应不含嵌入向量`。
 * - 重排：`rerank`，`{model, query:"ping", documents:["ping"]}`；`results[0].relevance_score` 是有限数字是 `ok`，否则
 *   `响应不含重排分数`。
 * 读到 1 MiB 还没完的 2xx 也是该目标的「不含」。非 2xx 是 `HTTP <status>：<excerpt>`：`readErrorBody` 加 `upstreamExcerpt`，
 * 净化集是这个上游自己的密钥与地址。这里不写日志，结果不带密钥。写回、身份判定与审计都归 `kb/settings.ts`。
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

interface ModelProbeResult {
  status: "ok" | "failed";
  message: string | null;
}

export interface ModelProbeDeadlines {
  connectDeadlineMs?: number;
  totalDeadlineMs?: number;
}

interface ModelUpstream {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 一种目标：上游路径、探活 body、2xx 正文的判定，与判定不过时的文案。 */
interface ProbeTarget {
  path: string;
  body(name: string): Record<string, unknown>;
  judge(document: unknown): boolean;
  missing: string;
}

const TARGETS: Record<"embedding" | "rerank", ProbeTarget> = {
  embedding: {
    path: "embeddings",
    body: (model) => ({ model, input: "ping" }),
    judge: carriesVector,
    missing: "响应不含嵌入向量",
  },
  rerank: {
    path: "rerank",
    body: (model) => ({ model, query: "ping", documents: ["ping"] }),
    judge: carriesScore,
    missing: "响应不含重排分数",
  },
};

const OK: ModelProbeResult = { status: "ok", message: null };
const failed = (message: string): ModelProbeResult => ({ status: "failed", message });

export function probeModel(
  target: keyof typeof TARGETS,
  upstream: ModelUpstream,
  deadlines: ModelProbeDeadlines = {},
): Promise<ModelProbeResult> {
  const spec = TARGETS[target];
  const payload = JSON.stringify(spec.body(upstream.name));
  return new Promise((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    let tls = false;
    const settle = (result: ModelProbeResult): void => {
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
      ({ req, tls } = openProbe(upstream, spec.path, payload, (response) => {
        clearTimeout(connectTimer);
        answer(response, upstream, spec, settle);
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
  upstream: ModelUpstream,
  path: string,
  payload: string,
  onResponse: (response: IncomingMessage) => void,
): { req: ClientRequest; tls: boolean } {
  const endpoint = upstreamEndpoint(upstream.baseUrl, path);
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

function answer(
  response: IncomingMessage,
  upstream: ModelUpstream,
  spec: ProbeTarget,
  settle: (result: ModelProbeResult) => void,
): void {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) {
    readResult(response, spec, settle);
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
  spec: ProbeTarget,
  settle: (result: ModelProbeResult) => void,
): void {
  const chunks: Buffer[] = [];
  let read = 0;
  response.on("data", (chunk: Buffer) => {
    read += chunk.length;
    if (read > MAX_RESULT_BYTES) {
      settle(failed(spec.missing));
      return;
    }
    chunks.push(chunk);
  });
  response.once("end", () => {
    settle(spec.judge(parsed(Buffer.concat(chunks))) ? OK : failed(spec.missing));
  });
  response.once("error", () => settle(failed(UNREACHABLE)));
  response.once("close", () => settle(failed(UNREACHABLE)));
}

/** 不是 JSON 时为 `undefined`：两种判定都不认它。 */
function parsed(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function carriesVector(document: unknown): boolean {
  const data = isRecord(document) ? document.data : undefined;
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  const embedding = isRecord(first) ? first.embedding : undefined;
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((value) => typeof value === "number")
  );
}

function carriesScore(document: unknown): boolean {
  const results = isRecord(document) ? document.results : undefined;
  const first: unknown = Array.isArray(results) ? results[0] : undefined;
  return isRecord(first) && Number.isFinite(first.relevance_score);
}
