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

/**
 * 一次 prompt 派发此刻是否仍归本页所有（六项）：页面仍挂载、这次派发没有被中止、没有被另一次派发取代、
 * 它的首次发送登记还在、账号没有变、当前请求的会话仍是它的会话。prompt 落定、其后的快照落定、暂存文件
 * 上传落定三处共用；不成立时既不发请求也不改界面。`owner` 是派发时记下的，`page` 是此刻读到的。
 */
export function ownsDispatch(
  owner: {
    client: ApiClient;
    controller: AbortController;
    createSendGeneration: number;
    mutationGeneration: number;
    sessionId: string;
  },
  page: {
    client: ApiClient;
    mounted: boolean;
    mutationGeneration: number;
    pending: PendingCreateSend | null;
    requestedSessionId: string | null;
  },
): boolean {
  return (
    page.mounted &&
    !owner.controller.signal.aborted &&
    owner.mutationGeneration === page.mutationGeneration &&
    page.pending?.generation === owner.createSendGeneration &&
    owner.client === page.client &&
    page.requestedSessionId === owner.sessionId
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
