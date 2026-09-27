/**
 * Session slot registration: generations, slots, and identity-gated claim release.
 */
import type { SessionRuntime } from "./omp/runtime.js";
import type { RingBuffer } from "./stream/ring-buffer.js";

export interface Generation {
  epoch: number;
  ring: RingBuffer;
  revoked: boolean;
  dispatchCount: number;
  pumpCount: number;
  sealed: boolean;
}

export interface Slot {
  sessionId: string;
  runtime: SessionRuntime;
  epoch: number;
  generation: Generation | undefined;
  claimedAssistantId: number | undefined;
  pump: Promise<void> | undefined;
  retiring: Promise<void> | undefined;
  acquisitionFault: unknown;
  infraFaulted: boolean;
}

interface ClaimSlot {
  claimedAssistantId: number | undefined;
  pump: Promise<void> | undefined;
}

/**
 * Pump exit always releases its own turn's claim, even after a newer pump took the
 * slot (issue #219); only the slot's current-pump registration is identity-gated.
 */
export function releasePumpExit<S extends ClaimSlot>(
  claims: Map<number, S>,
  slot: S,
  pump: Promise<void>,
  assistantMessageId: number,
): void {
  if (slot.pump === pump) {
    slot.pump = undefined;
  }
  releaseClaim(claims, slot, assistantMessageId);
}

export function releaseClaim<S extends ClaimSlot>(
  claims: Map<number, S>,
  slot: S,
  assistantMessageId: number,
): void {
  if (claims.get(assistantMessageId) === slot) {
    claims.delete(assistantMessageId);
  }
  if (slot.claimedAssistantId === assistantMessageId) {
    slot.claimedAssistantId = undefined;
  }
}
