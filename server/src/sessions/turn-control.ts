/**
 * Turn control: event persistence, post-failure stream draining, and the #473 stop of a
 * dispatched turn (Deny the entry snapshot of pending approvals, write `abort`, then wait
 * OMP_ABORT_GRACE_MS on the injected clock for agent_end before falling back to retire).
 */
import { HttpError } from "../core/errors/index.js";
import type { ChatEvent } from "./events.js";
import type { SessionClock } from "./omp/runtime.js";
import type { Slot } from "./pool.js";
import type { SessionStore } from "./store.js";

const OMP_ABORT_GRACE_MS = 8000;

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => {
    clearTimeout(id as NodeJS.Timeout);
  },
};

interface StopPorts {
  clock: SessionClock | undefined;
  /** Pending approvalIds of the slot, ascending. */
  pending(slot: Slot): number[];
  /** The owner-answer settlement with `deny`. */
  deny(sessionId: string, approvalId: number): Promise<unknown>;
  /** Existing slot retirement; never rejects. */
  retire(slot: Slot): Promise<void>;
}

interface StopEntry {
  promise: Promise<void>;
  timer: unknown;
  expired: boolean;
}

/** Per-turn (assistantMessageId) stop state: one abort, one grace, one fallback per turn. */
export class TurnStops {
  readonly #ports: StopPorts;
  readonly #clock: SessionClock;
  readonly #entries = new Map<number, StopEntry>();

  constructor(ports: StopPorts) {
    this.#ports = ports;
    this.#clock = ports.clock ?? systemClock;
  }

  /** Resolves once `abort` is written; a repeated stop of the same turn joins the first. */
  stop(slot: Slot, assistantMessageId: number): Promise<void> {
    const existing = this.#entries.get(assistantMessageId);
    if (existing !== undefined) {
      return existing.promise;
    }
    let adopt!: (work: Promise<void>) => void;
    const promise = new Promise<void>((resolve) => {
      adopt = resolve;
    });
    // Registered before #run: a re-entrant stop from a synchronous publish joins this promise.
    const entry: StopEntry = { promise, timer: undefined, expired: false };
    this.#entries.set(assistantMessageId, entry);
    adopt(this.#run(slot, assistantMessageId, entry));
    return promise;
  }

  /** True once this turn's grace ran out and its runtime was sent to retire. */
  expired(assistantMessageId: number): boolean {
    return this.#entries.get(assistantMessageId)?.expired === true;
  }

  /** Turn end: revoke the grace and forget the turn. */
  release(assistantMessageId: number): void {
    const entry = this.#entries.get(assistantMessageId);
    if (entry !== undefined) {
      this.#clock.clearTimeout(entry.timer);
      this.#entries.delete(assistantMessageId);
    }
  }

  /** The snapshot read and the first deny call run before any await (synchronous prefix). */
  async #run(slot: Slot, assistantMessageId: number, entry: StopEntry): Promise<void> {
    try {
      for (const approvalId of this.#ports.pending(slot)) {
        await this.#ports.deny(slot.sessionId, approvalId).catch(skipSettled);
      }
    } catch (error) {
      this.release(assistantMessageId);
      throw error;
    }
    const answer = slot.runtime.abort();
    if (answer === false) {
      this.release(assistantMessageId);
      return;
    }
    answer.catch(() => undefined);
    entry.timer = this.#clock.setTimeout(() => {
      this.#expire(slot, assistantMessageId, entry);
    }, OMP_ABORT_GRACE_MS);
  }

  /** Grace callback: synchronous, never throws. Without a pump nothing else releases the turn. */
  #expire(slot: Slot, assistantMessageId: number, entry: StopEntry): void {
    entry.expired = true;
    if (slot.pump === undefined) {
      this.release(assistantMessageId);
    }
    void this.#ports.retire(slot);
  }
}

/** Answered concurrently after the snapshot, or cascaded away: already settled, skip it. */
function skipSettled(error: unknown): void {
  if (
    !(
      error instanceof HttpError &&
      (error.code === "approval_settled" || error.code === "not_found")
    )
  ) {
    throw error;
  }
}

export function persistEvent(
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
      store.finishStep(stepId, event.data.status, event.data.output);
      return {
        type: "step.end",
        data: {
          messageId: event.data.messageId,
          stepId,
          status: event.data.status,
          output: event.data.output,
        },
      };
    }
    case "turn.end":
      store.finishTurn(assistantMessageId, event.data.status);
      return event;
  }
}

export async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _frame of stream) {
      /* discard buffered frames after pre-progress failure */
    }
  } catch {
    /* iterator already failed */
  }
}
