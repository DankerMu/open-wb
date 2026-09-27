/**
 * Session slot registration (generations, slots, identity-gated claim release) and the global
 * omp process pool: live-process registry, serialized admission, least-recently-active eviction.
 */
import { HttpError } from "../core/errors/index.js";
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
  entry: PoolEntry | undefined;
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

/** A slot is turn-free when no dispatch claim and no pump are outstanding. */
export function turnFree(slot: ClaimSlot): boolean {
  return slot.claimedAssistantId === undefined && slot.pump === undefined;
}

/** Supplied by the admitter: `busy` excludes eviction; `retire` resolves after exit and release. */
export interface PoolMember {
  busy(): boolean;
  retire(): Promise<void>;
}

export interface PoolEntry {
  readonly member: PoolMember;
  readonly seq: number;
  lastActive: number;
  evicting: boolean;
}

/**
 * One capacity slot per admitted process. Admissions run one at a time on a promise chain, so
 * "decide, evict, register" never interleaves with another admission.
 */
export class ProcessPool {
  readonly #cap: number;
  readonly #now: () => number;
  readonly #entries = new Set<PoolEntry>();
  #seq = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(cap: number, now: () => number) {
    this.#cap = cap;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  admit(member: PoolMember): Promise<PoolEntry> {
    const run = this.#tail.then(() => this.#admitNow(member));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  holds(entry: PoolEntry | undefined): boolean {
    return entry !== undefined && this.#entries.has(entry);
  }

  /** Synchronous and idempotent by entry identity. */
  release(entry: PoolEntry | undefined): void {
    if (entry !== undefined) {
      this.#entries.delete(entry);
    }
  }

  touch(entry: PoolEntry | undefined): void {
    if (entry !== undefined && this.#entries.has(entry)) {
      entry.lastActive = this.#now();
    }
  }

  async #admitNow(member: PoolMember): Promise<PoolEntry> {
    while (this.#entries.size >= this.#cap) {
      const victim = this.#victim();
      if (victim === undefined) {
        throw new HttpError("agent_capacity");
      }
      victim.evicting = true;
      await victim.member.retire();
    }
    this.#seq += 1;
    const entry: PoolEntry = { member, seq: this.#seq, lastActive: this.#now(), evicting: false };
    this.#entries.add(entry);
    return entry;
  }

  /** Least recently active non-busy entry not already being evicted; ties go to earlier seq. */
  #victim(): PoolEntry | undefined {
    let best: PoolEntry | undefined;
    for (const entry of this.#entries) {
      if (entry.evicting || entry.member.busy()) {
        continue;
      }
      if (
        best === undefined ||
        entry.lastActive < best.lastActive ||
        (entry.lastActive === best.lastActive && entry.seq < best.seq)
      ) {
        best = entry;
      }
    }
    return best;
  }
}
