import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
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
  return withApp(
    {
      assembly: {
        runtime: {
          bin: join(sandboxRoot, "omp"),
          sandboxRoot,
          stateDir: join(sandboxRoot, "state"),
          modelId: "deepseek-v4.1-flash",
        },
      },
    },
    async ({ app, db }) => {
      const fixture = { app, db, sandboxRoot };
      beforeRoutes?.(fixture);
      return action(fixture);
    },
  );
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

export function expectEmptyWorkspaceAuditAndOwnerRoot(db: DatabaseSync, sandboxRoot: string): void {
  expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
  expect(existsSync(join(sandboxRoot, "u1"))).toBe(false);
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
