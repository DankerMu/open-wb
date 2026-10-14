/**
 * Issue #909 task 5.2: sessions/upstream-classify.ts. Every expected reason, status, detail and
 * sentence is a literal of upstream-failure「回合失败分类」(its table and its four scenarios, one
 * case per row of each scenario) — none is computed by the module under test.
 */
import { describe, expect, it } from "vitest";
import {
  classifyTurnFailure,
  type FailureReason,
  failureLine,
  failureSentence,
} from "../src/sessions/upstream-classify.js";

/** The sentence table of upstream-failure「回合失败分类」, copied from the spec. */
const SENTENCES: Record<FailureReason, string> = {
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
};

/** omp's spelling of a proxy envelope (`<status> <message>\n<message> (type=… param=…)`). */
function marked(status: number, message: string, param: string): string {
  return `${String(status)} ${message}\n${message} (type=wb_upstream param=${param})`;
}

const fromEnd = (errorStatus: number | undefined, errorMessage: string) =>
  classifyTurnFailure({ source: "message_end", errorStatus, errorMessage });

describe("upstream-failure「回合失败分类」逐条分类", () => {
  const CASES: Array<[string, () => ReturnType<typeof fromEnd>, FailureReason, number | null]> = [
    ["401", () => fromEnd(401, "401 Incorrect API key provided"), "auth_failed", 401],
    ["403", () => fromEnd(403, "403 Forbidden"), "auth_failed", 403],
    [
      "404 naming a model",
      () => fromEnd(404, "404 The model `x` does not exist"),
      "model_not_found",
      404,
    ],
    ["404 without model", () => fromEnd(404, "404 Not Found"), "request_rejected", 404],
    ["402", () => fromEnd(402, "402 Payment Required"), "quota_exhausted", 402],
    [
      "429 insufficient_quota",
      () => fromEnd(429, "429 You exceeded your current quota (type=insufficient_quota)"),
      "quota_exhausted",
      429,
    ],
    // Row 7's other keywords, and both case-insensitive matches (rows 6 and 7: 不分大小写).
    ["429 余额", () => fromEnd(429, "429 账户余额不足"), "quota_exhausted", 429],
    ["429 额度", () => fromEnd(429, "429 本月调用额度已用完"), "quota_exhausted", 429],
    ["429 BILLING", () => fromEnd(429, "429 BILLING HARD LIMIT REACHED"), "quota_exhausted", 429],
    ["404 MODEL", () => fromEnd(404, "404 MODEL_NOT_FOUND"), "model_not_found", 404],
    ["429 plain", () => fromEnd(429, "429 Too Many Requests"), "rate_limited", 429],
    ["408", () => fromEnd(408, "408 Request Timeout"), "upstream_timeout", 408],
    ["400 no body", () => fromEnd(400, "400 status code (no body)"), "request_rejected", 400],
    [
      "502 status.503",
      () => fromEnd(502, marked(502, "模型服务返回 HTTP 503：busy", "status.503")),
      "upstream_error",
      503,
    ],
    [
      "502 connect.ECONNREFUSED",
      () => fromEnd(502, marked(502, "无法连接模型服务（ECONNREFUSED）", "connect.ECONNREFUSED")),
      "upstream_unreachable",
      null,
    ],
    [
      "424 no_connect",
      () => fromEnd(424, marked(424, "模型服务在 10 秒内没有建立连接", "no_connect")),
      "upstream_unreachable",
      null,
    ],
    [
      "424 no_response",
      () => fromEnd(424, marked(424, "模型服务在 120 秒内没有返回响应", "no_response")),
      "upstream_timeout",
      null,
    ],
    [
      "424 gateway_504",
      () => fromEnd(424, marked(424, "模型服务的网关等待模型超时", "gateway_504")),
      "upstream_timeout",
      504,
    ],
    [
      "424 gateway_524",
      () => fromEnd(424, marked(424, "模型服务的网关等待模型超时", "gateway_524")),
      "upstream_timeout",
      524,
    ],
    ["502 without a marker", () => fromEnd(502, "502 Bad Gateway"), "upstream_error", 502],
    [
      "no status, no marker",
      () => fromEnd(undefined, "The socket connection was closed unexpectedly."),
      "model_call_failed",
      null,
    ],
    [
      "runtime boom",
      () => classifyTurnFailure({ source: "runtime", errorMessage: "boom" }),
      "agent_failed",
      null,
    ],
  ];

  it.each(CASES)("%s", (_name, classify, reason, status) => {
    const failure = classify();
    expect(failure.reason).toBe(reason);
    expect(failure.status).toBe(status);
    expect(failureSentence(failure.reason)).toBe(SENTENCES[reason]);
  });

  it("detail is the whole errorMessage outside rows 2–4, and the runtime text for agent_failed", () => {
    expect(fromEnd(401, "401 bad\nbad (type=invalid_request_error)").detail).toBe(
      "401 bad\nbad (type=invalid_request_error)",
    );
    expect(classifyTurnFailure({ source: "runtime", errorMessage: "boom" }).detail).toBe("boom");
    expect(fromEnd(424, marked(424, "模型服务的网关等待模型超时", "gateway_504")).detail).toBe(
      "模型服务的网关等待模型超时",
    );
  });

  it("a non-integer errorStatus counts as absent", () => {
    expect(fromEnd(Number.NaN, "x").reason).toBe("model_call_failed");
    expect(
      classifyTurnFailure({ source: "message_end", errorStatus: "401", errorMessage: "x" }),
    ).toMatchObject({ reason: "model_call_failed", status: null });
  });
});

