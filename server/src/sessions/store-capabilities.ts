/**
 * A session's two capability columns (s1d-experts-skills design D2, D7; migration 047): `expert_id`
 * (NULL = no expert; not a foreign key — built-in experts are not rows) and `disabled_skills` (JSON
 * array text, `'[]'` for sessions older than 047). Raw values: whether the expert is still visible
 * is the reader's question (experts store), and the session view's fourteen keys do not carry them.
 * The write replaces both columns; the list goes through the one skill-name rule and is stored
 * deduplicated in dictionary order. Neither touches `updated_at`; both run in the caller's
 * transaction, if any.
 */
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import { normalizeSkillNames } from "../skills/store.js";

interface Capabilities {
  expertId: string | null;
  disabledSkills: string[];
}

const SELECT_CAPABILITIES = "SELECT expert_id, disabled_skills FROM chat_sessions WHERE id = ?";
const UPDATE_CAPABILITIES =
  "UPDATE chat_sessions SET expert_id = ?, disabled_skills = ? WHERE id = ?";

/** The stored expert id and disabled list; undefined for a missing session. */
export function readSessionCapabilities(
  db: DatabaseSync,
  sessionId: string,
): Capabilities | undefined {
  const row = db.prepare(SELECT_CAPABILITIES).get(sessionId) as
    | { expert_id: string | null; disabled_skills: string }
    | undefined;
  return row === undefined
    ? undefined
    : { expertId: row.expert_id, disabledSkills: JSON.parse(row.disabled_skills) as string[] };
}

/** Writes both columns; a refused skill name is `bad_request`, a missing session `not_found`. */
export function writeSessionCapabilities(
  db: DatabaseSync,
  sessionId: string,
  capabilities: { expertId: string | null; disabledSkills: readonly string[] },
): Capabilities {
  const disabledSkills = normalizeSkillNames(capabilities.disabledSkills);
  const { changes } = db
    .prepare(UPDATE_CAPABILITIES)
    .run(capabilities.expertId, JSON.stringify(disabledSkills), sessionId);
  if (changes === 0 || changes === 0n) {
    throw new HttpError("not_found");
  }
  return { expertId: capabilities.expertId, disabledSkills };
}
