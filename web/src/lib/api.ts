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

type Workspace = {
  id: string;
  name: string;
  dir: string;
  root: string;
  createdAt: number;
};

type WorkspaceList = {
  workspaces: Workspace[];
};

type CreateWorkspaceInput = {
  name: string;
  dir?: string;
};

type WorkspaceTreeEntry = {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
};

type WorkspaceTree = {
  path: string;
  entries: WorkspaceTreeEntry[];
};

type CreateDirResult = {
  path: string;
};

type FilePreview =
  | {
      kind: "text";
      text: string;
      size: number;
      truncated: boolean;
    }
  | {
      kind: "image";
      /** Caller-owned Blob URL; revoke it on replacement or unmount. */
      url: string;
      size: number;
      truncated: boolean;
    };

type AuditEvent = {
  id: number;
  ts: number;
  actorId: string;
  kind: string;
  title: string;
  detail: Record<string, unknown>;
  workspaceId: string | null;
};

type AuditList = {
  events: AuditEvent[];
};

type AuditFilter = {
  limit?: number;
  before?: string;
};

type PreviewKind = FilePreview["kind"];

type PreviewMetadata = {
  kind: PreviewKind;
  size: number;
  truncated: boolean;
};

type ApiRequestOptions = {
  signal?: AbortSignal;
};

export type ApiClient = {
  getMe(options?: ApiRequestOptions): Promise<Principal>;
  getInfo(options?: ApiRequestOptions): Promise<ServiceInfo>;
  login(credentials: LoginCredentials, options?: ApiRequestOptions): Promise<Principal>;
  logout(options?: ApiRequestOptions): Promise<void>;
  listWorkspaces(options?: ApiRequestOptions): Promise<WorkspaceList>;
  createWorkspace(input: CreateWorkspaceInput, options?: ApiRequestOptions): Promise<Workspace>;
  listTree(workspaceId: string, path: string, options?: ApiRequestOptions): Promise<WorkspaceTree>;
  createDir(
    workspaceId: string,
    path: string,
    options?: ApiRequestOptions,
  ): Promise<CreateDirResult>;
  fetchPreview(
    workspaceId: string,
    path: string,
    options?: ApiRequestOptions,
  ): Promise<FilePreview>;
  listAudit(filter?: AuditFilter, options?: ApiRequestOptions): Promise<AuditList>;
};

export type ApiClientOptions = {
  onUnauthorized?: (signal?: AbortSignal) => void | Promise<void>;
};

export const REQUEST_FAILED_MESSAGE = "请求失败，请稍后重试";
const REQUEST_FAILED_CODE = "request_failed";
const SERVICE_INFO_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseWorkspace(value: unknown): Workspace | null {
  if (!hasExactlyKeys(value, ["id", "name", "dir", "root", "createdAt"])) {
    return null;
  }

  const { createdAt, dir, id, name, root } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof dir !== "string" ||
    typeof root !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt)
  ) {
    return null;
  }

  return { id, name, dir, root, createdAt };
}

function parseJsonArray<T>(value: unknown, parseItem: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const items: T[] = [];
  for (const item of value) {
    const parsedItem = parseItem(item);
    if (!parsedItem) {
      return null;
    }

    items.push(parsedItem);
  }

  return items;
}

function parseWorkspaceList(value: unknown): WorkspaceList | null {
  if (!hasExactlyKeys(value, ["workspaces"])) {
    return null;
  }

  const workspaces = parseJsonArray(value.workspaces, parseWorkspace);
  return workspaces ? { workspaces } : null;
}

function parseWorkspaceTreeEntry(value: unknown): WorkspaceTreeEntry | null {
  if (!hasExactlyKeys(value, ["name", "type", "size", "mtime"])) {
    return null;
  }

  const { mtime, name, size, type } = value;
  if (
    typeof name !== "string" ||
    (type !== "dir" && type !== "file") ||
    !isNonNegativeSafeInteger(size) ||
    typeof mtime !== "number" ||
    !Number.isFinite(mtime)
  ) {
    return null;
  }

  return { name, type, size, mtime };
}

function parseWorkspaceTree(value: unknown): WorkspaceTree | null {
  if (!hasExactlyKeys(value, ["path", "entries"]) || typeof value.path !== "string") {
    return null;
  }

  const entries = parseJsonArray(value.entries, parseWorkspaceTreeEntry);
  return entries ? { path: value.path, entries } : null;
}

function parseCreateDirResult(value: unknown): CreateDirResult | null {
  if (!hasExactlyKeys(value, ["path"]) || typeof value.path !== "string") {
    return null;
  }

  return { path: value.path };
}

