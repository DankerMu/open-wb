/**
 * Issue #519 bounded thinking append (thinking-fold): `chat_messages.thinking` keeps at most
 * 32768 Unicode code points of a message's merged thinking. The append that would cross the cap
 * stores the prefix filling it exactly (never splitting a surrogate pair) followed by the shared
 * truncation mark; every later append stores nothing. Each call returns exactly the text it
 * stored, which is what the supervisor then publishes, so the column always equals the
 * concatenation of the published `thinking.delta` fragments.
 */
import type { DatabaseSync } from "node:sqlite";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { TRUNCATED_MARK } from "./events.js";
import { decodeNullableText, requireChanges } from "./store-branch.js";

const MAX_THINKING_POINTS = 32_768;
const SELECT_THINKING = "SELECT CAST(thinking AS BLOB) AS thinking FROM chat_messages WHERE id = ?";
const APPEND_THINKING =
  "UPDATE chat_messages SET thinking = COALESCE(thinking, '') || ? WHERE id = ?";

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
