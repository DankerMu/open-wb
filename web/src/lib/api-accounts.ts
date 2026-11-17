import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/**
 * 账号的 API 客户端（s2c-kb-visibility 组 12；account-groups「账号范围端点」）：`GET /api/accounts/me/scope`，
 * 调用者此刻的部门与项目组。严格解析：应答恰为 `{department, groups}`，组项恰为 `{id, name, memberCount}`，
 * `memberCount` 为正安全整数；不判非空串与次序（次序是服务端的契约）。
 */
export type MyScope = {
  department: string | null;
  groups: { id: string; name: string; memberCount: number }[];
};

type AccountTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
};

function parseGroup(value: unknown): MyScope["groups"][number] | null {
  if (!hasExactlyKeys(value, ["id", "name", "memberCount"])) {
    return null;
  }
  const { id, name, memberCount } = value;
  return typeof id === "string" &&
    typeof name === "string" &&
    isNonNegativeSafeInteger(memberCount) &&
    memberCount > 0
    ? { id, name, memberCount }
    : null;
}

function parseMyScope(value: unknown): MyScope | null {
  if (!hasExactlyKeys(value, ["department", "groups"])) {
    return null;
  }
  const { department } = value;
  if (department !== null && typeof department !== "string") {
    return null;
  }
  const groups = parseJsonArray(value.groups, parseGroup);
  return groups ? { department, groups } : null;
}

export function createAccountMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { request, getRequestOptions, requestFailed }: AccountTransport,
): Pick<ApiClient, "getMyScope"> {
  return {
    async getMyScope(options) {
      const response = await request(
        "/api/accounts/me/scope",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const scope = parseMyScope(response);
      if (!scope) {
        throw requestFailed(200);
      }
      return scope;
    },
  };
}
