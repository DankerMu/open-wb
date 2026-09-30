/**
 * Issue #519 thinking merge buffers: at most one per slot, holding the current turn's
 * not yet published thinking deltas in arrival order. A buffer is flushed as one `thinking.delta`
 * once it reaches 2048 UTF-8 bytes, 2000 ms (injected clock) after its first delta, or when the
 * supervisor is about to publish any other event of the slot. A flush is one synchronous segment,
 * append then publish with no await between them, so the column always equals the published
 * fragments and a buffered delta never overtakes an event that arrived after it.
 */
import { Buffer } from "node:buffer";
import type { ChatEvent } from "./events.js";
import type { SessionClock } from "./omp/runtime.js";
import type { Generation, Slot } from "./pool.js";

const FLUSH_BYTES = 2_048;
const FLUSH_MS = 2_000;

interface ThinkingPorts {
  clock: SessionClock | undefined;
  /** The bounded store append; returns the fragment actually stored ("" once capped). */
  append(messageId: number, chunk: string): string;
  /** Synchronous ring + observer publication; false means the slot is being retired. */
  publish(slot: Slot, event: ChatEvent<number>, generation: Generation | undefined): boolean;
  /** Owned error sink: retain the fault and retire the slot without awaiting. */
  fault(slot: Slot, error: Error): void;
}

interface Pending {
  messageId: number;
  generation: Generation | undefined;
  text: string;
  bytes: number;
  timer: unknown;
}

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => {
    clearTimeout(id as NodeJS.Timeout);
  },
};

export class ThinkingBuffers {
  readonly #clock: SessionClock;
  readonly #append: ThinkingPorts["append"];
  readonly #publish: ThinkingPorts["publish"];
  readonly #fault: ThinkingPorts["fault"];
  readonly #pending = new Map<Slot, Pending>();

  constructor(ports: ThinkingPorts) {
    this.#clock = ports.clock ?? systemClock;
    this.#append = ports.append;
    this.#publish = ports.publish;
    this.#fault = ports.fault;
  }

  /** Merges one delta; false once a threshold flush failed (the slot is being retired). */
  add(slot: Slot, generation: Generation | undefined, messageId: number, delta: string): boolean {
    let pending = this.#pending.get(slot);
    if (pending === undefined) {
      const created: Pending = { messageId, generation, text: "", bytes: 0, timer: undefined };
      created.timer = this.#clock.setTimeout(() => {
        this.#expire(slot, created);
      }, FLUSH_MS);
      this.#pending.set(slot, created);
      pending = created;
    }
    pending.text += delta;
    pending.bytes += Buffer.byteLength(delta, "utf8");
    return pending.bytes >= FLUSH_BYTES ? this.flush(slot) : true;
  }

  /**
   * Synchronous, never throws: stores and publishes the whole buffer as one event. True when
   * there is nothing to publish; false when the append faulted (nothing is published) or the
   * publication refused.
   */
  flush(slot: Slot): boolean {
    const pending = this.#pending.get(slot);
    if (pending === undefined) {
      return true;
    }
    this.#pending.delete(slot);
    this.#clock.clearTimeout(pending.timer);
    let fragment: string;
    try {
      fragment = this.#append(pending.messageId, pending.text);
    } catch (error) {
      this.#fault(slot, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    if (fragment.length === 0) {
      return true;
    }
    const data = { messageId: pending.messageId, delta: fragment };
    return this.#publish(slot, { type: "thinking.delta", data }, pending.generation);
  }

  /** Infra-fault retire: the turn has failed, its unsaved thinking is dropped. */
  discard(slot: Slot): void {
    const pending = this.#pending.get(slot);
    if (pending !== undefined) {
      this.#clock.clearTimeout(pending.timer);
      this.#pending.delete(slot);
    }
  }

  /** Ordinary retire: stop the timer; the turn's terminal event flushes the buffer. */
  clearTimer(slot: Slot): void {
    const pending = this.#pending.get(slot);
    if (pending !== undefined) {
      this.#clock.clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  /** Timer callback: synchronous, never throws; a failed flush has already taken the sink. */
  #expire(slot: Slot, pending: Pending): void {
    if (!slot.infraFaulted && this.#pending.get(slot) === pending) {
      this.flush(slot);
    }
  }
}
