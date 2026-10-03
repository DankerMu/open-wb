/**
 * Issue #100 session supervisor: dispatch, persistence, and owned lifecycle. #519: thinking deltas
 * are merged per slot (thinking-buffer.ts) and flushed before any other event of the slot enters
 * the ring.
 */
import { availableParallelism } from "node:os";
import { DEFAULT_OMP_MAX_PROCESSES } from "../agent-config.js";
import { HttpError } from "../core/errors/index.js";
import { ApprovalRegistry } from "./approvals.js";
import { type ForkResult, Forks, Regenerations, type Resume } from "./branching.js";
import { applyFailure, applyFrame, applyStop, type ChatEvent, createEventState } from "./events.js";
import type { OmpFrame } from "./omp/frame.js";
import type { SpawnImpl } from "./omp/process.js";
import { type PromptDispatchReceipt, type SessionClock, SessionRuntime } from "./omp/runtime.js";
import { SpawnGate, type SpawnLog } from "./omp/spawn-gate.js";
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
  type SpawnShared,
  sealGeneration,
  sessionRuntimeOpts,
  turnFree,
} from "./pool.js";
import { sessionCwdResolver, type WorkspaceRootOf } from "./session-cwd.js";
import type { ApprovalView, SessionStore, SettledApproval } from "./store.js";
import type { RetainedEvent, RingRead } from "./stream/ring-buffer.js";
import {
  asError,
  synchronousSinkViolation,
  throwCollected,
  translateSupervisorError,
} from "./supervisor-faults.js";
import { type SessionStreamLiveHandler, SubscriberTable } from "./supervisor-subscribers.js";
import { ThinkingBuffers } from "./thinking-buffer.js";
import type { TokenRegistry } from "./tokens.js";
import { ControlClaims, drain, persistEvent, TurnStops } from "./turn-control.js";

export { releasePumpExit } from "./pool.js";

export interface StreamCursor {
  epoch: number;
  seq: number | null;
}

export type { SessionStreamLiveHandler } from "./supervisor-subscribers.js";

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
  /** Concurrent spawn cap resolved by agent-config; undefined → os.availableParallelism(). */
  spawnConcurrency?: number;
  ompUser?: string;
  spawnImpl?: SpawnImpl;
  clock?: SessionClock;
  handshakeTimeoutMs?: number;
}

export interface SessionSupervisorOptions {
  store: SessionStore;
  tokens: TokenRegistry;
  runtime: SessionSupervisorRuntime;
  /** The workspace store's owner-scoped rootOf: a bound session's cwd (session-cwd.ts). */
  workspaceRootOf: WorkspaceRootOf;
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
  /** Synchronous handshake-timeout record sink, never an onError fault; omitted → discarded. */
  log?: SpawnLog;
  /** The skills of a session's cwd right now, for the branch-family command check (branching.ts). */
  skills: (ownerId: string, workspaceId: string | null) => readonly { name: string }[];
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
  readonly #subscribers = new SubscriberTable();
  readonly #claims = new Map<number, Slot>();
  readonly #admissions = new Set<Promise<unknown>>();
  readonly #pumps = new Set<Promise<void>>();
  readonly #faults: Error[] = [];
  readonly #pool: ProcessPool;
  readonly #spawn: SpawnShared;
  readonly #approvals: ApprovalRegistry;
  readonly #stops: TurnStops;
  readonly #thinking: ThinkingBuffers;
  readonly #controls = new ControlClaims();
  readonly #regenerations: Regenerations;
  readonly #forks: Forks;
  readonly #cwdOf: ReturnType<typeof sessionCwdResolver>;
  #closed = false;

