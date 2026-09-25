import type { ChatSession } from "../../lib/session-contract.js";
import type { ChatHistoryState } from "./types.js";

const TITLE_FALLBACK = "新会话";

export function sessionNavigation(
  pathname: string,
  search: string,
  hash: string,
  sessionId: string | null,
) {
  const parameters = new URLSearchParams(search);
  if (sessionId) {
    parameters.set("session", sessionId);
  } else {
    parameters.delete("session");
  }
  const nextSearch = parameters.toString();
  return { hash, pathname, search: nextSearch.length === 0 ? "" : `?${nextSearch}` };
}

export function sessionTitle(session: ChatSession) {
  return session.title && session.title.length > 0 ? session.title : TITLE_FALLBACK;
}

/**
 * 顶栏面包屑标题：列表项优先（服务端刷新标题的来源），本页持有的就绪快照兜底；
 * 无选中或尚未加载时为 undefined（不上报）。
 */
export function selectedSessionTitle(
  requestedSessionId: string | null,
  list: { sessions: ChatSession[] } | null,
  ownedHistory: boolean,
  historyState: ChatHistoryState,
): string | undefined {
  if (!requestedSessionId) return undefined;
  const selected =
    list?.sessions.find((session) => session.id === requestedSessionId) ??
    (ownedHistory && historyState.status === "ready" ? historyState.snapshot.session : undefined);
  return selected ? sessionTitle(selected) : undefined;
}
