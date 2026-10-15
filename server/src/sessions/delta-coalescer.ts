/**
 * Issue #910 delta coalescer (chat-stream「正文与思考增量的时间窗合并」, design D1/D2); it replaces
 * the #519 thinking buffer. State is per slot. A delta of a kind that has a save port is published
 * at once when nothing is held and its kind was not published in this turn within the last 250 ms
 * (injected clock); otherwise it joins the held text, published when that window ends. One kind is
 * held at a time: a delta of the other kind, any other event and the turn's terminal flush it
 * first. Every publication is one synchronous segment, save then publish with no await between,
 * so the store only ever holds published text and the ring keeps the upstream arrival order. No
 * byte threshold. Slice 3b: given the `durations` port, the dispatch also drives the thinking spans
 * (thinking-span.ts) — a `thinking.delta` opens one, anything else (and `endSpan`, omp's raw
 * `thinking_end`) closes the open one right after flushing; the window's own timer never does.
 */
import type { ChatEvent } from "./events.js";
import type { SessionClock } from "./omp/runtime.js";
import type { Generation, Slot } from "./pool.js";
import type { ThinkingMsStore } from "./store-thinking.js";
import { ThinkingSpans } from "./thinking-span.js";

const WINDOW_MS = 250;

export type DeltaKind = "thinking" | "text";

/** Stores one merged chunk and returns the text to publish; "" publishes nothing (capped). */
type Save = (messageId: number, chunk: string) => string;

interface CoalescerPorts {
  clock: SessionClock | undefined;
  /** A kind without a port is not coalesced: `route` flushes and passes it on like any event. */
  save: Partial<Record<DeltaKind, Save>>;
  /** Synchronous ring + observer publication; false means the slot is being retired. */
  publish(slot: Slot, event: ChatEvent<number>, generation: Generation | undefined): boolean;
  /** Owned error sink: retain the fault and retire the slot without awaiting. */
  fault(slot: Slot, error: Error): void;
  /** `chat_messages.thinking_ms`; omitted → no thinking span is timed (and no thinking.end). */
  durations?: ThinkingMsStore;
}

interface Chunk {
  kind: DeltaKind;
  save: Save;
  messageId: number;
  generation: Generation | undefined;
  text: string;
  timer: unknown;
}

/** The last publication time of each kind, for the turn (assistant message) it belongs to. */
interface TurnMarks {
  messageId: number;
  last: Partial<Record<DeltaKind, number>>;
}

/** `taken`: the coalescer owns the delta; `pass`: persist and publish it; false: the slot faulted. */
type Routed = "taken" | "pass" | false;

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => {
    clearTimeout(id as NodeJS.Timeout);
  },
};

export class DeltaCoalescer {
  readonly #clock: SessionClock;
  readonly #save: CoalescerPorts["save"];
  readonly #publish: CoalescerPorts["publish"];
  readonly #fault: CoalescerPorts["fault"];
  readonly #held = new Map<Slot, Chunk>();
  readonly #marks = new WeakMap<Slot, TurnMarks>();
  readonly #spans: ThinkingSpans | undefined;