  constructor(options: SessionSupervisorOptions) {
    this.#store = options.store;
    this.#tokens = options.tokens;
    this.#runtime = options.runtime;
    this.#onError = options.onError;
    this.#onEvent = options.onEvent;
    this.#cwdOf = sessionCwdResolver(options.runtime.sandboxRoot, options.workspaceRootOf);
    const clock = options.runtime.clock;
    this.#pool = new ProcessPool(
      options.runtime.maxProcesses ?? DEFAULT_OMP_MAX_PROCESSES,
      clock === undefined ? () => Date.now() : () => clock.now(),
    );
    this.#spawn = {
      spawnGate: new SpawnGate(options.runtime.spawnConcurrency ?? availableParallelism()),
      log: options.log ?? (() => {}),
    };
    this.#approvals = new ApprovalRegistry({
      store: this.#store,
      clock,
      publish: (slot, event, generation) => this.#publish(slot, event, generation),
      fault: (slot, error) => this.#faultSlot(slot, error),
    });
    this.#thinking = new ThinkingBuffers({
      clock,
      append: (messageId, chunk) => this.#store.appendThinking(messageId, chunk),
      publish: (slot, event, generation) => this.#pushNow(slot, event, generation),
      fault: (slot, error) => this.#faultSlot(slot, error),
    });
    this.#stops = new TurnStops({
      clock,
      pending: (slot) => this.#approvals.pendingFor(slot),
      deny: (sessionId, approvalId) => this.#approvals.decide(sessionId, approvalId, "deny"),
      retire: (slot) => this.#retireSlot(slot),
    });
    this.#regenerations = new Regenerations({
      store: this.#store,
      controls: this.#controls,
      stops: this.#stops,
      closed: () => this.#closed,
      live: (slot) => this.#pool.holds(slot.entry),
      acquire: async (sessionId, resume, use) => {
        await this.#slots.get(sessionId)?.retiring;
        if (this.#closed) {
          throw new HttpError("agent_unavailable");
        }
        return this.#onSlot(sessionId, resume, undefined, use);
      },
      dispatch: (slot, text, assistantMessageId) => {
        this.#claim(slot, assistantMessageId);
        return this.#bindDispatch(slot, text, assistantMessageId);
      },
      settled: (settled) => this.#approvals.settled(settled),
      skills: options.skills,
    });
    this.#forks = new Forks({
      store: this.#store,
      controls: this.#controls,
      pool: this.#pool,
      tokens: this.#tokens,
      config: this.#runtime,
      spawn: this.#spawn,
      closed: () => this.#closed,
      cwdOf: this.#cwdOf,
      retireSource: (sessionId) => {
        const slot = this.#slots.get(sessionId);
        return slot === undefined ? Promise.resolve() : this.#retireSlot(slot);
      },
      skills: options.skills,
    });
  }

  prompt(sessionId: string, text: string): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new HttpError("agent_unavailable"));
    }
    return this.#track(this.#prompt(sessionId, text));
  }

  /** Regenerates the last answer (#465); REST is #467. Every failure is a rejection. */
  regenerate(sessionId: string, ownerId: string): Promise<{ assistantMessageId: number }> {
    return this.#control(() => this.#regenerations.run(sessionId, ownerId));
  }

  /** Forks at a user message of the session (#466); REST is #469. Every failure is a rejection. */
  fork(sessionId: string, ownerId: string, messageId: number): Promise<ForkResult> {
    return this.#control(() => this.#forks.run(sessionId, ownerId, messageId));
  }

  /**
   * Registers one hold on the session's control claim (#465); the returned release takes effect
   * once.
   */
  holdControl(sessionId: string): () => void {
    return this.#controls.hold(sessionId);
  }

  /** Synchronous: whether a regenerate, fork or stop holds this session's control claim. */
  controlHeld(sessionId: string): boolean {
    return this.#controls.held(sessionId);
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
    onEnd?: () => void,
  ): SessionStreamSubscription {
    if (this.#closed) {
      return {
        mode: "fresh",
        replay: [],
        unsubscribe() {},
      };
    }
    this.#subscribers.add(sessionId, deliver, onEnd);
    let replay: RingRead;
    try {
      replay = this.#readReplay(sessionId, lastEventId);
    } catch (error) {
      this.#subscribers.remove(sessionId, deliver);
      throw error;
    }
    return {
      mode: replay.mode,
      replay: replay.events,
      unsubscribe: () => {
        this.#subscribers.remove(sessionId, deliver);
      },
    };
  }

  sessionStreamSubscriberCount(sessionId: string): number {
    return this.#subscribers.count(sessionId);
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
    return this.#controls.during(sessionId, () => {
      const turn = this.#store.runtimeState(sessionId)?.activeTurn?.assistantMessageId;
      if (turn === undefined) {
        return Promise.resolve();
      }
      const slot = this.#claims.get(turn);
      return this.#stops.stop(this.#slots.get(sessionId) === slot ? slot : undefined, turn);
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#approvals.close();
    this.#subscribers.clear();
    // Temporary fork processes are not slots; closing them first lets a held command return.
    const retirements: Promise<void>[] = [this.#forks.close()];
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

  /**
   * Deletion's recycle primitive: first drains the in-flight pump (so a terminal event persisted
   * just before still reaches the subscribers, #526), then retires the live generation (bounded
   * runtime shutdown, token revocation, cap release, generation seal), awaits native exit, drops
   * the slot and its ring, then ends every subscriber through its onEnd without publishing an
   * event. Writes no SQLite row; without a live slot it only ends subscribers. Precondition: the
   * session is not running (`activeTurn === null`) — a running turn's shutdown failure path would
   * persist and publish.
   */
  async retire(sessionId: string): Promise<void> {
    const slot = this.#slots.get(sessionId);
    if (slot !== undefined) {
      await slot.pump?.catch(() => undefined);
      await this.#retireSlot(slot);
    }
    this.#subscribers.endAll(sessionId);
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
    if (claimed !== undefined || this.#controls.held(sessionId)) {
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
    try {
      await this.#onSlot(sessionId, state, assistantMessageId, (slot) =>
        this.#bindDispatch(slot, text, assistantMessageId),
      );
    } catch (error) {
      this.#stops.release(assistantMessageId);
      throw translateSupervisorError(error);
    }
  }

  /** The regenerate/fork entry: closed check, error translation, tracked for shutdown. */
  #control<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new HttpError("agent_unavailable"));
    }
    const work = run().catch((error: unknown) => {
      throw translateSupervisorError(error);
    });
    return this.#track(work);
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#admissions.add(work);
    return work.finally(() => {
      this.#admissions.delete(work);
    });
  }

  /** Live-slot reuse (claimed when `claim` is set); one fresh admission on re-admission. */
  async #onSlot<T>(
    sessionId: string,
    resume: Resume,
    claim: number | undefined,
    use: (slot: Slot) => Promise<T>,
  ): Promise<T> {
    const live = this.#slots.get(sessionId);
    const fresh = () => this.#onNewSlot(sessionId, resume, claim, use);
    if (live === undefined || live.retiring !== undefined || !this.#pool.holds(live.entry)) {
      return fresh();
    }
    if (claim !== undefined) {
      this.#claim(live, claim);
    }
    try {
      return await use(live);
    } catch (error) {
      if (live.pump === undefined) {
        await this.#retireSlot(live);
      }
      if (!(error instanceof ReadmissionRequired)) {
        throw error;
      }
      return fresh();
    }
  }

  async #onNewSlot<T>(
    sessionId: string,
    resume: Resume,
    claim: number | undefined,
    use: (slot: Slot) => Promise<T>,
  ): Promise<T> {
    // First, before any claim or admission: an unusable root spawns nothing and holds nothing.
    const cwd = this.#cwdOf(resume.ownerId, resume.workspaceId);
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
      workspaceRoot: resume.workspaceId === null ? null : cwd,
    };
    const unclaim = () => {
      if (claim !== undefined) {
        releaseClaim(this.#claims, slot, claim);
      }
    };
    if (claim !== undefined) {
      this.#claim(slot, claim);
    }
    let entry: PoolEntry;
    try {
      entry = await this.#pool.admit({
        busy: () => !turnFree(slot) || this.#controls.held(sessionId),
        retire: () => this.#retireSlot(slot),
      });
    } catch (error) {
      unclaim();
      throw error;
    }
    if (this.#closed) {
      this.#pool.release(entry);
      unclaim();
      throw new HttpError("agent_unavailable");
    }
    slot.entry = entry;
    slot.runtime = new SessionRuntime(
      sessionRuntimeOpts(this.#runtime, this.#spawn, {
        sessionId,
        ownerId: resume.ownerId,
        cwd,
        resumePath: resume.ompSessionFile,
        tokens: generationTokens(slot, this.#pool, this.#store, this.#tokens),
        onExit: () => {
          this.#onProcessExit(slot);
        },
        onApproval: (request) => {
          this.#approvals.register(slot, request);
        },
      }),
    );
    this.#slots.set(sessionId, slot);
    try {
      return await use(slot);
    } catch (error) {
      await this.#retireSlot(slot);
      throw error;
    }
  }

  /**
   * Synchronous, never throws or writes stdin: free the capacity, retire only outside a turn and
   * outside a control claim (whose own failure path or pump end then retires the slot).
   */
  #onProcessExit(slot: Slot): void {
    this.#pool.release(slot.entry);
    if (turnFree(slot) && !this.#controls.held(slot.sessionId)) {
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
      // Every non-fault pump exit already released its turn: a still-active one is an orphan.
      this.#store.faultTurn(assistantMessageId, new Error("turn outlived its event pump"));
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
      // thinking.delta goes to the slot's buffer, never to persistEvent; any other event (also
      // files.changed) flushes it first, so a failed flush leaves no stored terminal off the ring.
      const thinking = event.type === "thinking.delta";
      const buffered = thinking
        ? this.#thinking.add(slot, generation, assistantMessageId, event.data.delta)
        : this.#thinking.flush(slot);
      if (!buffered) {
        return false;
      }
      if (thinking) {
        continue;
      }
      try {
        const settled: SettledApproval[] = [];
        const published = persistEvent(
          this.#store,
          assistantMessageId,
          event,
          toolIds,
          nextOrdinal,
          settled,
          slot.workspaceRoot,
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

  /**
   * Every non-thinking publication: the slot's buffered thinking is flushed first, in the same
   * synchronous segment as this event's ring push (no await between them), so a timer or a REST
   * settlement cannot interleave and the ring keeps the upstream arrival order. A no-op on
   * the pump path (#commit already flushed); the approval publications rely on it.
   */
  async #publish(
    slot: Slot,
    event: ChatEvent<number>,
    generation: Generation | undefined,
  ): Promise<boolean> {
    if (this.#thinking.flush(slot) && this.#pushNow(slot, event, generation)) {
      return true;
    }
    await this.#retireSlot(slot);
    return false;
  }

  /** The one ring push: ring, fanout and observer, synchronously; a sink failure faults. */
  #pushNow(slot: Slot, event: ChatEvent<number>, generation: Generation | undefined): boolean {
    if (generation !== undefined && !generation.sealed) {
      generation.ring.push(event);
      const recorded = generation.ring.latest();
      if (recorded !== undefined) {
        this.#subscribers.fanout(slot.sessionId, recorded);
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
      this.#faultSlot(slot, asError(error));
      return false;
    }
  }

  /** Owned error sink: retain, mark the slot infra-faulted and retire it without awaiting. */
  #faultSlot(slot: Slot, error: Error): void {
    slot.infraFaulted = true;
    this.#retain(error);
    void this.#retireSlot(slot);
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
    if (slot.infraFaulted) {
      this.#thinking.discard(slot);
      for (const error of this.#approvals.abandon(slot)) this.#retain(error);
    } else {
      this.#thinking.clearTimer(slot);
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
}
