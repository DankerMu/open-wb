/**
 * Session metadata writes (#523/#524, parent D2 "模块拆分"): creation with an optional workspace
 * binding and scene, and the title/scene/pin/archive PATCH. The row insert and its `session.bind`
 * audit share one SQLite transaction, so an audit failure leaves no session row. Ownership of the
 * workspace is the route's job; a temporary workspace cannot be bound by id (#925): the transaction
 * throws the same `not_found` and rolls the row back. A create without a workspace (#930, design
 * D6) makes a temporary one in that same transaction and binds it, with no audit row; when the
 * transaction rolls back, the directories that creation made are removed afterwards.
 * Both creations (#1005) open their transaction by settling the three composer columns
 * (`resolveCreateComposer`: a refused value throws before any write or directory), and close it
 * with the account's last choice and the creation's `session.permission` audit, so a failure of
 * either leaves no session row, no workspace row and no last choice.
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
import type { SessionView } from "./store.js";
import {
  decodeNullableText,
  hasChanges,
  requireAtMostOne,
  requireChanges,
  runOwnedTransaction,
} from "./store-branch.js";
import {
  COMPOSER_COLUMNS,
  type ComposerConfig,
  type ComposerInput,
  resolveCreateComposer,
  saveComposerPrefs,
} from "./store-composer.js";
import { listSessionTurnSnapshots, type TurnSnapshotOutcome } from "./store-undo.js";
import { readSessionView } from "./store-view.js";

export type SessionScene = "office" | "code" | "design";

/** The three composer keys arrive as unchecked strings: `createSession` validates their values. */
export interface SessionCreateInput extends ComposerInput {
  workspaceId?: string;
  scene?: SessionScene;
}

/** At least one key (the route guarantees it); `title` is already trimmed and 1..80 code points. */
export interface SessionPatch {
  title?: string;
  scene?: SessionScene;
  pinned?: boolean;
  archived?: boolean;
}

export interface SessionMetadataStore {
  /**
   * The new session's view, read back from its committed row. Throws `bad_request` for a composer
   * value the configuration refuses, before anything is written.
   */
  createSession(ownerId: string, input: SessionCreateInput): SessionView;
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
  /** What turns the three raw composer columns into a view's effective values. */
  composer: ComposerConfig;
}

interface DeletedRow {
  omp_session_file: Uint8Array | null;
  workspace_id: string | null;
}

const INSERT_SESSION = `INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id, scene, ${COMPOSER_COLUMNS}) VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, ?, ?)`;

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
      type Composer = ReturnType<typeof resolveCreateComposer>;
      // First in either transaction: reads the last choice and refuses an invalid value.
      const resolve = (): Composer => resolveCreateComposer(db, ownerId, input, options.composer);
      const insert = (workspaceId: string, { row }: Composer): void => {
        requireChanges(
          db
            .prepare(INSERT_SESSION)
            .run(
              id,
              ownerId,
              now,
              now,
              workspaceId,
              scene,
              row.approval_mode,
              row.model_id,
              row.reasoning_effort,
            ).changes,
          1,
          "session create",
        );
      };
      // Last in either transaction: the last choice, then the creation's permission audit.
      const settle = (workspaceId: string, { given, auditTo }: Composer): void => {
        saveComposerPrefs(db, ownerId, given, now);
        if (auditTo !== null) {
          options.emit(db, {
            kind: "session.permission",
            actorId: ownerId,
            title: "修改权限档位",
            workspaceId,
            detail: { sessionId: id, from: null, to: auditTo },
          });
        }
      };
      const view = (): SessionView =>
        readSessionView(db, id, options.composer, "created session row missing");
      const workspaceId = input.workspaceId;
      if (workspaceId === undefined) {
        createInTemporaryWorkspace(db, options, ownerId, resolve, (temporaryId, composer) => {
          insert(temporaryId, composer);
          settle(temporaryId, composer);
        });
        return view();
      }
      runOwnedTransaction(db, "session create rollback failed", () => {
        const composer = resolve();
        insert(workspaceId, composer);
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
        settle(workspaceId, composer);
      });
      return view();
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
      return readSessionView(db, sessionId, options.composer, "patched session row missing");
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
 * One transaction: `prepare` (reads and checks only — when it throws, no workspace and no
 * directory was made), the owner's new temporary workspace, then `insertSession` with the session
 * row bound to it — no `session.bind` and no `workspace.create` audit. When the transaction
 * rolls back after the workspace's directories were made, they are removed here, after the
 * rollback; never once it has committed. The original failure is what propagates.
 */
function createInTemporaryWorkspace<T>(
  db: DatabaseSync,
  options: SessionMetadataStoreOptions,
  ownerId: string,
  prepare: () => T,
  insertSession: (workspaceId: string, prepared: T) => void,
): void {
  let created: CreatedTemporaryWorkspace | undefined;
  try {
    runOwnedTransaction(db, "session create rollback failed", () => {
      const prepared = prepare();
      created = options.createTemporaryWorkspace(ownerId);
      insertSession(created.workspace.id, prepared);
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
