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
 * reconciliation does not touch the column. Issue 1472 (design D3/D4): each span is one
 * `chat_thinking_segments` row, inserted by the opening's transaction (after the coalescer flushed
 * held text, so its body offset counts it) and given its length and own milliseconds by the
 * closing's; two spans are two rows even with nothing between them. Issue 1474 (design D8):
 * `thinking.end` carries that closed row as its `segment`, as the closing's UPDATE returned it.
 */
import type { ChatEvent } from "./events.js";
import type { OmpFrame } from "./omp/frame.js";
import type { SessionClock } from "./omp/runtime.js";
import type { Generation, Slot } from "./pool.js";
import type { ThinkingSegmentStore } from "./store-segments.js";

interface SpanPorts {
  clock: SessionClock;
  store: ThinkingSegmentStore;
  /** Synchronous ring + observer publication; false means the slot is being retired. */
  publish(slot: Slot, event: ChatEvent<number>, generation: Generation | undefined): boolean;
  /** Owned error sink: retain the fault and retire the slot without awaiting. */
  fault(slot: Slot, error: Error): void;
}

/** One slot's current message: its accumulated milliseconds and the open span (row), if any. */
interface Span {
  messageId: number;
  generation: Generation | undefined;
  start: number | null;
  segment: number;
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
      span = { messageId, generation, start: null, segment: 0, total: 0 };
      this.#spans.set(slot, span);
    }
    if (span.start !== null) {
      return true;
    }
    const start = this.#ports.clock.now();
    const segment = this.#write(slot, () => this.#ports.store.openThinkingSegment(messageId));
    if (segment === false) {
      return false;
    }
    span.segment = segment;
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
    const ms = Math.max(0, this.#ports.clock.now() - span.start);
    span.total += ms;
    span.start = null;
    const thinkingMs = Math.round(span.total);
    const { messageId, segment } = span;
    const close = () =>
      this.#ports.store.closeThinkingSegment(messageId, segment, thinkingMs, Math.round(ms));
    const row = this.#write(slot, close);
    if (row === false) {
      return false;
    }
    const data = { messageId, thinkingMs, segment: row };
    return this.#ports.publish(slot, { type: "thinking.end", data }, span.generation);
  }

  /** The write's result; false when it threw (the fault is reported). */
  #write<T>(slot: Slot, write: () => T): T | false {
    try {
      return write();
    } catch (error) {
      this.#ports.fault(slot, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
}
