/**
 * Session slot registration (generations, slots, identity-gated claim release) and the global
 * omp process pool: live-process registry, serialized admission, least-recently-active eviction.
 */
import { HttpError } from "../core/errors/index.js";
import type { SessionRuntime, SessionRuntimeOpts } from "./omp/runtime.js";
import type { SessionStore } from "./store.js";
import { RingBuffer } from "./stream/ring-buffer.js";
import type { SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";

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

/** The slot's capacity entry was released; the dispatch falls back to one fresh admission. */
export class ReadmissionRequired extends Error {
  constructor() {
    super("session process must be re-admitted");
    this.name = "ReadmissionRequired";
  }
}

type PerRuntime = Pick<
  SessionRuntimeOpts,
  "sessionId" | "ownerId" | "cwd" | "tokens" | "onApproval"
> & {
  resumePath: string | null;
  onExit: () => void;
};

/** Supervisor-owned, shared by every session and fork runtime: one gate instance, one log port. */
export type SpawnShared = Required<Pick<SessionRuntimeOpts, "spawnGate" | "log">>;

/** The one SessionRuntime option assembly (spawn contract inputs) from the supervisor runtime. */
export function sessionRuntimeOpts(
  base: SessionSupervisorRuntime,
  shared: SpawnShared,
  per: PerRuntime,
): SessionRuntimeOpts {
  return {
    sessionId: per.sessionId,
    bin: base.bin,
    sandboxRoot: base.sandboxRoot,
    stateDir: base.stateDir,
    ownerId: per.ownerId,
    cwd: per.cwd,
    modelId: base.modelId,
    tokens: per.tokens,
    resumePath: per.resumePath,
    onExit: per.onExit,
    ...(per.onApproval === undefined ? {} : { onApproval: per.onApproval }),
    ...(base.idleMs === undefined ? {} : { idleMs: base.idleMs }),
    ...(base.ompUser === undefined ? {} : { ompUser: base.ompUser }),
    ...(base.spawnImpl === undefined ? {} : { spawnImpl: base.spawnImpl }),
    ...(base.clock === undefined ? {} : { clock: base.clock }),
    ...(base.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: base.handshakeTimeoutMs }),
    spawnGate: shared.spawnGate,
    log: shared.log,
  };
}

export function generationTokens(
  slot: Slot,
  pool: ProcessPool,
  store: SessionStore,
  tokens: TokenRegistry,
): { issue(sessionId: string): string; revoke(sessionId: string): void } {
  return {
    issue: (sessionId: string) => {
      slot.acquisitionFault = undefined;
      if (!pool.holds(slot.entry)) {
        slot.acquisitionFault = new ReadmissionRequired();
        throw slot.acquisitionFault;
      }
      try {
        slot.epoch = store.bumpStreamEpoch(sessionId);
      } catch (error) {
        slot.acquisitionFault = error;
        throw error;
      }
      const generation: Generation = {
        epoch: slot.epoch,
        ring: new RingBuffer(slot.epoch),
        revoked: false,
        dispatchCount: 1,
        pumpCount: 0,
        sealed: false,
      };
      slot.generation = generation;
      try {
        return tokens.issue(sessionId);
      } catch (error) {
        slot.acquisitionFault = error;
        releaseDispatch(slot, generation);
        generation.revoked = true;
        sealGeneration(slot, generation);
        throw error;
      }
    },
    revoke: (_sessionId: string) => {
      const generation = slot.generation;
      if (generation !== undefined) {
        generation.revoked = true;
        sealGeneration(slot, generation);
      }
      tokens.revoke(slot.sessionId);
    },
  };
}

/**
 * Fork temporary process (#466): no generation, no epoch, no ring. The token is issued once and only
 * while the entry is held, so a dead child is never lazily re-spawned outside the pool.
 */
export function temporaryTokens(
  pool: ProcessPool,
  entry: PoolEntry,
  tokens: TokenRegistry,
): SessionRuntimeOpts["tokens"] {
  let issued = false;
  return {
    issue: (sessionId: string) => {
      if (issued || !pool.holds(entry)) {
        throw new Error("fork temporary process cannot be re-acquired");
      }
      issued = true;
      return tokens.issue(sessionId);
    },
    revoke: (sessionId: string) => {
      tokens.revoke(sessionId);
    },
  };
}

export function releaseDispatch(slot: Slot, generation: Generation | undefined): void {
  if (generation === undefined) {
    return;
  }
  if (generation.dispatchCount > 0) {
    generation.dispatchCount -= 1;
  }
  sealGeneration(slot, generation);
}

export function releasePump(slot: Slot, generation: Generation | undefined): void {
  if (generation === undefined) {
    return;
  }
  if (generation.pumpCount > 0) {
    generation.pumpCount -= 1;
  }
  if (generation.dispatchCount > 0) {
    generation.dispatchCount -= 1;
  }
  sealGeneration(slot, generation);
}

export function sealGeneration(slot: Slot, generation: Generation): void {
  if (generation.sealed || generation.dispatchCount > 0 || generation.pumpCount > 0) {
    return;
  }
  if (!generation.revoked && slot.retiring === undefined) {
    return;
  }
  generation.sealed = true;
  if (slot.generation === generation) {
    slot.generation = undefined;
  }
}
