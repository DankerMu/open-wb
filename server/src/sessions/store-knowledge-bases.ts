/**
 * Issue #1971 knowledge-base references of a prompt (message-attachments「prompt 引用知识库」, design
 * D8 of s2c-kb-session): the request's `knowledgeBases`, judged after the attachments, and the
 * `chat_messages.knowledge_bases` column (migration 052) it is stored in. The column is a compact
 * JSON list of `{id, name}` or SQL NULL and has no CHECK: what it holds is judged here, on every
 * read. The names are those the bases had at admission: nothing here reads the base table again.
 */
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import { asPlain, own } from "./file-changes.js";

export interface KnowledgeBaseRef {
  id: string;
  name: string;
}

/**
 * The kb module's `resolveReferences` (kb/session-search.ts), as sessions sees it: every id one of
 * that account's bases → their `{id, name}` in input order; any other → null. Local reads only.
 */
export type KnowledgeBaseResolver = (
  ownerId: string,
  ids: readonly string[],
) => KnowledgeBaseRef[] | null;

const REFERENCE_LIMIT = 5;

const SELECT_STORED =
  "SELECT id, knowledge_bases FROM chat_messages WHERE session_id = ? AND knowledge_bases IS NOT NULL ORDER BY id";

/**
 * The `knowledgeBases` of a prompt body as `parsePromptBody` handed it over, judged once the
 * attachments are: absent or `[]` is no reference (the resolver is not asked); anything but a list
 * of at most five distinct (compared as given) non-empty strings is 400; a list the resolver does
 * not answer — some id is not this account's base, or the knowledge base is off (`resolve`
 * omitted) — is 404, the same body in all three cases. No audit, no RAGFlow request.
 */
export function admitKnowledgeBases(
  value: unknown,
  ownerId: string,
  resolve: KnowledgeBaseResolver | undefined,
): KnowledgeBaseRef[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > REFERENCE_LIMIT ||
    value.some(
      (id: unknown, index) =>
        typeof id !== "string" || id.length === 0 || value.indexOf(id) !== index,
    )
  ) {
    throw new HttpError("bad_request");
  }
  const resolved = resolve?.(ownerId, value as string[]) ?? null;
  if (resolved === null) {
    throw new HttpError("not_found");
  }
  return resolved.map(({ id, name }) => ({ id, name }));
}

/**
 * The stored list, or `[]` for anything that is not one: not a string, not JSON, not a list, more
 * than five elements, an element that is not exactly `{id, name}` with both non-empty strings, or
 * an `id` twice. One bad element drops the whole list. Never throws; the column is left as it is.
 */
export function parseKnowledgeBases(text: unknown): KnowledgeBaseRef[] {
  if (typeof text !== "string") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > REFERENCE_LIMIT) {
    return [];
  }
  const refs: KnowledgeBaseRef[] = [];
  for (const element of parsed) {
    const record = asPlain(element);
    const id = record === undefined ? undefined : own(record, "id");
    const name = record === undefined ? undefined : own(record, "name");
    if (
      record === undefined ||
      Object.keys(record).length !== 2 ||
      typeof id !== "string" ||
      id.length === 0 ||
      typeof name !== "string" ||
      name.length === 0 ||
      refs.some((ref) => ref.id === id)
    ) {
      return [];
    }
    refs.push({ id, name });
  }
  return refs;
}

/** The column of a new user message: NULL for no reference, else the compact `{id, name}` list. */
function serializeKnowledgeBases(list?: readonly KnowledgeBaseRef[]): string | null {
  return list === undefined || list.length === 0
    ? null
    : JSON.stringify(list.map(({ id, name }) => ({ id, name })));
}

/**
 * Writes the references of a just-inserted user message, inside the caller's admission
 * transaction; none (absent or `[]`) writes nothing, so the column stays NULL.
 */
export function writeKnowledgeBases(
  db: DatabaseSync,
  messageId: number,
  list?: readonly KnowledgeBaseRef[],
): void {
  const stored = serializeKnowledgeBases(list);
  if (stored !== null) {
    db.prepare("UPDATE chat_messages SET knowledge_bases = ? WHERE id = ?").run(stored, messageId);
  }
}

/**
 * Message id → the references it stores, in stored order, for the messages of this session that
 * have any; a NULL, an empty or an unreadable column has no entry (as `readAttachmentPaths`).
 */
export function readKnowledgeBaseRefs(
  db: DatabaseSync,
  sessionId: string,
): Map<number, KnowledgeBaseRef[]> {
  const refs = new Map<number, KnowledgeBaseRef[]>();
  for (const row of db.prepare(SELECT_STORED).all(sessionId)) {
    const stored = parseKnowledgeBases(row.knowledge_bases);
    if (stored.length > 0) {
      refs.set(Number(row.id), stored);
    }
  }
  return refs;
}
