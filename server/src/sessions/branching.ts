/**
 * Branch-family orchestration on the supervisor's ports: precheck and control claim,
 * get_branch_messages → branch → get_state and the final transaction. Regenerate (#465) then
 * dispatches on the session's own process; fork (#466) runs the commands on a temporary process
 * admitted after the source's process retired, shuts it down and only then commits.
 */
import { randomBytes } from "node:crypto";
import { HttpError } from "../core/errors/index.js";
import { SessionRuntime } from "./omp/runtime.js";
import {
  type PoolEntry,
  type ProcessPool,
  releaseDispatch,
  type Slot,
  type SpawnShared,
  sessionRuntimeOpts,
  temporaryTokens,
} from "./pool.js";
import type { SessionStore, SettledApproval } from "./store.js";
import type { SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";
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
    const branched = await branchTo(slot.runtime, entryId);
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
    const entryId = entryAt(data, -1, question);
    if (entryId === undefined) {
      throw new HttpError("agent_unavailable");
    }
    return entryId;
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

type Branched = { text: string; sessionFile: string };

interface ForkPorts {
  store: SessionStore;
  controls: ControlClaims;
  pool: ProcessPool;
  tokens: TokenRegistry;
  config: SessionSupervisorRuntime;
  /** The supervisor's spawn gate and log: the temporary process queues on the same permits. */
  spawn: SpawnShared;
  closed(): boolean;
  /** Retires the source's registered slot (if any) and resolves once it exited; never rejects. */
  retireSource(sessionId: string): Promise<void>;
}

interface ForkPlan {
  sourceId: string;
  /** The new session's id, pre-generated: the temporary token's key, inserted by the commit. */
  sessionId: string;
  ownerId: string;
  messageId: number;
  /** The fork point's index among the source's user messages, and its text. */
  ordinal: number;
  text: string;
  expectedAssistantId: number | null;
  file: string;
}

export type ForkResult = { session: ReturnType<SessionStore["commitFork"]>; draft: string };

/**
 * Fork (#466): precheck + claim of the source, source process retired first, a temporary process
 * (pool-admitted, never a slot or a generation) runs the three commands and is shut down, then one
 * CAS transaction inserts the new session and copies the history before the fork point.
 */
export class Forks {
  readonly #ports: ForkPorts;
  readonly #temps = new Set<SessionRuntime>();

  constructor(ports: ForkPorts) {
    this.#ports = ports;
  }

  /** Every failure is a rejection; claim, precheck and the source retire share one segment. */
  async run(sourceId: string, ownerId: string, messageId: number): Promise<ForkResult> {
    const { controls, retireSource } = this.#ports;
    const busy = controls.held(sourceId);
    return controls.during(sourceId, () => {
      const plan = this.#precheck(sourceId, ownerId, messageId, busy);
      return this.#fork(plan, retireSource(sourceId));
    });
  }

  /** Shuts down every in-flight temporary process (shutdown); never rejects. */
  async close(): Promise<void> {
    await Promise.all([...this.#temps].map(stopQuietly));
  }

  #precheck(sourceId: string, ownerId: string, messageId: number, busy: boolean): ForkPlan {
    const { store } = this.#ports;
    const tree = store.getMessages(sourceId, ownerId);
    const resume = store.runtimeState(sourceId);
    if (tree === null || resume === null) {
      throw new HttpError("not_found");
    }
    const users = tree.messages.filter((message) => message.role === "user");
    const ordinal = users.findIndex((message) => message.id === messageId);
    const user = users[ordinal];
    if (user === undefined) {
      throw new HttpError("bad_request");
    }
    if (busy || tree.session.status === "running") {
      throw new HttpError("session_busy");
    }
    if (resume.ompSessionFile === null) {
      throw new HttpError("agent_unavailable");
    }
    const assistant = tree.messages.findLast((message) => message.role === "assistant");
    return {
      sourceId,
      sessionId: randomBytes(16).toString("hex"),
      ownerId,
      messageId,
      ordinal,
      text: user.content,
      expectedAssistantId: assistant?.id ?? null,
      file: resume.ompSessionFile,
    };
  }

  async #fork(plan: ForkPlan, retired: Promise<void>): Promise<ForkResult> {
    const { pool, controls, tokens } = this.#ports;
    await retired;
    let temp: SessionRuntime | undefined;
    const entry = await pool.admit({
      busy: () => controls.held(plan.sourceId),
      retire: () => (temp === undefined ? Promise.resolve() : stopQuietly(temp)),
    });
    if (this.#ports.closed()) {
      pool.release(entry);
      throw new HttpError("agent_unavailable");
    }
    const runtime = new SessionRuntime(
      sessionRuntimeOpts(this.#ports.config, this.#ports.spawn, {
        sessionId: plan.sessionId,
        ownerId: plan.ownerId,
        resumePath: plan.file,
        tokens: temporaryTokens(pool, entry, tokens),
        onExit: () => {
          pool.release(entry);
        },
      }),
    );
    temp = runtime;
    this.#temps.add(runtime);
    let branched: Branched;
    try {
      branched = await this.#branch(runtime, entry, plan);
    } finally {
      await stopQuietly(runtime);
      pool.release(entry);
      tokens.revoke(plan.sessionId);
      this.#temps.delete(runtime);
    }
    return this.#commit(plan, branched);
  }

  /** get_branch_messages → ordinal + text alignment → branch → get_state on the temporary process. */
  async #branch(runtime: SessionRuntime, entry: PoolEntry, plan: ForkPlan): Promise<Branched> {
    let data: unknown;
    try {
      data = await runtime.command({ type: "get_branch_messages" });
    } catch {
      throw new HttpError("agent_unavailable");
    }
    const entryId = entryAt(data, plan.ordinal, plan.text);
    if (entryId === undefined) {
      throw new HttpError("agent_unavailable");
    }
    const branched = await branchTo(runtime, entryId);
    // Same segment as the get_state reply: the process that answered is still the admitted one.
    if (!this.#ports.pool.holds(entry)) {
      throw new HttpError("agent_unavailable");
    }
    return branched;
  }

  /** After the temporary process exited: closed and shared-file checks, then the one transaction. */
  #commit(plan: ForkPlan, branched: Branched): ForkResult {
    if (this.#ports.closed()) {
      throw new HttpError("agent_unavailable");
    }
    // Direct invariant: the new session never shares the source's session file.
    if (branched.sessionFile === plan.file) {
      throw new HttpError("agent_unavailable");
    }
    let session: ForkResult["session"];
    try {
      session = this.#ports.store.commitFork({
        sourceId: plan.sourceId,
        sessionId: plan.sessionId,
        ownerId: plan.ownerId,
        messageId: plan.messageId,
        expectedAssistantId: plan.expectedAssistantId,
        sessionFile: branched.sessionFile,
      });
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError("agent_unavailable");
    }
    return { session, draft: branched.text };
  }
}

function stopQuietly(runtime: SessionRuntime): Promise<void> {
  return runtime.shutdown().catch(() => undefined);
}

/** (c): any failure is agent_unavailable; get_state always follows branch. */
async function branchTo(runtime: SessionRuntime, entryId: string): Promise<Branched> {
  try {
    const branched = record(await runtime.command({ type: "branch", entryId }));
    const state = record(await runtime.command({ type: "get_state" }));
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

/** The entryId at `index` of a get_branch_messages answer, only when its text is `text`. */
function entryAt(data: unknown, index: number, text: string): string | undefined {
  const messages = record(data)?.messages;
  const entry = record(Array.isArray(messages) ? messages.at(index) : undefined);
  return typeof entry?.entryId === "string" && entry.text === text ? entry.entryId : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
