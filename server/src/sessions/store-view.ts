/**
 * The session view (#921): its column set, row type and mapping, shared by every exit that returns
 * a session — list, snapshot, PATCH and fork commit. `SESSION_COLUMNS` is written for the
 * unaliased single-table `SELECT … FROM chat_sessions` statements: the two derived columns are
 * correlated subqueries on `chat_sessions.id` / `chat_sessions.workspace_id`, so no caller changes
 * its FROM clause.
 */
import { decodeNullableText } from "./store-branch.js";

export type SessionStatus = "idle" | "running" | "done" | "failed" | "stopped";

type SessionScene = "office" | "code" | "design";

export interface SessionView {
  id: string;
  title: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  scene: SessionScene | null;
  workspaceId: string | null;
  pinnedAt: number | null;
  archivedAt: number | null;
  /** Derived on read, never stored: the session has an approval row with `decision IS NULL`. */
  pendingApproval: boolean;
  /** The bound workspace carries `temporary = 1`; false when no workspace is bound. */
  temporaryWorkspace: boolean;
}

export type SessionDbRow = {
  id: string;
  owner_id: string;
  title: Uint8Array | null;
  status: SessionStatus;
  omp_session_file: Uint8Array | null;
  stream_epoch: number;
  created_at: number;
  updated_at: number;
  workspace_id: string | null;
  scene: SessionScene | null;
  pinned_at: number | null;
  archived_at: number | null;
  pending_approval: number;
  temporary_workspace: number;
};

/** Pending means `decision IS NULL`, the predicate every approval settlement compares-and-sets. */
const PENDING_APPROVAL = `EXISTS (
  SELECT 1 FROM chat_approvals AS a JOIN chat_messages AS m ON m.id = a.message_id
   WHERE m.session_id = chat_sessions.id AND a.decision IS NULL)`;
const TEMPORARY_WORKSPACE =
  "COALESCE((SELECT w.temporary FROM workspaces AS w WHERE w.id = chat_sessions.workspace_id), 0)";

export const SESSION_COLUMNS = `id, owner_id, CAST(title AS BLOB) AS title, status, CAST(omp_session_file AS BLOB) AS omp_session_file, stream_epoch, created_at, updated_at, workspace_id, scene, pinned_at, archived_at, ${PENDING_APPROVAL} AS pending_approval, ${TEMPORARY_WORKSPACE} AS temporary_workspace`;

export function toSessionView(row: SessionDbRow, decoder: TextDecoder): SessionView {
  return {
    id: row.id,
    title: decodeNullableText(decoder, row.title),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    scene: row.scene,
    workspaceId: row.workspace_id,
    pinnedAt: row.pinned_at === null ? null : Number(row.pinned_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    pendingApproval: Number(row.pending_approval) === 1,
    temporaryWorkspace: Number(row.temporary_workspace) === 1,
  };
}
