import { ApiError, REQUEST_FAILED_MESSAGE } from "../../lib/api.js";

export function isUnauthorized(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

/** 服务端答了 404（路径解析不到文件或目录）；网络失败与别的状态码不是。 */
export function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}
