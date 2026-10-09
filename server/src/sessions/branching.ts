/**
 * Branch-family orchestration on the supervisor's ports: precheck and control claim,
 * get_branch_messages → branch → get_state and the final transaction. Regenerate (#465) then
 * dispatches on the session's own process; fork (#466) runs the commands on a temporary process
 * admitted after the source's process retired, shuts it down and only then commits. Both pick the
 * branch entry by wire candidates (#555): a whitelisted command turn has no entry and is refused,
 * escaped text has one with a leading space, and a message stored with attachments has one ending
 * in their suffix (#1018; the paths are read in the precheck, with the messages). Regenerate
 * dispatches the branch text escaped when it starts with `/` (#711), so an entry left before the
 * prompt route escaped is never re-sent bare.
 */
import { randomBytes } from "node:crypto";
import { HttpError } from "../core/errors/index.js";
import {
  type Branched,
  BranchTemps,
  branchEntries,
  branchTo,
  entryFor,
  type StoredUser,
} from "./branch-temp.js";
import { type ProcessPool, releaseDispatch, type Slot, type SpawnShared } from "./pool.js";
import { classifyPrompt } from "./slash-commands.js";
import type { SessionStore, SettledApproval } from "./store.js";
import type { StoredAttachment } from "./store-attachments.js";
import type { SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";
import type { ControlClaims, TurnStops } from "./turn-control.js";

export type Resume = { ownerId: string; ompSessionFile: string | null; workspaceId: string | null };

interface SkillsPort {
  /**
   * The platform and project skills of that session's cwd right now (never cached); called only
   * to judge content starting with `/`.
   */
  skills(ownerId: string, workspaceId: string | null): readonly { name: string }[];
}

interface RegeneratePorts extends SkillsPort {
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
  /** The attachment paths the last user message stores (none: `[]`). */
  paths: readonly string[];
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
    // Same synchronous segment as the messages: the paths are those of the rows just read.
    const attachments = store.attachmentPaths(sessionId);
    const resume = store.runtimeState(sessionId);
    if (tree === null || resume === null) {
      throw new HttpError("not_found");
    }
    if (tree.session.archivedAt !== null) {
      throw new HttpError("session_archived");
    }
    if (tree.session.status === "running" || controls.held(sessionId)) {
      throw new HttpError("session_busy");
    }
    const [user, assistant] = tree.messages.slice(-2);
    if (
      !TERMINAL.has(tree.session.status) ||
      user?.role !== "user" ||
      assistant?.role !== "assistant" ||
      isCommand(user.content, this.#ports, resume)
    ) {
      throw new HttpError("bad_request");
    }
    return {
      sessionId,
      expectedId: assistant.id,
      question: user.content,
      paths: attachments.get(user.id) ?? [],
      resume,
    };
  }

  async #regenerate(slot: Slot, plan: RegeneratePlan): Promise<{ assistantMessageId: number }> {
    const entryId = await this.#lastEntry(slot, plan);
    const branched = await branchTo(slot.runtime, entryId);
    return this.#commit(slot, plan, dispatchText(branched.text), branched.sessionFile);
  }

  /** (a)+(b): the only command whose acquisition fault (re-admission) may surface. */
  async #lastEntry(slot: Slot, plan: RegeneratePlan): Promise<string> {
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
    // Only the last pair is compared: earlier entries are not read.
    const entryId = entryFor(branchEntries(data).at(-1), plan.question, plan.paths);
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

/**
 * The text regenerate dispatches for a branch text (#711): one U+0020 is prefixed when it starts
 * with `/`. The precheck refused whitelisted command anchors, so a bare `/…` branch text is never
 * a command to run; an escaped entry starts with a space and is not escaped twice.
 */
function dispatchText(text: string): string {
  return text.startsWith("/") ? ` ${text}` : text;
}

interface ForkPorts extends SkillsPort {
  store: SessionStore;
  controls: ControlClaims;
  pool: ProcessPool;
  tokens: TokenRegistry;
  config: SessionSupervisorRuntime;
  /** The supervisor's spawn gate and log: the temporary process queues on the same permits. */
  spawn: SpawnShared;
  closed(): boolean;
  /** The session cwd resolution (session-cwd.ts), shared with the supervisor's acquisitions. */
  cwdOf(ownerId: string, workspaceId: string | null): string;
  /** Retires the source's registered slot (if any) and resolves once it exited; never rejects. */
  retireSource(sessionId: string): Promise<void>;
}

interface ForkPlan {
  sourceId: string;
  /** The new session's id, pre-generated: the temporary token's key, inserted by the commit. */
  sessionId: string;
  ownerId: string;
  messageId: number;
  /** The fork point's stored content, and the source's user messages in order to align it. */
  text: string;
  users: readonly StoredUser[];
  /** Message id → the attachment paths it stores, read with `users`. */
  attachments: ReadonlyMap<number, readonly string[]>;
  /** The fork point's stored attachments, read with `text`; handed back beside the draft. */
  stored: StoredAttachment[];
  expectedAssistantId: number | null;
  file: string;
  workspaceId: string | null;
}

export type ForkResult = {
  session: ReturnType<SessionStore["commitFork"]>;
  draft: string;
  attachments: StoredAttachment[];
};

/**
 * Fork (#466): precheck + claim of the source, source process retired first, a temporary process
 * (pool-admitted, never a slot or a generation) runs the three commands and is shut down, then one
 * CAS transaction inserts the new session and copies the history before the fork point.
 */
export class Forks {
  readonly #ports: ForkPorts;
  readonly #temps: BranchTemps;

  constructor(ports: ForkPorts) {
    this.#ports = ports;
    this.#temps = new BranchTemps(ports);
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
    await this.#temps.close();
  }

  #precheck(sourceId: string, ownerId: string, messageId: number, busy: boolean): ForkPlan {
    const { store } = this.#ports;
    const tree = store.getMessages(sourceId, ownerId);
    // Same synchronous segment as the messages: the paths are those of the rows just read.
    const attachments = store.attachmentPaths(sourceId);
    const resume = store.runtimeState(sourceId);
    if (tree === null || resume === null) {
      throw new HttpError("not_found");
    }
    // Read-only once archived: ahead of the fork point's own 400 and of session_busy.
    if (tree.session.archivedAt !== null) {
      throw new HttpError("session_archived");
    }
    const users = tree.messages.filter((message) => message.role === "user");
    const user = users.find((message) => message.id === messageId);
    if (user === undefined) {
      throw new HttpError("bad_request");
    }
    if (busy || tree.session.status === "running") {
      throw new HttpError("session_busy");
    }
    if (isCommand(user.content, this.#ports, resume)) {
      throw new HttpError("bad_request");
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
      text: user.content,
      users,
      attachments,
      stored: user.attachments,
      expectedAssistantId: assistant?.id ?? null,
      file: resume.ompSessionFile,
      workspaceId: resume.workspaceId,
    };
  }

  async #fork(plan: ForkPlan, retired: Promise<void>): Promise<ForkResult> {
    await retired;
    // Before admission: an unusable root fails the fork without taking (or evicting) capacity.
    const cwd = this.#ports.cwdOf(plan.ownerId, plan.workspaceId);
    // Claim key: the source session; token key: the new session's pre-generated id.
    const branched = await this.#temps.branchAt({
      claimKey: plan.sourceId,
      tokenKey: plan.sessionId,
      ownerId: plan.ownerId,
      cwd,
      resumePath: plan.file,
      messageId: plan.messageId,
      users: plan.users,
      attachments: plan.attachments,
    });
    return this.#commit(plan, branched);
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
    // The stored content, not the branch text: an escaped entry carries the wire-side space, and
    // the entry of a message with attachments their suffix. The attachments are the stored list.
    return { session, draft: plan.text, attachments: plan.stored };
  }
}

/** A whitelisted command turn left no omp `user` entry; the skill list is read only for `/` text. */
function isCommand(content: string, ports: SkillsPort, session: Resume): boolean {
  if (!content.startsWith("/")) {
    return false;
  }
  const skills = ports.skills(session.ownerId, session.workspaceId);
  return classifyPrompt(content, skills).kind !== "text";
}
