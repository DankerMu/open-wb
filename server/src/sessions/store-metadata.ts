/**
 * Session metadata writes (#523, parent D2 "模块拆分"): creation with an optional workspace
 * binding and scene. The row insert and its `session.bind` audit share one SQLite transaction, so
 * an audit failure leaves no session row. Ownership of the workspace is the route's job.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { emit as canonicalEmit } from "../core/audit/index.js";
import { requireChanges, runOwnedTransaction } from "./store-branch.js";

export type SessionScene = "office" | "code" | "design";

export interface SessionCreateInput {
  workspaceId?: string;
  scene?: SessionScene;
}

interface CreatedSessionView {
  id: string;
  title: null;
  status: "idle";
  createdAt: number;
  updatedAt: number;
  scene: SessionScene | null;
  workspaceId: string | null;
  pinnedAt: null;
}

export interface SessionMetadataStore {
  createSession(ownerId: string, input: SessionCreateInput): CreatedSessionView;
}

const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id, scene) VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?)";

export function createSessionMetadataStore(
  db: DatabaseSync,
  options: { emit: typeof canonicalEmit },
): SessionMetadataStore {
  return {
    createSession(ownerId, input) {
      const now = Date.now();
      const id = randomBytes(16).toString("hex");
      const workspaceId = input.workspaceId ?? null;
      const scene = input.scene ?? null;
      runOwnedTransaction(db, "session create rollback failed", () => {
        requireChanges(
          db.prepare(INSERT_SESSION).run(id, ownerId, now, now, workspaceId, scene).changes,
          1,
          "session create",
        );
        if (workspaceId !== null) {
          options.emit(db, {
            kind: "session.bind",
            actorId: ownerId,
            title: "绑定工作空间",
            workspaceId,
            detail: { sessionId: id, scene },
          });
        }
      });
      return {
        id,
        title: null,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        scene,
        workspaceId,
        pinnedAt: null,
      };
    },
  };
}
