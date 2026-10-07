/**
 * Issue #925 (s1f-session-list-temp-space task 3.3): a temporary workspace through the REST seam —
 * temporary-workspaces 「列表不含临时空间而按 id 可达」「不能显式绑定临时空间」, session-metadata
 * 「他人与不存在的空间一致 404」 and the first half of workspaces 「临时空间不在列表里，转正后出现」.
 * Real `createApp`, real SQLite, real directories. No REST path creates a temporary workspace
 * before task 5.6, so T comes from the 3.2 helper over a second store on the same database and
 * sandbox root. Oracles: the spec's literals and the bytes written here.
 */
import { Buffer } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { removeTempDirs } from "./core-db-helpers.js";
import { NOT_FOUND_ENVELOPE, UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";
import { withWorkspacesApp } from "./workspaces-http-helpers.js";

const JSON_TYPE = "application/json";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const OWNER = "u1";
const OTHER = "u2";
const OWNER_SESSION = "5".repeat(32);
const OTHER_SESSION = "6".repeat(32);
const UNKNOWN_ID = "e".repeat(32);
const FIVE_KEYS = ["id", "name", "dir", "root", "createdAt"];
const FILE_BYTES = Buffer.from("临时空间里的文件\n", "utf8");
const BUILTIN_NAMES = ["compact", "todo"];
const DEPLOY_SKILL = {
  name: "skill:deploy",
  label: "deploy",
  description: "上线到生产",
  hint: "可选参数",
  source: "project",
  overrides: false,
};
const AGENTS_FILE = { path: "AGENTS.md", kind: "instructions", depth: 0 };

interface Workspace {
  id: string;
  name: string;
  dir: string;
  root: string;
  createdAt: number;
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  owner: string;
  other: string;
  /** The owner's ordinary workspace, created through `POST /api/workspaces`. */
  normal: Workspace;
  /** The owner's temporary workspace with one session bound to it. */
  temporary: Workspace;
  /** A temporary workspace of the other account. */
  foreignTemporary: Workspace;
}

interface RouteRequest {
  method: "GET" | "POST";
  url: string;
  payload?: string;
}

afterEach(() => {
  removeTempDirs();
});

async function withWorld(action: (world: World) => Promise<void>): Promise<void> {
  await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
    const owner = await cookieFor(app, "zhangsan");
    const other = await cookieFor(app, "zhaoliu");
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { "content-type": JSON_TYPE, cookie: owner },
      payload: JSON.stringify({ name: "项目A", dir: "project-a" }),
    });
    expect(created.statusCode).toBe(201);
    const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
    const temporary = seedTemporaryWorkspaceSession(db, store, OWNER, OWNER_SESSION);
    const foreignTemporary = seedTemporaryWorkspaceSession(db, store, OTHER, OTHER_SESSION);
    expect(temporary.root).toBe(join(sandboxRoot, OWNER, `tmp-${temporary.id}`));
    expect(temporaryFlag(db, temporary.id)).toBe(1);
    expect(temporaryFlag(db, foreignTemporary.id)).toBe(1);
    await action({
      app,
      db,
      sandboxRoot,
      owner,
      other,
      normal: created.json() as Workspace,
      temporary,
      foreignTemporary,
    });
  });
}

function temporaryFlag(db: DatabaseSync, workspaceId: string): number {
  const row = db.prepare("SELECT temporary FROM workspaces WHERE id = ?").get(workspaceId) as
    | { temporary: number | bigint }
    | undefined;
  return Number(row?.temporary);
}

/** The by-id routes the visibility requirement names, in its order, for one workspace id. */
function byIdRoutes(workspaceId: string, dir: string): Record<string, RouteRequest> {
  return {
    tree: { method: "GET", url: `/api/workspaces/${workspaceId}/tree` },
    dirs: {
      method: "POST",
      url: `/api/workspaces/${workspaceId}/dirs`,
      payload: JSON.stringify({ path: dir }),
    },
    file: { method: "GET", url: `/api/workspaces/${workspaceId}/file?path=a.txt` },
    commands: { method: "GET", url: `/api/commands?workspaceId=${workspaceId}` },
    projectConfig: { method: "GET", url: `/api/project-config?workspaceId=${workspaceId}` },
  };
}

