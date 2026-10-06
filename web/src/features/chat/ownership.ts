import type { ApiClient } from "../../lib/api.js";
import type {
  ChatHistoryState,
  ChatMutationOwner,
  ChatOwnedAlert,
  PendingCreateSend,
} from "./types.js";

export function ownsCreateSend(
  pending: PendingCreateSend | null,
  client: ApiClient,
  sessionId: string | null,
): pending is PendingCreateSend & { sessionId: string } {
  return (
    pending !== null &&
    pending.client === client &&
    pending.sessionId !== null &&
    pending.sessionId === sessionId
  );
}

/**
 * `新建会话` must not navigate while a welcome-state first send (create, then prompt) is still
 * unsettled: leaving would abort the prompt and strand a session with no messages. Settled once
 * the prompt is accepted; a rejection or an abandoned handoff clears the registration.
 */
export function blocksNewSession(
  pending: PendingCreateSend | null,
  client: ApiClient,
  sessionId: string | null,
): boolean {
  return (
    ownsCreateSend(pending, client, sessionId) &&
    pending.originSessionId === null &&
    !pending.accepted
  );
}

export function ownsHistory(
  state: ChatHistoryState,
  client: ApiClient,
  sessionId: string | null,
): boolean {
  if (sessionId === null || state.status === "idle" || state.client !== client) {
    return false;
  }
  if (state.status === "ready") {
    return state.snapshot.session.id === sessionId;
  }
  return state.sessionId === sessionId;
}

export function ownsMutation(
  owner: ChatMutationOwner | null,
  client: ApiClient,
  sessionId: string | null,
): boolean {
  return (
    owner !== null &&
    owner.client === client &&
    (owner.sessionId === sessionId || owner.originSessionId === sessionId)
  );
}

export function visibleOwnedAlert(
  alert: ChatOwnedAlert | null,
  client: ApiClient,
  sessionId: string | null,
): string | null {
  if (!alert || alert.client !== client || alert.sessionId !== sessionId) {
    return null;
  }
  return alert.message;
}
