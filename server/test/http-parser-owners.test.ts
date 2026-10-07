import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { HTTP_ERROR_MESSAGES } from "../src/core/errors/index.js";
import { handleHttpError } from "../src/http/index.js";

/**
 * #512 parser owner 身份集：只走共享 handleHttpError + requestShaped 接缝，不挂载产品路由。
 * 期望值逐字抄录自 spec「统一错误信封」与 design「Required evidence」，独立于 http/errors.ts。
 */

const BAD_REQUEST_BODY = JSON.stringify({
  error: { code: "bad_request", message: "请求格式不正确" },
});
const NOT_FOUND_BODY = JSON.stringify({
  error: { code: "not_found", message: "请求的资源不存在" },
});
const GENERIC_BODY = JSON.stringify({ error: { message: "服务器内部错误" } });

const CTP_CODES = [
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "FST_ERR_CTP_BODY_TOO_LARGE",
] as const;

type CtpCode = (typeof CTP_CODES)[number];

/** spec 的十二条 method + matched route 归属身份（十一条 POST + 一条 PATCH）。 */
const TWELVE_OWNER_IDENTITIES = [
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/sessions/:id/prompt"],
  ["POST", "/v1/chat/completions"],
  ["POST", "/api/workspaces"],
  ["POST", "/api/workspaces/:id/dirs"],
  ["POST", "/api/sessions/:id/stop"],
  ["POST", "/api/sessions/:id/regenerate"],
  ["POST", "/api/sessions/:id/fork"],
  ["POST", "/api/sessions/:id/approvals/:approvalId"],
  ["POST", "/api/sessions"],
  ["PATCH", "/api/sessions/:id"],
] as const;

/** spec 码表的十四码键集（与 http-typed-errors.test.ts 同义的本文件守卫）。 */
const FOURTEEN_CODES = [
  "bad_request",
  "invalid_credentials",
  "account_disabled",
  "unauthorized",
  "not_found",
  "session_busy",
  "agent_unavailable",
  "sandbox_denied",
  "conflict",
  "preview_too_large",
  "preview_unsupported",
  "agent_capacity",
  "approval_settled",
  "session_archived",
] as const;

interface ReplyCapture {
  statusCode?: number;
  body?: string;
}

