/**
 * core/audit — append-only account-scoped event seam.
 *
 * Callers supply a structural principal; this module does not import auth or http.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { HttpError } from "../errors/index.js";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const ADMIN_ROLE = "管理员";
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

interface AuditEventInput {
  kind: string;
  actorId: string;
  title: string;
  detail?: object;
  workspaceId?: string;
  ts?: number;
}

export interface AuditPrincipal {
  id: string;
  role: string;
}

interface AuditQueryOptions {
  limit?: number;
  before?: string;
}

export interface AuditEvent {
  id: number;
  ts: number;
  actorId: string;
  kind: string;
  title: string;
  detail: unknown;
  workspaceId: string | null;
}

type AuditEventRow = {
  id: number;
  ts: number;
  actor_id: string;
  kind: string;
  title: string;
  detail: string;
  workspace_id: string | null;
} & Record<string, SQLOutputValue>;

export function emit(db: DatabaseSync, event: AuditEventInput): number {
  const detailJson = JSON.stringify(event.detail === undefined ? {} : event.detail);
  const result = db
    .prepare(
      "INSERT INTO audit_events(ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.ts === undefined ? Date.now() : event.ts,
      event.actorId,
      event.kind,
      event.title,
      detailJson,
      event.workspaceId === undefined ? null : event.workspaceId,
    );
  return Number(result.lastInsertRowid);
}

export function query(
  db: DatabaseSync,
  principal: AuditPrincipal,
  opts: AuditQueryOptions = {},
): AuditEvent[] {
  const limit = resolveLimit(opts.limit);
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];

  if (principal.role !== ADMIN_ROLE) {
    clauses.push("actor_id = ?");
    params.push(principal.id);
  }

  if (opts.before !== undefined) {
    if (typeof opts.before !== "string" || !isCanonicalPositiveDecimal(opts.before)) {
      throw new HttpError("bad_request");
    }
    const cursor = BigInt(opts.before);
    if (cursor <= SQLITE_INT64_MAX) {
      clauses.push("id < ?");
      params.push(cursor);
    }
  }

  params.push(limit);
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")} `;
  const rows = db
    .prepare(
      `SELECT id, ts, actor_id, kind, title, detail, workspace_id FROM audit_events ${where}ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as AuditEventRow[];
  return rows.map(mapEvent);
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < MIN_LIMIT ||
    limit > MAX_LIMIT
  ) {
    throw new HttpError("bad_request");
  }
  return limit;
}

function isCanonicalPositiveDecimal(value: string): boolean {
  if (value.length === 0 || value.charCodeAt(0) === 48) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

function mapEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    ts: row.ts,
    actorId: row.actor_id,
    kind: row.kind,
    title: row.title,
    detail: JSON.parse(row.detail) as unknown,
    workspaceId: row.workspace_id,
  };
}
