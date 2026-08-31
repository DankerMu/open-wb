import type { FastifyReply } from "fastify";

const HTTP_ERROR_DEFINITIONS = Object.freeze({
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

export function handleHttpError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof HttpError) {
    return sendHttpError(reply, error.code);
  }

  return reply.code(500).send({ error: { message: "服务器内部错误" } });
}
