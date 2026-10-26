/**
 * The mounts of a workspace (workspace-mounts「挂载端点」「挂载源端点」, design D18): the strict
 * parsers of `MountView` and `SourceView`, and the calls the files area makes — list, create and
 * unmount mounts, list the sources (the mount dialog's `服务器目录`) — plus the administrator's two
 * writes of a source (the center `挂载源` tab: register, delete).
 *
 * Parsing is key set and type only: a view with any key more or less is a parse failure, so is a
 * value of the wrong type. Which fields are null for which backend (`local` has no host, the remote
 * ones no source) is the server's contract and not cross-checked here.
 */
import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/** One mount as `GET …/mounts` lists it: exactly eleven keys, no credential among them. */
export type MountView = {
  id: string;
  name: string;
  backend: "sftp" | "smb" | "local";
  host: string | null;
  port: number | null;
  remotePath: string | null;
  sourceId: string | null;
  sourceName: string | null;
  readOnly: boolean;
  status: "online" | "offline";
  createdAt: number;
};

/** `GET /api/workspaces/:id/mounts`: `enabled` is whether the server has `RCLONE_BIN`. */
export type MountList = {
  enabled: boolean;
  mounts: MountView[];
};

/**
 * `POST …/mounts` body: the keys of one backend only (`server/src/workspaces/mounts/validate.ts`).
 * An empty optional `port` / `domain` is no key at all — the server takes no `null` for them.
 */
type RemoteMountInput = {
  name: string;
  host: string;
  port?: number;
  remotePath: string;
  readOnly: boolean;
  username: string;
};
export type CreateMountInput =
  | (RemoteMountInput & { backend: "sftp"; password: string })
  | (RemoteMountInput & { backend: "sftp"; privateKey: string })
  | (RemoteMountInput & { backend: "smb"; password: string; domain?: string })
  | { name: string; backend: "local"; sourceId: string; readOnly: boolean };

/** A source as an administrator sees it (the row) and as anyone else does (three keys). */
export type MountSourceRow = {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
  createdAt: number;
};
type UserSourceView = { id: string; name: string; readOnly: boolean };

/** `GET /api/mount-sources`: every item of one answer has the same one of the two key sets. */
export type MountSourceList =
  | { view: "admin"; sources: MountSourceRow[] }
  | { view: "user"; sources: UserSourceView[] };

/** `POST /api/mount-sources` body: exactly these three keys (`validateMountSourceBody`). */
export type CreateMountSourceInput = { name: string; path: string; readOnly: boolean };

const MOUNT_KEYS = [
  "id",
  "name",
  "backend",
  "host",
  "port",
  "remotePath",
  "sourceId",
  "sourceName",
  "readOnly",
  "status",
  "createdAt",
] as const;

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function isPort(value: unknown): value is number | null {
  return (
    value === null || (Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65535)
  );
}

function parseMountView(value: unknown): MountView | null {
  if (!hasExactlyKeys(value, MOUNT_KEYS)) {
    return null;
  }

  const {
    backend,
    createdAt,
    host,
    id,
    name,
    port,
    readOnly,
    remotePath,
    sourceId,
    sourceName,
    status,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    (backend !== "sftp" && backend !== "smb" && backend !== "local") ||
    !nullableString(host) ||
    !isPort(port) ||
    !nullableString(remotePath) ||
    !nullableString(sourceId) ||
    !nullableString(sourceName) ||
    typeof readOnly !== "boolean" ||
    (status !== "online" && status !== "offline") ||
    !isNonNegativeSafeInteger(createdAt)
  ) {
    return null;
  }

  return {
    id,
    name,
    backend,
    host,
    port,
    remotePath,
    sourceId,
    sourceName,
    readOnly,
    status,
    createdAt,
  };
}

function parseMountList(value: unknown): MountList | null {
  if (!hasExactlyKeys(value, ["enabled", "mounts"]) || typeof value.enabled !== "boolean") {
    return null;
  }

  const mounts = parseJsonArray(value.mounts, parseMountView);
  return mounts ? { enabled: value.enabled, mounts } : null;
}