function send(
  app: FastifyInstance,
  request: RouteRequest,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (request.payload !== undefined) {
    headers["content-type"] = JSON_TYPE;
  }
  return app.inject({
    method: request.method,
    url: request.url,
    headers,
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
}

function bindSession(
  app: FastifyInstance,
  cookie: string,
  body: unknown,
): Promise<LightMyRequestResponse> {
  return send(app, { method: "POST", url: "/api/sessions", payload: JSON.stringify(body) }, cookie);
}

function wireShape(response: LightMyRequestResponse) {
  return {
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
    contentLength: response.headers["content-length"],
    body: response.payload,
  };
}

function envelopeShape(status: number, envelope: object) {
  const body = JSON.stringify(envelope);
  return {
    status,
    cacheControl: "no-store",
    contentType: JSON_CONTENT_TYPE,
    contentLength: String(Buffer.byteLength(body, "utf8")),
    body,
  };
}

const NOT_FOUND = envelopeShape(404, NOT_FOUND_ENVELOPE);

function rowCounts(db: DatabaseSync) {
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  return {
    sessions: count("chat_sessions"),
    workspaces: count("workspaces"),
    audits: count("audit_events"),
  };
}

async function listedWorkspaces(app: FastifyInstance, cookie: string): Promise<Workspace[]> {
  const response = await send(app, { method: "GET", url: "/api/workspaces" }, cookie);
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return (response.json() as { workspaces: Workspace[] }).workspaces;
}

/** `a.txt`, an `AGENTS.md` and one project skill, so every by-id route has content to return. */
function plantContent(root: string): void {
  writeFileSync(join(root, "a.txt"), FILE_BYTES);
  writeFileSync(join(root, "AGENTS.md"), "# 约定\n");
  mkdirSync(join(root, ".omp", "skills", "deploy"), { recursive: true });
  writeFileSync(
    join(root, ".omp", "skills", "deploy", "SKILL.md"),
    "---\ndescription: 上线到生产\n---\n正文\n",
  );
}

describe("临时空间的可见性：列表", () => {
  it("临时空间不在列表里（前半）：GET /api/workspaces 恰含正式空间，每个对象恰五键，不含临时空间", async () => {
    await withWorld(async ({ app, owner, other, normal, temporary, foreignTemporary }) => {
      const workspaces = await listedWorkspaces(app, owner);

      expect(workspaces).toEqual([normal]);
      expect(workspaces.map((workspace) => workspace.name)).toEqual(["项目A"]);
      for (const workspace of workspaces) {
        expect(Object.keys(workspace)).toEqual(FIVE_KEYS);
      }
      const ids = workspaces.map((workspace) => workspace.id);
      expect(ids).not.toContain(temporary.id);
      expect(ids).not.toContain(foreignTemporary.id);
      // The other account has only a temporary workspace: its list is empty.
      expect(await listedWorkspaces(app, other)).toEqual([]);
    });
  });

  it("匿名请求列表 401", async () => {
    await withWorld(async ({ app }) => {
      const response = await send(app, { method: "GET", url: "/api/workspaces" });

      expect(wireShape(response)).toEqual(envelopeShape(401, UNAUTHORIZED_ENVELOPE));
    });
  });
});

describe("临时空间的可见性：列表不含临时空间而按 id 可达", () => {
  it("所有者对临时空间 id 的 tree / file / dirs / commands / project-config 与正式空间行为一致", async () => {
    await withWorld(async ({ app, db, owner, normal, temporary }) => {
      plantContent(temporary.root);
      plantContent(normal.root);
      const routes = byIdRoutes(temporary.id, "out");
      const normalRoutes = byIdRoutes(normal.id, "out");
      const before = rowCounts(db);

      expect((await listedWorkspaces(app, owner)).map((workspace) => workspace.id)).toEqual([
        normal.id,
      ]);

      const tree = await send(app, routes.tree as RouteRequest, owner);
      expect(tree.statusCode).toBe(200);
      expect(tree.headers["cache-control"]).toBe("no-store");
      const listing = tree.json() as { path: string; entries: Array<{ name: string }> };
      expect(listing.path).toBe("");
      expect(listing.entries.map((entry) => entry.name)).toEqual([".omp", "AGENTS.md", "a.txt"]);
      expect(listing.entries.find((entry) => entry.name === "a.txt")).toMatchObject({
        type: "file",
        size: FILE_BYTES.length,
      });

      const file = await send(app, routes.file as RouteRequest, owner);
      expect(file.statusCode).toBe(200);
      expect(file.headers["cache-control"]).toBe("no-store");
      expect(file.rawPayload.equals(FILE_BYTES)).toBe(true);

      const dirs = await send(app, routes.dirs as RouteRequest, owner);
      expect(dirs.statusCode).toBe(201);
      expect(dirs.headers["cache-control"]).toBe("no-store");
      expect(dirs.json()).toEqual({ path: "out" });
      expect(lstatSync(join(temporary.root, "out")).isDirectory()).toBe(true);

      const commands = await send(app, routes.commands as RouteRequest, owner);
      expect(commands.statusCode).toBe(200);
      expect(commands.headers["cache-control"]).toBe("no-store");
      const catalog = (commands.json() as { commands: Array<{ name: string }> }).commands;
      expect(catalog.map((command) => command.name)).toEqual([...BUILTIN_NAMES, "skill:deploy"]);
      expect(catalog.at(-1)).toEqual(DEPLOY_SKILL);

      const config = await send(app, routes.projectConfig as RouteRequest, owner);
      expect(config.statusCode).toBe(200);
      expect(config.headers["cache-control"]).toBe("no-store");
      expect(config.json()).toEqual({ files: [AGENTS_FILE] });

      // Same content in the ordinary workspace: the same bytes back from the same routes.
      const normalFile = await send(app, normalRoutes.file as RouteRequest, owner);
      expect(normalFile.rawPayload.equals(file.rawPayload)).toBe(true);
      expect(normalFile.headers["content-type"]).toBe(file.headers["content-type"]);
      const normalCommands = await send(app, normalRoutes.commands as RouteRequest, owner);
      expect(wireShape(normalCommands)).toEqual(wireShape(commands));
      const normalConfig = await send(app, normalRoutes.projectConfig as RouteRequest, owner);
      expect(wireShape(normalConfig)).toEqual(wireShape(config));

      // Only the directory creation wrote anything: one `dir.create` audit, no row elsewhere.
      expect(rowCounts(db)).toEqual({ ...before, audits: before.audits + 1 });
    });
  });

  it("另一个账号对临时空间 id 的每条按 id 路由都是 404，与不存在的 id 逐字节相同，且不建目录", async () => {
    await withWorld(async ({ app, db, other, temporary }) => {
      plantContent(temporary.root);
      const foreign = byIdRoutes(temporary.id, "intruder");
      const unknown = byIdRoutes(UNKNOWN_ID, "intruder");
      const before = rowCounts(db);

      for (const name of Object.keys(foreign)) {
        const refused = await send(app, foreign[name] as RouteRequest, other);
        const missing = await send(app, unknown[name] as RouteRequest, other);

        expect(wireShape(refused), name).toEqual(NOT_FOUND);
        expect(wireShape(refused), name).toEqual(wireShape(missing));
      }
      expect(existsSync(join(temporary.root, "intruder"))).toBe(false);
      expect(rowCounts(db)).toEqual(before);
    });
  });

  it("所有者对他人的临时空间 id 同样 404", async () => {
    await withWorld(async ({ app, owner, foreignTemporary }) => {
      const routes = byIdRoutes(foreignTemporary.id, "intruder");

      for (const name of Object.keys(routes)) {
        const refused = await send(app, routes[name] as RouteRequest, owner);

        expect(wireShape(refused), name).toEqual(NOT_FOUND);
      }
      expect(existsSync(join(foreignTemporary.root, "intruder"))).toBe(false);
    });
  });

  it("匿名请求对临时空间 id 的每条按 id 路由都是 401，且不建目录", async () => {
    await withWorld(async ({ app, temporary }) => {
      plantContent(temporary.root);
      const routes = byIdRoutes(temporary.id, "anonymous");

      for (const name of Object.keys(routes)) {
        const refused = await send(app, routes[name] as RouteRequest);

        expect(wireShape(refused), name).toEqual(envelopeShape(401, UNAUTHORIZED_ENVELOPE));
      }
      expect(existsSync(join(temporary.root, "anonymous"))).toBe(false);
    });
  });
});

describe("临时空间的可见性：不能显式绑定临时空间", () => {
  it("所有者显式绑定自己的临时空间是 404，与随机 id 的响应逐字节相同，不写会话行与审计", async () => {
    await withWorld(async ({ app, db, owner, temporary }) => {
      const before = rowCounts(db);

      const refused = await bindSession(app, owner, { workspaceId: temporary.id });
      const withScene = await bindSession(app, owner, { workspaceId: temporary.id, scene: "code" });
      const unknown = await bindSession(app, owner, { workspaceId: UNKNOWN_ID });

      expect(wireShape(refused)).toEqual(NOT_FOUND);
      expect(wireShape(withScene)).toEqual(NOT_FOUND);
      expect(wireShape(unknown)).toEqual(NOT_FOUND);
      expect(wireShape(refused)).toEqual(wireShape(unknown));
      expect(rowCounts(db)).toEqual(before);
      // The session the helper bound to T is still the only one that uses it.
      expect(
        db.prepare("SELECT id FROM chat_sessions WHERE workspace_id = ?").all(temporary.id),
      ).toEqual([{ id: OWNER_SESSION }]);
    });
  });

  it("他人与不存在的空间一致 404：他人的正式空间、他人的临时空间、随机 id、abc 与自己的临时空间逐字节相同", async () => {
    await withWorld(async ({ app, db, owner, other, normal, temporary, foreignTemporary }) => {
      const before = rowCounts(db);

      const responses = {
        foreignNormal: await bindSession(app, other, { workspaceId: normal.id }),
        foreignTemporary: await bindSession(app, owner, { workspaceId: foreignTemporary.id }),
        ownersTemporaryByOther: await bindSession(app, other, { workspaceId: temporary.id }),
        unknown: await bindSession(app, owner, { workspaceId: UNKNOWN_ID }),
        malformed: await bindSession(app, owner, { workspaceId: "abc" }),
        ownTemporary: await bindSession(app, owner, { workspaceId: temporary.id }),
      };

      for (const [name, response] of Object.entries(responses)) {
        expect(wireShape(response), name).toEqual(NOT_FOUND);
      }
      expect(rowCounts(db)).toEqual(before);
    });
  });

  it("绑定正式空间仍是 201：多一行会话与一条 session.bind 审计", async () => {
    await withWorld(async ({ app, db, owner, normal }) => {
      const before = rowCounts(db);

      const created = await bindSession(app, owner, { workspaceId: normal.id });

      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const body = created.json() as { id: string };
      expect(body).toMatchObject({ workspaceId: normal.id, temporaryWorkspace: false });
      expect(rowCounts(db)).toEqual({
        ...before,
        sessions: before.sessions + 1,
        audits: before.audits + 1,
      });
      expect(
        db
          .prepare("SELECT kind, actor_id, workspace_id FROM audit_events ORDER BY id DESC LIMIT 1")
          .get(),
      ).toEqual({ kind: "session.bind", actor_id: OWNER, workspace_id: normal.id });
      expect(
        db.prepare("SELECT owner_id, workspace_id FROM chat_sessions WHERE id = ?").get(body.id),
      ).toEqual({ owner_id: OWNER, workspace_id: normal.id });
    });
  });
});
