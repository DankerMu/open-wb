/**
 * Shared world of the two cwd-scoped directory routes, `GET /api/commands` (#551, #813) and
 * `GET /api/project-config` (#815): the production createApp assembly over a real in-memory
 * SQLite with the sandbox and the omp state directory in a temporary directory, driven through
 * `app.inject()`; no omp process is started. Also the requests both routes must refuse — they
 * share one set of request rules.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import { BAD_REQUEST_ENVELOPE, loginSessionPair } from "./session-db-helpers.js";

export const MODEL = "deepseek-v4.1-flash";

export interface DirectoryWorld {
  app: FastifyInstance;
  db: DatabaseSync;
  root: string;
  stateDir: string;
  sandboxRoot: string;
}

interface RejectedRequest {
  name: string;
  query?: string;
  headers?: Record<string, string>;
  payload?: string;
}

/**
 * Authenticated requests a directory route must refuse: a body, or a query string that is not
 * exactly one `workspaceId` key with one non-empty value (`WS` stands for a workspace id of the
 * caller).
 */
export const REJECTED: readonly RejectedRequest[] = [
  { name: "a query key other than workspaceId", query: "?x=1" },
  { name: "workspaceId given twice", query: "?workspaceId=WS&workspaceId=WS" },
  { name: "an empty workspaceId", query: "?workspaceId=" },
  { name: "workspaceId without a value", query: "?workspaceId" },
  { name: "workspaceId and another key", query: "?workspaceId=WS&x=1" },
  {
    name: "a workspaceId and a JSON body",
    query: "?workspaceId=WS",
    headers: { "content-type": "application/json" },
    payload: "{}",
  },
  { name: "a JSON body", headers: { "content-type": "application/json" }, payload: "{}" },
  { name: "a body without a content type", payload: "x" },
  { name: "a transfer-encoding header", headers: { "transfer-encoding": "chunked" } },
];

const apps: FastifyInstance[] = [];
const databases: DatabaseSync[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const db of databases.splice(0)) {
    db.close();
  }
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh app; closed, with its database and its temporary directory, after the running case. */
export function openWorld(prefix: string): DirectoryWorld {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  const stateDir = join(root, "state dir");
  const sandboxRoot = join(root, "sandbox");
  const db = openDb(":memory:");
  databases.push(db);
  const app = createApp({
    db,
    assembly: {
      runtime: { bin: join(root, "omp-bin"), sandboxRoot, stateDir, modelId: MODEL },
    },
  });
  apps.push(app);
  return { app, db, root, stateDir, sandboxRoot };
}

/** A workspace of the cookie's account under `sandboxRoot` (created first: the store realpaths it). */
export async function createWorkspace(
  app: FastifyInstance,
  cookie: string,
  sandboxRoot: string,
  dir = "proj",
): Promise<{ id: string; root: string }> {
  mkdirSync(sandboxRoot, { recursive: true });
  const created = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name: dir, dir }),
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: string; root: string }>();
}

/** GET `route` for the owner root, or for a workspace; every answer is no-store. */
export async function getDirectory(
  app: FastifyInstance,
  route: string,
  cookie: string,
  workspaceId?: string,
) {
  const response = await app.inject({
    method: "GET",
    url: workspaceId === undefined ? route : `${route}?workspaceId=${workspaceId}`,
    headers: { cookie },
  });
  expect(response.headers["cache-control"]).toBe("no-store");
  return response;
}

/** The owner sends one of `REJECTED` to `route` of a fresh app: 400 bad_request, no-store. */
export async function expectRejected(route: string, input: RejectedRequest): Promise<void> {
  const { app, sandboxRoot } = openWorld("directory-rest-");
  const cookie = await loginSessionPair(app);
  const workspace = await createWorkspace(app, cookie, sandboxRoot);
  const { query = "", headers = {}, payload } = input;

  const response = await app.inject({
    method: "GET",
    url: `${route}${query.replaceAll("WS", workspace.id)}`,
    headers: { ...headers, cookie },
    ...(payload === undefined ? {} : { payload }),
  });

  expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
}
