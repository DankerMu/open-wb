/**
 * What a dispatch aligns a session's process with (#1009, s1g design D2/D5): the effective composer
 * values of the session, computed once per dispatch from the raw columns `store.runtimeState`
 * reports and the configuration the assembly hands down. Only effective values reach a spawn's argv
 * — the mode clamped by `approvalMaxMode`, the model inside the whitelist — never a raw column.
 * Likewise the session's effective capabilities (s1d-experts-skills design D8): the visible expert's
 * prompt and the disabled skills as `skill:<name>`, from the two capability columns, never cached.
 */
import { type ApprovalMode, type Effort, effectiveComposer } from "../model-catalog.js";
import { type SessionCapabilities, sessionConfigFingerprint } from "./omp/session-config.js";
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

/** The two capability columns of a session, as `store.runtimeState` reports them. */
export type RawCapabilities = { expertId: string | null; disabledSkills: readonly string[] };

/**
 * experts「专家提示词注入」: the prompt of expert `expertId` when `ownerId` can see it (built-in or
 * their own), else null — a deleted, foreign or withdrawn expert is no expert.
 */
export type ExpertPrompt = (ownerId: string, expertId: string) => string | null;

/** A session's effective capabilities, bound to the assembly's expert port (the supervisor's). */
export type CapabilitiesOf = (session: {
  ownerId: string;
  capabilities: RawCapabilities;
}) => SessionCapabilities;

/**
 * The effective capabilities of a session for one spawn (chat-sessions「派发前按会话设置对齐进程」, design
 * D8), bound to `expertPrompt`: the effective expert's prompt (null without one) and every disabled
 * skill prefixed `skill:`. Each call looks the expert up anew: nothing is cached between dispatches.
 */
export function effectiveCapabilities(expertPrompt: ExpertPrompt): CapabilitiesOf {
  return ({ ownerId, capabilities: { expertId, disabledSkills } }) => ({
    appendSystemPrompt: expertId === null ? null : expertPrompt(ownerId, expertId),
    disabledExtensions: disabledSkills.map((name) => `skill:${name}`),
  });
}

/**
 * Everything one dispatch aligns a process with, computed once per dispatch (never cached) from its
 * one `store.runtimeState` read: the effective composer values, the effective capabilities and
 * their fingerprint.
 */
export function alignmentOf(
  session: { ownerId: string; composer: RawComposer; capabilities: RawCapabilities },
  config: ComposerConfig,
  capabilitiesOf: CapabilitiesOf,
) {
  const capabilities = capabilitiesOf(session);
  return {
    ...effectiveOf(session.composer, config),
    capabilities,
    fingerprint: sessionConfigFingerprint(capabilities),
  };
}

/**
 * Whether a live slot can serve a dispatch whose effective values are `effective` (step 1, s1d
 * design D19 and s1d-experts-skills D8): its process was started under the effective mode (omp takes
 * it from argv alone), knows the effective model (omp reads `models.yml` at spawn only and refuses
 * `set_model` for a model registered later, `Model not found`) and was spawned with session config
 * files of the effective capabilities' fingerprint (omp reads them at spawn only). A model of the
 * spawn-time set or an effort change needs no restart: step 2 switches it.
 */
export function reusable(
  slot: { approvalMode: ApprovalMode; modelIds: ReadonlySet<string>; fingerprint: string },
  effective: { approvalMode: ApprovalMode; modelId: string; fingerprint: string },
): boolean {
  return (
    slot.approvalMode === effective.approvalMode &&
    slot.modelIds.has(effective.modelId) &&
    slot.fingerprint === effective.fingerprint
  );
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
