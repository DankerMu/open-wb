/**
 * Turn control: event persistence, post-failure stream draining, and the #473 stop of a
 * dispatched turn (Deny the entry snapshot of pending approvals, write `abort`, then wait
 * OMP_ABORT_GRACE_MS on the injected clock for agent_end before falling back to retire).
 * A stop before the dispatch receipt (#490) registers an intent, honored once the receipt is.
 */
import { HttpError } from "../core/errors/index.js";
import type { ChatEvent } from "./events.js";
import type { SessionClock } from "./omp/runtime.js";
import type { Slot } from "./pool.js";
import type { SessionStore, SettledApproval } from "./store.js";

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
  /** Stop arrived before the dispatch receipt: `abort` is owed once the receipt is honored. */
  intent: boolean;
}

/** Per-turn (assistantMessageId) stop state: one abort, one grace, one fallback per turn. */
export class TurnStops {
  readonly #ports: StopPorts;
  readonly #clock: SessionClock;
  readonly #entries = new Map<number, StopEntry>();
  /** Per-turn dispatch phase, from the prompt's first claim check until `release`. */
  readonly #phases = new Map<number, "dispatching" | "dispatched">();

  constructor(ports: StopPorts) {
    this.#ports = ports;
    this.#clock = ports.clock ?? systemClock;
  }

  /** The turn's prompt entered dispatch; never downgrades a turn already dispatched. */
  open(assistantMessageId: number): void {
    if (!this.#phases.has(assistantMessageId)) {
      this.#phases.set(assistantMessageId, "dispatching");
    }
  }

  /**
   * Resolves once `abort` is written, or once the intent is registered when the turn has no
   * dispatched prompt yet (`slot` undefined: no runtime to ask); a repeated stop joins the first.
   */
  stop(slot: Slot | undefined, assistantMessageId: number): Promise<void> {
    const existing = this.#entries.get(assistantMessageId);
    if (existing !== undefined) {
      return existing.promise;
    }
    let adopt!: (work: Promise<void>) => void;
    const promise = new Promise<void>((resolve) => {
      adopt = resolve;
    });
    // Registered before #run: a re-entrant stop from a synchronous publish joins this promise.
    const entry: StopEntry = { promise, timer: undefined, expired: false, intent: false };
    this.#entries.set(assistantMessageId, entry);
    adopt(this.#run(slot, assistantMessageId, entry));
    return promise;
  }

  /** True once this turn's grace ran out and its runtime was sent to retire. */
  expired(assistantMessageId: number): boolean {
    return this.#entries.get(assistantMessageId)?.expired === true;
  }

  /**
   * Receipt honored and pump registered: synchronous, never throws. A registered intent writes
   * its one `abort` on this slot's runtime; a `false` answer (child gone) drops it.
   */
  dispatched(slot: Slot, assistantMessageId: number): void {
    this.#phases.set(assistantMessageId, "dispatched");
    const entry = this.#entries.get(assistantMessageId);
    if (entry?.intent !== true) {
      return;
    }
    entry.intent = false;
    const answer = slot.runtime.abort();
    if (answer === false) {
      this.#drop(assistantMessageId);
      return;
    }
    this.#arm(slot, assistantMessageId, entry, answer);
  }

  /** Turn end or failed dispatch: revoke the grace and forget the turn and its phase. */
  release(assistantMessageId: number): void {
    this.#phases.delete(assistantMessageId);
    this.#drop(assistantMessageId);
  }

  /** Forget this turn's stop (grace, intent) but keep its phase. */
  #drop(assistantMessageId: number): void {
    const entry = this.#entries.get(assistantMessageId);
    if (entry !== undefined) {
      this.#clock.clearTimeout(entry.timer);
      this.#entries.delete(assistantMessageId);
    }
  }

  /** The snapshot read and the first deny call run before any await (synchronous prefix). */
  async #run(slot: Slot | undefined, assistantMessageId: number, entry: StopEntry): Promise<void> {
    if (slot !== undefined) {
      try {
        for (const approvalId of this.#ports.pending(slot)) {
          await this.#ports.deny(slot.sessionId, approvalId).catch(skipSettled);
        }
      } catch (error) {
        this.#drop(assistantMessageId);
        throw error;
      }
    }
    const answer = slot === undefined ? false : slot.runtime.abort();
    if (slot === undefined || answer === false) {
      if (this.#phases.get(assistantMessageId) === "dispatching") {
        entry.intent = true;
      } else {
        this.#drop(assistantMessageId);
      }
      return;
    }
    this.#arm(slot, assistantMessageId, entry, answer);
  }

  /** The abort's rejection is consumed in this same synchronous segment; then the grace. */
  #arm(slot: Slot, assistantMessageId: number, entry: StopEntry, answer: Promise<unknown>): void {
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
  settled: SettledApproval[],
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
      store.finishTurn(assistantMessageId, event.data.status, settled);
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
