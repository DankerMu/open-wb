/**
 * skills/store — the skill-name rule and the account's default disabled skills (s1d-experts-skills
 * design D4, D6; skill-switches「技能清单与账号缺省」storage part). The rule here is the only one:
 * expert `skills`, the account defaults and a session's disabled list all go through
 * `normalizeSkillNames`, and `GET /api/skills` filters the platform skills by `isSkillName`. A
 * refused name throws the fixed-message `bad_request` (no value echoed). List-size caps are the callers' (experts: 32; the endpoints of groups 4 and 5: 128).
 * Pure DB, `node:sqlite` sync; the writes run in the caller's transaction, if any.
 */
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";

const MAX_SKILL_NAME_BYTES = 128;

const SELECT_PREFS = "SELECT disabled_skills FROM account_skill_prefs WHERE account_id = ?";
const UPSERT_PREFS =
  "INSERT INTO account_skill_prefs(account_id, disabled_skills, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET disabled_skills = excluded.disabled_skills, updated_at = excluded.updated_at";

/**
 * 1..128 UTF-8 bytes, no U+0000–U+001F or U+007F (the `MODEL_ID` set of `model-catalog.ts`), no `,`.
 */
export function isSkillName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SKILL_NAME_BYTES) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || char === ",") {
      return false;
    }
  }
  return true;
}

/** Every element a skill name, else `bad_request`; returns them deduplicated in dictionary order. */
export function normalizeSkillNames(values: readonly unknown[]): string[] {
  if (!values.every(isSkillName)) {
    throw new HttpError("bad_request");
  }
  return [...new Set(values as readonly string[])].sort();
}

/** The account's default disabled skills; `[]` when it never saved any. */
export function readAccountDisabledSkills(db: DatabaseSync, accountId: string): string[] {
  const row = db.prepare(SELECT_PREFS).get(accountId) as { disabled_skills: string } | undefined;
  return row === undefined ? [] : (JSON.parse(row.disabled_skills) as string[]);
}

/** Replaces the account's default disabled skills whole; returns the stored list. */
export function saveAccountDisabledSkills(
  db: DatabaseSync,
  accountId: string,
  names: readonly string[],
): string[] {
  const stored = normalizeSkillNames(names);
  db.prepare(UPSERT_PREFS).run(accountId, JSON.stringify(stored), Date.now());
  return stored;
}
