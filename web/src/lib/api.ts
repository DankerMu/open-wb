export type Principal = {
  id: string;
  account: string;
  role: string;
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
  login(credentials: LoginCredentials, options?: ApiRequestOptions): Promise<Principal>;
};

export type ApiClientOptions = {
  onUnauthorized?: (signal?: AbortSignal) => void | Promise<void>;
};

export const REQUEST_FAILED_MESSAGE = "请求失败，请稍后重试";
const REQUEST_FAILED_CODE = "request_failed";

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

function requestOptions(signal?: AbortSignal): RequestInit {
  return {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  };
}

function meRequestOptions(signal?: AbortSignal): RequestInit {
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

async function request(
  path: "/api/auth/me" | "/api/auth/login",
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(path, options);
  } catch {
    throw requestFailed(0);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 401) {
      notifyUnauthorized(onUnauthorized, options.signal ?? undefined);
    }

    throw requestFailed(response.status);
  }

  if (response.ok) {
    return body;
  }

  const envelope = parseErrorEnvelope(body);
  if (!envelope) {
    if (response.status === 401) {
      notifyUnauthorized(onUnauthorized, options.signal ?? undefined);
    }

    throw requestFailed(response.status);
  }

  if (response.status === 401) {
    notifyUnauthorized(onUnauthorized, options.signal ?? undefined);
  }

  throw new ApiError(response.status, envelope.error.code, envelope.error.message);
}

export function createApiClient({ onUnauthorized }: ApiClientOptions = {}): ApiClient {
  return {
    async getMe(options) {
      const response = await request(
        "/api/auth/me",
        meRequestOptions(options?.signal),
        onUnauthorized,
      );
      const principal = parsePrincipal(response);
      if (!principal) {
        throw requestFailed(200);
      }

      return principal;
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
  };
}
