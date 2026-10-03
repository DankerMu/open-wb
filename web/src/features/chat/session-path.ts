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
 * 当前会话：列表项优先（服务端刷新标题的来源），本页持有的就绪快照兜底；无选中或尚未加载时为
 * undefined。
 */
export function selectedSession(
  requestedSessionId: string | null,
  list: { sessions: ChatSession[] } | null,
  ownedHistory: boolean,
  historyState: ChatHistoryState,
): ChatSession | undefined {
  if (!requestedSessionId) return undefined;
  return (
    list?.sessions.find((session) => session.id === requestedSessionId) ??
    (ownedHistory && historyState.status === "ready" ? historyState.snapshot.session : undefined)
  );
}

/**
 * composer 所在的工作空间 id（斜杠候选目录按它取）：已选会话的工作空间，欢迎态为 footer 里选中的
 * 空间；没有空间为 null，请求了会话但还没解析出来时未知（undefined）。
 */
export function composerWorkspaceId(
  requestedSessionId: string | null,
  selected: ChatSession | undefined,
  chosen: { id: string } | null,
): string | null | undefined {
  return requestedSessionId ? selected?.workspaceId : (chosen?.id ?? null);
}

/** 顶栏面包屑标题：当前会话的显示标题；没有当前会话时为 undefined（不上报）。 */
export function selectedSessionTitle(
  requestedSessionId: string | null,
  list: { sessions: ChatSession[] } | null,
  ownedHistory: boolean,
  historyState: ChatHistoryState,
): string | undefined {
  const selected = selectedSession(requestedSessionId, list, ownedHistory, historyState);
  return selected ? sessionTitle(selected) : undefined;
}