function parseAuditEvent(value: unknown): AuditEvent | null {
  if (!hasExactlyKeys(value, ["id", "ts", "actorId", "kind", "title", "detail", "workspaceId"])) {
    return null;
  }

  const { actorId, detail, id, kind, title, ts, workspaceId } = value;
  if (
    !isNonNegativeSafeInteger(id) ||
    id === 0 ||
    !isNonNegativeSafeInteger(ts) ||
    typeof actorId !== "string" ||
    typeof kind !== "string" ||
    typeof title !== "string" ||
    !isPlainJsonObject(detail) ||
    (workspaceId !== null && typeof workspaceId !== "string")
  ) {
    return null;
  }

  return { id, ts, actorId, kind, title, detail, workspaceId };
}

function parseAuditList(value: unknown): AuditList | null {
  if (!hasExactlyKeys(value, ["events"])) {
    return null;
  }

  const events = parseJsonArray(value.events, parseAuditEvent);
  return events ? { events } : null;
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

function workspaceEndpoint(workspaceId: string, endpoint: "tree" | "dirs" | "file") {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}`;
}

function parsePreviewSize(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const size = Number(value);
  return isNonNegativeSafeInteger(size) ? size : null;
}

function parsePreviewKind(value: string | null): PreviewKind | null {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "text/plain") {
    return "text";
  }

  if (contentType === "image/png" || contentType === "image/jpeg") {
    return "image";
  }

  return null;
}

function parsePreviewMetadata(response: Response): PreviewMetadata | null {
  const kind = parsePreviewKind(response.headers.get("Content-Type"));
  const size = parsePreviewSize(response.headers.get("X-Workbuddy-Size"));
  if (!kind || size === null) {
    return null;
  }

  return {
    kind,
    size,
    truncated: response.headers.get("X-Workbuddy-Truncated") === "1",
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

async function previewRequest(
  path: string,
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<FilePreview> {
  const response = await fetchResponse(path, options);
  if (response.status !== 200) {
    if (isSuccessfulStatus(response.status)) {
      throw requestFailed(response.status);
    }

    await parseJsonResponse(response, options.signal ?? undefined, onUnauthorized);
    throw requestFailed(response.status);
  }

  const metadata = parsePreviewMetadata(response);
  if (!metadata) {
    throw requestFailed(response.status);
  }

  try {
    if (metadata.kind === "text") {
      return {
        kind: "text",
        text: await response.text(),
        size: metadata.size,
        truncated: metadata.truncated,
      };
    }

    return {
      kind: "image",
      url: URL.createObjectURL(await response.blob()),
      size: metadata.size,
      truncated: metadata.truncated,
    };
  } catch {
    throw requestFailed(response.status);
  }
}

async function fetchResponse(path: string, options: RequestInit): Promise<Response> {
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
  path: string,
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  expectedStatus?: number,
): Promise<unknown> {
  const response = await fetchResponse(path, options);
  if (
    expectedStatus !== undefined &&
    isSuccessfulStatus(response.status) &&
    response.status !== expectedStatus
  ) {
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
    async listWorkspaces(options) {
      const response = await request(
        "/api/workspaces",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const workspaces = parseWorkspaceList(response);
      if (!workspaces) {
        throw requestFailed(200);
      }

      return workspaces;
    },

    async createWorkspace(input, options) {
      const response = await request(
        "/api/workspaces",
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            ...(input.dir === undefined ? {} : { dir: input.dir }),
          }),
        },
        onUnauthorized,
        201,
      );
      const workspace = parseWorkspace(response);
      if (!workspace) {
        throw requestFailed(201);
      }

      return workspace;
    },

    async listTree(workspaceId, path, options) {
      const response = await request(
        `${workspaceEndpoint(workspaceId, "tree")}?path=${encodeURIComponent(path)}`,
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const tree = parseWorkspaceTree(response);
      if (!tree) {
        throw requestFailed(200);
      }

      return tree;
    },

    async createDir(workspaceId, path, options) {
      const response = await request(
        workspaceEndpoint(workspaceId, "dirs"),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        },
        onUnauthorized,
        201,
      );
      const directory = parseCreateDirResult(response);
      if (!directory) {
        throw requestFailed(201);
      }

      return directory;
    },

    async fetchPreview(workspaceId, path, options) {
      return previewRequest(
        `${workspaceEndpoint(workspaceId, "file")}?path=${encodeURIComponent(path)}`,
        getRequestOptions(options?.signal),
        onUnauthorized,
      );
    },

    async listAudit(filter, options) {
      const search = new URLSearchParams();
      if (filter?.limit !== undefined) {
        search.set("limit", String(filter.limit));
      }
      if (filter?.before !== undefined) {
        search.set("before", filter.before);
      }

      const query = search.toString();
      const response = await request(
        query.length === 0 ? "/api/audit" : `/api/audit?${query}`,
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const audit = parseAuditList(response);
      if (!audit) {
        throw requestFailed(200);
      }

      return audit;
    },

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
      const response = await request(
        "/api/info",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
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