/** 捕获 reply.code/send 的唯一替身（系统边界：Fastify reply）。 */
function captureReply(): { reply: FastifyReply; captured: ReplyCapture } {
  const captured: ReplyCapture = {};
  const reply = {
    code(statusCode: number) {
      captured.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      captured.body = JSON.stringify(body);
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

/** matched route identity 仅由 method + routeOptions.url 表达；url 为 undefined 即 unmatched。 */
function requestShaped(
  method: string,
  routeOptionsUrl: string | undefined,
  rawUrl = routeOptionsUrl ?? "/unmatched",
): FastifyRequest {
  return {
    method,
    url: rawUrl,
    routeOptions: { url: routeOptionsUrl },
  } as unknown as FastifyRequest;
}

/** 以 fastify.errorCodes 的真实构造器实例化 CTP 错误；code/statusCode 由构造器自带。 */
function genuineCtpError(code: CtpCode): Error {
  const ctpConstructor = fastify.errorCodes[code] as unknown as new (detail?: string) => Error;
  return new ctpConstructor("application/x-raw-detail");
}

function forgedCtpError(code: CtpCode): Error {
  const statusCode = code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : 400;
  return Object.assign(new Error(`forged ${code}`), { code, statusCode });
}

function mapThrough(error: Error, request: FastifyRequest): ReplyCapture {
  const { reply, captured } = captureReply();
  handleHttpError(error, request, reply);
  return captured;
}

function expectNoRawDetail(captured: ReplyCapture, error: Error): void {
  expect(captured.body).not.toContain("FST_ERR");
  expect(captured.body).not.toContain(error.message);
  expect(captured.body).not.toContain("x-raw-detail");
}

function expectSendErrorEnvelope(captured: ReplyCapture, error: Error): void {
  expect(captured.statusCode).toBe(400);
  expect(captured.body).toBe(BAD_REQUEST_BODY);
  expectNoRawDetail(captured, error);
}

function expectGeneric500(captured: ReplyCapture, error: Error): void {
  expect(captured.statusCode).toBe(500);
  expect(captured.body).toBe(GENERIC_BODY);
  expectNoRawDetail(captured, error);
  for (const code of FOURTEEN_CODES) {
    expect(captured.body).not.toContain(code);
  }
}

function expectNotFound(captured: ReplyCapture, error: Error): void {
  expect(captured.statusCode).toBe(404);
  expect(captured.body).toBe(NOT_FOUND_BODY);
  expectNoRawDetail(captured, error);
}

function crossWithCodes<T extends readonly unknown[]>(rows: readonly T[]) {
  return rows.flatMap((row) => CTP_CODES.map((code) => [...row, code] as const));
}

describe("证据 1：十二条身份 × 四个真实 CTP 错误 -> 400", () => {
  it("身份集恰十二条且互不重复", () => {
    const keys = TWELVE_OWNER_IDENTITIES.map(([method, url]) => `${method} ${url}`);
    expect(new Set(keys).size).toBe(12);
  });

  it.each(crossWithCodes(TWELVE_OWNER_IDENTITIES))(
    "%s %s 上真实 %s -> 400 bad_request 且无 raw 细节",
    (method, url, code) => {
      const error = genuineCtpError(code);
      expectSendErrorEnvelope(mapThrough(error, requestShaped(method, url)), error);
    },
  );
});

describe("证据 2（守卫）：DELETE /api/sessions/:id 不被覆盖", () => {
  it.each(CTP_CODES)("DELETE /api/sessions/:id 上真实 %s -> generic 500", (code) => {
    const error = genuineCtpError(code);
    expectGeneric500(mapThrough(error, requestShaped("DELETE", "/api/sessions/:id")), error);
  });
});

describe("证据 3（守卫）：非本身份与 lookalike 保持 500", () => {
  const NON_OWNER_METHODS = [
    ["PATCH", "/api/sessions"],
    ["POST", "/api/sessions/:id"],
    ["GET", "/api/sessions"],
    ["GET", "/api/sessions/:id"],
    ["PUT", "/api/sessions/:id"],
    ["PUT", "/api/auth/logout"],
    ["PATCH", "/api/sessions/:id/prompt"],
  ] as const;

  const LOOKALIKES = [
    ["POST", "/api/sessions/"],
    ["PATCH", "/api/sessions/:id/"],
    ["PATCH", "/api/sessions/abc"],
    ["patch", "/api/sessions/:id"],
  ] as const;

  it.each(crossWithCodes(NON_OWNER_METHODS))(
    "非本身份方法 %s %s 上真实 %s -> generic 500",
    (method, url, code) => {
      const error = genuineCtpError(code);
      expectGeneric500(mapThrough(error, requestShaped(method, url)), error);
    },
  );

  it.each(crossWithCodes(LOOKALIKES))(
    "lookalike/raw-concrete/小写 %s %s 上真实 %s -> generic 500",
    (method, url, code) => {
      const error = genuineCtpError(code);
      expectGeneric500(mapThrough(error, requestShaped(method, url)), error);
    },
  );
});

describe("证据 4（守卫）：伪造错误打到新身份不映射", () => {
  const NEW_IDENTITIES = [
    ["POST", "/api/sessions"],
    ["PATCH", "/api/sessions/:id"],
  ] as const;

  it.each(crossWithCodes(NEW_IDENTITIES))(
    "伪造 %s %s 上的 %s -> generic 500",
    (method, url, code) => {
      const forged = forgedCtpError(code);
      expectGeneric500(mapThrough(forged, requestShaped(method, url)), forged);
    },
  );

  it("design 原样：Object.assign(new Error, INVALID_JSON_BODY/400) -> generic 500", () => {
    for (const [method, url] of NEW_IDENTITIES) {
      const forged = Object.assign(new Error("forged parser error"), {
        code: "FST_ERR_CTP_INVALID_JSON_BODY",
        statusCode: 400,
      });
      expectGeneric500(mapThrough(forged, requestShaped(method, url)), forged);
    }
  });
});

describe("证据 5（回归）：catch-all 与 unmatched 分流不变", () => {
  const FALLBACK_404 = [
    ["POST", "/api"],
    ["PATCH", "/api"],
    ["DELETE", "/api/*"],
    ["PATCH", "/api/*"],
    ["POST", "/api/*"],
  ] as const;

  it.each(crossWithCodes(FALLBACK_404))(
    "matched %s %s 上真实 %s -> typed not_found 404",
    (method, url, code) => {
      const error = genuineCtpError(code);
      expectNotFound(mapThrough(error, requestShaped(method, url)), error);
    },
  );

  it.each(crossWithCodes([["PATCH"], ["DELETE"], ["POST"]] as const))(
    "unmatched %s 上真实 %s -> typed not_found 404",
    (method, code) => {
      const error = genuineCtpError(code);
      const request = requestShaped(method, undefined, "/api/sessions/abc");
      expectNotFound(mapThrough(error, request), error);
    },
  );

  it.each(CTP_CODES)("unmatched GET 上真实 %s -> generic 500（现状）", (code) => {
    const error = genuineCtpError(code);
    expectGeneric500(mapThrough(error, requestShaped("GET", undefined)), error);
  });
});

describe("证据 6（守卫）：错误码表仍恰十四码", () => {
  it("HTTP_ERROR_MESSAGES 键集与 spec 码表相等", () => {
    expect(Object.keys(HTTP_ERROR_MESSAGES).sort()).toEqual([...FOURTEEN_CODES].sort());
  });
});
