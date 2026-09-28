/**
 * Branch-family orchestration (#465 regenerate) on the supervisor's ports: precheck and control
 * claim, get_branch_messages → branch → get_state, the CAS commit and the post-commit dispatch.
 */
import { HttpError } from "../core/errors/index.js";
import { releaseDispatch, type Slot } from "./pool.js";
import type { SessionStore, SettledApproval } from "./store.js";
import type { ControlClaims, TurnStops } from "./turn-control.js";

type Resume = { ownerId: string; ompSessionFile: string | null };

interface RegeneratePorts {
  store: SessionStore;
  controls: ControlClaims;
  stops: TurnStops;
  closed(): boolean;
  /** Whether the slot still holds its pool entry (false once the supervisor saw its exit). */
  live(slot: Slot): boolean;
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

  /** (d): closed and liveness checks → CAS → open → dispatch in one synchronous segment. */
  #commit(
    slot: Slot,
    plan: RegeneratePlan,
    text: string,
    sessionFile: string,
  ): Promise<{ assistantMessageId: number }> {
    const { store, stops } = this.#ports;
    if (this.#ports.closed() || !this.#ports.live(slot)) {
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
