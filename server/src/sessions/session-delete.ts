/**
 * Session deletion, non-running path (#525, parent D3 "删除"). One call runs, in this order: the
 * control-claim check and hold → owner recheck (a running session is a transitional 409) →
 * tombstone → supervisor `retire` → the in-memory active-turn invariant → one delete + audit
 * transaction → post-commit unlink of the session file. Everything up to `retire` is one
 * synchronous segment. The tombstone set belongs to this deleter instance; the SSE route asks
 * `isDeleting` before it subscribes. The tombstone is lifted before the claim on every exit path.
 */
import { unlink } from "node:fs/promises";
import { HttpError } from "../core/errors/index.js";
import type { SessionStore } from "./store.js";
import type { SessionMetadataStore } from "./store-metadata.js";
import type { SessionSupervisor } from "./supervisor.js";
import { asError } from "./supervisor-faults.js";

export interface SessionDeleter {
  deleteSession(sessionId: string, ownerId: string): Promise<void>;
  isDeleting(sessionId: string): boolean;
}

interface SessionDeleterDependencies {
  store: Pick<SessionStore, "getMessages" | "runtimeState">;
  supervisor: Pick<SessionSupervisor, "controlHeld" | "holdControl" | "retire">;
  metadata: Pick<SessionMetadataStore, "deleteSession">;
  /** The session module's synchronous service error channel (unlink failures only). */
  onError: (error: Error) => void;
}

export function createSessionDeleter(deps: SessionDeleterDependencies): SessionDeleter {
  const tombstones = new Set<string>();

  /** Held by regenerate, fork, stop or another DELETE → 409 with no side effect. */
  const claim = (sessionId: string): (() => void) => {
    if (deps.supervisor.controlHeld(sessionId)) {
      throw new HttpError("session_busy");
    }
    return deps.supervisor.holdControl(sessionId);
  };

  /** Rechecked under the claim: gone (concurrent delete) → 404; running → transitional 409. */
  const requireIdle = (sessionId: string, ownerId: string): void => {
    const tree = deps.store.getMessages(sessionId, ownerId);
    if (tree === null) {
      throw new HttpError("not_found");
    }
    if (tree.session.status === "running") {
      throw new HttpError("session_busy");
    }
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
      await unlinkReported(removed.ompSessionFile, deps.onError);
    }
  };

  return {
    async deleteSession(sessionId, ownerId) {
      const release = claim(sessionId);
      try {
        requireIdle(sessionId, ownerId);
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

/** The row is already gone: ENOENT is success, any other failure is reported and not thrown. */
async function unlinkReported(path: string, onError: (error: Error) => void): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onError(asError(error));
    }
  }
}
