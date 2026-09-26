import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import {
  parseMessageSnapshot,
  parsePromptAccepted,
  parseSession,
  parseSessionList,
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
};

function sessionEndpoint(sessionId: string, endpoint: "messages" | "prompt") {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${endpoint}`;
}

export function createSessionMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { getRequestOptions, request, requestFailed, requestOptions }: SessionTransport,
): Pick<ApiClient, "listSessions" | "createSession" | "getMessages" | "prompt"> {
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
  };
}
