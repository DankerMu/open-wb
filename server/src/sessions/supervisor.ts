/**
 * Issue #100 session supervisor: dispatch, persistence, and owned lifecycle.
 */
import { HttpError } from "../core/errors/index.js";
import { applyFailure, applyFrame, type ChatEvent, createEventState } from "./events.js";
import type { OmpFrame } from "./omp/frame.js";
import { AgentUnavailableError, OmpProtocolError, type SpawnImpl } from "./omp/process.js";
import {
  type PromptDispatchReceipt,
  SessionBusyError,
  type SessionClock,
  SessionRuntime,
  type SessionRuntimeOpts,
} from "./omp/runtime.js";
import type { SessionStore } from "./store.js";
import type { TokenRegistry } from "./tokens.js";

export interface SessionSupervisorRuntime {
  bin: string;
  sandboxRoot: string;
  stateDir: string;
  modelId: string;
  idleMs?: number;
  ompUser?: string;
  spawnImpl?: SpawnImpl;
  clock?: SessionClock;
  handshakeTimeoutMs?: number;
}

export interface SessionSupervisorOptions {
  store: SessionStore;
  tokens: TokenRegistry;
  runtime: SessionSupervisorRuntime;
  onError: (error: Error) => void;
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
}

interface FlushFailure {
  sessionId: string;
  assistantMessageId: number;
  error: unknown;
}

interface Slot {
  sessionId: string;
  runtime: SessionRuntime;
  epoch: number;
  claimedAssistantId: number | undefined;
  pump: Promise<void> | undefined;
  retiring: Promise<void> | undefined;
  acquisitionFault: unknown;
  infraFaulted: boolean;
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
  readonly #claims = new Map<number, Slot>();
  readonly #admissions = new Set<Promise<void>>();
  readonly #pumps = new Set<Promise<void>>();
  readonly #faults: Error[] = [];
  #closed = false;

