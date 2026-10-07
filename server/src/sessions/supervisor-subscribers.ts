/**
 * The session supervisor's live subscriber table (moved out of supervisor.ts unchanged, #526):
 * per-session deliver → onEnd registrations, fan-out that drops a throwing deliver, and the
 * end-every-subscriber step of retire.
 */
import type { Generation } from "./pool.js";
import type { RetainedEvent, RingRead } from "./stream/ring-buffer.js";
import type { SessionStreamSubscription, StreamCursor } from "./supervisor.js";

export type SessionStreamLiveHandler = (event: RetainedEvent) => void;

type Listeners = Map<SessionStreamLiveHandler, (() => void) | undefined>;

/** A subscriber's replay: without a live unsealed generation a cursor or a running turn is a gap. */
export function readReplay(
  generation: Generation | undefined,
  lastEventId: string | null,
  turnRunning: boolean,
): RingRead {
  if (generation === undefined || generation.sealed) {
    if (lastEventId !== null || turnRunning) {
      return { mode: "gap", events: [] };
    }
    return { mode: "fresh", events: [] };
  }
  return generation.ring.since(lastEventId, { turnRunning });
}

/** The live unsealed generation's epoch and ring sequence; else the stored epoch, read only then. */
export function streamCursorOf(
  generation: Generation | undefined,
  storedState: () => { streamEpoch: number } | null,
): StreamCursor {
  if (generation !== undefined && !generation.sealed) {
    return { epoch: generation.epoch, seq: generation.ring.sequence };
  }
  const state = storedState();
  return { epoch: state?.streamEpoch ?? 0, seq: null };
}

/** A closed supervisor's subscription: nothing registered, nothing replayed. */
export function closedSubscription(): SessionStreamSubscription {
  return {
    mode: "fresh",
    replay: [],
    unsubscribe() {},
  };
}

export class SubscriberTable {
  readonly #sessions = new Map<string, Listeners>();

  /**
   * Registers the subscriber before reading its replay, so no event published in between is
   * lost; a failed read unregisters it and rethrows.
   */
  subscribe(
    sessionId: string,
    deliver: SessionStreamLiveHandler,
    onEnd: (() => void) | undefined,
    read: () => RingRead,
  ): SessionStreamSubscription {
    this.add(sessionId, deliver, onEnd);
    let replay: RingRead;
    try {
      replay = read();
    } catch (error) {
      this.remove(sessionId, deliver);
      throw error;
    }
    return {
      mode: replay.mode,
      replay: replay.events,
      unsubscribe: () => {
        this.remove(sessionId, deliver);
      },
    };
  }

  add(sessionId: string, deliver: SessionStreamLiveHandler, onEnd: (() => void) | undefined) {
    let listeners = this.#sessions.get(sessionId);
    if (listeners === undefined) {
      listeners = new Map();
      this.#sessions.set(sessionId, listeners);
    }
    listeners.set(deliver, onEnd);
  }

  remove(sessionId: string, deliver: SessionStreamLiveHandler): void {
    const listeners = this.#sessions.get(sessionId);
    if (listeners === undefined) {
      return;
    }
    listeners.delete(deliver);
    if (listeners.size === 0) {
      this.#sessions.delete(sessionId);
    }
  }

  count(sessionId: string): number {
    return this.#sessions.get(sessionId)?.size ?? 0;
  }

  fanout(sessionId: string, event: RetainedEvent): void {
    const listeners = this.#sessions.get(sessionId);
    if (listeners === undefined) {
      return;
    }
    for (const deliver of [...listeners.keys()]) {
      try {
        deliver(event);
      } catch {
        this.remove(sessionId, deliver);
      }
    }
  }

  /** Drops the session's registrations, then ends each through its onEnd without an event. */
  endAll(sessionId: string): void {
    const listeners = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    for (const onEnd of listeners?.values() ?? []) {
      try {
        onEnd?.();
      } catch {
        /* one subscriber's close cannot keep the others open (mirrors fanout) */
      }
    }
  }

  clear(): void {
    this.#sessions.clear();
  }
}
