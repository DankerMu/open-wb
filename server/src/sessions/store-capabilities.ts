/**
 * A session's two capability columns (s1d-experts-skills design D2, D7; migration 047): `expert_id`
 * (NULL = no expert; not a foreign key — built-in experts are not rows) and `disabled_skills` (JSON
 * array text, `'[]'` for sessions older than 047). Raw values: whether the expert is still visible
 * is the reader's question (experts store), and the session view's fourteen keys do not carry them.
 * The write replaces both columns; the list goes through the one skill-name rule and is stored
 * deduplicated in dictionary order. None of them touches `updated_at`; all run in the caller's
 * transaction, if any.
 * The union rule (D7) is `withoutExpertSkills`, the one place both a creation (`store-metadata.ts`)
 * and a capabilities PUT (`patchSessionCapabilities`) apply it: a body that names a (non-null) expert
 * leaves none of that expert's declared skills disabled; clearing the expert restores nothing.
 */
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import { normalizeSkillNames } from "../skills/store.js";

export interface Capabilities {
  expertId: string | null;
  disabledSkills: string[];
}

/** An expert the route found visible to the caller: its id and its declared skills. */
export interface SessionExpert {
  id: string;
  skills: readonly string[];
}

/** A capabilities PUT, already shape-checked; at least one key. */
export interface CapabilitiesPatch {
  /** Absent: the stored id stays as it is; null clears it. */
  expert?: SessionExpert | null;
  /** Absent: the stored list is the base of the union rule. */
  disabledSkills?: readonly string[];
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

/** `disabled` through the skill-name rule, minus the expert's declared skills (the union rule). */
export function withoutExpertSkills(
  disabled: readonly string[],
  expert: SessionExpert | null | undefined,
): string[] {
  const needed = new Set(expert?.skills ?? []);
  return normalizeSkillNames(disabled).filter((name) => !needed.has(name));
}

/**
 * Reads the row, merges `patch` by the union rule and writes both columns, in one synchronous
 * segment. A missing session is `not_found`; a refused skill name `bad_request`, nothing written.
 */
export function patchSessionCapabilities(
  db: DatabaseSync,
  sessionId: string,
  patch: CapabilitiesPatch,
): Capabilities {
  const current = readSessionCapabilities(db, sessionId);
  if (current === undefined) {
    throw new HttpError("not_found");
  }
  const disabled = patch.disabledSkills ?? current.disabledSkills;
  return writeSessionCapabilities(db, sessionId, {
    expertId: patch.expert === undefined ? current.expertId : (patch.expert?.id ?? null),
    disabledSkills: withoutExpertSkills(disabled, patch.expert),
  });
}
