import { ApiError, REQUEST_FAILED_MESSAGE } from "../../lib/api.js";

export function isUnauthorized(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

export function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE;
}
