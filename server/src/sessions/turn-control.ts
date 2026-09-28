/**
 * Turn control: event persistence, post-failure stream draining, and the #473 stop of a
 * dispatched turn (Deny the entry snapshot of pending approvals, write `abort`, then wait
 * OMP_ABORT_GRACE_MS on the injected clock for agent_end before falling back to retire).
 * A stop before the dispatch receipt (#490) registers an intent, honored once the receipt is.
 * The #465 per-session control claim and the regenerate orchestration (precheck, the three
 * commands, CAS commit, dispatch) run on the supervisor's ports.
 */
import { HttpError } from "../core/errors/index.js";
import type { ChatEvent } from "./events.js";
import type { SessionClock } from "./omp/runtime.js";
import { releaseDispatch, type Slot } from "./pool.js";
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

type Resume = { ownerId: string; ompSessionFile: string | null };

interface RegeneratePorts {
  store: SessionStore;
  controls: ControlClaims;
  stops: TurnStops;
  closed(): boolean;
  /** Live-slot reuse or one fresh admission (`retiring` wait and closed check included). */
  acquire<T>(sessionId: string, resume: Resume, use: (slot: Slot) => Promise<T>): Promise<T>;
  /** `#claim` + `#bindDispatch` of the new assistant id on this slot. */
  dispatch(slot: Slot, text: string, assistantMessageId: number): Promise<void>;
  /** `approvals.settled`: publishes the deny settlements of a terminal transaction. */
  settled(settled: SettledApproval[]): Promise<boolean>;
}

interface RegeneratePlan {
  sessionId: string;
  expectedId: number;
  question: string;
  resume: Resume;
}

const TERMINAL = new Set(["done", "failed", "stopped"]);

/** Regenerate (#465): precheck + claim, get_branch_messages → branch → get_state, CAS, dispatch. */
export class Regenerations {
  readonly #ports: RegeneratePorts;

  constructor(ports: RegeneratePorts) {
    this.#ports = ports;
  }

  /** Every failure is a rejection; the claim is taken in the precheck's synchronous segment. */
  async run(sessionId: string, ownerId: string): Promise<{ assistantMessageId: number }> {
    const plan = this.#precheck(sessionId, ownerId);
    return this.#ports.controls.during(sessionId, () =>
      this.#ports.acquire(sessionId, plan.resume, (slot) => this.#regenerate(slot, plan)),
    );
  }

  #precheck(sessionId: string, ownerId: string): RegeneratePlan {
    const { store, controls } = this.#ports;
    const tree = store.getMessages(sessionId, ownerId);
    const resume = store.runtimeState(sessionId);
    if (tree === null || resume === null) {
      throw new HttpError("not_found");
    }
    if (tree.session.status === "running" || controls.held(sessionId)) {
      throw new HttpError("session_busy");
    }
    const [user, assistant] = tree.messages.slice(-2);
    if (
      !TERMINAL.has(tree.session.status) ||
      user?.role !== "user" ||
      assistant?.role !== "assistant"
    ) {
      throw new HttpError("bad_request");
    }
    return { sessionId, expectedId: assistant.id, question: user.content, resume };
  }

  async #regenerate(slot: Slot, plan: RegeneratePlan): Promise<{ assistantMessageId: number }> {
    const entryId = await this.#lastEntry(slot, plan.question);
    const branched = await this.#branch(slot, entryId);
    return this.#commit(slot, plan, branched.text, branched.sessionFile);
  }

  /** (a)+(b): the only command whose acquisition fault (re-admission) may surface. */
  async #lastEntry(slot: Slot, question: string): Promise<string> {
    const before = slot.generation;
    let data: unknown;
    try {
      data = await slot.runtime.command({ type: "get_branch_messages" });
    } catch (error) {
      const fault = slot.acquisitionFault;
      slot.acquisitionFault = undefined;
      throw fault ?? error;
    } finally {
      if (slot.generation !== before) {
        releaseDispatch(slot, slot.generation);
      }
    }
    const messages = record(data)?.messages;
    const last = record(Array.isArray(messages) ? messages.at(-1) : undefined);
    if (typeof last?.entryId !== "string" || last.text !== question) {
      throw new HttpError("agent_unavailable");
    }
    return last.entryId;
  }

  /** (c): any failure is agent_unavailable; get_state always follows branch. */
  async #branch(slot: Slot, entryId: string): Promise<{ text: string; sessionFile: string }> {
    try {
      const branched = record(await slot.runtime.command({ type: "branch", entryId }));
      const state = record(await slot.runtime.command({ type: "get_state" }));
      const text = branched?.text;
      const sessionFile = state?.sessionFile;
      if (
        typeof text === "string" &&
        branched?.cancelled === false &&
        typeof sessionFile === "string" &&
        sessionFile.length > 0
      ) {
        return { text, sessionFile };
      }
    } catch {
      /* mapped below */
    }
    throw new HttpError("agent_unavailable");
  }

  /** (d): closed check → CAS → open → dispatch in one synchronous segment. */
  #commit(
    slot: Slot,
    plan: RegeneratePlan,
    text: string,
    sessionFile: string,
  ): Promise<{ assistantMessageId: number }> {
    const { store, stops } = this.#ports;
    if (this.#ports.closed()) {
      throw new HttpError("agent_unavailable");
    }
    let assistantMessageId: number;
    try {
      assistantMessageId = store.acceptRegenerate(plan.sessionId, plan.expectedId, sessionFile);
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError("agent_unavailable");
    }
    stops.open(assistantMessageId);
    return this.#dispatch(slot, text, assistantMessageId);
  }

  /** (e): a failed dispatch settles the new row `failed`; the deleted row is never revived. */
  async #dispatch(
    slot: Slot,
    text: string,
    assistantMessageId: number,
  ): Promise<{ assistantMessageId: number }> {
    try {
      await this.#ports.dispatch(slot, text, assistantMessageId);
    } catch {
      this.#ports.stops.release(assistantMessageId);
      const settled: SettledApproval[] = [];
      this.#ports.store.finishTurn(assistantMessageId, "failed", settled);
      if (settled.length > 0) {
        await this.#ports.settled(settled);
      }
      throw new HttpError("agent_unavailable");
    }
    return { assistantMessageId };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
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
