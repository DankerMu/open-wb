import type { ChatSession } from "../../lib/session-contract.js";

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
