/**
 * What a dispatch aligns a session's process with (#1009, s1g design D2/D5): the effective composer
 * values of the session, computed once per dispatch from the raw columns `store.runtimeState`
 * reports and the configuration the assembly hands down. Only effective values reach a spawn's argv
 * — the mode clamped by `approvalMaxMode`, the model inside the whitelist — never a raw column.
 */
import { type ApprovalMode, type Effort, effectiveComposer } from "../model-catalog.js";
import { commandOn, type Slot } from "./pool.js";
import type { ComposerConfig } from "./store-composer.js";

/** The provider key of every whitelisted model in the managed `models.yml` (omp/process.ts argv). */
const PROVIDER = "workbuddy";

/** The three raw composer columns of a session, each null when never chosen. */
export type RawComposer = Parameters<typeof effectiveComposer>[0];

/** session-composer-settings「有效值解析」 for one dispatch; nothing is cached between dispatches. */
export function effectiveOf(
  raw: RawComposer,
  config: ComposerConfig,
): ReturnType<typeof effectiveComposer> {
  return effectiveComposer(raw, config);
}

/**
 * Whether a live slot can serve a dispatch whose effective values are `effective`: only the mode
 * decides, because omp takes it from argv alone. A model or effort change needs no restart.
 */
export function reusable(
  slot: { approvalMode: ApprovalMode },
  effective: { approvalMode: ApprovalMode },
): boolean {
  return slot.approvalMode === effective.approvalMode;
}

/**
 * Step 2 of the alignment (#1010, design D8), on a slot the dispatch already holds by its turn claim
 * or its control claim: `set_model` on a generation's first dispatch (whatever argv said: after a
 * `--resume` the effort is the session file's stale one) or when the model differs, then
 * `set_thinking_level` when the model reasons and its effort is not the one this generation applied.
 * Nothing is sent when neither changed. A value is recorded only after its command succeeded, on
 * the generation the command ran on; a rejection is the caller's pre-dispatch failure, which retires
 * the slot. Only the commands are awaited here: no other I/O, no timer.
 */
export async function alignModel(
  slot: Slot,
  effective: { modelId: string; reasoningEffort: Effort | null },
): Promise<void> {
  const { modelId, reasoningEffort } = effective;
  if (slot.generation?.applied?.modelId !== modelId) {
    await commandOn(slot, { type: "set_model", provider: PROVIDER, modelId });
    if (slot.generation !== undefined) {
      slot.generation.applied = { modelId, effort: undefined };
    }
  }
  const applied = slot.generation?.applied;
  if (reasoningEffort !== null && applied !== undefined && applied.effort !== reasoningEffort) {
    await commandOn(slot, { type: "set_thinking_level", level: reasoningEffort });
    applied.effort = reasoningEffort;
  }
}
