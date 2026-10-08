import type { FastifyReply, FastifyRequest } from "fastify";
import fastify from "fastify";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../core/errors/index.js";

const HTTP_ERROR_STATUSES = Object.freeze({
  bad_request: 400,
  invalid_credentials: 401,
  account_disabled: 403,
  unauthorized: 401,
  not_found: 404,
  session_busy: 409,
  agent_unavailable: 502,
  sandbox_denied: 403,
  conflict: 409,
  preview_too_large: 413,
  preview_unsupported: 415,
  agent_capacity: 503,
  approval_settled: 409,
  session_archived: 409,
  undo_conflict: 409,
  upload_too_large: 413,
} as const satisfies Record<HttpErrorCode, number>);

export function sendHttpError(reply: FastifyReply, code: HttpErrorCode): FastifyReply {
  return reply.code(HTTP_ERROR_STATUSES[code]).send({
    error: { code, message: HTTP_ERROR_MESSAGES[code] },
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

/** 受信 content-parser owner 的 exact 十五条 `<METHOD> <route template>` 身份：POST login（#9）、
 * POST logout（#10）、prompt、chat completions、两条工作空间、回合控制四条（#450）、会话
 * 元数据（#512）POST /api/sessions 与 PATCH /api/sessions/:id、临时空间转正（#927）
 * POST /api/workspaces/:id/promote、撤回（#948）POST /api/sessions/:id/undo，以及上传（#1013）
 * POST /api/workspaces/:id/uploads（模板不含查询串）。method 是身份的一部分：
 * DELETE /api/sessions/:id 与 PATCH 同模板但不在集合内。模板须与 Fastify 路由注册逐字一致，
 * method 按 Fastify 原样（大写）比较、不做大小写归一。 */
const CONTENT_PARSER_OWNED_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/sessions/:id/prompt",
  "POST /v1/chat/completions",
  "POST /api/workspaces",
  "POST /api/workspaces/:id/dirs",
  "POST /api/sessions/:id/stop",
  "POST /api/sessions/:id/regenerate",
  "POST /api/sessions/:id/fork",
  "POST /api/sessions/:id/approvals/:approvalId",
  "POST /api/sessions",
  "PATCH /api/sessions/:id",
  "POST /api/workspaces/:id/promote",
  "POST /api/sessions/:id/undo",
  "POST /api/workspaces/:id/uploads",
]);

/**
 * 构造函数-backed CTP 错误的 route-owner 结果：仅 `${method} ${route template}` 恰为
 * CONTENT_PARSER_OWNED_ROUTES 十五条之一时归一 exact 400（无单独的 POST 门；同模板的
 * 其他方法不被覆盖）；matched /api 或 /api/* catch-all 与 unmatched non-GET
 * （routeOptions.url undefined 且 method != GET）恢复 typed not_found 404；其他已注册
 * route 保持 generic 5xx。显式 typed HttpError 保持 route-independent。方法/URL 边界
 * 基于实际路由匹配，不做 raw URL/statusCode/code-prefix 分类。
 */
function routeOwnerResult(request: FastifyRequest, error: unknown): HttpErrorCode | null {
  if (!isConstructorBackedContentParserError(error)) {
    return null;
  }

  const routeUrl = request.routeOptions.url;
  if (routeUrl !== undefined && CONTENT_PARSER_OWNED_ROUTES.has(`${request.method} ${routeUrl}`)) {
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
