/**
 * Issue #100 session supervisor: dispatch, persistence, and owned lifecycle.
 */
import { DEFAULT_OMP_MAX_PROCESSES } from "../agent-config.js";
import { HttpError } from "../core/errors/index.js";
import { ApprovalRegistry } from "./approvals.js";
import { applyFailure, applyFrame, applyStop, type ChatEvent, createEventState } from "./events.js";
import type { OmpFrame } from "./omp/frame.js";
import { AgentUnavailableError, OmpProtocolError, type SpawnImpl } from "./omp/process.js";
import {
  type PromptDispatchReceipt,
  SessionBusyError,
  type SessionClock,
  SessionRuntime,
  type SessionRuntimeOpts,
} from "./omp/runtime.js";
import {
  type Generation,
  generationTokens,
  type PoolEntry,
  ProcessPool,
  ReadmissionRequired,
  releaseClaim,
  releaseDispatch,
  releasePump,
  releasePumpExit,
  type Slot,
  sealGeneration,
  turnFree,
} from "./pool.js";
import type { ApprovalView, SessionStore, SettledApproval } from "./store.js";
import type { RetainedEvent, RingRead } from "./stream/ring-buffer.js";
import type { TokenRegistry } from "./tokens.js";
import { drain, persistEvent, TurnStops } from "./turn-control.js";

export { releasePumpExit } from "./pool.js";

export interface StreamCursor {
  epoch: number;
  seq: number | null;
}

export type SessionStreamLiveHandler = (event: RetainedEvent) => void;

export interface SessionStreamSubscription {
  mode: "replay" | "gap" | "fresh";
  replay: RetainedEvent[];
  unsubscribe(): void;
}

export interface SessionSupervisorRuntime {
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  modelId: string;
  idleMs?: number;
  /** Global live-process cap resolved by agent-config; undefined → DEFAULT_OMP_MAX_PROCESSES (16). */
  maxProcesses?: number;
  ompUser?: string;
  spawnImpl?: SpawnImpl;
  clock?: SessionClock;
  handshakeTimeoutMs?: number;
}

export interface SessionSupervisorOptions {
  store: SessionStore;
  tokens: TokenRegistry;
  runtime: SessionSupervisorRuntime;
  /**
   * Must return synchronously. A returned thenable is an owned programming error;
   * its rejection is consumed and is not a second fault. A thrown then getter uses
   * the existing synchronous fault path.
   */
  onError: (error: Error) => void;
  /**
   * Optional and synchronous. Ordinary non-thenable returns are ignored. A returned
   * thenable stops publication for that pump and retires its runtime through the
   * existing ownership path. Omitted means no observer.
   */
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
}

interface FlushFailure {
  sessionId: string;
  assistantMessageId: number;
  error: unknown;
}

export class SessionSupervisor {
  readonly #store: SessionStore;
  readonly #tokens: TokenRegistry;
  readonly #runtime: SessionSupervisorRuntime;
  readonly #onError: (error: Error) => void;
  readonly #onEvent:
    | ((sessionId: string, epoch: number, event: ChatEvent<number>) => void)
    | undefined;
  readonly #slots = new Map<string, Slot>();
  readonly #subscribers = new Map<string, Set<SessionStreamLiveHandler>>();
  readonly #claims = new Map<number, Slot>();
  readonly #admissions = new Set<Promise<void>>();
  readonly #pumps = new Set<Promise<void>>();
  readonly #faults: Error[] = [];
  readonly #pool: ProcessPool;
  readonly #approvals: ApprovalRegistry;
  readonly #stops: TurnStops;
  #closed = false;

