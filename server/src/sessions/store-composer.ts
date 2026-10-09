/**
 * The three composer settings of a session (#1004, s1g design D3): the raw columns of migration
 * 040 as the user chose them (NULL = never chosen). What a session view shows is their effective
 * value, `effectiveComposer(rawComposer(row), config)`; the configuration is handed down by the
 * assembly and never read from the environment here.
 * The write side of creation (#1005, design D4/D6): which raw values a new session row gets — the
 * request's, else the account's last choice (`account_composer_prefs`, migration 041), else NULL —
 * the upsert of that last choice, and whether the creation writes a `session.permission` audit.
 * All of it runs inside the caller's creation transaction; nothing here opens one.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { HttpError } from "../core/errors/index.js";
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type Effort,
  effectiveComposer,
} from "../model-catalog.js";

/** `approvalMaxMode` and the model catalog, as `effectiveComposer` takes them. */
export type ComposerConfig = Parameters<typeof effectiveComposer>[1];

/** For the unaliased single-table `SELECT … FROM chat_sessions` statements. */
export const COMPOSER_COLUMNS = "approval_mode, model_id, reasoning_effort";

/**
 * 040's CHECKs keep the two enumerated columns inside their value sets; `model_id` is plain TEXT
 * with no CHECK — an id outside the catalog falls back to the default model on read.
 */
export type ComposerDbRow = {
  approval_mode: ApprovalMode | null;
  model_id: string | null;
  reasoning_effort: Effort | null;
};

/** The stored choices, each possibly null: the `raw` argument of `effectiveComposer`. */
export function rawComposer(row: ComposerDbRow): Parameters<typeof effectiveComposer>[0] {
  return {
    approvalMode: row.approval_mode,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
  };
}

/** The three keys of a create body as the route hands them over: strings, values unchecked. */
export interface ComposerInput {
  approvalMode?: string;
  modelId?: string;
  reasoningEffort?: string;
}

/** What `resolveCreateComposer` settles for one creation. */
interface CreateComposer {
  /** The raw values of the new session row. */
  row: ComposerDbRow;
  /** Only the columns the request named: what the last choice is updated with. */
  given: Partial<ComposerDbRow>;
  /** The `to` of the creation's `session.permission` audit; null when none is written. */
  auditTo: ApprovalMode | null;
}

/** The seven effort names; `auto` is not one. */
const EFFORTS: Record<Effort, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

const NO_CHOICE: ComposerDbRow = { approval_mode: null, model_id: null, reasoning_effort: null };

const SELECT_PREFS = `SELECT ${COMPOSER_COLUMNS} FROM account_composer_prefs WHERE account_id = ?`;
const UPSERT_PREFS =
  "INSERT INTO account_composer_prefs(account_id, approval_mode, model_id, reasoning_effort, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET";
const SET_APPROVAL_MODE = "approval_mode = excluded.approval_mode";
const SET_MODEL_ID = "model_id = excluded.model_id";
const SET_REASONING_EFFORT = "reasoning_effort = excluded.reasoning_effort";
const SET_UPDATED_AT = "updated_at = excluded.updated_at";

/**
 * Reads the owner's last choice and validates the request's keys against the configuration — a
 * read only, so it goes first in the creation transaction; an invalid value throws `bad_request`
 * before anything is written or any directory made.
 * A mode above `approvalMaxMode` is refused, not stored and clamped. An effort needs a reasoning
 * model — the request's, else the effective one of the last choice — but is not checked against
 * that model's `efforts` (omp clamps). Keys the request does not name copy the last choice's raw
 * columns as they are, valid under today's configuration or not (design D3: clamped on read).
 */
export function resolveCreateComposer(
  db: DatabaseSync,
  ownerId: string,
  input: ComposerInput,
  config: ComposerConfig,
): CreateComposer {
  const last = (db.prepare(SELECT_PREFS).get(ownerId) as ComposerDbRow | undefined) ?? NO_CHOICE;
  const { models } = config.modelCatalog;
  const given: Partial<ComposerDbRow> = {};
  if (input.approvalMode !== undefined) {
    const rank = (APPROVAL_MODES as readonly string[]).indexOf(input.approvalMode);
    if (rank < 0 || rank > APPROVAL_MODES.indexOf(config.approvalMaxMode)) {
      throw new HttpError("bad_request");
    }
    given.approval_mode = input.approvalMode as ApprovalMode;
  }
  if (input.modelId !== undefined) {
    if (!models.some((model) => model.id === input.modelId)) {
      throw new HttpError("bad_request");
    }
    given.model_id = input.modelId;
  }
  if (input.reasoningEffort !== undefined) {
    const modelId =
      given.model_id ??
      effectiveComposer(rawComposer({ ...NO_CHOICE, model_id: last.model_id }), config).modelId;
    const reasons = models.find((model) => model.id === modelId)?.reasoning === true;
    if (!Object.hasOwn(EFFORTS, input.reasoningEffort) || !reasons) {
      throw new HttpError("bad_request");
    }
    given.reasoning_effort = input.reasoningEffort as Effort;
  }
  const row = { ...last, ...given };
  return { row, given, auditTo: creationAuditTo(row.approval_mode, config) };
}

/**
 * Upserts the owner's last choice with the columns the request named; the others keep their value
 * (NULL in a new row). A request that named none sends no statement: `updated_at` stays.
 */
export function saveComposerPrefs(
  db: DatabaseSync,
  ownerId: string,
  given: Partial<ComposerDbRow>,
  now: number,
): void {
  // The SET clause from source-constant fragments only; every value travels as a parameter.
  const fragments: string[] = [];
  if (given.approval_mode !== undefined) {
    fragments.push(SET_APPROVAL_MODE);
  }
  if (given.model_id !== undefined) {
    fragments.push(SET_MODEL_ID);
  }
  if (given.reasoning_effort !== undefined) {
    fragments.push(SET_REASONING_EFFORT);
  }
  if (fragments.length === 0) {
    return;
  }
  const values: SQLInputValue[] = [
    ownerId,
    given.approval_mode ?? null,
    given.model_id ?? null,
    given.reasoning_effort ?? null,
    now,
  ];
  db.prepare(`${UPSERT_PREFS} ${[...fragments, SET_UPDATED_AT].join(", ")}`).run(...values);
}

/**
 * session-permission-tier「档位变更审计」, the creation condition: a non-NULL raw mode whose effective
 * mode differs from the effective mode of NULL (the default under this configuration). Returns
 * that effective mode, or null when the creation writes no audit.
 */
function creationAuditTo(
  approvalMode: ApprovalMode | null,
  config: ComposerConfig,
): ApprovalMode | null {
  if (approvalMode === null) {
    return null;
  }
  const effectiveOf = (mode: ApprovalMode | null): ApprovalMode =>
    effectiveComposer(rawComposer({ ...NO_CHOICE, approval_mode: mode }), config).approvalMode;
  const effective = effectiveOf(approvalMode);
  return effective === effectiveOf(null) ? null : effective;
}
