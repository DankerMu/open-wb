/**
 * auth 域错误载体：只携带语义 code，不携带 HTTP 状态/文案（typed definition map
 * 归属 server/src/http）。auth 不 import server/src/http；http 层经
 * mapAuthError 把 AuthErrorCode 映射为 HttpError。
 */

export type AuthErrorCode =
  | "bad_request"
  | "invalid_credentials"
  | "account_disabled"
  | "unauthorized";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
    this.code = code;
  }
}
