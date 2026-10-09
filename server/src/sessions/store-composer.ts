/**
 * The three composer settings of a session (#1004, s1g design D3) — read side only: the raw
 * columns of migration 040 as the user chose them (NULL = never chosen). What a session view
 * shows is their effective value, `effectiveComposer(rawComposer(row), config)`; the configuration
 * is handed down by the assembly and never read from the environment here.
 */
import type { ApprovalMode, Effort, effectiveComposer } from "../model-catalog.js";

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
