/**
 * Issue #909 upstream-failure「回合失败分类」: every turn that ends in an `error` event gets exactly
 * one `reason` (design D10's twelve rows, first match wins) and one fixed Chinese sentence. The
 * sentence table lives here and nowhere else in the server. Pure: no IO; `detail` is not
 * sanitised here: turn-control's `persistEvent` sanitises it, stores the three error columns and
 * only then returns the five-key `error` event for publication; the snapshot looks the sentence up
 * again from the stored `reason` (store-error.ts).
 *
 * The proxy's own failure envelopes reach omp's `errorMessage` ending in
 * `(type=wb_upstream param=<kind>)` (model-proxy「透传端点与 bearer 鉴权」, shape 实测 under omp
 * v18.0.10). Such a marker is credited only at the very end of the text and only when `errorStatus`
 * is the status the proxy sends for that kind (502 for `status.*` / `connect.*`, 424 for the other
 * three): a `< 500` upstream body is passed through and omp appends its own `type` / `param`, so a
 * 401 body can end in the same words. Accepted residual (design Risks, 读代码推出): an upstream
 * that itself answers 424 with `"type":"wb_upstream"` and a forged `param` cannot be told from the
 * proxy's own 424 — `no_response` / `gateway_<s>` classify as `upstream_timeout`, `no_connect` as
 * `upstream_unreachable`.
 */

export type FailureReason =
  | "agent_failed"
  | "upstream_error"
  | "upstream_unreachable"
  | "upstream_timeout"
  | "auth_failed"
  | "model_not_found"
  | "quota_exhausted"
  | "rate_limited"
  | "request_rejected"
  | "model_call_failed";

export interface TurnFailure {
  reason: FailureReason;
  status: number | null;
  detail: string;
}

const SENTENCES: Readonly<Record<FailureReason, string>> = Object.freeze({
  agent_failed: "Agent 运行失败",
  upstream_error: "上游出错：模型服务内部错误",
  upstream_unreachable: "上游不可达：无法连接模型服务",
  upstream_timeout: "上游超时：模型服务没有及时响应",
  auth_failed: "鉴权失败：模型服务拒绝了配置的 API 密钥",
  model_not_found: "模型不存在：模型服务找不到所请求的模型",
  quota_exhausted: "额度不足：模型服务账户的额度已用完",
  rate_limited: "请求过于频繁：模型服务暂时限流",
  request_rejected: "请求被拒：模型服务拒绝了这次请求",
  model_call_failed: "模型调用失败",
});

const MARKER =
  /\(type=wb_upstream param=(status\.[1-5][0-9]{2}|connect\.[A-Z0-9_]{1,64}|gateway_(?:504|524)|no_connect|no_response)\)$/u;
const RETRY_BUDGET_PREFIX = /^Retry budget exhausted after \d+ (?:retry|retries): /u;
const STATUS_PREFIX = /^\d{3} /u;
const QUOTA = /quota|insufficient|billing|余额|额度/iu;

/** The fixed sentence of `reason`. */
export function failureSentence(reason: FailureReason): string {
  return SENTENCES[reason];
}

/** True for one of the ten reasons (a stored column may hold anything a hand edit wrote). */
export function isFailureReason(value: string): value is FailureReason {
  return Object.hasOwn(SENTENCES, value);
}

export function classifyTurnFailure(input: {
  source: "message_end" | "runtime";
  errorStatus?: unknown;
  errorMessage: string;
}): TurnFailure {
  const text = input.errorMessage;
  if (input.source === "runtime") {
    return { reason: "agent_failed", status: null, detail: text };
  }
  // Outside 100–599 counts as missing (the web accepts only that range): never stored or published.
  const status =
    typeof input.errorStatus === "number" &&
    Number.isInteger(input.errorStatus) &&
    input.errorStatus >= 100 &&
    input.errorStatus <= 599
      ? input.errorStatus
      : null;
  return markerFailure(status, text) ?? statusFailure(status, text);
}

/** Rows 2–4: a credited marker at the end of the text. */
function markerFailure(status: number | null, text: string): TurnFailure | undefined {
  const kind = MARKER.exec(text)?.[1];
  if (kind === undefined) {
    return undefined;
  }
  const detail = firstLineDetail(text);
  if (status === 502 && kind.startsWith("status.")) {
    return { reason: "upstream_error", status: Number(kind.slice("status.".length)), detail };
  }
  if (status === 502 && kind.startsWith("connect.")) {
    return { reason: "upstream_unreachable", status: null, detail };
  }
  if (status !== 424) {
    return undefined;
  }
  if (kind === "no_connect") {
    return { reason: "upstream_unreachable", status: null, detail };
  }
  if (kind === "no_response") {
    return { reason: "upstream_timeout", status: null, detail };
  }
  if (kind.startsWith("gateway_")) {
    return { reason: "upstream_timeout", status: Number(kind.slice("gateway_".length)), detail };
  }
  return undefined;
}

/** Rows 5–12: the status omp reported, and the text for 404 and 429. */
function statusFailure(status: number | null, text: string): TurnFailure {
  const failure = (reason: FailureReason, value = status): TurnFailure => ({
    reason,
    status: value,
    detail: text,
  });
  if (status === null) {
    return failure("model_call_failed");
  }
  if (status === 401 || status === 403) {
    return failure("auth_failed");
  }
  if (status === 404 && /model/iu.test(text)) {
    return failure("model_not_found");
  }
  if (status === 402 || (status === 429 && QUOTA.test(text))) {
    return failure("quota_exhausted");
  }
  if (status === 429) {
    return failure("rate_limited");
  }
  if (status === 408) {
    return failure("upstream_timeout");
  }
  if (status >= 400 && status <= 499) {
    return failure("request_rejected");
  }
  return status >= 500 ? failure("upstream_error") : failure("model_call_failed", null);
}

/**
 * The proxy's one-line message: the first line without omp's optional `Retry budget exhausted
 * after <n> retry|retries: ` prefix (`turn-recovery.ts:2145`) and without the leading
 * `<status> `.
 */
function firstLineDetail(text: string): string {
  const [first = ""] = text.split("\n");
  return first.replace(RETRY_BUDGET_PREFIX, "").replace(STATUS_PREFIX, "");
}
