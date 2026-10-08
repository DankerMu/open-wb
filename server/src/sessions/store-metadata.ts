/**
 * Session metadata writes (#523/#524, parent D2 "模块拆分"): creation with an optional workspace
 * binding and scene, and the title/scene/pin/archive PATCH. The row insert and its `session.bind`
 * audit share one SQLite transaction, so an audit failure leaves no session row. Ownership of the
 * workspace is the route's job; a temporary workspace cannot be bound by id (#925): the transaction
 * throws the same `not_found` and rolls the row back. A create without a workspace (#930, design
 * D6) makes a temporary one in that same transaction and binds it, with no audit row; when the
 * transaction rolls back, the directories that creation made are removed afterwards.
 * A PATCH is one owner-scoped UPDATE of only the given columns: it
 * never touches `updated_at`, `status`, `workspace_id`, the generation columns or message rows.
 * `archived: true` (#922) puts `status != 'running'` on that whole UPDATE, so a running session
 * gets none of the PATCH's keys.
 * A delete (#525) reads the file and message count, deletes the owner's row (messages, steps and
 * approvals cascade; fork children's `parent_session_id` is set NULL by the foreign keys) and
 * writes its `session.delete` audit in one transaction: an audit failure keeps the row. In that
 * same transaction (#928, design D8) a temporary workspace the deleted session was the last user
 * of loses its row, with a `workspace.delete` audit; its directory is the deleter's job after the
 * commit. So are the snapshot directories (#953): the registrations of the session's messages are
 * read in that transaction before the delete cascades them away, and returned.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { emit as canonicalEmit } from "../core/audit/index.js";
import { createSqliteTextDecoder } from "../core/db/index.js";
import { HttpError } from "../core/errors/index.js";
import { SESSION_COLUMNS, type SessionDbRow, type SessionView, toSessionView } from "./store.js";
import {
  decodeNullableText,
  hasChanges,
  requireAtMostOne,
  requireChanges,
  runOwnedTransaction,
} from "./store-branch.js";
import { listSessionTurnSnapshots, type TurnSnapshotOutcome } from "./store-undo.js";

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
  archivedAt: null;
  pendingApproval: false;
  temporaryWorkspace: boolean;
}

/** At least one key (the route guarantees it); `title` is already trimmed and 1..80 code points. */
export interface SessionPatch {
  title?: string;
  scene?: SessionScene;
  pinned?: boolean;
  archived?: boolean;
}

export interface SessionMetadataStore {
  createSession(ownerId: string, input: SessionCreateInput): CreatedSessionView;
  /**
   * The updated session view; null when this owner has no such row (unknown or deleted); `"busy"`
   * when the row exists but `archived: true` met a running session — nothing was written.
   */
  patchSession(
    ownerId: string,
    sessionId: string,
    patch: SessionPatch,
  ): SessionView | null | "busy";
  /**
   * A fresh synchronous read of this owner's `archived_at` (#923): the archive time, or null when
   * the session is not archived or this owner has no such row (admission then answers the 404).
   */
  archivedAt(sessionId: string, ownerId: string): number | null;
  /** The deleted row's file and message count; null when no row of this owner matched. */
  deleteSession(ownerId: string, sessionId: string): DeletedSession | null;
}

interface TemporaryWorkspaceRef {
  id: string;
  ownerId: string;
}

interface DeletedSession {
  ompSessionFile: string | null;
  messageCount: number;
  /** Present only when this delete also removed that temporary workspace's row. */
  temporaryWorkspace?: TemporaryWorkspaceRef;
  /** The registrations of the deleted user messages; only an `ok` one has a snapshot directory. */
  snapshots: { messageId: number; workspaceId: string; outcome: TurnSnapshotOutcome }[];
}

/** What the workspace store's `createTemporary` hands back, as far as session creation uses it. */
interface CreatedTemporaryWorkspace {
  workspace: { id: string };
  /** Only for a rolled-back transaction: removes the still-empty directories that call created. */
  removeCreatedDirs(): void;
}

export interface SessionMetadataStoreOptions {
  emit: typeof canonicalEmit;
  /**
   * The workspace store's `createTemporary` for this owner (injected by the assembly; sessions
   * does not import the workspaces module). Called inside the session-create transaction.
   */
  createTemporaryWorkspace: (ownerId: string) => CreatedTemporaryWorkspace;
  /** `SANDBOX_ROOT`: the `root` a `workspace.delete` audit names is built from its realpath. */
  sandboxRoot: string;
}

interface DeletedRow {
  omp_session_file: Uint8Array | null;
  workspace_id: string | null;
}

const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id, scene) VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?)";

