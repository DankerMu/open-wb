/**
 * Session archive test plumbing shared by the PATCH `archived` cases (#922) and the read-only
 * interception cases (#923): the PATCH request, its 200 view and the whole `chat_sessions` row.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

const FOURTEEN_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
  "archivedAt",
  "pendingApproval",
  "temporaryWorkspace",
  "approvalMode",
  "modelId",
  "reasoningEffort",
];

export type View = Record<string, unknown> & { archivedAt: number | null; pinnedAt: number | null };

export interface Target {
  fixture: { app: FastifyInstance; db: DatabaseSync };
  cookie: string;
  session: string;
}

/** `cookie: null` sends none (anonymous); `raw` sends the payload bytes as they are. */
export function patch(
  target: Target,
  body: unknown,
  options: { cookie?: string | null; session?: string; raw?: boolean } = {},
): Promise<LightMyRequestResponse> {
  const cookie = options.cookie === undefined ? target.cookie : options.cookie;
  return target.fixture.app.inject({
    method: "PATCH",
    url: `/api/sessions/${options.session ?? target.session}`,
    headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) },
    payload: options.raw === true ? String(body) : JSON.stringify(body),
  });
}

/** 200 + no-store + exactly the fourteen keys in wire order. */
export async function patched(response: Promise<LightMyRequestResponse>): Promise<View> {
  const settled = await response;
  expect(settled.statusCode).toBe(200);
  expect(settled.headers["cache-control"]).toBe("no-store");
  const view = settled.json() as View;
  expect(Object.keys(view)).toEqual(FOURTEEN_KEYS);
  return view;
}

/** The whole row, every column: "unchanged" means none of them moved. */
export function rowOf(db: DatabaseSync, session: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(session);
  if (row === undefined) {
    throw new Error("session row missing");
  }
  return { ...row };
}

/** Archives now and returns the 200 view, with `archivedAt` checked against the request window. */
export async function archiveNow(target: Target, body: object): Promise<View> {
  const start = Date.now();
  const view = await patched(patch(target, body));
  const end = Date.now();
  expect(view.archivedAt).toEqual(expect.any(Number));
  expect(view.archivedAt).toBeGreaterThanOrEqual(start);
  expect(view.archivedAt).toBeLessThanOrEqual(end);
  expect(rowOf(target.fixture.db, target.session).archived_at).toBe(view.archivedAt);
  return view;
}