function parseAdminSource(value: unknown): MountSourceRow | null {
  if (!hasExactlyKeys(value, ["id", "name", "path", "readOnly", "createdAt"])) {
    return null;
  }

  const { createdAt, id, name, path, readOnly } = value;
  return typeof id === "string" &&
    typeof name === "string" &&
    typeof path === "string" &&
    typeof readOnly === "boolean" &&
    isNonNegativeSafeInteger(createdAt)
    ? { id, name, path, readOnly, createdAt }
    : null;
}

function parseUserSource(value: unknown): UserSourceView | null {
  if (!hasExactlyKeys(value, ["id", "name", "readOnly"])) {
    return null;
  }

  const { id, name, readOnly } = value;
  return typeof id === "string" && typeof name === "string" && typeof readOnly === "boolean"
    ? { id, name, readOnly }
    : null;
}

/**
 * The answer of `GET /api/mount-sources`, or `null`. The whole list is read with one of the two
 * views, so an answer mixing them fails both. An empty list is the user view (nothing tells them
 * apart).
 */
export function parseMountSources(value: unknown): MountSourceList | null {
  if (!hasExactlyKeys(value, ["sources"]) || !Array.isArray(value.sources)) {
    return null;
  }

  const user = parseJsonArray(value.sources, parseUserSource);
  if (user) {
    return { view: "user", sources: user };
  }
  const admin = parseJsonArray(value.sources, parseAdminSource);
  return admin ? { view: "admin", sources: admin } : null;
}

type MountTransport = {
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  requestOptions(signal?: AbortSignal): RequestInit;
  getRequestOptions(signal?: AbortSignal): RequestInit;
  requestFailed(status: number): ApiError;
  noContentRequest(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
  ): Promise<void>;
};

/** `…/mounts` of a workspace, and `…/mounts/<id>`: both ids are encoded as one path segment each. */
function mountsPath(workspaceId: string, mountId?: string): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/mounts`;
  return mountId === undefined ? base : `${base}/${encodeURIComponent(mountId)}`;
}

export function createMountMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { getRequestOptions, noContentRequest, request, requestFailed, requestOptions }: MountTransport,
): Pick<
  ApiClient,
  | "listMounts"
  | "createMount"
  | "deleteMount"
  | "listMountSources"
  | "createMountSource"
  | "deleteMountSource"
> {
  return {
    async listMounts(workspaceId, options) {
      const response = await request(
        mountsPath(workspaceId),
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const list = parseMountList(response);
      if (!list) {
        throw requestFailed(200);
      }

      return list;
    },

    async createMount(workspaceId, input, options) {
      // 201 is the only success; its body is the new mount's view.
      const response = await request(
        mountsPath(workspaceId),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        onUnauthorized,
        201,
      );
      const view = parseMountView(response);
      if (!view) {
        throw requestFailed(201);
      }

      return view;
    },

    async deleteMount(workspaceId, mountId, options) {
      // No body: the route does not read one. 204 is the only success.
      await noContentRequest(
        mountsPath(workspaceId, mountId),
        { ...requestOptions(options?.signal), method: "DELETE" },
        onUnauthorized,
      );
    },

    async listMountSources(options) {
      const response = await request(
        "/api/mount-sources",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const list = parseMountSources(response);
      if (!list) {
        throw requestFailed(200);
      }

      return list;
    },

    async createMountSource(input, options) {
      // 201 is the only success; its body is the new source's administrator row.
      const response = await request(
        "/api/mount-sources",
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: input.name, path: input.path, readOnly: input.readOnly }),
        },
        onUnauthorized,
        201,
      );
      const row = parseAdminSource(response);
      if (!row) {
        throw requestFailed(201);
      }

      return row;
    },

    async deleteMountSource(sourceId, options) {
      // No body; 204 is the only success. The server unmounts every mount on the source first.
      await noContentRequest(
        `/api/mount-sources/${encodeURIComponent(sourceId)}`,
        { ...requestOptions(options?.signal), method: "DELETE" },
        onUnauthorized,
      );
    },
  };
}