const SELECT_TEMPORARY = "SELECT temporary FROM workspaces WHERE id = ?";

const SELECT_DELETED =
  "SELECT CAST(omp_session_file AS BLOB) AS omp_session_file, workspace_id FROM chat_sessions WHERE id = ? AND owner_id = ?";
const COUNT_MESSAGES = "SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?";
const DELETE_SESSION = "DELETE FROM chat_sessions WHERE id = ? AND owner_id = ?";
const SELECT_OWNED_TEMPORARY = "SELECT temporary FROM workspaces WHERE id = ? AND owner_id = ?";
/** Every session row counts as a user, whoever owns it and archived or not. */
const COUNT_WORKSPACE_SESSIONS = "SELECT COUNT(*) AS n FROM chat_sessions WHERE workspace_id = ?";
const DELETE_TEMPORARY_WORKSPACE =
  "DELETE FROM workspaces WHERE id = ? AND owner_id = ? AND temporary = 1";

const SET_TITLE = "title = ?";
const SET_SCENE = "scene = ?";
/** Re-pinning keeps the original pin time. */
const SET_PINNED = "pinned_at = COALESCE(pinned_at, ?)";
const SET_UNPINNED = "pinned_at = NULL";
/** Re-archiving keeps the original archive time. */
const SET_ARCHIVED = "archived_at = COALESCE(archived_at, ?)";
const SET_UNARCHIVED = "archived_at = NULL";
const PATCH_OWNED = "WHERE id = ? AND owner_id = ?";
/** Archiving and prompt admission (which writes `running`) cannot both succeed. */
const PATCH_OWNED_NOT_RUNNING = `${PATCH_OWNED} AND status != 'running'`;
const SELECT_OWNED = `SELECT 1 FROM chat_sessions ${PATCH_OWNED}`;
const SELECT_ARCHIVED_AT = `SELECT archived_at FROM chat_sessions ${PATCH_OWNED}`;

