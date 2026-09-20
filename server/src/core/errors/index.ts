/**
 * Canonical application errors: codes, messages, and HttpError identity.
 * HTTP statuses, content-parser ownership, and reply mapping remain in http/.
 */
export const HTTP_ERROR_MESSAGES = Object.freeze({
  bad_request: "请求格式不正确",
  invalid_credentials: "账号或密码不正确",
  account_disabled: "该账号已停用，请联系管理员",
  unauthorized: "请先登录",
  not_found: "请求的资源不存在",
  session_busy: "会话正在生成，请稍候",
  agent_unavailable: "Agent 运行时不可用",
});

export type HttpErrorCode = keyof typeof HTTP_ERROR_MESSAGES;

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode) {
    super(HTTP_ERROR_MESSAGES[code]);
    this.name = "HttpError";
    this.code = code;
  }
}
