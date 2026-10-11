import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

export type Workspace = {
  id: string;
  name: string;
  dir: string;
  root: string;
  createdAt: number;
};

export type WorkspaceList = {
  workspaces: Workspace[];
};

export type CreateWorkspaceInput = {
  name: string;
  dir?: string;
};

type WorkspaceTreeEntry = {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
};

export type WorkspaceTree = {
  path: string;
  entries: WorkspaceTreeEntry[];
};

export type CreateDirResult = {
  path: string;
};

/** Body of `POST …/move`. Both paths are data: sent as given, the server's sandbox decides. */
export type MoveEntryInput = {
  from: string;
  to: string;
};

export type FilePreview =
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

/**
 * What `POST …/preview-token` answers. `token` is the credential of the preview origin; as read
 * from the route's code (not exercised from here) `base` and `officeBase` contain it too.
 * `issuePreviewToken` only returns the value: the method body has no storage, address or log call.
 */
export type PreviewToken = {
  token: string;
  base: string;
  officeBase: string;
  expiresAt: number;
  documentMaxBytes: number;
  officeAvailable: boolean;
};

type PreviewKind = FilePreview["kind"];

type PreviewMetadata = {
  kind: PreviewKind;
  size: number;
  truncated: boolean;
};

/** Transport injected by `api.ts`; this module imports only types from it. */
type FileTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  requestOptions(signal?: AbortSignal): RequestInit;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
  fetchResponse(path: string, options: RequestInit): Promise<Response>;
  isSuccessfulStatus(status: number): boolean;
  parseJsonResponse(
    response: Response,
    signal: AbortSignal | undefined,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
  ): Promise<unknown>;
};

type WorkspaceEndpoint =
  | "tree"
  | "dirs"
  | "file"
  | "promote"
  | "download"
  | "preview-token"
  | "move";

/** Same-origin address of one endpoint of a workspace; the id is encoded as a single path segment. */
function workspaceEndpoint(workspaceId: string, endpoint: WorkspaceEndpoint): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}`;
}

/**
 * Address the browser reads a workspace file from (`GET …/file?path=`). Builds the string only, no
 * request. The path is data: encoded whole, never normalised — the server's sandbox decides.
 */
export function fileUrl(workspaceId: string, path: string): string {
  return `${workspaceEndpoint(workspaceId, "file")}?path=${encodeURIComponent(path)}`;
}

/** Address a browser navigation downloads a workspace file from (`GET …/download?path=`). */
export function downloadUrl(workspaceId: string, path: string): string {
  return `${workspaceEndpoint(workspaceId, "download")}?path=${encodeURIComponent(path)}`;
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

/** Exactly `{path}`; the answer of both `createDir` and `moveEntry`. */
function parseCreateDirResult(value: unknown): CreateDirResult | null {
  if (!hasExactlyKeys(value, ["path"]) || typeof value.path !== "string") {
    return null;
  }

  return { path: value.path };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Exactly the six keys of the contract. The client does not check the token's shape or that the two
 * bases are URLs containing it: that is the server's contract.
 */
function parsePreviewToken(value: unknown): PreviewToken | null {
  if (
    !hasExactlyKeys(value, [
      "token",
      "base",
      "officeBase",
      "expiresAt",
      "documentMaxBytes",
      "officeAvailable",
    ])
  ) {
    return null;
  }

  const { base, documentMaxBytes, expiresAt, officeAvailable, officeBase, token } = value;
  if (
    !isNonEmptyString(token) ||
    !isNonEmptyString(base) ||
    !isNonEmptyString(officeBase) ||
    !isNonNegativeSafeInteger(expiresAt) ||
    !isNonNegativeSafeInteger(documentMaxBytes) ||
    typeof officeAvailable !== "boolean"
  ) {
    return null;
  }

  return { token, base, officeBase, expiresAt, documentMaxBytes, officeAvailable };
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

  if (/^image\/(?:png|jpeg|gif|webp|bmp|x-icon)$/.test(contentType ?? "")) {
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

async function previewRequest(
  { fetchResponse, isSuccessfulStatus, parseJsonResponse, requestFailed }: FileTransport,
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

export function createFileMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  transport: FileTransport,
): Pick<
  ApiClient,
  | "listWorkspaces"
  | "createWorkspace"
  | "promoteWorkspace"
  | "listTree"
  | "createDir"
  | "fetchPreview"
  | "issuePreviewToken"
  | "moveEntry"
> {
  const { getRequestOptions, request, requestFailed, requestOptions } = transport;
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

    async promoteWorkspace(id, name, options) {
      const response = await request(
        workspaceEndpoint(id, "promote"),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
        onUnauthorized,
        200,
      );
      const workspace = parseWorkspace(response);
      if (!workspace) {
        throw requestFailed(200);
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
        transport,
        fileUrl(workspaceId, path),
        getRequestOptions(options?.signal),
        onUnauthorized,
      );
    },

    async issuePreviewToken(workspaceId, options) {
      // No body and no Content-Type. Read from the route's code, not exercised from here: it
      // answers 400 to any body.
      const response = await request(
        workspaceEndpoint(workspaceId, "preview-token"),
        { ...requestOptions(options?.signal), method: "POST" },
        onUnauthorized,
        200,
      );
      const issued = parsePreviewToken(response);
      if (!issued) {
        throw requestFailed(200);
      }

      return issued;
    },

    async moveEntry(workspaceId, input, options) {
      // Key by key, not `JSON.stringify(input)`. Read from the route's code, not exercised from
      // here: its body parser wants exactly `from` and `to` and answers 400 to a third key.
      // The answer is returned as the server gave it; `path` is not compared with `to`. A 200
      // with `{path}` does not prove the entry is at `to` (known residual of the route, see the
      // header of `server/src/workspaces/rest-entries.ts`): list the directory again afterwards.
      const response = await request(
        workspaceEndpoint(workspaceId, "move"),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: input.from, to: input.to }),
        },
        onUnauthorized,
        200,
      );
      const moved = parseCreateDirResult(response);
      if (!moved) {
        throw requestFailed(200);
      }

      return moved;
    },
  };
}
