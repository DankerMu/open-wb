/**
 * Issue #91 pure per-epoch event ring.
 * Retains the latest 1000 canonical ChatEvent records and decides replay, gap, or fresh.
 */
import type { ChatEvent } from "../events.js";

const CAPACITY = 1000;

export type RetainedEvent = { id: string } & ChatEvent<number>;

export type RingRead = {
  mode: "replay" | "gap" | "fresh";
  events: RetainedEvent[];
};

function retain(id: string, event: ChatEvent<number>): RetainedEvent {
  if (event.type === "turn.start") {
    return Object.freeze({
      id,
      type: event.type,
      data: Object.freeze({ messageId: event.data.messageId }),
    });
  }
  if (event.type === "text.delta") {
    return Object.freeze({
      id,
      type: event.type,
      data: Object.freeze({ messageId: event.data.messageId, delta: event.data.delta }),
    });
  }
  if (event.type === "step.start") {
    return Object.freeze({
      id,
      type: event.type,
      data: Object.freeze({
        messageId: event.data.messageId,
        stepId: event.data.stepId,
        name: event.data.name,
        detail: event.data.detail,
      }),
    });
  }
  if (event.type === "step.end") {
    return Object.freeze({
      id,
      type: event.type,
      data: Object.freeze({
        messageId: event.data.messageId,
        stepId: event.data.stepId,
        status: event.data.status,
        detail: event.data.detail,
      }),
    });
  }
  if (event.type === "turn.end") {
    return Object.freeze({
      id,
      type: event.type,
      data: Object.freeze({ messageId: event.data.messageId, status: event.data.status }),
    });
  }
  return Object.freeze({
    id,
    type: event.type,
    data: Object.freeze({ messageId: event.data.messageId, message: event.data.message }),
  });
}

export class RingBuffer {
  readonly #epoch: number;
  readonly #slots: Array<RetainedEvent | undefined> = new Array<RetainedEvent | undefined>(
    CAPACITY,
  );
  #nextSeq = 1;
  #count = 0;
  #head = 0;
  #activeStartSeq: number | undefined;

  constructor(streamEpoch: number) {
    this.#epoch = streamEpoch;
  }

  push(event: ChatEvent<number>): string {
    const seq = this.#nextSeq;
    const id = `${this.#epoch}:${seq}`;
    this.#slots[this.#head] = retain(id, event);
    this.#head = (this.#head + 1) % CAPACITY;
    if (this.#count < CAPACITY) {
      this.#count += 1;
    }
    this.#nextSeq += 1;
    if (event.type === "turn.start") {
      this.#activeStartSeq = seq;
    } else if (event.type === "turn.end") {
      this.#activeStartSeq = undefined;
    }
    return id;
  }

  since(lastEventId: string | null, options: { turnRunning: boolean }): RingRead {
    if (lastEventId !== null) {
      return this.#afterCursor(lastEventId);
    }
    if (!options.turnRunning) {
      return { mode: "fresh", events: [] };
    }
    return this.#activeTurn();
  }

  #afterCursor(lastEventId: string): RingRead {
    const parsed = parseCursor(lastEventId);
    if (parsed === undefined || parsed.epoch !== this.#epoch) {
      return { mode: "gap", events: [] };
    }
    const oldest = this.#nextSeq - this.#count;
    if (parsed.seq < oldest - 1) {
      return { mode: "gap", events: [] };
    }
    return { mode: "replay", events: this.#materialize((seq) => seq > parsed.seq) };
  }

  #activeTurn(): RingRead {
    const startSeq = this.#activeStartSeq;
    const oldest = this.#nextSeq - this.#count;
    if (startSeq === undefined || startSeq < oldest) {
      return { mode: "gap", events: [] };
    }
    return { mode: "replay", events: this.#materialize((seq) => seq >= startSeq) };
  }

  #materialize(keep: (seq: number) => boolean): RetainedEvent[] {
    const events: RetainedEvent[] = [];
    const oldest = this.#nextSeq - this.#count;
    let index = (this.#head - this.#count + CAPACITY) % CAPACITY;
    for (let seen = 0; seen < this.#count; seen += 1) {
      const event = this.#slots[index];
      if (event !== undefined && keep(oldest + seen)) {
        events.push(event);
      }
      index = (index + 1) % CAPACITY;
    }
    return events;
  }
}

const CANONICAL = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;
const MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER);

function parseCursor(value: string): { epoch: number; seq: number } | undefined {
  const match = CANONICAL.exec(value);
  if (match === null) {
    return undefined;
  }
  const epochText = match[1];
  const seqText = match[2];
  if (epochText === undefined || seqText === undefined) {
    return undefined;
  }
  if (!fitsSafeInteger(epochText) || !fitsSafeInteger(seqText)) {
    return undefined;
  }
  return { epoch: Number(epochText), seq: Number(seqText) };
}

function fitsSafeInteger(digits: string): boolean {
  if (digits.length > MAX_SAFE_DIGITS.length) {
    return false;
  }
  if (digits.length < MAX_SAFE_DIGITS.length) {
    return true;
  }
  return digits <= MAX_SAFE_DIGITS;
}
