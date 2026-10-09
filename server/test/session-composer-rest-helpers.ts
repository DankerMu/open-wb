/**
 * The world of the composer-settings REST tests (#1005, moved here by #1006 so the PATCH scenarios
 * share it): production createApp → registerSessions with the three-model catalog of「有效值解析」 and
 * a chosen `approvalMaxMode`, a real in-memory SQLite and real directories under the runtime's
 * temporary sandbox root; no omp child is ever spawned. Three seeded accounts: zhangsan (`u1`) and
 * zhaoliu (`u2`) are members, lisi (`u3`) is the administrator. Importing this file registers the
 * `afterEach` that closes every world it opened.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import type { ComposerConfig } from "../src/sessions/store-composer.js";
import { BAD_REQUEST_ENVELOPE, FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { SESSION_VIEW_KEYS, THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import { cookieFor } from "./session-rest-helpers.js";
import { createControlledRuntime } from "./session-supervisor-helpers.js";

export type Cap = ComposerConfig["approvalMaxMode"];
export type Account = "zhangsan" | "zhaoliu" | "lisi";
type Composer = [approvalMode: string | null, modelId: string | null, effort: string | null];

export const ACCOUNT_ID: Record<Account, string> = { zhangsan: "u1", zhaoliu: "u2", lisi: "u3" };
const JSON_TYPE = "application/json";

export interface View {
  id: string;
  createdAt: number;
  workspaceId: string;
  temporaryWorkspace: boolean;
  approvalMode: string;
  modelId: string;
  reasoningEffort: string | null;
}

export interface PermissionAudit {
  actor: string;
  title: string;
  workspaceId: string | null;
  detail: unknown;
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  cookies: Record<Account, string>;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** `cap` undefined is `APPROVAL_MAX_MODE` unset: the assembly's `yolo`. */
export async function openWorld(cap?: Cap): Promise<World> {
  const db = openDb(":memory:");
  cleanups.push(() => {
    db.close();
  });
  const { runtime } = createControlledRuntime(() => {});
  // Startup makes no sandbox directory; `POST /api/workspaces` needs the root to exist.
  ensureSharedDir(runtime.sandboxRoot);
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime,
      modelCatalog: THREE_MODEL_CATALOG,
      ...(cap === undefined ? {} : { approvalMaxMode: cap }),
    },
  });
  cleanups.push(() => app.close());
  const cookies = {
    zhangsan: await cookieFor(app, "zhangsan"),
    zhaoliu: await cookieFor(app, "zhaoliu"),
    lisi: await cookieFor(app, "lisi"),
  };
  return { app, db, sandboxRoot: runtime.sandboxRoot, cookies };
}

/** `body` undefined sends no body and no Content-Type. */
export function post(
  world: World,
  account: Account,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return world.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: {
      cookie: world.cookies[account],
      ...(body === undefined ? {} : { "content-type": JSON_TYPE }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

export async function create(world: World, account: Account, body?: unknown): Promise<View> {
  const response = await post(world, account, body);
  expect(response.statusCode).toBe(201);
  const view = response.json() as View;
  expect(Object.keys(view)).toEqual(SESSION_VIEW_KEYS);
  return view;
}

export async function createWorkspace(world: World, account: Account): Promise<string> {
  const made = await world.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie: world.cookies[account], "content-type": JSON_TYPE },
    payload: JSON.stringify({ name: "项目A", dir: "project-a" }),
  });
  expect(made.statusCode).toBe(201);
  return (made.json() as { id: string }).id;
}

export function composerOf(view: View): Composer {
  return [view.approvalMode, view.modelId, view.reasoningEffort];
}

export function rawOf(world: World, sessionId: string): Composer {
  const row = world.db
    .prepare("SELECT approval_mode, model_id, reasoning_effort FROM chat_sessions WHERE id = ?")
    .get(sessionId) as Record<string, string | null>;
  return [row.approval_mode ?? null, row.model_id ?? null, row.reasoning_effort ?? null];
}

/** Every last-choice row, as `[accountId, approvalMode, modelId, effort, updatedAt]`. */
export function prefs(world: World): unknown[] {
  return world.db
    .prepare(
      "SELECT account_id, approval_mode, model_id, reasoning_effort, updated_at FROM account_composer_prefs ORDER BY account_id",
    )
    .all()
    .map((row) => Object.values(row));
}

export function plantPrefs(world: World, account: Account, choice: Composer): void {
  world.db
    .prepare(
      "INSERT INTO account_composer_prefs(account_id, approval_mode, model_id, reasoning_effort, updated_at) VALUES (?, ?, ?, ?, 5)",
    )
    .run(ACCOUNT_ID[account], ...choice);
}

/** Every `session.permission` row of the database, oldest first. */
export function permissionAudits(world: World): PermissionAudit[] {
  const rows = world.db
    .prepare(
      "SELECT actor_id, CAST(title AS TEXT) AS title, workspace_id, detail FROM audit_events WHERE kind = 'session.permission' ORDER BY id",
    )
    .all() as Array<{
    actor_id: string;
    title: string;
    workspace_id: string | null;
    detail: string;
  }>;
  return rows.map((row) => ({
    actor: row.actor_id,
    title: row.title,
    workspaceId: row.workspace_id,
    detail: JSON.parse(row.detail) as unknown,
  }));
}

export async function auditKindsSeenBy(world: World, account: Account): Promise<string[]> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/audit?limit=200",
    headers: { cookie: world.cookies[account] },
  });
  expect(response.statusCode).toBe(200);
  const { events } = response.json() as { events: Array<{ kind: string; actorId: string }> };
  return events.filter((event) => event.kind.startsWith("session.")).map((event) => event.kind);
}

/** Everything a refused creation must leave alone. */
export function footprint(world: World): unknown {
  const count = (table: string): number =>
    Number((world.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const dirs = Object.values(ACCOUNT_ID).flatMap((id) => {
    const accountRoot = join(world.sandboxRoot, id);
    return existsSync(accountRoot) ? readdirSync(accountRoot).map((name) => `${id}/${name}`) : [];
  });
  return {
    sessions: count("chat_sessions"),
    workspaces: count("workspaces"),
    audits: count("audit_events"),
    prefs: prefs(world),
    dirs: dirs.sort(),
  };
}

export function expectBadRequest(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual(BAD_REQUEST_ENVELOPE);
  expect(response.headers["cache-control"]).toBe("no-store");
}
