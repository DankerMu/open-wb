/**
 * models/probe — one probe of a model's upstream (s1d-model-registry D11; model-registry「探活」).
 * `GET upstreamEndpoint(baseUrl, "models")` (core/base-url: path without its trailing slashes,
 * then `/models`, query kept) with `authorization: Bearer <apiKey>` and
 * `accept: application/json` over a fresh connection (`agent: false`): no redirect is followed,
 * nothing is retried. 2xx → `ok` (the body is drained, not awaited); any other status → `failed`
 * with `HTTP <status>：<excerpt>` — at most 16 KiB of the body (`core/error-body.ts`), sanitised by
 * `upstreamExcerpt` with the caller's secrets plus this upstream's own, then capped at 200 code
 * points; a refused / reset connection, a DNS failure or a request that cannot be built →
 * `无法连接`; the connect deadline (10 s) or the total one (15 s, which also covers reading that
 * body) → `超时`. The result never carries the key or the base URL; nothing is logged.
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { upstreamEndpoint } from "../core/base-url.js";
import { readErrorBody } from "../core/error-body.js";
import { capPoints, upstreamExcerpt, upstreamSecretList } from "../core/upstream-failure.js";

const CONNECT_DEADLINE_MS = 10_000;
const TOTAL_DEADLINE_MS = 15_000;
const MAX_EXCERPT_POINTS = 200;
const UNREACHABLE = "无法连接";
const TIMED_OUT = "超时";

export interface ProbeResult {
  status: "ok" | "failed";
  message: string | null;
}

export interface ProbeOptions {
  connectDeadlineMs?: number;
  totalDeadlineMs?: number;
  /** The sanitising key set of every registered upstream (`registry.secrets()`). */
  secrets: readonly string[];
}

export function probeUpstream(
  upstream: { baseUrl: string; apiKey: string },
  options: ProbeOptions,
): Promise<ProbeResult> {
  const secrets = [
    ...options.secrets,
    ...upstreamSecretList({ apiKey: upstream.apiKey, baseUrl: upstream.baseUrl, paths: [] }),
  ];
  return new Promise((resolve) => {
    let settled = false;
    let req: ClientRequest | undefined;
    let tls = false;
    const settle = (result: ProbeResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        resolve(result);
      }
    };
    // A deadline settles first and destroys after: the error the destroy raises cannot turn it into 无法连接.
    const expire = (): void => {
      settle({ status: "failed", message: TIMED_OUT });
      req?.destroy();
    };
    const connectTimer = setTimeout(expire, options.connectDeadlineMs ?? CONNECT_DEADLINE_MS);
    const totalTimer = setTimeout(expire, options.totalDeadlineMs ?? TOTAL_DEADLINE_MS);
    try {
      ({ req, tls } = openProbe(upstream, (response) => {
        clearTimeout(connectTimer);
        void answer(response, secrets).then(settle);
      }));
    } catch {
      clearTimeout(totalTimer);
      settle({ status: "failed", message: UNREACHABLE });
      return;
    }
    req.once("close", () => clearTimeout(totalTimer));
    req.on("error", () => settle({ status: "failed", message: UNREACHABLE }));
    // A fresh socket per probe: the connect deadline ends once TCP (and TLS) is up.
    req.on("socket", (socket: Socket) => {
      socket.once(tls ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    req.end();
  });
}

function openProbe(
  upstream: { baseUrl: string; apiKey: string },
  onResponse: (response: IncomingMessage) => void,
): { req: ClientRequest; tls: boolean } {
  const endpoint = upstreamEndpoint(upstream.baseUrl, "models");
  const tls = endpoint.protocol === "https:";
  const req = (tls ? https : http).request(
    endpoint,
    {
      method: "GET",
      agent: false,
      headers: { authorization: `Bearer ${upstream.apiKey}`, accept: "application/json" },
    },
    onResponse,
  );
  return { req, tls };
}

async function answer(response: IncomingMessage, secrets: readonly string[]): Promise<ProbeResult> {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) {
    response.resume();
    return { status: "ok", message: null };
  }
  const { body, cut } = await readErrorBody(response);
  const excerpt = capPoints(
    upstreamExcerpt(body.toString("utf8"), secrets, cut),
    MAX_EXCERPT_POINTS,
  );
  return { status: "failed", message: `HTTP ${String(status)}：${excerpt}` };
}
