/**
 * The snapshot step of an accepted prompt (#945, design D9「接入点」「登记」of
 * s1f-session-list-temp-space; spec workspace-snapshots「受理时做快照」).
 *
 * The prompt route passes `step(turn)` to `supervisor.prompt` as its `beforeDispatch`: the
 * supervisor runs it once the turn accepts a stop intent and before any wait or spawn, so a stop or
 * a delete that arrives during the snapshot takes the existing paths. The step never rejects: a
 * snapshot that could not be taken, or a registration row that could not be written, is told to the
 * service error channel and the prompt is dispatched all the same.
 *
 * The snapshot service is a port declared here by shape; `createApp` binds it to the workspaces
 * module. Nothing is imported from `workspaces/`.
 */
import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceRootOf } from "./session-cwd.js";
import {
  insertTurnSnapshot,
  latestOkTurnSnapshot,
  listSessionTurnSnapshots,
  readStoredTodo,
  type SkippedPath,
  type TurnSnapshotOutcome,
  type UndoState,
  undoStatesOf,
} from "./store-undo.js";

/** What `take` resolves with; `skipped` reasons are stored as given and never interpreted. */
type TakeOutcome =
  | { outcome: "ok"; skipped: readonly SkippedPath[] }
  | { outcome: "too_large" }
  | { outcome: "failed"; error: unknown };

/** What `restore` resolves with: the counts and the entries left as they were, by relative path. */
export interface RestoreOutcome {
  restored: number;
  removed: number;
  skipped: readonly SkippedPath[];
  failed: readonly { path: string }[];
}

/** The one workspace-snapshots service of the app, bound to its snapshot root and limits. */
export interface TurnSnapshotService {
  /**
   * Snapshots the workspace into the directory of `userMessageId`. `previousMessageId` is the
   * workspace's latest successful snapshot and is left out when there is none (never `null`).
   */
  take(
    workspaceRoot: string,
    workspaceId: string,
    userMessageId: number,
    previousMessageId?: number,
  ): Promise<TakeOutcome>;
  /** Removes the snapshot directory of one message; a missing one is success. */
  remove(workspaceId: string, messageId: number): Promise<void>;
  /** Removes the workspace's whole snapshot directory; a missing one is success. */
  removeWorkspace(workspaceId: string): Promise<void>;
  /**
   * Puts the workspace back to the snapshot of `messageId`. Rejects on a structural failure (no
   * or a damaged manifest, a root that is no directory); single entries end up in `failed`.
   */
  restore(workspaceRoot: string, workspaceId: string, messageId: number): Promise<RestoreOutcome>;
}

interface TurnSnapshotDependencies {
  db: DatabaseSync;
  snapshots: TurnSnapshotService;
  workspaceRootOf: WorkspaceRootOf;
  /** The session module's synchronous service error channel. */
  onError: (error: Error) => void;
}

/** One accepted prompt, as the route knows it right after admission. */
interface AcceptedTurn {
  ownerId: string;
  sessionId: string;
  /** The session's binding; null for a legacy unbound session. */
  workspaceId: string | null;
  userMessageId: number;
  /** Whether the text is a whitelisted command (`builtin` / `skill`). */
  command: boolean;
}

export interface TurnSnapshots {
  /** The pre-dispatch step of this turn. Building it does nothing; running it never rejects. */
  step(turn: AcceptedTurn): () => Promise<void>;
  /**
   * After a compensated acceptance, a committed undo or a committed session delete: removes the
   * message's snapshot directory (its registration row went with the message). Never rejects; a
   * failure is only reported.
   */
  discard(workspaceId: string | null, userMessageId: number): Promise<void>;
  /**
   * After the row of a temporary workspace was deleted: removes its whole snapshot directory.
   * Never rejects; a failure is only reported.
   */
  discardWorkspace(workspaceId: string): Promise<void>;
  /**
   * The `undo` value of each user message of the session, as its registration rows stand at this
   * call (one synchronous read); `workspaceId` is the session's binding. Unlike the two above it
   * throws when the database does.
   */
  undoStates(sessionId: string, workspaceId: string | null): (userMessageId: number) => UndoState;
  /**
   * Restores the owner's workspace from the snapshot of `messageId` (undo with `restore` /
   * `force`). Rejects as the service does, and when the workspace root cannot be resolved.
   */
  restore(ownerId: string, workspaceId: string, messageId: number): Promise<RestoreOutcome>;
}

type Registration = { outcome: TurnSnapshotOutcome; skipped: readonly SkippedPath[] };

export function createTurnSnapshots(deps: TurnSnapshotDependencies): TurnSnapshots {
  const { db, snapshots } = deps;

  const report = (error: unknown): void => {
    try {
      deps.onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A failing error channel must not fail the prompt either.
    }
  };

  /** Every failure is reported here, once, and becomes `failed`. */
  const snapshot = async (
    ownerId: string,
    workspaceId: string,
    userMessageId: number,
  ): Promise<Registration> => {
    try {
      const root = deps.workspaceRootOf(ownerId, workspaceId);
      if (root === null) {
        throw new Error("turn snapshot: workspace root is unresolvable");
      }
      const previous = latestOkTurnSnapshot(db, workspaceId)?.messageId;
      // Omitted, not null: `take` rejects a null before it writes anything.
      const result =
        previous === undefined
          ? await snapshots.take(root, workspaceId, userMessageId)
          : await snapshots.take(root, workspaceId, userMessageId, previous);
      if (result.outcome === "ok") {
        return { outcome: "ok", skipped: result.skipped };
      }
      if (result.outcome === "failed") {
        report(result.error);
      }
      return { outcome: result.outcome, skipped: [] };
    } catch (error) {
      report(error);
      return { outcome: "failed", skipped: [] };
    }
  };

  const discard = async (workspaceId: string | null, userMessageId: number): Promise<void> => {
    if (workspaceId === null) {
      return;
    }
    try {
      await snapshots.remove(workspaceId, userMessageId);
    } catch (error) {
      report(error);
    }
  };

  return {
    step: (turn) => async () => {
      const { workspaceId, userMessageId } = turn;
      if (workspaceId === null) {
        return;
      }
      let taken = false;
      try {
        // Read before the snapshot: the task list as it was when the prompt was accepted.
        const todo = readStoredTodo(db, turn.sessionId);
        const registration: Registration = turn.command
          ? { outcome: "command", skipped: [] }
          : await snapshot(turn.ownerId, workspaceId, userMessageId);
        taken = registration.outcome === "ok";
        insertTurnSnapshot(db, {
          messageId: userMessageId,
          workspaceId,
          outcome: registration.outcome,
          skipped: registration.skipped,
          todo,
          createdAt: Date.now(),
        });
      } catch (error) {
        report(error);
        if (taken) {
          // No row was written, so nothing would ever lead to this directory again.
          await discard(workspaceId, userMessageId);
        }
      }
    },
    discard,
    discardWorkspace: async (workspaceId) => {
      try {
        await snapshots.removeWorkspace(workspaceId);
      } catch (error) {
        report(error);
      }
    },
    undoStates: (sessionId, workspaceId) =>
      undoStatesOf(listSessionTurnSnapshots(db, sessionId), workspaceId),
    restore: async (ownerId, workspaceId, messageId) => {
      const root = deps.workspaceRootOf(ownerId, workspaceId);
      if (root === null) {
        throw new Error("undo restore: workspace root is unresolvable");
      }
      return snapshots.restore(root, workspaceId, messageId);
    },
  };
}
