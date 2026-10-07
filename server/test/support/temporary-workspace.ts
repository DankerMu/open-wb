/**
 * Test data around temporary workspaces (s1f tasks 3.2, 5.6, 5.7):
 * - `seedTemporaryWorkspaceSession`: the workspace goes through the store's own `createTemporary`,
 *   the session row is written straight into the database (tests that need a chosen session id or
 *   predate the body-less create of task 5.6).
 * - `seedUnboundSession`: a legacy session row with `workspace_id` NULL — REST can no longer
 *   create one since task 5.6, so tests about unbound sessions write the row directly.
 * - `workspaceOf`: the workspace a session row is bound to (e.g. the temporary one a body-less
 *   create made).
 * - `temporaryWorkspacePort`: the `createTemporaryWorkspace` port for a hand-built session
 *   assembly, over a real workspace store on the given sandbox root.
 */
import type { DatabaseSync } from "node:sqlite";
import { emit } from "../../src/core/audit/index.js";
import { ensureSharedDir } from "../../src/core/sandbox/dirs.js";
import { createWorkspaceStore, type WorkspaceStore } from "../../src/workspaces/store.js";

type TemporaryWorkspace = ReturnType<WorkspaceStore["createTemporary"]>["workspace"];

const INSERT_SESSION_SQL =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id) VALUES (?, ?, NULL, 'idle', ?, ?, ?)";

/** One committed transaction: the temporary workspace of `ownerId` plus session `sessionId` bound to it. */
export function seedTemporaryWorkspaceSession(
  db: DatabaseSync,
  store: WorkspaceStore,
  ownerId: string,
  sessionId: string,
): TemporaryWorkspace {
  db.exec("BEGIN");
  try {
    const { workspace } = store.createTemporary({ id: ownerId });
    db.prepare(INSERT_SESSION_SQL).run(
      sessionId,
      ownerId,
      workspace.createdAt,
      workspace.createdAt,
      workspace.id,
    );
    db.exec("COMMIT");
    return workspace;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const INSERT_UNBOUND_SQL =
  "INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id, scene) VALUES (?, ?, NULL, 'idle', ?, ?, NULL, ?)";

/**
 * A legacy unbound session: one idle row of `ownerId` with `workspace_id` NULL, as
 * `POST /api/sessions` wrote it before task 5.6. Returns its id.
 */
export function seedUnboundSession(
  db: DatabaseSync,
  ownerId: string,
  sessionId: string,
  options: { scene?: "office" | "code" | "design"; now?: number } = {},
): string {
  const now = options.now ?? Date.now();
  db.prepare(INSERT_UNBOUND_SQL).run(sessionId, ownerId, now, now, options.scene ?? null);
  return sessionId;
}

/** The id of the workspace `session` is bound to; an unbound or unknown session is an error. */
export function workspaceOf(db: DatabaseSync, session: string): string {
  const row = db.prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?").get(session) as
    | { workspace_id: string | null }
    | undefined;
  if (typeof row?.workspace_id !== "string") {
    throw new Error(`session ${session} is not bound to a workspace`);
  }
  return row.workspace_id;
}

/** What `createApp` injects into the sessions module, for assemblies built by hand in tests. */
export function temporaryWorkspacePort(
  db: DatabaseSync,
  sandboxRoot: string,
): (ownerId: string) => ReturnType<WorkspaceStore["createTemporary"]> {
  const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
  return (ownerId) => store.createTemporary({ id: ownerId });
}
