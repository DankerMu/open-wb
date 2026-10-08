/**
 * Undo of a user message, in place (#951; design D11 of s1f-session-list-temp-space; spec
 * message-undo「撤回 REST」「对话原地回退」「文件还原与结果」): `POST /api/sessions/:id/undo` and its
 * orchestration. `files:"keep"` rewinds the conversation and leaves the workspace as it is;
 * `restore` / `force` also put the workspace back to the message's snapshot (#952), after two more
 * prechecks. The snapshot directory cleanup is task 12.3.
 *
 * It is fork's process policy applied to the session itself: with the session's control claim
 * held, the session's own process is retired, a temporary process (pool admitted, never a slot or a
 * generation, `stream_epoch` untouched) resumes the session file and runs get_branch_messages →
 * branch → get_state, it is shut down, and only then one transaction (`commitUndo`) removes the
 * message and everything after it and moves the session onto the branch file. The file restore
 * runs between the two: the session has no process then, and a restore that rejects commits
 * nothing. Anything that fails before the transaction leaves every row as it was; the retired
 * process is not brought back, the next prompt spawns lazily on the old file.
 *
 * The supervisor has no database, snapshot service, audit sink or list notifier, so the database
 * steps (the undo state of the message, the shared-workspace checks, the transaction) and the
 * restore are callbacks the route passes in with the request, and the route sends the two list
 * events once `supervisor.undo` has resolved.
 * Used inside `sessions/` only.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { emit } from "../core/audit/index.js";
import { HttpError } from "../core/errors/index.js";
import { type Branched, BranchTemps, type StoredUser } from "./branch-temp.js";
import type { SessionListNotifier } from "./list-events.js";
import {
  currentPrincipal,
  noStoreSessionHeaders,
  requireOwnedSession,
  requirePlainRecord,
  type SessionSupervisorPort,
  toPublicSession,
} from "./rest.js";
import type { SessionMessageTree, SessionStore } from "./store.js";
import {
  commitUndo,
  listSessionTurnSnapshots,
  SKIPPED_PATHS_LIMIT,
  type UndoCommit,
  type UndoState,
  undoConflicts,
  undoStatesOf,
  workspaceRunsElsewhere,
} from "./store-undo.js";
import type { RestoreOutcome, TurnSnapshots } from "./turn-snapshot.js";

export interface UndoRequest {
  sessionId: string;
  ownerId: string;
  messageId: number;
  /**
   * Precheck step 4, called in the precheck's synchronous segment: the undo state of this user
   * message of the session, whose binding is `workspaceId`.
   */
  undoState(workspaceId: string | null): UndoState;
  /**
   * Precheck steps 6 and 7, right after step 5 in the same synchronous segment, when files are to
   * be restored: throws when the workspace is being used by, or was changed through, another
   * session.
   */
  sharing?(workspaceId: string): void;
  /**
   * Step 4, awaited once the temporary process has exited and before `commit`, when files are to
   * be restored. A rejection is the request's failure as it is, and nothing is committed.
   */
  restore?(workspaceId: string): Promise<void>;
  /**
   * Step 5, called once the temporary process has exited: the undo transaction. What it throws is
   * the request's failure as it is.
   */
  commit(input: Pick<UndoCommit, "expectedLastAssistantId" | "ompSessionFile">): void;
}

/** The session as the commit left it, and the undone message's stored content. */
export type UndoResult = { session: SessionMessageTree["session"]; draft: string };

/** The fork ports this needs: the temporary process's, the store, the cwd and the retirement. */
type UndoPorts = ConstructorParameters<typeof BranchTemps>[0] & {
  store: SessionStore;
  /** The session cwd resolution (session-cwd.ts), shared with the supervisor's acquisitions. */
  cwdOf(ownerId: string, workspaceId: string | null): string;
  /**
   * Retires the session's process (if any) and ends its per-session stream subscriptions; resolves
   * once the process exited, never rejects.
   */
  retireSource(sessionId: string): Promise<void>;
};

interface UndoPlan {
  /** The undone message's stored content, and the session's user messages in order to align it. */
  text: string;
  users: readonly StoredUser[];
  /** The last assistant message of the whole session as the precheck read it. */
  expectedLastAssistantId: number | null;
  file: string;
  workspaceId: string | null;
}

/**
 * Undo (#951): precheck + claim of the session, its own process retired first, a temporary process
 * runs the three commands and is shut down, then the request's commit runs the one transaction.
 */
export class Undos {
  readonly #ports: UndoPorts;
  readonly #temps: BranchTemps;

