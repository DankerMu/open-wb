/**
 * experts/store — built-in and self-made experts (s1d-experts-skills design D2–D4; experts「专家校验与
 * 可见性」store part). Pure DB, `node:sqlite` sync.
 *
 * Visibility: an account sees every built-in expert (code constants, `builtin.ts`) and the rows it owns.
 * Another account's expert and a missing id are the same `undefined` for `get`, `update` and `remove`;
 * a built-in id is not a row, so the store never writes one (the route answers 403 before).
 * Validation (D4) throws the fixed-message `bad_request` and never echoes a value. Lengths count code
 * points; `name`, `tags` and `prompt` are stored trimmed; skill names follow the one rule in
 * `skills/store.ts`. Each write opens its own transaction (the caller must not be in one); the optional
 * `within(expert)` runs after the write, before COMMIT (the audit hook) — a throw rolls all of it back.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import { normalizeSkillNames } from "../skills/store.js";
import { BUILTIN_EXPERTS } from "./builtin.js";

const CATEGORIES = ["开发", "办公", "设计", "产品"] as const;
const MAX_EXPERTS_PER_ACCOUNT = 50;
const MAX_NAME_POINTS = 32;
const MAX_DESCRIPTION_POINTS = 200;
const MAX_TAGS = 5;
const MAX_TAG_POINTS = 12;
const MAX_PROMPT_POINTS = 8000;
const MAX_SKILLS = 32;

/** The view of one expert, built-in or self-made. */
export interface Expert {
  id: string;
  name: string;
  description: string;
  category: (typeof CATEGORIES)[number];
  tags: readonly string[];
  prompt: string;
  skills: readonly string[];
  builtin: boolean;
}

type Fields = Omit<Expert, "id" | "builtin">;
type Within = (expert: Expert) => void;

const SELECT_OWN = "SELECT * FROM experts WHERE id = ? AND owner_id = ?";
const SELECT_ALL_OWN = "SELECT * FROM experts WHERE owner_id = ? ORDER BY created_at, id";
const INSERT =
  "INSERT INTO experts(id, owner_id, name, description, category, tags, prompt, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE =
  "UPDATE experts SET name = ?, description = ?, category = ?, tags = ?, prompt = ?, skills = ?, updated_at = ? WHERE id = ? AND owner_id = ?";
const DELETE = "DELETE FROM experts WHERE id = ? AND owner_id = ?";
const CLEAR_SESSION_REFERENCES = "UPDATE chat_sessions SET expert_id = NULL WHERE expert_id = ?";

export function createExpertStore(db: DatabaseSync) {
  const own = (ownerId: string, id: string): Expert | undefined => {
    const raw = db.prepare(SELECT_OWN).get(id, ownerId);
    return raw === undefined ? undefined : toExpert(raw);
  };
  const finish = (ownerId: string, id: string, within: Within | undefined): Expert => {
    const expert = own(ownerId, id) as Expert;
    within?.(expert);
    return expert;
  };

  return {
    /** Built-ins in their fixed order, then the account's own by `created_at, id`. */
    list: (ownerId: string): Expert[] => [
      ...BUILTIN_EXPERTS,
      ...db.prepare(SELECT_ALL_OWN).all(ownerId).map(toExpert),
    ],

    get: (ownerId: string, id: string): Expert | undefined =>
      BUILTIN_EXPERTS.find((expert) => expert.id === id) ?? own(ownerId, id),

    /** POST semantics; the 51st expert of an account is `bad_request`. */
    create(ownerId: string, body: unknown, within?: Within): Expert {
      const fields = parseFields(body);
      return inTransaction(db, () => {
        const { count, last } = db
          .prepare(
            "SELECT COUNT(*) AS count, MAX(created_at) AS last FROM experts WHERE owner_id = ?",
          )
          .get(ownerId) as { count: number; last: number | null };
        if (count >= MAX_EXPERTS_PER_ACCOUNT) {
          throw new HttpError("bad_request");
        }
        // The list order is the creation order, even within one millisecond or after a clock step back.
        const now = Date.now();
        const createdAt = last === null ? now : Math.max(now, last + 1);
        const id = randomBytes(16).toString("hex");
        db.prepare(INSERT).run(id, ownerId, ...columns(fields), createdAt, createdAt);
        return finish(ownerId, id, within);
      });
    },

    /** PUT semantics: whole replacement; undefined when the account owns no such expert. */
    update(ownerId: string, id: string, body: unknown, within?: Within): Expert | undefined {
      return inTransaction(db, () => {
        if (own(ownerId, id) === undefined) {
          return undefined;
        }
        const fields = parseFields(body);
        db.prepare(UPDATE).run(...columns(fields), Date.now(), id, ownerId);
        return finish(ownerId, id, within);
      });
    },

    /** Deletes the expert and, in the same transaction, clears every session's reference to it. */
    remove(ownerId: string, id: string, within?: Within): Expert | undefined {
      return inTransaction(db, () => {
        const expert = own(ownerId, id);
        if (expert === undefined) {
          return undefined;
        }
        db.prepare(DELETE).run(id, ownerId);
        db.prepare(CLEAR_SESSION_REFERENCES).run(id);
        within?.(expert);
        return expert;
      });
    },
  };
}

function toExpert(raw: Record<string, SQLOutputValue>): Expert {
  return {
    id: String(raw.id),
    name: String(raw.name),
    description: String(raw.description),
    category: raw.category as Expert["category"],
    tags: JSON.parse(String(raw.tags)) as string[],
    prompt: String(raw.prompt),
    skills: JSON.parse(String(raw.skills)) as string[],
    builtin: false,
  };
}

/** The six stored text columns, in INSERT / UPDATE order. */
function columns(fields: Fields): string[] {
  const { name, description, category, tags, prompt, skills } = fields;
  return [name, description, category, JSON.stringify(tags), prompt, JSON.stringify(skills)];
}

/** D4, field by field; key-set strictness is the route's. */
function parseFields(body: unknown): Fields {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail();
  }
  const fields = body as Record<string, unknown>;
  return {
    name: trimmedText(fields.name, MAX_NAME_POINTS),
    description: description(fields.description),
    category: category(fields.category),
    tags: tags(fields.tags),
    prompt: trimmedText(fields.prompt, MAX_PROMPT_POINTS),
    skills: skills(fields.skills),
  };
}

/** A string that is 1..`max` code points once trimmed; returns the trimmed text. */
function trimmedText(value: unknown, max: number): string {
  if (typeof value !== "string") {
    fail();
  }
  const trimmed = value.trim();
  const points = [...trimmed].length;
  if (points === 0 || points > max) {
    fail();
  }
  return trimmed;
}

function description(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || [...value].length > MAX_DESCRIPTION_POINTS) {
    fail();
  }
  return value;
}

function category(value: unknown): Expert["category"] {
  const found = CATEGORIES.find((name) => name === value);
  return found ?? fail();
}

/** At most five; each trimmed to 1..12 code points; deduplicated keeping the first occurrence. */
function tags(value: unknown): string[] {
  const items = list(value, MAX_TAGS);
  return [...new Set(items.map((item) => trimmedText(item, MAX_TAG_POINTS)))];
}

/** At most 32 skill names, deduplicated in dictionary order. */
function skills(value: unknown): string[] {
  return normalizeSkillNames(list(value, MAX_SKILLS));
}

/** An optional array of at most `max` items (absent = empty). */
function list(value: unknown, max: number): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > max) {
    fail();
  }
  return value;
}

function fail(): never {
  throw new HttpError("bad_request");
}

/** This module's own transaction (as `models/store.ts`; `experts` does not import `sessions`). */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "expert store rollback failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}
