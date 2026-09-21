import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { registerAccounts } from "../src/accounts/index.js";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createSandbox } from "../src/core/sandbox/index.js";
import { registerWorkspaces } from "../src/workspaces/index.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { type InjectResponse, NOT_FOUND_ENVELOPE, withApp } from "./auth-lifecycle-helpers.js";
import { tempDir } from "./core-db-helpers.js";

const INSERT_WORKSPACE_SQL =
  "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)";

interface WorkspaceHttpFixture {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
}

export async function withWorkspacesApp<T>(
  action: (fixture: WorkspaceHttpFixture) => Promise<T>,
  beforeRoutes?: (fixture: WorkspaceHttpFixture) => void,
): Promise<T> {
  const sandboxRoot = realpathSync(tempDir());
  return withApp({}, async ({ app, db }) => {
    const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
    const audit = { emit: (event: Parameters<typeof emit>[1]) => emit(db, event) };
    const sandbox = createSandbox({ rootOf: store.rootOf, audit });
    const fixture = { app, db, sandboxRoot };
    beforeRoutes?.(fixture);
    registerAccounts(app, { db });
    registerWorkspaces(app, { store, sandbox, audit });
    return action(fixture);
  });
}

export function expectWorkspaceResponse(
  response: InjectResponse,
  status: number,
  body: unknown,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual(body);
  expect(response.headers["cache-control"]).toBe("no-store");
}

interface WorkspaceRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  payload?: string;
}

export async function expectWorkspaceNotFound(
  app: FastifyInstance,
  cookie: string,
  requests: WorkspaceRequest[],
): Promise<void> {
  for (const request of requests) {
    const response = await app.inject({
      ...request,
      headers: { cookie, ...request.headers },
    });
    expectWorkspaceResponse(response, 404, NOT_FOUND_ENVELOPE);
  }
}

export function requestWorkspaceFile(
  app: FastifyInstance,
  workspaceId: string,
  cookie: string,
  path: string,
) {
  return app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`,
    headers: { cookie },
  });
}

export function insertWorkspace(
  db: DatabaseSync,
  id: string,
  ownerId: string,
  name: string,
  dir: string,
  createdAt: number,
): void {
  db.prepare(INSERT_WORKSPACE_SQL).run(id, ownerId, name, dir, createdAt);
}
