import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { isStringArray } from "./api-experts.js";
import { hasExactlyKeys } from "./api-json.js";

/**
 * `GET` / `PUT /api/sessions/:id/capabilities` 的应答（design D7）：会话的有效专家（引用的专家已不可见时为
 * null）与停用技能名单。会话视图的十四键不含这两项，只经本端点读写。
 */
export type SessionCapabilities = {
  expertId: string | null;
  disabledSkills: string[];
};

/** `PUT …/capabilities` 的 body：两键的非空子集（`expertId: null` 即清除专家）。 */
export type SessionCapabilitiesPatch = {
  expertId?: string | null;
  disabledSkills?: string[];
};

type CapabilityTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  requestOptions(signal?: AbortSignal): RequestInit;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
};

function parseCapabilities(value: unknown): SessionCapabilities | null {
  if (!hasExactlyKeys(value, ["expertId", "disabledSkills"])) {
    return null;
  }
  const { expertId, disabledSkills } = value;
  if ((expertId !== null && typeof expertId !== "string") || !isStringArray(disabledSkills)) {
    return null;
  }
  return { expertId, disabledSkills };
}

function capabilitiesPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/capabilities`;
}

export function createSessionCapabilityMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { request, requestOptions, getRequestOptions, requestFailed }: CapabilityTransport,
): Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities"> {
  /** 一次 200 请求加严格解析（两个方法的应答同形）。 */
  async function capabilities(sessionId: string, init: RequestInit): Promise<SessionCapabilities> {
    const parsed = parseCapabilities(
      await request(capabilitiesPath(sessionId), init, onUnauthorized, 200),
    );
    if (!parsed) {
      throw requestFailed(200);
    }
    return parsed;
  }

  return {
    getSessionCapabilities(sessionId, options) {
      return capabilities(sessionId, getRequestOptions(options?.signal));
    },

    putSessionCapabilities(sessionId, patch, options) {
      return capabilities(sessionId, {
        ...requestOptions(options?.signal),
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
  };
}
