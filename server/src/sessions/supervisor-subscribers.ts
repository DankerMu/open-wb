/**
 * The session supervisor's live subscriber table (moved out of supervisor.ts unchanged, #526):
 * per-session deliver → onEnd registrations, fan-out that drops a throwing deliver, and the
 * end-every-subscriber step of retire.
 */
import type { RetainedEvent } from "./stream/ring-buffer.js";

export type SessionStreamLiveHandler = (event: RetainedEvent) => void;

type Listeners = Map<SessionStreamLiveHandler, (() => void) | undefined>;

export class SubscriberTable {
  readonly #sessions = new Map<string, Listeners>();

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