  constructor(ports: CoalescerPorts) {
    this.#clock = ports.clock ?? systemClock;
    this.#save = ports.save;
    this.#publish = ports.publish;
    this.#fault = ports.fault;
    const { durations: store, publish, fault } = ports;
    this.#spans =
      store === undefined
        ? undefined
        : new ThinkingSpans({ clock: this.#clock, store, publish, fault });
  }

  /** The `#commit` dispatch of one mapped event: a coalesced delta is taken, any other flushes. */
  route(slot: Slot, generation: Generation | undefined, event: ChatEvent<string>): Routed {
    if (event.type === "thinking.delta" || event.type === "text.delta") {
      const kind = event.type === "thinking.delta" ? "thinking" : "text";
      const save = this.#save[kind];
      if (save !== undefined) {
        const { messageId, delta } = event.data;
        // Thinking opens a span (at frame arrival, before coalescing); text closes the open one.
        const spanned =
          kind === "thinking"
            ? (this.#spans?.open(slot, generation, messageId) ?? true)
            : this.endSpan(slot, true);
        const chunk: Chunk = { kind, save, messageId, generation, text: delta, timer: undefined };
        return spanned && this.#take(slot, chunk) ? "taken" : false;
      }
    }
    return this.flush(slot) ? "pass" : false;
  }

  /**
   * Synchronous, never throws: before any non-delta event, saves and publishes the held text as one
   * event, then closes the open thinking span. True when there is nothing to publish; false when
   * a write faulted (nothing more is published) or a publication refused.
   */
  flush(slot: Slot): boolean {
    return this.#flushHeld(slot) && (this.#spans?.close(slot) ?? true);
  }

  /**
   * When `signal` (omp's raw `thinking_end` read by the pump, or a text delta): flush and close an
   * open span. A no-op otherwise, and without an open span (held text stays held).
   */
  endSpan(slot: Slot, signal: boolean): boolean {
    return !signal || this.#spans?.isOpen(slot) !== true || this.flush(slot);
  }

  #flushHeld(slot: Slot): boolean {
    const held = this.#held.get(slot);
    if (held === undefined) {
      return true;
    }
    this.#held.delete(slot);
    this.#clock.clearTimeout(held.timer);
    return this.#emit(slot, held);
  }

  /** Infra-fault retire: the turn has failed, its unpublished deltas are dropped. */
  discard(slot: Slot): void {
    const held = this.#held.get(slot);
    if (held !== undefined) {
      this.#clock.clearTimeout(held.timer);
      this.#held.delete(slot);
    }
  }

  /** Ordinary retire: stop the timer; the turn's terminal event flushes the held text. */
  clearTimer(slot: Slot): void {
    const held = this.#held.get(slot);
    if (held !== undefined) {
      this.#clock.clearTimeout(held.timer);
      held.timer = undefined;
    }
  }

  #take(slot: Slot, delta: Chunk): boolean {
    if (slot.infraFaulted) {
      return true; // 读代码推出: a delta reaching a faulted slot is dropped like a discarded one.
    }
    const held = this.#held.get(slot);
    if (held?.kind === delta.kind && held.messageId === delta.messageId) {
      held.text += delta.text;
      return true;
    }
    if (!this.#flushHeld(slot)) {
      return false;
    }
    const now = this.#clock.now();
    const last = this.#marksOf(slot, delta.messageId)[delta.kind];
    if (last === undefined || now - last >= WINDOW_MS) {
      return this.#emit(slot, delta);
    }
    // The window ends 250 ms after the kind's last publication; capped at 250 ms so a wall clock
    // stepped backwards cannot hold the text longer than one window (读代码推出).
    delta.timer = this.#clock.setTimeout(
      () => {
        this.#expire(slot, delta);
      },
      Math.min(WINDOW_MS, last + WINDOW_MS - now),
    );
    this.#held.set(slot, delta);
    return true;
  }

  #emit(slot: Slot, chunk: Chunk): boolean {
    this.#marksOf(slot, chunk.messageId)[chunk.kind] = this.#clock.now();
    let fragment: string;
    try {
      fragment = chunk.save(chunk.messageId, chunk.text);
    } catch (error) {
      this.#fault(slot, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    if (fragment.length === 0) {
      return true;
    }
    const data = { messageId: chunk.messageId, delta: fragment };
    const event: ChatEvent<number> =
      chunk.kind === "thinking" ? { type: "thinking.delta", data } : { type: "text.delta", data };
    return this.#publish(slot, event, chunk.generation);
  }

  #marksOf(slot: Slot, messageId: number): TurnMarks["last"] {
    let marks = this.#marks.get(slot);
    if (marks?.messageId !== messageId) {
      marks = { messageId, last: {} };
      this.#marks.set(slot, marks);
    }
    return marks.last;
  }

  /** Timer callback: synchronous, never throws; a failed flush has already taken the sink. */
  #expire(slot: Slot, held: Chunk): void {
    if (!slot.infraFaulted && this.#held.get(slot) === held) {
      this.#flushHeld(slot);
    }
  }
}
