/**
 * Issue #1018 message attachments, read side (message-attachments「交给 omp 的附件后缀」, design D12
 * of s1g-composer-capabilities): the parse of `chat_messages.attachments` and the paths the branch
 * alignment rebuilds the attachment suffix from. The column is a compact JSON list of
 * `{path, size}` or SQL NULL, and has no CHECK (migration 042): what it holds is judged here, on
 * every read.
 *
 * Issue #1019, write side (message-attachments「附件落库与快照」): what the admission stores in the
 * column and what it titles a new session from. `JSON.stringify` escapes U+0000–U+001F and lone
 * surrogates, so the stored text is always well-formed UTF-8 without NUL whatever the paths are —
 * which is why the column is read as bare TEXT.
 */
import type { DatabaseSync } from "node:sqlite";
import { asPlain, own } from "./file-changes.js";

export interface StoredAttachment {
  path: string;
  size: number;
}

const SELECT_STORED =
  "SELECT id, attachments FROM chat_messages WHERE session_id = ? AND attachments IS NOT NULL ORDER BY id";

/**
 * The stored list, or `[]` for anything that is not one: not a string, not JSON, not a list, or a
 * list with any element that is not an object whose `path` is a non-empty string and whose `size`
 * is a non-negative safe integer (one bad element drops the whole list — a suffix rebuilt from part
 * of it would match no entry anyway). Other keys of an element are dropped. Never throws.
 */
export function parseAttachments(text: unknown): StoredAttachment[] {
  if (typeof text !== "string") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const attachments: StoredAttachment[] = [];
  for (const element of parsed) {
    const record = asPlain(element);
    const path = record === undefined ? undefined : own(record, "path");
    const size = record === undefined ? undefined : own(record, "size");
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return [];
    }
    attachments.push({ path, size });
  }
  return attachments;
}

/** The column of a new user message: NULL for no attachment, else the compact `{path, size}` list. */
export function serializeAttachments(list?: readonly StoredAttachment[]): string | null {
  return list === undefined || list.length === 0
    ? null
    : JSON.stringify(list.map(({ path, size }) => ({ path, size })));
}

/**
 * What a prompt admission titles a NULL-title session from: the text, or for an attachment-only
 * prompt the first attachment's file name (its path after the last `/`).
 */
export function titleSource(text: string, list?: readonly StoredAttachment[]): string {
  const first = list?.[0];
  return text.length > 0 || first === undefined
    ? text
    : first.path.slice(first.path.lastIndexOf("/") + 1);
}

/**
 * Message id → the paths it stores, in stored order, for the messages of this session that have
 * any; a message with a NULL, an empty or an unreadable column has no entry. The column is left as
 * it is.
 */
export function readAttachmentPaths(db: DatabaseSync, sessionId: string): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  for (const row of db.prepare(SELECT_STORED).all(sessionId)) {
    const stored = parseAttachments(row.attachments);
    if (stored.length > 0) {
      paths.set(
        Number(row.id),
        stored.map((attachment) => attachment.path),
      );
    }
  }
  return paths;
}