  constructor(ports: UndoPorts) {
    this.#ports = ports;
    this.#temps = new BranchTemps(ports);
  }

  /** Every failure is a rejection; claim, precheck and the retirement share one segment. */
  async run(request: UndoRequest): Promise<UndoResult> {
    const { controls, retireSource } = this.#ports;
    // Read before the claim below is taken: inside it the session always reads as held.
    const busy = controls.held(request.sessionId);
    return controls.during(request.sessionId, () => {
      const plan = this.#precheck(request, busy);
      return this.#undo(request, plan, retireSource(request.sessionId));
    });
  }

  /** Shuts down every in-flight temporary process (shutdown); never rejects. */
  async close(): Promise<void> {
    await this.#temps.close();
  }

  /** Steps 1–7 of「撤回 REST」, in that order; reads only. */
  #precheck(request: UndoRequest, busy: boolean): UndoPlan {
    const { store } = this.#ports;
    const { sessionId, ownerId, messageId } = request;
    const tree = store.getMessages(sessionId, ownerId);
    const resume = store.runtimeState(sessionId);
    if (tree === null || resume === null) {
      throw new HttpError("not_found");
    }
    // Read-only once archived: ahead of session_busy and of everything about the message.
    if (tree.session.archivedAt !== null) {
      throw new HttpError("session_archived");
    }
    if (busy || tree.session.status === "running") {
      throw new HttpError("session_busy");
    }
    const users = tree.messages.filter((message) => message.role === "user");
    const user = users.find((message) => message.id === messageId);
    if (user === undefined) {
      throw new HttpError("bad_request");
    }
    // Only `available` has a registration to rewind to; a command turn has no omp entry either.
    if (request.undoState(resume.workspaceId) !== "available") {
      throw new HttpError("bad_request");
    }
    if (resume.ompSessionFile === null) {
      throw new HttpError("agent_unavailable");
    }
    request.sharing?.(bound(resume.workspaceId));
    const assistant = tree.messages.findLast((message) => message.role === "assistant");
    return {
      text: user.content,
      users,
      expectedLastAssistantId: assistant?.id ?? null,
      file: resume.ompSessionFile,
      workspaceId: resume.workspaceId,
    };
  }

  async #undo(request: UndoRequest, plan: UndoPlan, retired: Promise<void>): Promise<UndoResult> {
    await retired;
    const { sessionId, ownerId, messageId } = request;
    // Before admission: an unusable root fails the undo without taking (or evicting) capacity.
    const cwd = this.#ports.cwdOf(ownerId, plan.workspaceId);
    // Claim key: the session. Token key: a fresh one, never the session's id — the session's own
    // process revoked its token as it retired, and the cleanup below revokes this key.
    const branched = await this.#temps.branchAt({
      claimKey: sessionId,
      tokenKey: randomBytes(16).toString("hex"),
      ownerId,
      cwd,
      resumePath: plan.file,
      messageId,
      users: plan.users,
    });
    if (this.#ports.closed()) {
      throw new HttpError("agent_unavailable");
    }
    // A branch that left the session on its own file rewound nothing: there is nothing to commit.
    if (branched.sessionFile === plan.file) {
      throw new HttpError("agent_unavailable");
    }
    // The session has no process now. Not translated: a restore that rejects is the generic 5xx.
    await request.restore?.(bound(plan.workspaceId));
    return this.#commit(request, plan, branched);
  }

  /** After the temporary process exited and the files were restored: the one transaction. */
  #commit(request: UndoRequest, plan: UndoPlan, branched: Branched): UndoResult {
    // Not translated: a CAS failure is its own session_busy, an audit failure the generic 5xx.
    request.commit({
      expectedLastAssistantId: plan.expectedLastAssistantId,
      ompSessionFile: branched.sessionFile,
    });
    const tree = this.#ports.store.getMessages(request.sessionId, request.ownerId);
    if (tree === null) {
      throw new HttpError("not_found");
    }
    // The stored content, not the branch text: an escaped entry carries the wire-side space.
    return { session: tree.session, draft: plan.text };
  }
}

/** The binding of a session whose message read `available`: such a message has a registration. */
function bound(workspaceId: string | null): string {
  if (workspaceId === null) {
    throw new Error("undo restore: the session is bound to no workspace");
  }
  return workspaceId;
}

interface UndoRouteDependencies {
  db: DatabaseSync;
  store: Pick<SessionStore, "getMessages">;
  supervisor: Pick<SessionSupervisorPort, "undo">;
  listEvents: Pick<SessionListNotifier, "notify" | "notifyRewound">;
  turnSnapshots: Pick<TurnSnapshots, "restore">;
}

