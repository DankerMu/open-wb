import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger, parseJsonArray } from "./api-json.js";

/**
 * One entry of the slash-command catalogue (`GET /api/commands`). A `project` entry is a skill of
 * the workspace's own `.omp/skills`; `overrides` is true when it replaces a platform skill of the
 * same name.
 */
export type Command = {
  name: string;
  label: string;
  description: string;
  hint: string | null;
  source: "builtin" | "skill" | "project";
  overrides: boolean;
};

/**
 * One entry of `GET /api/project-config`: a project configuration file that exists at a location
 * the assistant reads. `path` is relative to the directory `depth` levels above the session's
 * working directory (0 is that directory itself). Present, not necessarily in effect.
 */
export type ProjectConfigFile = {
  path: string;
  kind: "instructions" | "system" | "agent";
  depth: number;
};

type CommandTransport = {
  getRequestOptions(signal?: AbortSignal): RequestInit;
  request(
    path: string,
    options: RequestInit,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
    expectedStatus?: number,
  ): Promise<unknown>;
  requestFailed(status: number): ApiError;
};

function parseCommand(value: unknown): Command | null {
  if (!hasExactlyKeys(value, ["name", "label", "description", "hint", "source", "overrides"])) {
    return null;
  }

  const { name, label, description, hint, source, overrides } = value;
  if (typeof name !== "string" || typeof label !== "string" || typeof description !== "string") {
    return null;
  }
  if (hint !== null && typeof hint !== "string") {
    return null;
  }
  if (source !== "builtin" && source !== "skill" && source !== "project") {
    return null;
  }
  if (typeof overrides !== "boolean") {
    return null;
  }

  return { name, label, description, hint, source, overrides };
}

/** The body is exactly `{commands}`; one invalid element rejects the whole catalogue. */
function parseCommandList(value: unknown): Command[] | null {
  return hasExactlyKeys(value, ["commands"]) ? parseJsonArray(value.commands, parseCommand) : null;
}

function parseProjectConfigFile(value: unknown): ProjectConfigFile | null {
  if (!hasExactlyKeys(value, ["path", "kind", "depth"])) {
    return null;
  }

  const { path, kind, depth } = value;
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }
  if (kind !== "instructions" && kind !== "system" && kind !== "agent") {
    return null;
  }
  if (!isNonNegativeSafeInteger(depth)) {
    return null;
  }

  return { path, kind, depth };
}

/** The body is exactly `{files}`; one invalid element rejects the whole list. */
function parseProjectConfig(value: unknown): ProjectConfigFile[] | null {
  return hasExactlyKeys(value, ["files"])
    ? parseJsonArray(value.files, parseProjectConfigFile)
    : null;
}

/** `workspaceId` null is the account's own root: no query string at all. */
function workspacePath(path: string, workspaceId: string | null): string {
  return workspaceId === null ? path : `${path}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function createCommandMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { getRequestOptions, request, requestFailed }: CommandTransport,
): Pick<ApiClient, "listCommands" | "listProjectConfig"> {
  return {
    async listCommands(workspaceId, options) {
      const response = await request(
        workspacePath("/api/commands", workspaceId),
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const commands = parseCommandList(response);
      if (!commands) {
        throw requestFailed(200);
      }

      return commands;
    },

    async listProjectConfig(workspaceId, options) {
      const response = await request(
        workspacePath("/api/project-config", workspaceId),
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const files = parseProjectConfig(response);
      if (!files) {
        throw requestFailed(200);
      }

      return files;
    },
  };
}
