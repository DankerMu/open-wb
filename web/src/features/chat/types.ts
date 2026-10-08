import type { ApiClient } from "../../lib/api.js";
import type { ChatMessageSnapshot, ChatSession } from "../../lib/session-contract.js";
import type { ChatState } from "./stream.js";

export type ChatListState =
  | { status: "loading"; client: ApiClient }
  | { status: "error"; client: ApiClient; message: string }
  | { status: "success"; client: ApiClient; sessions: ChatSession[] };

export type ChatHistoryState =
  | { status: "idle" }
  | { status: "loading"; client: ApiClient; sessionId: string }
  | { status: "error"; client: ApiClient; sessionId: string; message: string }
  | { status: "ready"; client: ApiClient; snapshot: ChatMessageSnapshot; view: ChatState };

export type PendingCreateSend = {
  /** The prompt was accepted: the handoff is settled, whatever the follow-up history read does. */
  accepted: boolean;
  client: ApiClient;
  generation: number;
  originSessionId: string | null;
  prompt: string;
  sessionId: string | null;
};

export type ChatMutationOwner = {
  client: ApiClient;
  originSessionId: string | null;
  sessionId: string | null;
};

/** 撤回的 200 里没有还原的文件（`files.skipped` / `files.failed`），属于写入它的账号与会话。 */
type UndoPathList = { count: number; paths: { path: string }[] };
export type ChatUndoNotice = {
  client: ApiClient;
  sessionId: string;
  skipped: UndoPathList;
  failed: UndoPathList;
};

export type ChatOwnedAlert = {
  client: ApiClient;
  sessionId: string | null;
  message: string;
};
