/**
 * Issue #909 upstream failure text, shared by model-proxy and sessions (pure, no IO; the
 * `refused-characters.ts` precedent for a pure function both modules use): the one sanitiser of
 * upstream text (upstream-failure「上游原文净化」), the secret list it is given, the excerpt of a
 * ≥500 body and the five failure envelopes the proxy answers omp with (model-proxy「透传端点与
 * bearer 鉴权」, design D6–D9).
 */

/** The truncation mark of every capped text: step detail/output, thinking and upstream text. */
export const TRUNCATED_MARK = "…（已截断）";

const REMOVED = "[已移除]";
const MAX_SANITIZED_POINTS = 2000;
const MAX_EXCERPT_POINTS = 1000;
/** Path segments shorter than this (`v1`, `api`) are not listed alone: they would shred text. */
const MIN_SEGMENT_LENGTH = 8;
const MAX_REASON_CODE = 64;
const DUMP_LINE = /^raw-http-request(?:-save-failed)?=/u;
const BEARER = /Bearer\s+\S+/giu;
const SK_KEY = /sk-[A-Za-z0-9_-]{16,}/gu;

/** One answer the proxy writes instead of the upstream's: status and the exact JSON body. */
export interface UpstreamFailureReply {
  status: 502 | 424;
  body: string;
}

/** The three non-retryable answers (424), byte for byte (design D7). */
export const NO_CONNECT_REPLY: UpstreamFailureReply = envelope(
  424,
  "模型服务在 10 秒内没有建立连接",
  "no_connect",
);
export const NO_RESPONSE_REPLY: UpstreamFailureReply = envelope(
  424,
  "模型服务在 120 秒内没有返回响应",
  "no_response",
);

/** Upstream 504 / 524: never carries any byte of the upstream body (design D6). */
export function gatewayReply(status: 504 | 524): UpstreamFailureReply {
  return envelope(424, "模型服务的网关等待模型超时", `gateway_${String(status)}`);
}

/** Upstream ≥500 other than 504 / 524: retryable, with the sanitised excerpt when there is one. */
export function statusReply(status: number, excerpt: string): UpstreamFailureReply {
  const head = `模型服务返回 HTTP ${String(status)}`;
  return envelope(502, excerpt === "" ? head : `${head}：${excerpt}`, `status.${String(status)}`);
}

/** A transport failure before the connection is up, or a synchronous throw building the request. */
export function connectReply(code: unknown): UpstreamFailureReply {
  const kept =
    typeof code === "string" ? code.replace(/[^A-Z0-9_]/gu, "").slice(0, MAX_REASON_CODE) : "";
  const reason = kept === "" ? "UNKNOWN" : kept;
  return envelope(502, `无法连接模型服务（${reason}）`, `connect.${reason}`);
}

function envelope(status: 502 | 424, message: string, param: string): UpstreamFailureReply {
  return { status, body: JSON.stringify({ error: { message, type: "wb_upstream", param } }) };
}

/**
 * The excerpt of a ≥500 body: sanitised, every run of line feeds and tabs folded into one space,
 * at most 1000 code points (994 and the mark when longer).
 */
export function upstreamExcerpt(text: string, secrets: readonly string[]): string {
  const flat = sanitizeUpstreamText(text, secrets).replace(/[\n\t]+/gu, " ");
  return capPoints(flat, MAX_EXCERPT_POINTS);
}

/**
 * The six steps of upstream-failure「上游原文净化」, in their order: control characters go before
 * the secrets are replaced (a secret split by `\0` cannot slip through and be joined again), the
 * secrets before the cut (a secret cannot survive as a half).
 */
export function sanitizeUpstreamText(text: string, secrets: readonly string[]): string {
  const lines = normalize(text)
    .split("\n")
    .filter((line) => !DUMP_LINE.test(line));
  let result = lines.join("\n");
  const ordered = secrets
    .map(normalize)
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    result = result.split(secret).join(REMOVED);
  }
  result = result.replace(BEARER, `Bearer ${REMOVED}`).replace(SK_KEY, REMOVED);
  return capPoints(result.trimEnd(), MAX_SANITIZED_POINTS);
}

function normalize(text: string): string {
  return dropControls(text.replace(/\r\n?|[\u2028\u2029]/gu, "\n"));
}

/** Deletes U+0000–U+0008, U+000B–U+001F and U+007F; tab and line feed stay. */
function dropControls(text: string): string {
  let kept = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x08 || (unit >= 0x0b && unit <= 0x1f) || unit === 0x7f) {
      continue;
    }
    kept += text[index];
  }
  return kept;
}

/** Keeps `max` code points, or `max - 6` and the mark; a surrogate pair is never split. */
function capPoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) {
    return text;
  }
  return points.slice(0, max - Array.from(TRUNCATED_MARK).length).join("") + TRUNCATED_MARK;
}

/**
 * The secret list of upstream-failure「上游原文净化」: the API key; the base URL as configured; its
 * userinfo (between `//` and `@`) and the password in it; its pathname (not empty, not `/`) and each
 * segment of it at least 8 long; its query without `?`; and every absolute path given. The host is
 * not a secret (it names the provider). Empty and repeated entries are dropped.
 */
export function upstreamSecretList(input: {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  paths: readonly string[];
}): string[] {
  const list = [input.apiKey ?? "", ...baseUrlParts(input.baseUrl ?? ""), ...input.paths];
  return [...new Set(list.filter((entry) => entry !== ""))];
}

function baseUrlParts(baseUrl: string): string[] {
  if (baseUrl === "") {
    return [];
  }
  const parts = [baseUrl];
  const userinfo = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)@/u.exec(baseUrl)?.[1];
  if (userinfo !== undefined) {
    const colon = userinfo.indexOf(":");
    parts.push(userinfo, colon === -1 ? "" : userinfo.slice(colon + 1));
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return parts;
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    parts.push(url.pathname);
    parts.push(...url.pathname.split("/").filter((s) => s.length >= MIN_SEGMENT_LENGTH));
  }
  parts.push(url.search.slice(1));
  return parts;
}
