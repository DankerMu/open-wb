/**
 * The part of the branch family that fork (#466) and undo share (#950): the entry alignment by
 * wire candidates (#555; with the attachment suffix of a message that stores attachments, #1018),
 * `branch` → `get_state`, and the temporary process that runs them — pool admitted, never a slot or
 * a generation, shut down before its caller commits anything. The prechecks, the control claim and
 * the commit stay with the caller.
 */
import { HttpError } from "../core/errors/index.js";
import { SessionRuntime } from "./omp/runtime.js";
import {
  type PoolEntry,
  type ProcessPool,
  type SpawnShared,
  sessionRuntimeOpts,
  temporaryTokens,
} from "./pool.js";
import { attachmentSuffix } from "./slash-commands.js";
import type { SessionSupervisorRuntime } from "./supervisor.js";
import type { TokenRegistry } from "./tokens.js";
import type { ControlClaims } from "./turn-control.js";

export type Branched = { text: string; sessionFile: string };

export type StoredUser = { id: number; content: string };

interface BranchTempPorts {
  controls: ControlClaims;
  pool: ProcessPool;
  tokens: TokenRegistry;
  config: SessionSupervisorRuntime;
  /** The supervisor's spawn gate and log: the temporary process queues on the same permits. */
  spawn: SpawnShared;
  closed(): boolean;
}

interface BranchTempPlan {
  /** The session whose control claim marks the admission busy (fork: the source session). */
  claimKey: string;
  /**
   * The key the temporary process's token is issued and revoked under (fork: the new session's
   * pre-generated id). Never a session that owns a live token: the cleanup revokes this key.
   */
  tokenKey: string;
  ownerId: string;
  /** Resolved by the caller before admission: an unusable root takes (or evicts) no capacity. */
  cwd: string;
  /** The omp session file the temporary process resumes. */
  resumePath: string;
  /** The branch point's message id, and the session's user messages in order to align it. */
  messageId: number;
  users: readonly StoredUser[];
  /**
   * Message id → the attachment paths it stores, read with `users` in the caller's precheck; a
   * message with no entry has no attachment.
   */
  attachments: ReadonlyMap<number, readonly string[]>;
}

/**
 * The temporary processes of one caller: each is admitted by the pool, runs get_branch_messages →
 * branch → get_state and is shut down before `branchAt` settles; `close` reaps the in-flight ones.
 */
export class BranchTemps {
  readonly #ports: BranchTempPorts;
  readonly #temps = new Set<SessionRuntime>();

  constructor(ports: BranchTempPorts) {
    this.#ports = ports;
  }

  /** Shuts down every in-flight temporary process (shutdown); never rejects. */
  async close(): Promise<void> {
    await Promise.all([...this.#temps].map(stopQuietly));
  }

  /** Every failure is `agent_unavailable`; the process has exited once this settles. */
  async branchAt(plan: BranchTempPlan): Promise<Branched> {
    const { pool, controls, tokens } = this.#ports;
    let temp: SessionRuntime | undefined;
    const entry = await pool.admit({
      busy: () => controls.held(plan.claimKey),
      retire: () => (temp === undefined ? Promise.resolve() : stopQuietly(temp)),
    });
    if (this.#ports.closed()) {
      pool.release(entry);
      throw new HttpError("agent_unavailable");
    }
    const runtime = new SessionRuntime(
      sessionRuntimeOpts(this.#ports.config, this.#ports.spawn, {
        sessionId: plan.tokenKey,
        ownerId: plan.ownerId,
        cwd: plan.cwd,
        approvalMode: "write",
        modelId: this.#ports.config.modelId,
        resumePath: plan.resumePath,
        tokens: temporaryTokens(pool, entry, tokens),
        onExit: () => {
          pool.release(entry);
        },
      }),
    );
    temp = runtime;
    this.#temps.add(runtime);
    try {
      return await this.#branch(runtime, entry, plan);
    } finally {
      await stopQuietly(runtime);
      pool.release(entry);
      tokens.revoke(plan.tokenKey);
      this.#temps.delete(runtime);
    }
  }

  /** get_branch_messages → first-fit alignment → branch → get_state on the temporary process. */
  async #branch(
    runtime: SessionRuntime,
    entry: PoolEntry,
    plan: BranchTempPlan,
  ): Promise<Branched> {
    let data: unknown;
    try {
      data = await runtime.command({ type: "get_branch_messages" });
    } catch {
      throw new HttpError("agent_unavailable");
    }
    const entryId = alignBranchEntries(plan.users, branchEntries(data), plan.attachments).get(
      plan.messageId,
    );
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
}

function stopQuietly(runtime: SessionRuntime): Promise<void> {
  return runtime.shutdown().catch(() => undefined);
}

/** (c): any failure is agent_unavailable; get_state always follows branch. */
export async function branchTo(runtime: SessionRuntime, entryId: string): Promise<Branched> {
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

/**
 * Whether an entry's text is a wire candidate of a stored user message: its content (sent verbatim
 * before the prompt route escaped) or, for `/` text, its escaped form — each followed by the
 * attachment suffix of the paths the message stores, which is empty for none. A message with
 * attachments and no text therefore has one candidate, the suffix itself. The stored row only —
 * the current skill set is never consulted, so installing or removing a skill moves no alignment.
 */
function matches(entryText: string, content: string, paths: readonly string[]): boolean {
  const suffix = attachmentSuffix(paths);
  return (
    entryText === content + suffix ||
    (content.startsWith("/") && entryText === ` ${content}${suffix}`)
  );
}

/** The entries of a get_branch_messages answer; anything but a list is no entry. */
export function branchEntries(data: unknown): readonly unknown[] {
  const messages = record(data)?.messages;
  return Array.isArray(messages) ? messages : [];
}

/**
 * The entryId of `entry` when it is well formed and its text is a wire candidate of the message
 * stored as `content` with the attachment `paths`.
 */
export function entryFor(
  entry: unknown,
  content: string,
  paths: readonly string[],
): string | undefined {
  const { entryId, text } = record(entry) ?? {};
  return typeof entryId === "string" && typeof text === "string" && matches(text, content, paths)
    ? entryId
    : undefined;
}

/**
 * First-fit from the front: a user message matching the current entry takes it and both advance;
 * one that does not is skipped (a command or other local-only turn) and consumes no entry. An
 * entry is never skipped, so a malformed one aligns nothing from there on.
 */
function alignBranchEntries(
  users: readonly StoredUser[],
  entries: readonly unknown[],
  attachments: ReadonlyMap<number, readonly string[]>,
): Map<number, string> {
  const aligned = new Map<number, string>();
  let next = 0;
  for (const user of users) {
    const entryId = entryFor(entries[next], user.content, attachments.get(user.id) ?? []);
    if (entryId !== undefined) {
      aligned.set(user.id, entryId);
      next += 1;
    }
  }
  return aligned;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
