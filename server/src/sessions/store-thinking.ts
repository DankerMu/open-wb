/**
 * Issue #519 bounded thinking append (thinking-fold): `chat_messages.thinking` keeps at most
 * 32768 Unicode code points of a message's merged thinking. The append that would cross the cap
 * stores the prefix filling it exactly (never splitting a surrogate pair) followed by the shared
 * truncation mark; every later append stores nothing. Each call returns exactly the text it
 * stored, which is what the supervisor then publishes, so the column always equals the
 * concatenation of the published `thinking.delta` fragments. #910 (slice 3b) adds the two writes
 * of `chat_messages.thinking_ms` (044) a thinking span makes (thinking-span.ts): NULL when a span
 * opens, the message's accumulated milliseconds when it closes.
 */
import type { DatabaseSync } from "node:sqlite";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { TRUNCATED_MARK } from "../core/upstream-failure.js";
import { decodeNullableText, requireChanges } from "./store-branch.js";

const MAX_THINKING_POINTS = 32_768;
const SELECT_THINKING = "SELECT CAST(thinking AS BLOB) AS thinking FROM chat_messages WHERE id = ?";
const APPEND_THINKING =
  "UPDATE chat_messages SET thinking = COALESCE(thinking, '') || ? WHERE id = ?";
const SET_THINKING_MS = "UPDATE chat_messages SET thinking_ms = ? WHERE id = ?";

export interface ThinkingMsStore {
  /** A span opens: the column reads NULL until it closes; throws off exactly one row. */
  clearThinkingMs(messageId: number): void;
  /** A span closes: the message's accumulated milliseconds; throws off exactly one row. */
  setThinkingMs(messageId: number, ms: number): void;
}

export function createThinkingMsStore(db: DatabaseSync): ThinkingMsStore {
  const write = (messageId: number, ms: number | null) => {
    requireChanges(db.prepare(SET_THINKING_MS).run(ms, messageId).changes, 1, "thinking duration");
  };
  return {
    clearThinkingMs(messageId) {
      write(messageId, null);
    },
    setThinkingMs(messageId, ms) {
      write(messageId, ms);
    },
  };
}

/** The stored fragment; "" (and no write) for an empty chunk or once the cap is reached. */
export function appendThinking(db: DatabaseSync, messageId: number, chunk: string): string {
  if (chunk.length === 0) {
    return "";
  }
  const row = db.prepare(SELECT_THINKING).get(messageId) as
    | { thinking: Uint8Array | null }
    | undefined;
  // A missing row reads as empty; the UPDATE below then fails its one-row receipt.
  const stored =
    row === undefined ? null : decodeNullableText(createSqliteTextDecoder(db), row.thinking);
  const used = stored === null ? 0 : [...stored].length;
  if (used > MAX_THINKING_POINTS) {
    return "";
  }
  const incoming = [...chunk];
  const fragment =
    used + incoming.length <= MAX_THINKING_POINTS
      ? chunk
      : incoming.slice(0, MAX_THINKING_POINTS - used).join("") + TRUNCATED_MARK;
  requireChanges(
    db.prepare(APPEND_THINKING).run(fragment, messageId).changes,
    1,
    "thinking append",
  );
  return fragment;
}
