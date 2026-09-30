/**
 * Session metadata writes (#523/#524, parent D2 "模块拆分"): creation with an optional workspace
 * binding and scene, and the title/scene/pin PATCH. The row insert and its `session.bind` audit
 * share one SQLite transaction, so an audit failure leaves no session row. Ownership of the
 * workspace is the route's job. A PATCH is one owner-scoped UPDATE of only the given columns: it
 * never touches `updated_at`, `status`, `workspace_id`, the generation columns or message rows.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { emit as canonicalEmit } from "../core/audit/index.js";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { SESSION_COLUMNS, type SessionDbRow, type SessionView, toSessionView } from "./store.js";
import {
  hasChanges,
  requireAtMostOne,
  requireChanges,
  runOwnedTransaction,
} from "./store-branch.js";

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

/** At least one key (the route guarantees it); `title` is already trimmed and 1..80 code points. */
export interface SessionPatch {
  title?: string;
  scene?: SessionScene;
  pinned?: boolean;
}

export interface SessionMetadataStore {
  createSession(ownerId: string, input: SessionCreateInput): CreatedSessionView;
  /** The updated eight-key view; null when no row of this owner matched (unknown or deleted). */
  patchSession(ownerId: string, sessionId: string, patch: SessionPatch): SessionView | null;
}

const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id, scene) VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?)";

const SET_TITLE = "title = ?";
const SET_SCENE = "scene = ?";
/** Re-pinning keeps the original pin time. */
const SET_PINNED = "pinned_at = COALESCE(pinned_at, ?)";
const SET_UNPINNED = "pinned_at = NULL";

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

    patchSession(ownerId, sessionId, patch) {
      const { assignments, values } = patchAssignments(patch, Date.now());
      const changes = db
        .prepare(`UPDATE chat_sessions SET ${assignments} WHERE id = ? AND owner_id = ?`)
        .run(...values, sessionId, ownerId).changes;
      requireAtMostOne(changes, "session patch");
      if (!hasChanges(changes)) {
        return null;
      }
      const row = db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`)
        .get(sessionId) as unknown as SessionDbRow | undefined;
      if (row === undefined) {
        throw new Error("patched session row missing");
      }
      return toSessionView(row, createSqliteTextDecoder(db));
    },
  };
}

/** The SET clause from source-constant fragments only; every value travels as a parameter. */
function patchAssignments(
  patch: SessionPatch,
  now: number,
): { assignments: string; values: SQLInputValue[] } {
  const fragments: string[] = [];
  const values: SQLInputValue[] = [];
  if (patch.title !== undefined) {
    fragments.push(SET_TITLE);
    values.push(patch.title);
  }
  if (patch.scene !== undefined) {
    fragments.push(SET_SCENE);
    values.push(patch.scene);
  }
  if (patch.pinned === true) {
    fragments.push(SET_PINNED);
    values.push(now);
  } else if (patch.pinned === false) {
    fragments.push(SET_UNPINNED);
  }
  return { assignments: fragments.join(", "), values };
}
