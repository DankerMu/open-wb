import type { FastifyReply, FastifyRequest } from "fastify";
import fastify from "fastify";

const HTTP_ERROR_DEFINITIONS = Object.freeze({
  bad_request: Object.freeze({ statusCode: 400, message: "请求格式不正确" }),
  invalid_credentials: Object.freeze({ statusCode: 401, message: "账号或密码不正确" }),
  account_disabled: Object.freeze({ statusCode: 403, message: "该账号已停用，请联系管理员" }),
  unauthorized: Object.freeze({ statusCode: 401, message: "请先登录" }),
  not_found: Object.freeze({ statusCode: 404, message: "请求的资源不存在" }),
});

export type HttpErrorCode = keyof typeof HTTP_ERROR_DEFINITIONS;

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode) {
    super(HTTP_ERROR_DEFINITIONS[code].message);
    this.name = "HttpError";
    this.code = code;
  }
}

export function sendHttpError(reply: FastifyReply, code: HttpErrorCode): FastifyReply {
  const definition = HTTP_ERROR_DEFINITIONS[code];
  return reply.code(definition.statusCode).send({
    error: { code, message: definition.message },
  });
}

/**
 * bad_request 唯一入口 = 显式 HttpError("bad_request") 或 exact Fastify
 * content-parser error code allowlist。Login 无 route schema，因此
 * FST_ERR_VALIDATION 不在 allowlist（真实 validation error 是可伪造的普通
 * Error shape，无构造器身份）。分类不依赖 raw statusCode（body-limit 原始
 * 413 也归一为 400），不依赖 code 前缀；伪造 code/statusCode 的 programmer
 * error 保持 5xx。
 */
const ALLOWED_FASTIFY_REQUEST_ERROR_CODES = new Set([
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_BODY_TOO_LARGE",
]);

/** 受信 content-parser owner 的 exact auth 路由身份：POST login（#9）与 POST logout（#10）。 */
const CONTENT_PARSER_OWNED_ROUTES = new Set(["/api/auth/login", "/api/auth/logout"]);

/**
 * 构造函数-backed CTP 错误的 route-owner 结果：仅 matched identity 恰为
 * POST /api/auth/login 或 POST /api/auth/logout 时归一 exact 400；matched /api
 * 或 /api/* catch-all 与 unmatched non-GET（routeOptions.url undefined 且
 * method != GET）恢复 typed not_found 404；其他已注册 route 保持 generic 5xx。
 * 显式 typed HttpError 保持 route-independent。方法/URL 边界基于实际路由匹配，
 * 不做 raw URL/statusCode/code-prefix 分类。
 */
function routeOwnerResult(request: FastifyRequest, error: unknown): HttpErrorCode | null {
  if (!isConstructorBackedContentParserError(error)) {
    return null;
  }

  const routeUrl = request.routeOptions.url;
  if (
    request.method === "POST" &&
    routeUrl !== undefined &&
    CONTENT_PARSER_OWNED_ROUTES.has(routeUrl)
  ) {
    return "bad_request";
  }

  const isApiFallback = routeUrl === "/api" || routeUrl === "/api/*";
  const isUnmatchedNonGetPost = routeUrl === undefined && request.method !== "GET";
  if (isApiFallback || isUnmatchedNonGetPost) {
    return "not_found";
  }

  return null;
}

function isConstructorBackedContentParserError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown };
  if (
    typeof candidate.code !== "string" ||
    !ALLOWED_FASTIFY_REQUEST_ERROR_CODES.has(candidate.code)
  ) {
    return false;
  }

  const errorConstructor = fastify.errorCodes[
    candidate.code as keyof typeof fastify.errorCodes
  ] as unknown;
  return (
    typeof errorConstructor === "function" && error instanceof (errorConstructor as new () => Error)
  );
}

export function handleHttpError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof HttpError) {
    return sendHttpError(reply, error.code);
  }

  const ownerCode = routeOwnerResult(request, error);
  if (ownerCode !== null) {
    return sendHttpError(reply, ownerCode);
  }

  return reply.code(500).send({ error: { message: "服务器内部错误" } });
}
