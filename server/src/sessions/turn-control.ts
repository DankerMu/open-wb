/**
 * Turn control: event persistence, post-failure stream draining, and the #473 stop of a
 * dispatched turn (Deny the entry snapshot of pending approvals, ask the runtime to `abort` — it
 * writes the frame once the turn started, #650 — then wait OMP_ABORT_GRACE_MS from that call on
 * the injected clock for agent_end before falling back to retire).
 * A stop before the dispatch receipt (#490) registers an intent, honored once the receipt is.
 * The #465 per-session control claim lives here; the regenerate orchestration is in
 * branching.ts.
 */
import { HttpError } from "../core/errors/index.js";
import type { PumpSteps } from "./approval-pairing.js";
import type { ChatEvent } from "./events.js";
import { ownedChanges } from "./file-changes-ownership.js";
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
   * Resolves once `abort` is requested (the runtime writes it when the turn starts, #650), or once
   * the intent is registered when the turn has no dispatched prompt yet (`slot` undefined: no
   * runtime to ask); a repeated stop joins the first.
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

/** Per-session control claim (#465): counted, so each holder releases only its own hold. */
export class ControlClaims {
  readonly #counts = new Map<string, number>();

  held(sessionId: string): boolean {
    return this.#counts.has(sessionId);
  }

  /** Returns a release that takes effect once. */
  hold(sessionId: string): () => void {
    this.#counts.set(sessionId, (this.#counts.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const left = (this.#counts.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        this.#counts.set(sessionId, left);
      } else {
        this.#counts.delete(sessionId);
      }
    };
  }

  /** Holds for `fn`'s promise; a synchronous throw releases first and is rethrown as is. */
  during<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const release = this.hold(sessionId);
    let work: Promise<T>;
    try {
      work = fn();
    } catch (error) {
      release();
      throw error;
    }
    return work.finally(release);
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

type Persisted = ChatEvent<number> | undefined;
type FilesChanged = Extract<ChatEvent<string>, { type: "files.changed" }>;
/** `persistEvent`'s parameters after the event, the same for every overload. */
type PersistRest = [
  steps: PumpSteps,
  settled: SettledApproval[],
  workspaceRoot: string | null,
  redactUpstream: (text: string) => string,
  mountNames?: () => ReadonlySet<string>,
];

/**
 * Stores one event and returns what to publish, synchronously — except a `files.changed` of a
 * bound session's registered call: its ownership judgment waits on the file system (each call
 * under its deadline, D21), so that one returns a promise, and nothing of it is stored before the
 * judgment is done. `mountNames` is read for that judgment only: the bound workspace's registered
 * mount names right then.
 */
export function persistEvent(
  store: SessionStore,
  assistantMessageId: number,
  event: Exclude<ChatEvent<string>, FilesChanged>,
  ...rest: PersistRest
): Persisted;
export function persistEvent(
  store: SessionStore,
  assistantMessageId: number,
  event: ChatEvent<string>,
  ...rest: PersistRest
): Persisted | Promise<Persisted>;
export function persistEvent(
  store: SessionStore,
  assistantMessageId: number,
  event: ChatEvent<string>,
  steps: PumpSteps,
  settled: SettledApproval[],
  workspaceRoot: string | null,
  redactUpstream: (text: string) => string,
  mountNames: () => ReadonlySet<string> = () => new Set(),
): Persisted | Promise<Persisted> {
  switch (event.type) {
    // turn.retry (#909) takes a ring sequence like turn.start and is never stored.
    case "turn.start":
    case "turn.retry":
      return event;
    // #909: `detail` is sanitised, then the three error columns are stored, then the five-key
    // event goes back to be published (落库先于发布); `turn.end failed` follows as before.
    case "error": {
      const { messageId, message, reason, status } = event.data;
      const failure = { reason, status, detail: redactUpstream(event.data.detail) };
      store.recordError(assistantMessageId, failure);
      return { type: "error", data: { messageId, message, ...failure } };
    }
    // #910: the supervisor's delta coalescer takes text.delta first and calls appendDelta itself.
    case "text.delta":
      store.appendDelta(assistantMessageId, event.data.delta);
      return event;
    // Issue 1473 (design D6 rule 1): the queued approval is paired in the step insert's transaction;
    // issue 1474 publishes the stored body offset and the paired approval's id with the step.
    case "step.start": {
      const { name, detail } = event.data;
      const approval = steps.takeApproval(name);
      const ordinal = steps.nextOrdinal();
      const { stepId, bodyOffset, approvalId } = store.startStep(assistantMessageId, {
        ordinal,
        name,
        detail,
        approval,
      });
      steps.started(event.data.stepId, stepId, name, approvalId);
      return {
        type: "step.start",
        data: { messageId: event.data.messageId, stepId, name, detail, bodyOffset, approvalId },
      };
    }
    // #1568: an eval step's browser calls are audited in the step end's transaction, never published.
    case "step.end": {
      const stepId = steps.toolIds.get(event.data.stepId);
      if (stepId === undefined) {
        return undefined;
      }
      store.finishStep(stepId, event.data.status, event.data.output, event.data.browser);
      steps.ended(stepId);
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
    // An unregistered call or an unbound session drops the event before any filesystem access;
    // otherwise the files owned by the workspace root are stored first, then returned to publish.
    case "files.changed": {
      const stepId = steps.toolIds.get(event.data.stepId);
      if (stepId === undefined || workspaceRoot === null) {
        return undefined;
      }
      return persistOwnedChanges(store, event, stepId, workspaceRoot, mountNames());
    }
    // The raw candidate is validated, normalised, compared with the stored list and written by
    // the store (#864); an invalid or unchanged one is dropped there and takes no ring sequence.
    case "todo.updated": {
      const stored = store.storeTodo(assistantMessageId, event.data.todo);
      return stored === undefined
        ? undefined
        : { type: "todo.updated", data: { messageId: event.data.messageId, todo: stored.todo } };
    }
    // thinking.delta never reaches here: the supervisor's delta coalescer (#910) takes it first;
    // thinking.end is published by its thinking spans (thinking-span.ts), never mapped.
    case "thinking.delta":
    case "thinking.end":
      return undefined;
  }
}

/** The owned files of a `files.changed`, stored before they are returned to publish; none: nothing. */
async function persistOwnedChanges(
  store: SessionStore,
  event: FilesChanged,
  stepId: number,
  workspaceRoot: string,
  mountNames: ReadonlySet<string>,
): Promise<Persisted> {
  const files = await ownedChanges(workspaceRoot, event.data.files, mountNames);
  if (files.length === 0) {
    return undefined;
  }
  store.setStepChanges(stepId, JSON.stringify(files));
  return { type: "files.changed", data: { messageId: event.data.messageId, stepId, files } };
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