describe("upstream-failure「回合失败分类」记号只认末尾", () => {
  it("a marker inside the first line loses to the one at the very end", () => {
    const text = `502 模型服务返回 HTTP 500：echo (type=wb_upstream param=connect.X)\n模型服务返回 HTTP 500 (type=wb_upstream param=status.500)`;
    expect(fromEnd(502, text)).toMatchObject({ reason: "upstream_error", status: 500 });
  });

  it("a marker in the middle of the text without one at the end is not credited", () => {
    const text = "400 bad (type=wb_upstream param=no_response) request\nbad request";
    expect(fromEnd(400, text)).toMatchObject({ reason: "request_rejected", status: 400 });
  });
});

describe("upstream-failure「回合失败分类」状态不符的记号不被采信", () => {
  it("a 401 body ending in a status.500 marker stays auth_failed", () => {
    const text = "401 x\nx (type=wb_upstream param=status.500)";
    expect(fromEnd(401, text)).toMatchObject({ reason: "auth_failed", status: 401 });
  });

  it("a 401 body ending in a connect.ECONNREFUSED marker stays auth_failed", () => {
    const text = "401 x\nx (type=wb_upstream param=connect.ECONNREFUSED)";
    expect(fromEnd(401, text)).toMatchObject({ reason: "auth_failed", status: 401 });
  });

  it("a 502 ending in no_response falls to row 11", () => {
    const text = "502 x\nx (type=wb_upstream param=no_response)";
    expect(fromEnd(502, text)).toMatchObject({ reason: "upstream_error", status: 502 });
  });

  it("a 424 ending in status.503 falls to row 10", () => {
    const text = "424 x\nx (type=wb_upstream param=status.503)";
    expect(fromEnd(424, text)).toMatchObject({ reason: "request_rejected", status: 424 });
  });
});

describe("upstream-failure「回合失败分类」重试预算前缀不影响 detail", () => {
  const BODY =
    "502 模型服务返回 HTTP 503：busy\n模型服务返回 HTTP 503：busy (type=wb_upstream param=status.503)";

  it.each([
    ["with the prefix", `Retry budget exhausted after 1 retry: ${BODY}`],
    ["without the prefix", BODY],
  ])("%s", (_name, text) => {
    expect(fromEnd(502, text)).toEqual({
      reason: "upstream_error",
      status: 503,
      detail: "模型服务返回 HTTP 503：busy",
    });
  });

  it("the plural spelling is stripped the same way", () => {
    expect(fromEnd(502, `Retry budget exhausted after 2 retries: ${BODY}`).detail).toBe(
      "模型服务返回 HTTP 503：busy",
    );
  });
});

describe("failureLine (the two-key error message of PR 3)", () => {
  it("appends （HTTP s） when there is a status and nothing when it is null", () => {
    expect(failureLine({ reason: "auth_failed", status: 401 })).toBe(
      "鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）",
    );
    expect(failureLine({ reason: "upstream_unreachable", status: null })).toBe(
      "上游不可达：无法连接模型服务",
    );
  });
});