export function createSessionMetadataStore(
  db: DatabaseSync,
  options: SessionMetadataStoreOptions,
): SessionMetadataStore {
  return {
    createSession(ownerId, input) {
      const now = Date.now();
      const id = randomBytes(16).toString("hex");
      const scene = input.scene ?? null;
      const insert = (workspaceId: string): void => {
        requireChanges(
          db.prepare(INSERT_SESSION).run(id, ownerId, now, now, workspaceId, scene).changes,
          1,
          "session create",
        );
      };
      const view = (workspaceId: string, temporaryWorkspace: boolean): CreatedSessionView => ({
        id,
        title: null,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        scene,
        workspaceId,
        pinnedAt: null,
        archivedAt: null,
        pendingApproval: false,
        temporaryWorkspace,
      });
      const workspaceId = input.workspaceId;
      if (workspaceId === undefined) {
        return view(createInTemporaryWorkspace(db, options, ownerId, insert), true);
      }
      runOwnedTransaction(db, "session create rollback failed", () => {
        insert(workspaceId);
        const bound = db.prepare(SELECT_TEMPORARY).get(workspaceId) as
          | { temporary: number | bigint }
          | undefined;
        if (Number(bound?.temporary) === 1) {
          // Same error as the route's unknown / foreign id; the INSERT above is rolled back.
          throw new HttpError("not_found");
        }
        options.emit(db, {
          kind: "session.bind",
          actorId: ownerId,
          title: "绑定工作空间",
          workspaceId,
          detail: { sessionId: id, scene },
        });
      });
      return view(workspaceId, false);
    },

    patchSession(ownerId, sessionId, patch) {
      const { assignments, values } = patchAssignments(patch, Date.now());
      const guarded = patch.archived === true;
      const where = guarded ? PATCH_OWNED_NOT_RUNNING : PATCH_OWNED;
      const changes = db
        .prepare(`UPDATE chat_sessions SET ${assignments} ${where}`)
        .run(...values, sessionId, ownerId).changes;
      requireAtMostOne(changes, "session patch");
      if (!hasChanges(changes)) {
        // Zero rows under the guard means either no such row or a running one: re-read to tell.
        const present = guarded && db.prepare(SELECT_OWNED).get(sessionId, ownerId) !== undefined;
        return present ? "busy" : null;
      }
      const row = db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`)
        .get(sessionId) as unknown as SessionDbRow | undefined;
      if (row === undefined) {
        throw new Error("patched session row missing");
      }
      return toSessionView(row, createSqliteTextDecoder(db));
    },

    archivedAt(sessionId, ownerId) {
      const row = db.prepare(SELECT_ARCHIVED_AT).get(sessionId, ownerId) as
        | { archived_at: number | bigint | null }
        | undefined;
      const at = row?.archived_at ?? null;
      return at === null ? null : Number(at);
    },

    deleteSession(ownerId, sessionId) {
      const decoder = createSqliteTextDecoder(db);
      return runOwnedTransaction(db, "session delete rollback failed", () => {
        const row = db.prepare(SELECT_DELETED).get(sessionId, ownerId) as unknown as
          | DeletedRow
          | undefined;
        if (row === undefined) {
          return null;
        }
        const ompSessionFile = decodeNullableText(decoder, row.omp_session_file);
        const counted = db.prepare(COUNT_MESSAGES).get(sessionId) as { n: number | bigint };
        const messageCount = Number(counted.n);
        // Before the delete: the registration rows go with their messages (039 cascade).
        const snapshots = listSessionTurnSnapshots(db, sessionId).map(
          ({ messageId, workspaceId, outcome }) => ({ messageId, workspaceId, outcome }),
        );
        requireChanges(
          db.prepare(DELETE_SESSION).run(sessionId, ownerId).changes,
          1,
          "session delete",
        );
        options.emit(db, {
          kind: "session.delete",
          actorId: ownerId,
          title: "删除会话",
          ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
          detail: { sessionId, ompSessionFile, messageCount },
        });
        const temporaryWorkspace =
          row.workspace_id === null
            ? undefined
            : deleteUnusedTemporaryWorkspace(db, options, ownerId, sessionId, row.workspace_id);
        return {
          ompSessionFile,
          messageCount,
          ...(temporaryWorkspace === undefined ? {} : { temporaryWorkspace }),
          snapshots,
        };
      });
    },
  };
}

/**
 * Inside the delete transaction, after the session row is gone: when `workspaceId` is a temporary
 * workspace of this owner that no session row references any more, deletes its row and writes the
 * `workspace.delete` audit. An ordinary (or promoted) workspace, someone else's, or one another
 * session still uses is left alone — `chat_sessions.workspace_id` is `ON DELETE SET NULL`, so
 * deleting a row still in use would silently unbind those sessions.
 * `root` is a plain join computed before the row is deleted; the directory is not inspected here
 * (whatever stands there is the post-commit removal's finding, not this transaction's failure).
 */
function deleteUnusedTemporaryWorkspace(
  db: DatabaseSync,
  options: SessionMetadataStoreOptions,
  ownerId: string,
  sessionId: string,
  workspaceId: string,
): TemporaryWorkspaceRef | undefined {
  const owned = db.prepare(SELECT_OWNED_TEMPORARY).get(workspaceId, ownerId) as
    | { temporary: number | bigint }
    | undefined;
  if (owned === undefined || Number(owned.temporary) !== 1) {
    return undefined;
  }
  const users = db.prepare(COUNT_WORKSPACE_SESSIONS).get(workspaceId) as { n: number | bigint };
  if (Number(users.n) !== 0) {
    return undefined;
  }
  const root = join(realpathSync(options.sandboxRoot), ownerId, `tmp-${workspaceId}`);
  requireChanges(
    db.prepare(DELETE_TEMPORARY_WORKSPACE).run(workspaceId, ownerId).changes,
    1,
    "temporary workspace delete",
  );
  options.emit(db, {
    kind: "workspace.delete",
    actorId: ownerId,
    title: "删除临时空间",
    workspaceId,
    detail: { root, sessionId },
  });
  return { id: workspaceId, ownerId };
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
  if (patch.archived === true) {
    fragments.push(SET_ARCHIVED);
    values.push(now);
  } else if (patch.archived === false) {
    fragments.push(SET_UNARCHIVED);
  }
  return { assignments: fragments.join(", "), values };
}

/**
 * One transaction: the owner's new temporary workspace, then the session row bound to it — no
 * `session.bind` and no `workspace.create` audit. Returns the workspace id. When the transaction
 * rolls back after the workspace's directories were made, they are removed here, after the
 * rollback; never once it has committed. The original failure is what propagates.
 */
function createInTemporaryWorkspace(
  db: DatabaseSync,
  options: SessionMetadataStoreOptions,
  ownerId: string,
  insertSession: (workspaceId: string) => void,
): string {
  let created: CreatedTemporaryWorkspace | undefined;
  try {
    return runOwnedTransaction(db, "session create rollback failed", () => {
      created = options.createTemporaryWorkspace(ownerId);
      insertSession(created.workspace.id);
      return created.workspace.id;
    });
  } catch (error) {
    try {
      created?.removeCreatedDirs();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "session create left a temporary workspace directory",
        { cause: error },
      );
    }
    throw error;
  }
}