type UndoFiles = UndoCommit["files"];

/**
 * The longest valid body is ~50 bytes (`{"messageId":9007199254740991,"files":"restore"}`); 1 KiB,
 * as for fork, keeps every oversized body a deterministic owned 400.
 */
const UNDO_BODY_LIMIT = 1_024;
const FILES: ReadonlySet<unknown> = new Set<UndoFiles>(["restore", "force", "keep"]);
/** The `files` of a `keep` undo: nothing was read from a snapshot and nothing restored. */
const KEPT_FILES = {
  mode: "kept",
  restored: 0,
  removed: 0,
  skipped: { count: 0, paths: [] },
  failed: { count: 0, paths: [] },
} as const;

/** The `files` of an undo that restored: both lists cut to their first 200, with the totals. */
function restoredFiles({ restored, removed, skipped, failed }: RestoreOutcome) {
  return {
    mode: "restored",
    restored,
    removed,
    skipped: {
      count: skipped.length,
      paths: skipped.slice(0, SKIPPED_PATHS_LIMIT).map(({ path, reason }) => ({ path, reason })),
    },
    failed: {
      count: failed.length,
      paths: failed.slice(0, SKIPPED_PATHS_LIMIT).map(({ path }) => ({ path })),
    },
  };
}

/**
 * `POST /api/sessions/:id/undo`: owner checked before the body is parsed, an exact
 * `{messageId, files}` body, the prechecks and the orchestration in `supervisor.undo`, then the
 * two list events and 200 `{session, draft, files}`.
 */
export function registerUndoRoute(app: FastifyInstance, dependencies: UndoRouteDependencies): void {
  const { db, listEvents, turnSnapshots } = dependencies;
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/undo",
    {
      bodyLimit: UNDO_BODY_LIMIT,
      onRequest: noStoreSessionHeaders,
      // Unknown and foreign ids share one 404, before the body is parsed.
      preParsing: (request, _reply, payload, done) => {
        requireOwnedSession(dependencies.store, request);
        done(null, payload);
      },
    },
    async (request, reply) => {
      const { messageId, files } = parseUndoBody(request.body);
      const ownerId = currentPrincipal(request).id;
      const sessionId = request.params.id;
      let outcome: RestoreOutcome | undefined;
      // `keep` passes neither: no other session is looked at and no snapshot is read.
      const withFiles: Pick<UndoRequest, "sharing" | "restore"> = {
        sharing: (workspaceId) => {
          if (workspaceRunsElsewhere(db, sessionId, workspaceId)) {
            throw new HttpError("session_busy");
          }
          // `force` is the answer to this refusal: it restores over the other session's changes.
          if (
            files === "restore" &&
            undoConflicts(db, { ownerId, sessionId, workspaceId, messageId })
          ) {
            throw new HttpError("undo_conflict");
          }
        },
        restore: async (workspaceId) => {
          outcome = await turnSnapshots.restore(ownerId, workspaceId, messageId);
        },
      };
      // Archive, status and claim are read inside `undo`, in this same synchronous segment: the
      // session as it is now, not as the owner check saw it before the body arrived.
      const result = await dependencies.supervisor.undo({
        sessionId,
        ownerId,
        messageId,
        undoState: (workspaceId) =>
          undoStatesOf(listSessionTurnSnapshots(db, sessionId), workspaceId)(messageId),
        ...(files === "keep" ? {} : withFiles),
        commit: (branched) => {
          commitUndo(db, emit, {
            ownerId,
            sessionId,
            messageId,
            files,
            now: Date.now(),
            ...branched,
          });
        },
      });
      // After the commit, before the reply; a refused or failed undo threw above and tells no one.
      listEvents.notify(ownerId);
      listEvents.notifyRewound(ownerId, sessionId);
      return reply.code(200).send({
        session: toPublicSession(result.session),
        draft: result.draft,
        files: outcome === undefined ? KEPT_FILES : restoredFiles(outcome),
      });
    },
  );
}

/**
 * Exactly `{messageId, files}`: a positive safe integer and one of the three modes. Whether the
 * id is a user message of this session is the precheck's.
 */
function parseUndoBody(body: unknown): { messageId: number; files: UndoFiles } {
  const record = requirePlainRecord(body);
  const { messageId, files } = record;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "messageId") ||
    !Object.hasOwn(record, "files") ||
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0 ||
    !FILES.has(files)
  ) {
    throw new HttpError("bad_request");
  }
  return { messageId, files: files as UndoFiles };
}
