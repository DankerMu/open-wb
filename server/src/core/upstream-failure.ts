/**
 * Issue #909 upstream failure text, shared by model-proxy and sessions (pure, no IO; the
 * `refused-characters.ts` precedent for a pure function both modules use): the one sanitiser of
 * upstream text (upstream-failure「上游原文净化」), the secret list it is given, the excerpt of a
 * ≥500 body and the five failure envelopes the proxy answers omp with (model-proxy「透传端点与
 * bearer 鉴权」, design D6–D9).
 */
import { userinfoParts } from "./base-url.js";

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
const SK_TAIL = /sk-[A-Za-z0-9_-]*$/u;

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
 * at most 1000 code points (994 and the mark when longer). `cut` means the body was cut short
 * before it reached here (core/error-body.ts); then a tail that is the start of a secret is
 * dropped, and when finding it would exceed `HEAD_SCAN_BUDGET` the excerpt is `""` (#1716).
 */
export function upstreamExcerpt(text: string, secrets: readonly string[], cut = false): string {
  const replaced = redact(text, secrets);
  const kept = cut ? dropSecretHead(replaced, secrets) : replaced;
  if (kept === null) {
    return "";
  }
  const flat = capPoints(kept.trimEnd(), MAX_SANITIZED_POINTS).replace(/[\n\t]+/gu, " ");
  return capPoints(flat, MAX_EXCERPT_POINTS);
}

/**
 * The six steps of upstream-failure「上游原文净化」, in their order: control characters go before
 * the secrets are replaced (a secret split by `\0` cannot slip through and be joined again), the
 * listed secrets before the 2000-point cut (no whole one is left for that cut to halve). A secret
 * the caller's own cut already halved is not recognised here; only `upstreamExcerpt` with `cut`
 * drops such a tail (the proxy's 16 KiB / 5 s read is that caller).
 */
export function sanitizeUpstreamText(text: string, secrets: readonly string[]): string {
  return capPoints(redact(text, secrets).trimEnd(), MAX_SANITIZED_POINTS);
}

/** Steps 1–5 of「上游原文净化」: everything before the cut. */
function redact(text: string, secrets: readonly string[]): string {
  const lines = normalize(text)
    .split("\n")
    .filter((line) => !DUMP_LINE.test(line));
  const result = replaceSecrets(lines.join("\n"), orderedSecrets(secrets));
  return result.replace(BEARER, `Bearer ${REMOVED}`).replace(SK_KEY, REMOVED);
}

/** Step 3: every occurrence of each listed secret, in the given (longest first) order. */
function replaceSecrets(text: string, ordered: readonly string[]): string {
  let result = text;
  for (const secret of ordered) {
    result = result.split(secret).join(REMOVED);
  }
  return result;
}

function orderedSecrets(secrets: readonly string[]): string[] {
  return secrets
    .map(normalize)
    .filter((secret) => secret !== "")
    .sort((a, b) => b.length - a.length);
}

/**
 * The work `dropSecretHead` may do, in units of about one character comparison (issue #1716;
 * upstream-failure「截断尾部丢弃的计算上界」, design D3). V8's `split`/`includes` cost follows the
 * pattern's structure, not just the string's length, so a search for an `m`-long pattern in an
 * `n`-long string (`m ≤ n`) costs what a naive search compares at most, `(n − m + 1) × m`, with
 * `m` raised to `SHORT_PATTERN_COST` (a short pattern costs per position whatever its length), plus
 * `CALL_COST`; a `split` adds `MATCH_COST` per occurrence; a comparison with the text's end costs
 * the head's length plus `CALL_COST`.
 *
 * Measured 2026-10-23 on the development machine (Apple Silicon, Node 24.13.1), searches in
 * strings of 16000 one- or two-byte units: about 6.5 ns per position for patterns of 2–6 units
 * dense in their first unit (and up to 64 units whose first unit is absent), 0.12–0.15 ns per
 * comparison for long patterns whose middle unit differs (`m` 512–12000), 10 ns per match, 35 ns
 * per call. Per unit, over whole `dropSecretHead` runs with a body ending `]` (no pruning), by
 * family: benign patterns 0.002–0.064 ns (a 16 KB base URL of 1780 segments 0.004; 4000 keys of
 * 32 units 0.064); short patterns dense in their first unit 0.12–0.14 ns; long patterns whose
 * middle unit differs 0.11–0.157 ns (two-byte, `m` = 512, the worst); dense matches 0.016–0.10 ns.
 * The worst single search measured, `aaaaa]` in `a`×16000, is 0.17 ns. Floor: 50 upstreams /
 * 300 secrets (three distinct 12–14-unit segments per base URL) with a body ending `[已移除]`
 * spend 9.4e7 units with 32-unit keys and
 * 1.74e8 (17% of the budget, 3 ms) with 164-unit keys, the length of an OpenAI `sk-proj-` key.
 * Ceiling: every input above that exhausts the budget returns within 160 ms (budget × the worst
 * single search: 170 ms).
 */
const HEAD_SCAN_BUDGET = 1_000_000_000;
const CALL_COST = 250;
const SHORT_PATTERN_COST = 52;
const MATCH_COST = 50;
const LAST_OF_REMOVED = REMOVED.charCodeAt(REMOVED.length - 1);
const REMOVED_UNITS = new Set(REMOVED);

/** The units charged so far by one `dropSecretHead` call. */
interface Spent {
  units: number;
}

/** `orderedSecrets`, and those of them with a unit of `[已移除]` (same order). */
interface Listing {
  ordered: readonly string[];
  marked: readonly string[];
  markedSet: ReadonlySet<string>;
}

/**
 * A cut can leave the head of a listed secret at the end of the text, and the replacement has
 * already run over that head: a shorter listed secret wholly inside it reads `[已移除]` there (a
 * base URL cut after its long path segment). So the text's end is compared with each proper prefix
 * of each listed secret as the replacement leaves it — the raw prefix when nothing listed fits
 * inside — and, of each secret, its longest matching prefix decides; the largest of those drops is
 * taken, as is an `sk-` run too short for `SK_KEY`. A `Bearer` token cut short is still caught by
 * `BEARER`. A head the cut split inside a multi-byte character ends in U+FFFD and matches no prefix.
 *
 * Three shortcuts change no result (design D2, D2b). A prefix as the replacement leaves it ends
 * either in its own last code unit (its end was not replaced) or in the last unit of `[已移除]`, `]`
 * (a `split/join` changes the end only when the string ends in the secret it removes); so when the
 * text's last unit is neither, that prefix is not built. Every string of the replacement chain is
 * raw pieces of the prefix between marks, so a listed secret with no unit of `[已移除]` can only
 * occur inside one raw piece: unless it is part of `secret`, it never matches and is left out of
 * that secret's chain. And a secret longer than the string being scanned cannot occur in it, so its
 * `split` is skipped (`ordered` runs longest first). What remains is charged against
 * `HEAD_SCAN_BUDGET`; past it the answer is `null`, and `upstreamExcerpt` keeps nothing of the body
 * rather than a tail that might still hold a secret's head.
 */
function dropSecretHead(text: string, secrets: readonly string[]): string | null {
  const ordered = orderedSecrets(secrets);
  const marked = ordered.filter(hasRemovedUnit);
  const listing: Listing = { ordered, marked, markedSet: new Set(marked) };
  const spent: Spent = { units: 0 };
  let end = text.length;
  for (const secret of text === "" ? [] : ordered) {
    const dropped = longestHeadAtEnd(text, secret, listing, spent);
    if (dropped === null) {
      return null;
    }
    end = Math.min(end, text.length - dropped);
  }
  const sk = SK_TAIL.exec(text);
  return text.slice(0, sk === null ? end : Math.min(end, sk.index));
}

/**
 * The length of the longest proper prefix of `secret`, as the replacement leaves it, that ends
 * `text`: 0 for none, `null` past the budget.
 */
function longestHeadAtEnd(
  text: string,
  secret: string,
  listing: Listing,
  spent: Spent,
): number | null {
  const last = text.charCodeAt(text.length - 1);
  let chain: string[] | null | undefined;
  for (let length = secret.length - 1; length > 0; length -= 1) {
    if (last !== LAST_OF_REMOVED && last !== secret.charCodeAt(length - 1)) {
      continue;
    }
    chain ??= relevantSecrets(secret, listing, spent);
    const head = chain === null ? null : replacedHead(secret.slice(0, length), chain, spent);
    if (head === null) {
      return null;
    }
    if (text.endsWith(head)) {
      return head.length;
    }
  }
  return 0;
}

/**
 * The listed secrets that can match in the chain of a prefix of `secret`, in `ordered` order: those
 * with a unit of `[已移除]`, and those that are part of `secret` (each search charged); or `null`.
 */
function relevantSecrets(secret: string, listing: Listing, spent: Spent): string[] | null {
  const chain = listing.marked.slice(0, firstFitting(listing.marked, secret.length, 0));
  spent.units += chain.length * CALL_COST;
  const fitting = firstFitting(listing.ordered, secret.length, 0);
  for (const listed of listing.ordered.slice(fitting)) {
    const marked = listing.markedSet.has(listed);
    spent.units += marked ? CALL_COST : searchCost(secret.length, listed.length);
    if (spent.units > HEAD_SCAN_BUDGET) {
      return null;
    }
    if (marked || secret.includes(listed)) {
      chain.push(listed);
    }
  }
  return chain;
}

/** `replaceSecrets(raw, chain)`, each `split` and the comparison after it charged; or `null`. */
function replacedHead(raw: string, chain: readonly string[], spent: Spent): string | null {
  let head = raw;
  let index = firstFitting(chain, head.length, 0);
  let listed = chain[index];
  while (listed !== undefined) {
    spent.units += searchCost(head.length, listed.length);
    if (spent.units > HEAD_SCAN_BUDGET) {
      return null;
    }
    const pieces = head.split(listed);
    spent.units += (pieces.length - 1) * MATCH_COST;
    head = pieces.join(REMOVED);
    index = firstFitting(chain, head.length, index + 1);
    listed = chain[index];
  }
  spent.units += head.length + CALL_COST;
  return spent.units > HEAD_SCAN_BUDGET ? null : head;
}

/** Comparisons a naive search for an `m`-long pattern in an `n`-long string makes, at most (m ≤ n). */
function searchCost(n: number, m: number): number {
  return (n - m + 1) * Math.max(m, SHORT_PATTERN_COST) + CALL_COST;
}

function hasRemovedUnit(listed: string): boolean {
  for (const unit of listed) {
    if (REMOVED_UNITS.has(unit)) {
      return true;
    }
  }
  return false;
}

/** The first index at or after `from` whose secret is at most `length` long (`ordered` descends). */
function firstFitting(ordered: readonly string[], length: number, from: number): number {
  let low = from;
  let high = ordered.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((ordered[middle]?.length ?? 0) > length) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
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
export function capPoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) {
    return text;
  }
  return points.slice(0, max - Array.from(TRUNCATED_MARK).length).join("") + TRUNCATED_MARK;
}

/**
 * The secret list of upstream-failure「上游原文净化」: the API key; the base URL as configured; its
 * userinfo and the password in it, raw and as WHATWG parses them (`core/base-url` `userinfoParts`,
 * never the user name alone); its pathname (not empty, not `/`) and each segment of it at least 8
 * long; its query without `?`; and every absolute path given. The host is not a secret (it names the
 * provider). Empty and repeated entries are dropped.
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
  const parts = [baseUrl, ...userinfoParts(baseUrl)];
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
