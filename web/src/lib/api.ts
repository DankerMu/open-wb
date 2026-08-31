export type Principal = {
  id: string;
  account: string;
  role: string;
};

export type ServiceInfo = {
  name: string;
  version: string;
};

export type LoginCredentials = {
  account: string;
  password: string;
};

type ApiRequestOptions = {
  signal?: AbortSignal;
};

export type ApiClient = {
  getMe(options?: ApiRequestOptions): Promise<Principal>;
  getInfo(options?: ApiRequestOptions): Promise<ServiceInfo>;
  login(credentials: LoginCredentials, options?: ApiRequestOptions): Promise<Principal>;
  logout(options?: ApiRequestOptions): Promise<void>;
};

export type ApiClientOptions = {
  onUnauthorized?: (signal?: AbortSignal) => void | Promise<void>;
};

export const REQUEST_FAILED_MESSAGE = "请求失败，请稍后重试";
const REQUEST_FAILED_CODE = "request_failed";
const SERVICE_INFO_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

type ApiPath = "/api/auth/me" | "/api/auth/login" | "/api/auth/logout" | "/api/info";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isPlainJsonObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parsePrincipal(value: unknown): Principal | null {
  if (!hasExactlyKeys(value, ["id", "account", "role"])) {
    return null;
  }

  const { account, id, role } = value;
  if (typeof id !== "string" || typeof account !== "string" || typeof role !== "string") {
    return null;
  }

  return { id, account, role };
}

function parseServiceInfo(value: unknown): ServiceInfo | null {
  if (!hasExactlyKeys(value, ["name", "version"])) {
    return null;
  }

  const { name, version } = value;
  if (typeof name !== "string" || name.length === 0 || typeof version !== "string") {
    return null;
  }

  if (!SERVICE_INFO_VERSION.test(version)) {
    return null;
  }

  return { name, version };
}

function parseErrorEnvelope(value: unknown): ErrorEnvelope | null {
  if (!hasExactlyKeys(value, ["error"]) || !hasExactlyKeys(value.error, ["code", "message"])) {
    return null;
  }

  const { code, message } = value.error;
  if (typeof code !== "string" || typeof message !== "string") {
    return null;
  }

  return { error: { code, message } };
}

function requestFailed(status: number): ApiError {
  return new ApiError(status, REQUEST_FAILED_CODE, REQUEST_FAILED_MESSAGE);
}

function isSuccessfulStatus(status: number) {
  return status >= 200 && status < 300;
}

function requestOptions(signal?: AbortSignal): RequestInit {
  return {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  };
}

function getRequestOptions(signal?: AbortSignal): RequestInit {
  return {
    ...requestOptions(signal),
    method: "GET",
    cache: "no-store",
  };
}

function notifyUnauthorized(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  signal: AbortSignal | undefined,
) {
  try {
    void Promise.resolve(onUnauthorized?.(signal)).catch(() => undefined);
  } catch {
    // The response contract must remain stable if a consumer callback fails.
  }
}

async function fetchResponse(path: ApiPath, options: RequestInit): Promise<Response> {
  try {
    return await fetch(path, options);
  } catch {
    throw requestFailed(0);
  }
}

async function parseJsonResponse(
  response: Response,
  signal: AbortSignal | undefined,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 401) {
      notifyUnauthorized(onUnauthorized, signal);
    }

    throw requestFailed(response.status);
  }

  if (isSuccessfulStatus(response.status)) {
    return body;
  }

  const envelope = parseErrorEnvelope(body);
  if (!envelope) {
    if (response.status === 401) {
      notifyUnauthorized(onUnauthorized, signal);
    }

    throw requestFailed(response.status);
  }

  if (response.status === 401) {
    notifyUnauthorized(onUnauthorized, signal);
  }

  throw new ApiError(response.status, envelope.error.code, envelope.error.message);
}

async function request(
  path: ApiPath,
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<unknown> {
  const response = await fetchResponse(path, options);
  return parseJsonResponse(response, options.signal ?? undefined, onUnauthorized);
}

async function serviceInfoRequest(
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<unknown> {
  const response = await fetchResponse("/api/info", options);
  if (isSuccessfulStatus(response.status) && response.status !== 200) {
    throw requestFailed(response.status);
  }

  return parseJsonResponse(response, options.signal ?? undefined, onUnauthorized);
}

async function logoutRequest(
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<void> {
  const response = await fetchResponse("/api/auth/logout", options);
  if (response.status === 204) {
    return;
  }

  if (isSuccessfulStatus(response.status)) {
    throw requestFailed(response.status);
  }

  await parseJsonResponse(response, options.signal ?? undefined, onUnauthorized);
  throw requestFailed(response.status);
}

export function createApiClient({ onUnauthorized }: ApiClientOptions = {}): ApiClient {
  return {
    async getMe(options) {
      const response = await request(
        "/api/auth/me",
        getRequestOptions(options?.signal),
        onUnauthorized,
      );
      const principal = parsePrincipal(response);
      if (!principal) {
        throw requestFailed(200);
      }

      return principal;
    },

    async getInfo(options) {
      const response = await serviceInfoRequest(getRequestOptions(options?.signal), onUnauthorized);
      const serviceInfo = parseServiceInfo(response);
      if (!serviceInfo) {
        throw requestFailed(200);
      }

      return serviceInfo;
    },

    async login(credentials, options) {
      const response = await request(
        "/api/auth/login",
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: credentials.account, password: credentials.password }),
        },
        onUnauthorized,
      );
      const principal = parsePrincipal(response);
      if (!principal) {
        throw requestFailed(200);
      }

      return principal;
    },

    async logout(options) {
      await logoutRequest(
        {
          ...requestOptions(options?.signal),
          method: "POST",
        },
        onUnauthorized,
      );
    },
  };
}
