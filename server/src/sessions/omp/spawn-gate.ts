/**
 * Issue #652 bounded concurrent spawn: `limit` permits, FIFO waiters, cancellable while queued.
 * A permit covers one acquisition from grant until its startup (spawn + handshake) settles.
 */
import { AgentUnavailableError } from "./process.js";

interface Waiter {
  grant: (release: () => void) => void;
  refuse: (error: Error) => void;
}

export class SpawnGate {
  readonly #limit: number;
  readonly #queue: Waiter[] = [];
  #held = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("spawn gate limit must be a positive integer");
    }
    this.#limit = limit;
  }

  /** `granted` resolves to an idempotent release; `cancel` refuses a still-queued waiter. */
  acquire(): { granted: Promise<() => void>; cancel(): void } {
    let waiter!: Waiter;
    const granted = new Promise<() => void>((resolve, reject) => {
      waiter = { grant: resolve, refuse: reject };
    });
    if (this.#held < this.#limit) {
      this.#grant(waiter);
    } else {
      this.#queue.push(waiter);
    }
    return {
      granted,
      cancel: () => {
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) {
          this.#queue.splice(index, 1);
          waiter.refuse(new AgentUnavailableError("runtime shutdown"));
        }
      },
    };
  }

  #grant(waiter: Waiter): void {
    this.#held += 1;
    let released = false;
    waiter.grant(() => {
      if (released) {
        return;
      }
      released = true;
      this.#held -= 1;
      const next = this.#queue.shift();
      if (next !== undefined) {
        this.#grant(next);
      }
    });
  }
}

export interface HandshakeTimeoutRecord {
  event: "omp_handshake_timeout";
  sessionId: string;
  reason: "handshake timeout";
  elapsedMs: number;
}

/** Synchronous observation port; omitted → records are discarded. */
export type SpawnLog = (record: HandshakeTimeoutRecord) => void;

/**
 * One record for a handshake-deadline failure only; `began` is `performance.now()` at acquisition
 * entry (queue time included). A throwing log or a returned thenable never alters the failure.
 */
export function reportHandshakeTimeout(
  log: SpawnLog | undefined,
  sessionId: string,
  began: number,
  error: unknown,
): void {
  if (
    log === undefined ||
    !(error instanceof AgentUnavailableError) ||
    error.message !== "handshake timeout"
  ) {
    return;
  }
  const elapsedMs = Math.round(performance.now() - began);
  try {
    const returned: unknown = log({
      event: "omp_handshake_timeout",
      sessionId,
      reason: "handshake timeout",
      elapsedMs,
    });
    consumeThenable(returned);
  } catch {
    // The log port is observation only: its failure never changes the startup error.
  }
}

function consumeThenable(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return;
  }
  const then: unknown = (value as { then?: unknown }).then;
  if (typeof then === "function") {
    then.call(value, undefined, () => undefined);
  }
}
