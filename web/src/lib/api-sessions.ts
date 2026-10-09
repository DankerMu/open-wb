import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { parseComposerOptions } from "./composer-contract.js";
import {
  isStopAccepted,
  parseMessageSnapshot,
  parsePromptAccepted,
  parseRegenerateAccepted,
  parseSession,
  parseSessionFork,
  parseSessionList,
  parseSessionUndo,
  parseSettledApproval,
} from "./session-contract.js";

type SessionTransport = {
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

type SessionEndpoint = "messages" | "prompt" | "stop" | "regenerate" | "fork" | "undo";

function sessionPath(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

function sessionEndpoint(sessionId: string, endpoint: SessionEndpoint) {
  return `${sessionPath(sessionId)}/${endpoint}`;
}

/** `undefined` or an input with no own keys sends no body, exactly like the bodyless create. */
function createSessionBody(input: object | undefined): RequestInit {
  if (input === undefined || Object.keys(input).length === 0) {
    return {};
  }

  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) };
}

function approvalEndpoint(sessionId: string, approvalId: number) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(String(approvalId))}`;
}

export function createSessionMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  {
    fetchResponse,
    getRequestOptions,
    isSuccessfulStatus,
    parseJsonResponse,
    request,
    requestFailed,
    requestOptions,
  }: SessionTransport,
): Pick<
  ApiClient,
  | "listSessions"
  | "createSession"
  | "patchSession"
  | "deleteSession"
  | "getMessages"
  | "prompt"
  | "stopSession"
  | "regenerateSession"
  | "forkSession"
  | "undoMessage"
  | "decideApproval"
  | "getComposerOptions"
> {
  return {
    async listSessions(options) {
      const response = await request(
        "/api/sessions",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const sessions = parseSessionList(response);
      if (!sessions) {
        throw requestFailed(200);
      }

      return sessions;
    },

    async createSession(input, options) {
      const response = await request(
        "/api/sessions",
        {
          ...requestOptions(options?.signal),
          method: "POST",
          ...createSessionBody(input),
        },
        onUnauthorized,
        201,
      );
      const session = parseSession(response);
      if (!session) {
        throw requestFailed(201);
      }

      return session;
    },

    async patchSession(sessionId, patch, options) {
      if (Object.keys(patch).length === 0) {
        throw new TypeError("patchSession requires at least one field");
      }

      const response = await request(
        sessionPath(sessionId),
        {
          ...requestOptions(options?.signal),
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
        onUnauthorized,
        200,
      );
      const session = parseSession(response);
      if (!session) {
        throw requestFailed(200);
      }

      return session;
    },

    async deleteSession(sessionId, options) {
      const init: RequestInit = { ...requestOptions(options?.signal), method: "DELETE" };
      const response = await fetchResponse(sessionPath(sessionId), init);
      if (response.status === 204) {
        return;
      }

      if (isSuccessfulStatus(response.status)) {
        throw requestFailed(response.status);
      }

      await parseJsonResponse(response, options?.signal, onUnauthorized);
      throw requestFailed(response.status);
    },

    async getMessages(sessionId, options) {
      const response = await request(
        sessionEndpoint(sessionId, "messages"),
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const snapshot = parseMessageSnapshot(response);
      if (!snapshot) {
        throw requestFailed(200);
      }

      return snapshot;
    },

    async prompt(sessionId, message, options) {
      const response = await request(
        sessionEndpoint(sessionId, "prompt"),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
          }),
        },
        onUnauthorized,
        202,
      );
      const accepted = parsePromptAccepted(response);
      if (!accepted) {
        throw requestFailed(202);
      }

      return accepted;
    },

    async stopSession(sessionId, options) {
      const init: RequestInit = { ...requestOptions(options?.signal), method: "POST" };
      const response = await fetchResponse(sessionEndpoint(sessionId, "stop"), init);
      if (response.status === 204) {
        return "idle";
      }

      if (isSuccessfulStatus(response.status) && response.status !== 202) {
        throw requestFailed(response.status);
      }

      const body = await parseJsonResponse(response, options?.signal, onUnauthorized);
      if (!isStopAccepted(body)) {
        throw requestFailed(202);
      }

      return "stopping";
    },

    async regenerateSession(sessionId, options) {
      const response = await request(
        sessionEndpoint(sessionId, "regenerate"),
        { ...requestOptions(options?.signal), method: "POST" },
        onUnauthorized,
        202,
      );
      const accepted = parseRegenerateAccepted(response);
      if (!accepted) {
        throw requestFailed(202);
      }

      return accepted;
    },

    async forkSession(sessionId, messageId, options) {
      const response = await request(
        sessionEndpoint(sessionId, "fork"),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId }),
        },
        onUnauthorized,
        201,
      );
      const fork = parseSessionFork(response);
      if (!fork) {
        throw requestFailed(201);
      }

      return fork;
    },

    async undoMessage(sessionId, messageId, files, options) {
      const response = await request(
        sessionEndpoint(sessionId, "undo"),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId, files }),
        },
        onUnauthorized,
        200,
      );
      const undo = parseSessionUndo(response);
      if (!undo) {
        throw requestFailed(200);
      }

      return undo;
    },

    async decideApproval(sessionId, approvalId, decision, options) {
      const response = await request(
        approvalEndpoint(sessionId, approvalId),
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
        onUnauthorized,
        200,
      );
      const approval = parseSettledApproval(response);
      if (!approval) {
        throw requestFailed(200);
      }

      return approval;
    },

    async getComposerOptions(options) {
      const response = await request(
        "/api/composer/options",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const composerOptions = parseComposerOptions(response);
      if (!composerOptions) {
        throw requestFailed(200);
      }

      return composerOptions;
    },
  };
}