  constructor(options: SessionSupervisorOptions) {
    this.#store = options.store;
    this.#tokens = options.tokens;
    this.#runtime = options.runtime;
    this.#onError = options.onError;
    this.#onEvent = options.onEvent;
    const clock = options.runtime.clock;
    this.#pool = new ProcessPool(
      options.runtime.maxProcesses ?? DEFAULT_OMP_MAX_PROCESSES,
      clock === undefined ? () => Date.now() : () => clock.now(),
    );
    this.#approvals = new ApprovalRegistry({
      store: this.#store,
      clock,
      publish: (slot, event, generation) => this.#publish(slot, event, generation),
      fault: (slot, error) => {
        this.#retain(error);
        slot.infraFaulted = true;
        void this.#retireSlot(slot);
      },
    });
    this.#stops = new TurnStops({
      clock,
      pending: (slot) => this.#approvals.pendingFor(slot),
      deny: (sessionId, approvalId) => this.#approvals.decide(sessionId, approvalId, "deny"),
      retire: (slot) => this.#retireSlot(slot),
    });
  }

  prompt(sessionId: string, text: string): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new HttpError("agent_unavailable"));
    }
    const work = this.#prompt(sessionId, text);
    this.#admissions.add(work);
    return work.finally(() => {
      this.#admissions.delete(work);
    });
  }

  streamCursor(sessionId: string): StreamCursor {
    const generation = this.#slots.get(sessionId)?.generation;
    if (generation !== undefined && !generation.sealed) {
      return { epoch: generation.epoch, seq: generation.ring.sequence };
    }
    const state = this.#store.runtimeState(sessionId);
    return { epoch: state?.streamEpoch ?? 0, seq: null };
  }

  subscribe(
    sessionId: string,
    lastEventId: string | null,
    deliver: SessionStreamLiveHandler,
  ): SessionStreamSubscription {
    if (this.#closed) {
      return {
        mode: "fresh",
        replay: [],
        unsubscribe() {},
      };
    }
    const listeners = this.#listenersFor(sessionId);
    listeners.add(deliver);
    let replay: RingRead;
    try {
      replay = this.#readReplay(sessionId, lastEventId);
    } catch (error) {
      this.#removeListener(sessionId, deliver);
      throw error;
    }
    return {
      mode: replay.mode,
      replay: replay.events,
      unsubscribe: () => {
        this.#removeListener(sessionId, deliver);
      },
    };
  }

  sessionStreamSubscriberCount(sessionId: string): number {
    return this.#subscribers.get(sessionId)?.size ?? 0;
  }

  /** Admitted, not yet released process entries (read-only observation). */
  liveProcessCount(): number {
    return this.#pool.size;
  }

  /** Owner answer to one pending approval of this session (#464); REST is #468. */
  decide(sessionId: string, approvalId: number, decision: "allow" | "deny"): Promise<ApprovalView> {
    if (this.#closed) {
      return Promise.reject(new HttpError("agent_unavailable"));
    }
    return this.#approvals.decide(sessionId, approvalId, decision);
  }

  /** Stops the active turn (#473/#490): resolves once `abort` is written or the intent is kept. */
  stop(sessionId: string): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new HttpError("agent_unavailable"));
    }
    const turn = this.#store.runtimeState(sessionId)?.activeTurn?.assistantMessageId;
    if (turn === undefined) {
      return Promise.resolve();
    }
    const slot = this.#claims.get(turn);
    return this.#stops.stop(this.#slots.get(sessionId) === slot ? slot : undefined, turn);
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#approvals.close();
    this.#subscribers.clear();
    const retirements: Promise<void>[] = [];
    for (const slot of this.#slots.values()) {
      retirements.push(this.#retireSlot(slot));
    }
    const admissions = [...this.#admissions];
    await Promise.allSettled(admissions);
    const owned = [...this.#pumps, ...retirements];
    const results = await Promise.allSettled(owned);
    for (const result of results) {
      if (result.status === "rejected") {
        this.#retain(asError(result.reason));
      }
    }
    this.#slots.clear();
    throwCollected(this.#faults);
  }

  handleFlushError(failure: FlushFailure): void {
    const slot = this.#slots.get(failure.sessionId);
    if (slot !== undefined) {
      slot.infraFaulted = true;
      void this.#retireSlot(slot);
    }
    this.#retain(asError(failure.error));
  }

  async #prompt(sessionId: string, text: string): Promise<void> {
    const state = this.#store.runtimeState(sessionId);
    if (state === null || state.activeTurn === null) {
      throw new HttpError("not_found");
    }
    const assistantMessageId = state.activeTurn.assistantMessageId;
    const claimed = this.#claims.get(assistantMessageId);
    if (claimed !== undefined) {
      throw new HttpError("session_busy");
    }
    this.#stops.open(assistantMessageId);
    const existing = this.#slots.get(sessionId);
    if (existing?.retiring !== undefined) {
      await existing.retiring;
    }
    if (this.#closed) {
      throw new HttpError("agent_unavailable");
    }
    if (this.#claims.has(assistantMessageId)) {
      throw new HttpError("session_busy");
    }
    const live = this.#slots.get(sessionId);
    const dispatchNew = () =>
      this.#dispatchNew(sessionId, text, state.ownerId, state.ompSessionFile, assistantMessageId);
    try {
      if (live === undefined || live.retiring !== undefined || !this.#pool.holds(live.entry)) {
        await dispatchNew();
        return;
      }
      this.#claim(live, assistantMessageId);
      try {
        await this.#bindDispatch(live, text, assistantMessageId);
      } catch (error) {
        if (live.pump === undefined) {
          await this.#retireSlot(live);
        }
        if (!(error instanceof ReadmissionRequired)) {
          throw error;
        }
        await dispatchNew();
      }
    } catch (error) {
      this.#stops.release(assistantMessageId);
      throw this.#translate(error);
    }
  }

  async #dispatchNew(
    sessionId: string,
    text: string,
    ownerId: string,
    resumePath: string | null,
    assistantMessageId: number,
  ): Promise<void> {
    const slot: Slot = {
      sessionId,
      runtime: undefined as unknown as SessionRuntime,
      epoch: 0,
      generation: undefined,
      claimedAssistantId: undefined,
      pump: undefined,
      retiring: undefined,
      acquisitionFault: undefined,
      infraFaulted: false,
      entry: undefined,
    };
    this.#claim(slot, assistantMessageId);
    let entry: PoolEntry;
    try {
      entry = await this.#pool.admit({
        busy: () => !turnFree(slot),
        retire: () => this.#retireSlot(slot),
      });
    } catch (error) {
      releaseClaim(this.#claims, slot, assistantMessageId);
      throw error;
    }
    if (this.#closed) {
      this.#pool.release(entry);
      releaseClaim(this.#claims, slot, assistantMessageId);
      throw new HttpError("agent_unavailable");
    }
    slot.entry = entry;
    const opts: SessionRuntimeOpts = {
      sessionId,
      bin: this.#runtime.bin,
      sandboxRoot: this.#runtime.sandboxRoot,
      stateDir: this.#runtime.stateDir,
      ownerId,
      modelId: this.#runtime.modelId,
      tokens: generationTokens(slot, this.#pool, this.#store, this.#tokens),
      resumePath,
      onExit: () => {
        this.#onProcessExit(slot);
      },
      onApproval: (request) => {
        this.#approvals.register(slot, request);
      },
      ...(this.#runtime.idleMs === undefined ? {} : { idleMs: this.#runtime.idleMs }),
      ...(this.#runtime.ompUser === undefined ? {} : { ompUser: this.#runtime.ompUser }),
      ...(this.#runtime.spawnImpl === undefined ? {} : { spawnImpl: this.#runtime.spawnImpl }),
      ...(this.#runtime.clock === undefined ? {} : { clock: this.#runtime.clock }),
      ...(this.#runtime.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: this.#runtime.handshakeTimeoutMs }),
    };
    slot.runtime = new SessionRuntime(opts);
    this.#slots.set(sessionId, slot);
    try {
      await this.#bindDispatch(slot, text, assistantMessageId);
    } catch (error) {
      await this.#retireSlot(slot);
      throw error;
    }
  }

  /** Synchronous, never throws or writes stdin: free the capacity, retire only outside a turn. */
  #onProcessExit(slot: Slot): void {
    this.#pool.release(slot.entry);
    if (turnFree(slot)) {
      void this.#retireSlot(slot);
    }
  }

  async #bindDispatch(slot: Slot, text: string, assistantMessageId: number): Promise<void> {
    this.#pool.touch(slot.entry);
    const generation = slot.generation;
    if (generation !== undefined) {
      generation.dispatchCount += 1;
    }
    const stream = slot.runtime.prompt(text);
    let receipt: PromptDispatchReceipt;
    try {
      receipt = await stream.dispatched;
    } catch (error) {
      const acquisition = slot.acquisitionFault;
      slot.acquisitionFault = undefined;
      const live = slot.generation ?? generation;
      releaseDispatch(slot, live);
      await this.#abortPreProgress(slot, stream);
      throw acquisition ?? error;
    }
    try {
      this.#store.setSessionFile(slot.sessionId, receipt.sessionFile);
    } catch (error) {
      const live = slot.generation ?? generation;
      releaseDispatch(slot, live);
      await this.#abortPreProgress(slot, stream);
      throw error;
    }
    const pumpGeneration = slot.generation;
    if (pumpGeneration !== undefined) {
      pumpGeneration.pumpCount += 1;
    }
    const pump = this.#pump(slot, stream, assistantMessageId, receipt.requestId, pumpGeneration);
    slot.pump = pump;
    this.#pumps.add(pump);
    void pump.finally(() => {
      this.#pumps.delete(pump);
      releasePump(slot, pumpGeneration);
      this.#stops.release(assistantMessageId);
      releasePumpExit(this.#claims, slot, pump, assistantMessageId);
      this.#pool.touch(slot.entry);
      if (!this.#pool.holds(slot.entry) && turnFree(slot)) {
        void this.#retireSlot(slot);
      }
    });
    this.#stops.dispatched(slot, assistantMessageId);
  }

  async #abortPreProgress(slot: Slot, stream: AsyncIterable<unknown>): Promise<void> {
    const retiring = this.#retireSlot(slot);
    await drain(stream);
    await retiring;
  }

  #claim(slot: Slot, assistantMessageId: number): void {
    if (this.#claims.has(assistantMessageId)) {
      throw new HttpError("session_busy");
    }
    slot.claimedAssistantId = assistantMessageId;
    this.#claims.set(assistantMessageId, slot);
  }

  async #pump(
    slot: Slot,
    stream: AsyncIterable<OmpFrame>,
    assistantMessageId: number,
    requestId: string,
    generation: Generation | undefined,
  ): Promise<void> {
    let mapper = createEventState({ messageId: assistantMessageId, promptRequestId: requestId });
    const toolIds = new Map<string, number>();
    let ordinal = 0;
    const nextOrdinal = (): number => {
      const current = ordinal;
      ordinal += 1;
      return current;
    };
    try {
      for await (const frame of stream) {
        if (slot.infraFaulted) {
          break;
        }
        this.#pool.touch(slot.entry);
        const applied = applyFrame(mapper, frame);
        mapper = applied.state;
        if (
          !(await this.#commit(
            slot,
            assistantMessageId,
            applied.events,
            toolIds,
            nextOrdinal,
            generation,
          )) ||
          !(await this.#approvals.publishRequest(slot, frame))
        ) {
          return;
        }
      }
      if (slot.infraFaulted) {
        await this.#retireSlot(slot);
        return;
      }
      if (mapper.ended) {
        return;
      }
      if (
        !(await this.#commit(
          slot,
          assistantMessageId,
          [{ type: "turn.end", data: { messageId: assistantMessageId, status: "done" } }],
          toolIds,
          nextOrdinal,
          generation,
        ))
      ) {
        return;
      }
    } catch (error) {
      if (!slot.infraFaulted && !mapper.ended) {
        const applied = this.#failure(mapper, assistantMessageId, error);
        await this.#commit(
          slot,
          assistantMessageId,
          applied.events,
          toolIds,
          nextOrdinal,
          generation,
        );
      }
      if (!slot.infraFaulted) {
        await this.#retireSlot(slot);
      }
    }
  }

  /** Pump catch outcome: a stop past its grace ends `stopped` without error (#473). */
  #failure(mapper: ReturnType<typeof createEventState>, turn: number, error: unknown) {
    return this.#stops.expired(turn)
      ? applyStop(mapper)
      : applyFailure(mapper, asError(error).message);
  }

  async #commit(
    slot: Slot,
    assistantMessageId: number,
    events: ChatEvent<string>[],
    toolIds: Map<string, number>,
    nextOrdinal: () => number,
    generation: Generation | undefined,
  ): Promise<boolean> {
    for (const event of events) {
      try {
        const settled: SettledApproval[] = [];
        const published = persistEvent(
          this.#store,
          assistantMessageId,
          event,
          toolIds,
          nextOrdinal,
          settled,
        );
        if (settled.length > 0 && !(await this.#approvals.settled(settled))) {
          return false;
        }
        if (published !== undefined && !(await this.#publish(slot, published, generation))) {
          return false;
        }
      } catch (error) {
        slot.infraFaulted = true;
        this.#retain(asError(error));
        await this.#retireSlot(slot);
        return false;
      }
    }
    return true;
  }

  async #publish(
    slot: Slot,
    event: ChatEvent<number>,
    generation: Generation | undefined,
  ): Promise<boolean> {
    if (generation !== undefined && !generation.sealed) {
      generation.ring.push(event);
      const recorded = generation.ring.latest();
      if (recorded !== undefined) {
        this.#fanout(slot.sessionId, recorded);
      }
    }
    if (this.#onEvent === undefined) {
      return true;
    }
    try {
      const returned = this.#onEvent(slot.sessionId, generation?.epoch ?? slot.epoch, event);
      const violation = synchronousSinkViolation(returned);
      if (violation !== undefined) {
        throw violation;
      }
      return true;
    } catch (error) {
      slot.infraFaulted = true;
      this.#retain(asError(error));
      await this.#retireSlot(slot);
      return false;
    }
  }

  #readReplay(sessionId: string, lastEventId: string | null): RingRead {
    const generation = this.#slots.get(sessionId)?.generation;
    const turnRunning = this.#store.runtimeState(sessionId)?.activeTurn !== null;
    if (generation === undefined || generation.sealed) {
      if (lastEventId !== null || turnRunning) {
        return { mode: "gap", events: [] };
      }
      return { mode: "fresh", events: [] };
    }
    return generation.ring.since(lastEventId, { turnRunning });
  }

  #listenersFor(sessionId: string): Set<SessionStreamLiveHandler> {
    const existing = this.#subscribers.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<SessionStreamLiveHandler>();
    this.#subscribers.set(sessionId, created);
    return created;
  }

  #removeListener(sessionId: string, deliver: SessionStreamLiveHandler): void {
    const listeners = this.#subscribers.get(sessionId);
    if (listeners === undefined) {
      return;
    }
    listeners.delete(deliver);
    if (listeners.size === 0) {
      this.#subscribers.delete(sessionId);
    }
  }

  #fanout(sessionId: string, event: RetainedEvent): void {
    const listeners = this.#subscribers.get(sessionId);
    if (listeners === undefined) {
      return;
    }
    for (const deliver of [...listeners]) {
      try {
        deliver(event);
      } catch {
        this.#removeListener(sessionId, deliver);
      }
    }
  }

  async #retireSlot(slot: Slot): Promise<void> {
    if (slot.claimedAssistantId !== undefined) {
      releaseClaim(this.#claims, slot, slot.claimedAssistantId);
    }
    slot.retiring ??= slot.runtime.shutdown().catch((error: unknown) => {
      this.#retain(asError(error));
    });
    const generation = slot.generation;
    if (generation !== undefined) {
      generation.revoked = true;
      sealGeneration(slot, generation);
    }
    await slot.retiring;
    this.#pool.release(slot.entry);
    if (this.#slots.get(slot.sessionId) === slot) {
      this.#slots.delete(slot.sessionId);
    }
  }

  #retain(error: Error): void {
    this.#faults.push(error);
    try {
      const returned = this.#onError(error);
      const violation = synchronousSinkViolation(returned);
      if (violation !== undefined) {
        this.#faults.push(violation);
      }
    } catch (thrown) {
      this.#faults.push(asError(thrown));
    }
  }

  #translate(error: unknown): unknown {
    if (error instanceof HttpError) {
      return error;
    }
    if (error instanceof SessionBusyError) {
      return new HttpError("session_busy");
    }
    if (error instanceof AgentUnavailableError || error instanceof OmpProtocolError) {
      return new HttpError("agent_unavailable");
    }
    return error;
  }
}

function throwCollected(faults: Error[]): void {
  if (faults.length === 1) {
    throw faults[0];
  }
  if (faults.length > 1) {
    throw new AggregateError(faults, "session supervisor shutdown failed");
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function synchronousSinkViolation(returned: unknown): Error | undefined {
  if ((typeof returned !== "object" && typeof returned !== "function") || returned === null) {
    return undefined;
  }
  let then: unknown;
  try {
    then = "then" in returned ? returned.then : undefined;
  } catch (error) {
    return asError(error);
  }
  if (typeof then !== "function") {
    return undefined;
  }
  try {
    then.call(returned, undefined, () => undefined);
  } catch {
    /* a throwing then is containment, not a second reported violation */
  }
  return new Error("session observation sink must return synchronously");
}
