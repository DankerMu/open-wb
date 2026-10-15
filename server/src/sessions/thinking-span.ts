/**
 * Issue #910 thinking spans (thinking-fold「思考时长记录与下发」, design D3): how long a message's
 * assistant thought, on the injected server clock. A span opens at the first `thinking.delta` the
 * supervisor handles while none is open (before coalescing, at frame arrival) and writes
 * `chat_messages.thinking_ms` NULL at once, so an open span is visible as NULL. It closes at the
 * earlier of omp's raw `thinking_end` frame and the next non-thinking event; the delta coalescer
 * (delta-coalescer.ts) flushes itself first, then `close` adds `max(0, now − start)` to the
 * message's total, writes it and publishes `thinking.end` in the same synchronous segment. The
 * frame is only a time signal, never a content source. Nothing is written on an infra-faulted
 * slot, and a host that dies with a span open leaves the NULL its opening wrote; startup
 * reconciliation does not touch the column.
 */
import type { ChatEvent } from "./events.js";
import type { OmpFrame } from "./omp/frame.js";
import type { SessionClock } from "./omp/runtime.js";
import type { Generation, Slot } from "./pool.js";
import type { ThinkingMsStore } from "./store-thinking.js";

interface SpanPorts {
  clock: SessionClock;
  store: ThinkingMsStore;
  /** Synchronous ring + observer publication; false means the slot is being retired. */
  publish(slot: Slot, event: ChatEvent<number>, generation: Generation | undefined): boolean;
  /** Owned error sink: retain the fault and retire the slot without awaiting. */
  fault(slot: Slot, error: Error): void;
}

/** One slot's current message: its accumulated milliseconds and the open span, if any. */
interface Span {
  messageId: number;
  generation: Generation | undefined;
  start: number | null;
  total: number;
}

/** omp's raw `message_update{assistantMessageEvent:{type:"thinking_end"}}`. */
export function endsThinking(frame: OmpFrame): boolean {
  const event = frame.assistantMessageEvent;
  return (
    frame.type === "message_update" &&
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "thinking_end"
  );
}

export class ThinkingSpans {
  readonly #ports: SpanPorts;
  readonly #spans = new WeakMap<Slot, Span>();

  constructor(ports: SpanPorts) {
    this.#ports = ports;
  }

  isOpen(slot: Slot): boolean {
    return (this.#spans.get(slot)?.start ?? null) !== null;
  }

  /** A `thinking.delta` arrives: opens a span unless one is open. False when the write faulted. */
  open(slot: Slot, generation: Generation | undefined, messageId: number): boolean {
    if (slot.infraFaulted) {
      return true;
    }
    let span = this.#spans.get(slot);
    if (span?.messageId !== messageId) {
      span = { messageId, generation, start: null, total: 0 };
      this.#spans.set(slot, span);
    }
    if (span.start !== null) {
      return true;
    }
    const start = this.#ports.clock.now();
    if (!this.#write(slot, () => this.#ports.store.clearThinkingMs(messageId))) {
      return false;
    }
    span.start = start;
    span.generation = generation;
    return true;
  }

  /**
   * Closes the open span (the caller has flushed the coalescer): total, write, then publish.
   * True when no span is open; false when the write faulted (nothing published) or the
   * publication refused.
   */
  close(slot: Slot): boolean {
    const span = this.#spans.get(slot);
    if (span === undefined || span.start === null || slot.infraFaulted) {
      return true;
    }
    // A wall clock stepped backwards counts the span as 0, never a negative duration.
    span.total += Math.max(0, this.#ports.clock.now() - span.start);
    span.start = null;
    const thinkingMs = Math.round(span.total);
    const { messageId } = span;
    if (!this.#write(slot, () => this.#ports.store.setThinkingMs(messageId, thinkingMs))) {
      return false;
    }
    const event: ChatEvent<number> = { type: "thinking.end", data: { messageId, thinkingMs } };
    return this.#ports.publish(slot, event, span.generation);
  }

  #write(slot: Slot, write: () => void): boolean {
    try {
      write();
      return true;
    } catch (error) {
      this.#ports.fault(slot, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
}
