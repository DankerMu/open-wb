import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import {
  isStopAccepted,
  parseMessageSnapshot,
  parsePromptAccepted,
  parseRegenerateAccepted,
  parseSession,
  parseSessionFork,
  parseSessionList,
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

type SessionEndpoint = "messages" | "prompt" | "stop" | "regenerate" | "fork";

function sessionEndpoint(sessionId: string, endpoint: SessionEndpoint) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${endpoint}`;
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
  | "getMessages"
  | "prompt"
  | "stopSession"
  | "regenerateSession"
  | "forkSession"
  | "decideApproval"
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

    async createSession(options) {
      const response = await request(
        "/api/sessions",
        {
          ...requestOptions(options?.signal),
          method: "POST",
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
          body: JSON.stringify({ message }),
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
  };
}
