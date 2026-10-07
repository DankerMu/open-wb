/**
 * Test data for「a session that uses a temporary workspace」(s1f tasks 3.2): the workspace goes
 * through the store's own `createTemporary`, the session row is written straight into the database
 * — no REST path creates temporaries before the session-create semantics change (task 5.6).
 */
import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceStore } from "../../src/workspaces/store.js";

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
