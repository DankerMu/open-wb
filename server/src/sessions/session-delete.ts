/**
 * Session deletion (#525 non-running path, #526 running path; parent D3 "删除"). One call runs,
 * in this order: the control-claim check and hold → owner recheck → for a running session, under
 * that same claim, the supervisor stop (Deny pending approvals, then `abort`, or a stop intent
 * before the dispatch receipt) and the wait for the store to release the turn (terminal state
 * persisted, or the admission compensated; a faulted turn rejects → generic 5xx) → tombstone →
 * supervisor `retire` → the in-memory active-turn invariant → one delete + audit transaction →
 * post-commit removal of the session file (validated first: the path is omp-reported and must
 * name a regular file directly inside the owner's session dir). From the tombstone up to `retire`
 * is one synchronous segment. The tombstone set belongs to this deleter instance; the SSE route
 * asks `isDeleting` before it subscribes. The tombstone is lifted before the claim on every exit
 * path. No timer of its own: the bounds are the stop grace, retire escalation and acquisition's.
 */
import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { HttpError } from "../core/errors/index.js";
import { ompSessionDir } from "./omp/process.js";
import type { SessionStore, SessionView } from "./store.js";
import type { SessionMetadataStore } from "./store-metadata.js";
import type { SessionSupervisor } from "./supervisor.js";
import { asError } from "./supervisor-faults.js";

export interface SessionDeleter {
  deleteSession(sessionId: string, ownerId: string): Promise<void>;
  isDeleting(sessionId: string): boolean;
}

interface SessionDeleterDependencies {
  store: Pick<SessionStore, "getMessages" | "runtimeState" | "turnReleased">;
  supervisor: Pick<SessionSupervisor, "controlHeld" | "holdControl" | "retire" | "stop">;
  metadata: Pick<SessionMetadataStore, "deleteSession">;
  /** `OMP_STATE_DIR`; the owner's session dir under it bounds what a delete may unlink. */
  stateDir: string;
  /** The session module's synchronous service error channel (session file removal only). */
  onError: (error: Error) => void;
}

type Report = (error: unknown) => void;

const OUTSIDE_SESSION_DIR = "session delete: session file outside the owner session dir";
const NOT_REGULAR_FILE = "session delete: session file is not a regular file";

export function createSessionDeleter(deps: SessionDeleterDependencies): SessionDeleter {
  const tombstones = new Set<string>();

  const report: Report = (error) => {
    try {
      deps.onError(asError(error));
    } catch {
      // A failing error channel must not turn a committed delete into a 5xx.
    }
  };

  /** Held by regenerate, fork, stop or another DELETE → 409 with no side effect. */
  const claim = (sessionId: string): (() => void) => {
    if (deps.supervisor.controlHeld(sessionId)) {
      throw new HttpError("session_busy");
    }
    return deps.supervisor.holdControl(sessionId);
  };

  /** Rechecked under the claim: gone (concurrent delete) → 404; otherwise its status. */
  const requireOwned = (sessionId: string, ownerId: string): SessionView["status"] => {
    const tree = deps.store.getMessages(sessionId, ownerId);
    if (tree === null) {
      throw new HttpError("not_found");
    }
    return tree.session.status;
  };

  const retireAndRemove = async (sessionId: string, ownerId: string): Promise<void> => {
    await deps.supervisor.retire(sessionId);
    // An in-memory check after authorization, not authorization itself.
    const activeTurn = deps.store.runtimeState(sessionId)?.activeTurn;
    if (activeTurn !== undefined && activeTurn !== null) {
      throw new Error("session delete: active turn survived retire");
    }
    const removed = deps.metadata.deleteSession(ownerId, sessionId);
    if (removed === null) {
      throw new HttpError("not_found");
    }
    if (removed.ompSessionFile !== null) {
      await removeSessionFile(
        removed.ompSessionFile,
        ompSessionDir(deps.stateDir, ownerId),
        report,
      );
    }
  };

  return {
    async deleteSession(sessionId, ownerId) {
      const release = claim(sessionId);
      try {
        if (requireOwned(sessionId, ownerId) === "running") {
          // A user stop meanwhile joins this one (same turn entry: one Deny snapshot, one abort).
          await deps.supervisor.stop(sessionId);
          await deps.store.turnReleased(sessionId);
        }
        tombstones.add(sessionId);
        try {
          await retireAndRemove(sessionId, ownerId);
        } finally {
          tombstones.delete(sessionId);
        }
      } finally {
        release();
      }
    },
    isDeleting(sessionId) {
      return tombstones.has(sessionId);
    },
  };
}

/**
 * The row is already gone, so nothing here throws. `path` is omp-reported and was never validated
 * on write: it must be absolute and its parent's realpath must be the owner's session dir; from then
 * on only `target` (that realpath joined with the basename) is touched, so no component of the omp
 * string is re-resolved. `target` is unlinked only when `lstat` (no symlink follow) says regular
 * file; anything else is reported and left alone. ENOENT at any step is success. Residual: `sessions`
 * and `sessions/<ownerId>` are group-writable (2770) and Node has no `unlinkat`, so between realpath
 * and `unlink` the omp group can still rename-swap `sessions/<ownerId>` (or an ancestor up to
 * stateDir) for a symlink; that means replacing the owner's whole session dir, and closing it needs
 * a dir fd / `unlinkat` or tighter `sessions/` ownership.
 */
async function removeSessionFile(path: string, sessionDir: string, report: Report): Promise<void> {
  if (!isAbsolute(path)) {
    report(new Error(OUTSIDE_SESSION_DIR));
    return;
  }
  try {
    const [parent, expected] = await Promise.all([realpath(dirname(path)), realpath(sessionDir)]);
    if (parent !== expected) {
      report(new Error(OUTSIDE_SESSION_DIR));
      return;
    }
    const target = join(expected, basename(path));
    if (!(await lstat(target)).isFile()) {
      report(new Error(NOT_REGULAR_FILE));
      return;
    }
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      report(error);
    }
  }
}
