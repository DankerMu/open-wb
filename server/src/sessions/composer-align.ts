/**
 * What a dispatch aligns a session's process with (#1009, s1g design D2/D5): the effective composer
 * values of the session, computed once per dispatch from the raw columns `store.runtimeState`
 * reports and the configuration the assembly hands down. Only effective values reach a spawn's argv
 * — the mode clamped by `approvalMaxMode`, the model inside the whitelist — never a raw column.
 */
import { type ApprovalMode, effectiveComposer } from "../model-catalog.js";
import type { ComposerConfig } from "./store-composer.js";

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