  constructor(options: SessionSupervisorOptions) {
    this.#store = options.store;
    this.#tokens = options.tokens;
    this.#runtime = options.runtime;
    this.#onError = options.onError;
    this.#onEvent = options.onEvent;
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

  async shutdown(): Promise<void> {
    this.#closed = true;
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
    try {
      if (live === undefined || live.retiring !== undefined) {
        await this.#dispatchNew(
          sessionId,
          text,
          state.ownerId,
          state.ompSessionFile,
          assistantMessageId,
        );
        return;
      }
      this.#claim(live, assistantMessageId);
      try {
        await this.#bindDispatch(live, text, assistantMessageId);
      } catch (error) {
        if (live.pump === undefined) {
          await this.#retireSlot(live);
        }
        throw error;
      }
    } catch (error) {
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
      claimedAssistantId: undefined,
      pump: undefined,
      retiring: undefined,
      acquisitionFault: undefined,
      infraFaulted: false,
    };
    this.#claim(slot, assistantMessageId);
    const opts: SessionRuntimeOpts = {
      sessionId,
      bin: this.#runtime.bin,
      sandboxRoot: this.#runtime.sandboxRoot,
      stateDir: this.#runtime.stateDir,
      ownerId,
      modelId: this.#runtime.modelId,
      tokens: this.#adapter(slot),
      resumePath,
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

  async #bindDispatch(slot: Slot, text: string, assistantMessageId: number): Promise<void> {
    const stream = slot.runtime.prompt(text);
    let receipt: PromptDispatchReceipt;
    try {
      receipt = await stream.dispatched;
    } catch (error) {
      const acquisition = slot.acquisitionFault;
      slot.acquisitionFault = undefined;
      await this.#abortPreProgress(slot, stream);
      throw acquisition ?? error;
    }
    try {
      this.#store.setSessionFile(slot.sessionId, receipt.sessionFile);
    } catch (error) {
      await this.#abortPreProgress(slot, stream);
      throw error;
    }
    const pump = this.#pump(slot, stream, assistantMessageId, receipt.requestId);
    slot.pump = pump;
    this.#pumps.add(pump);
    void pump.finally(() => {
      this.#pumps.delete(pump);
      if (slot.pump === pump) {
        slot.pump = undefined;
        this.#releaseClaim(slot, assistantMessageId);
      }
    });
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

  #releaseClaim(slot: Slot, assistantMessageId: number): void {
    if (this.#claims.get(assistantMessageId) === slot) {
      this.#claims.delete(assistantMessageId);
    }
    if (slot.claimedAssistantId === assistantMessageId) {
      slot.claimedAssistantId = undefined;
    }
  }

  async #pump(
    slot: Slot,
    stream: AsyncIterable<OmpFrame>,
    assistantMessageId: number,
    requestId: string,
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
        const applied = applyFrame(mapper, frame);
        mapper = applied.state;
        if (!(await this.#commit(slot, assistantMessageId, applied.events, toolIds, nextOrdinal))) {
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
        ))
      ) {
        return;
      }
    } catch (error) {
      if (!slot.infraFaulted && !mapper.ended) {
        const applied = applyFailure(mapper, asError(error).message);
        await this.#commit(slot, assistantMessageId, applied.events, toolIds, nextOrdinal);
      }
      if (!slot.infraFaulted) {
        await this.#retireSlot(slot);
      }
    }
  }

  async #commit(
    slot: Slot,
    assistantMessageId: number,
    events: ChatEvent<string>[],
    toolIds: Map<string, number>,
    nextOrdinal: () => number,
  ): Promise<boolean> {
    for (const event of events) {
      try {
        const published = persistEvent(
          this.#store,
          assistantMessageId,
          event,
          toolIds,
          nextOrdinal,
        );
        if (published !== undefined && !(await this.#publish(slot, published))) {
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

  async #publish(slot: Slot, event: ChatEvent<number>): Promise<boolean> {
    if (this.#onEvent === undefined) {
      return true;
    }
    try {
      this.#onEvent(slot.sessionId, slot.epoch, event);
      return true;
    } catch (error) {
      slot.infraFaulted = true;
      this.#retain(asError(error));
      await this.#retireSlot(slot);
      return false;
    }
  }

  #adapter(slot: Slot): { issue(sessionId: string): string; revoke(sessionId: string): void } {
    return {
      issue: (sessionId: string) => {
        slot.acquisitionFault = undefined;
        try {
          slot.epoch = this.#store.bumpStreamEpoch(sessionId);
        } catch (error) {
          slot.acquisitionFault = error;
          throw error;
        }
        try {
          return this.#tokens.issue(sessionId);
        } catch (error) {
          slot.acquisitionFault = error;
          throw error;
        }
      },
      revoke: (sessionId: string) => {
        this.#tokens.revoke(sessionId);
      },
    };
  }

  async #retireSlot(slot: Slot): Promise<void> {
    if (slot.claimedAssistantId !== undefined) {
      this.#releaseClaim(slot, slot.claimedAssistantId);
    }
    slot.retiring ??= slot.runtime.shutdown().catch((error: unknown) => {
      this.#retain(asError(error));
    });
    await slot.retiring;
    if (this.#slots.get(slot.sessionId) === slot) {
      this.#slots.delete(slot.sessionId);
    }
  }

  #retain(error: Error): void {
    this.#faults.push(error);
    try {
      this.#onError(error);
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

function persistEvent(
  store: SessionStore,
  assistantMessageId: number,
  event: ChatEvent<string>,
  toolIds: Map<string, number>,
  nextOrdinal: () => number,
): ChatEvent<number> | undefined {
  switch (event.type) {
    case "turn.start":
    case "error":
      return event;
    case "text.delta":
      store.appendDelta(assistantMessageId, event.data.delta);
      return event;
    case "step.start": {
      const stepId = store.startStep(assistantMessageId, {
        ordinal: nextOrdinal(),
        name: event.data.name,
        detail: event.data.detail,
      });
      toolIds.set(event.data.stepId, stepId);
      return {
        type: "step.start",
        data: {
          messageId: event.data.messageId,
          stepId,
          name: event.data.name,
          detail: event.data.detail,
        },
      };
    }
    case "step.end": {
      const stepId = toolIds.get(event.data.stepId);
      if (stepId === undefined) {
        return undefined;
      }
      store.finishStep(stepId, event.data.status, event.data.detail);
      return {
        type: "step.end",
        data: {
          messageId: event.data.messageId,
          stepId,
          status: event.data.status,
          detail: event.data.detail,
        },
      };
    }
    case "turn.end":
      store.finishTurn(assistantMessageId, event.data.status);
      return event;
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

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _frame of stream) {
      /* discard buffered frames after pre-progress failure */
    }
  } catch {
    /* iterator already failed */
  }
}
