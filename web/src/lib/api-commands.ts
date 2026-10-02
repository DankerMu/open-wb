import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, parseJsonArray } from "./api-json.js";

/** One entry of the slash-command catalogue (`GET /api/commands`). */
export type Command = {
  name: string;
  label: string;
  description: string;
  hint: string | null;
  source: "builtin" | "skill";
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
  if (!hasExactlyKeys(value, ["name", "label", "description", "hint", "source"])) {
    return null;
  }

  const { name, label, description, hint, source } = value;
  if (typeof name !== "string" || typeof label !== "string" || typeof description !== "string") {
    return null;
  }
  if (hint !== null && typeof hint !== "string") {
    return null;
  }
  if (source !== "builtin" && source !== "skill") {
    return null;
  }

  return { name, label, description, hint, source };
}

/** The body is exactly `{commands}`; one invalid element rejects the whole catalogue. */
function parseCommandList(value: unknown): Command[] | null {
  return hasExactlyKeys(value, ["commands"]) ? parseJsonArray(value.commands, parseCommand) : null;
}

export function createCommandMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { getRequestOptions, request, requestFailed }: CommandTransport,
): Pick<ApiClient, "listCommands"> {
  return {
    async listCommands(options) {
      const response = await request(
        "/api/commands",
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
  };
}
