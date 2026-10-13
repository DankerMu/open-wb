/**
 * Issue #1244 (s1-followups-batch tasks 3.2, 3.5): workspaces「工作空间 HTTP 集成边界」, scenario
 * 「空间根被非目录占据」. Real `createApp`, real SQLite, real directories; requests go through
 * `inject`, except the one upload row that has to show the request body was not read (a raw
 * socket: a head that declares a body it never sends).
 *
 * The oracle of the nine-route table is the answer the same request gets for a workspace of the
 * same owner whose root directory was never made — status, body bytes and headers — next to the
 * literal 404 envelope. `promote` is the one route where an occupied root and a missing one differ
 * (owner 2026-10-13): 404 against 200. A root that is a symbolic link stays a sanitized 500
 * (design D14-1).
 *
 * What it does not show: every row is one request against a root that was occupied before the
 * request began. Nothing here replaces the root between the route's check and what follows it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createPreviewTokens } from "../src/preview/tokens.js";
import { ompAgentDir } from "../src/sessions/omp/process.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { INTERNAL_ERROR_ENVELOPE, NOT_FOUND_ENVELOPE } from "./auth-lifecycle-helpers.js";
import {
  createWorkspace as createDirectoryWorkspace,
  getDirectory,
  openWorld as openDirectoryWorld,
} from "./commands-rest-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import {
  createWorkspace as createUploadWorkspace,
  expectWire,
  OCTET_STREAM,
  send as sendUpload,
  auditCount as uploadAuditCount,
  withUploadWorld,
} from "./workspace-upload-helpers.js";
import {
  auditCount,
  auditRows,
  contentOf,
  expectEnvelope,
  FILES_WORKSPACE,
  insertWorkspace,
  seedWorkspace,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

/** zhangsan's `files`: a regular file where its root directory should be. */
const OCCUPIED = FILES_WORKSPACE;
/** zhangsan's, with a row and no root directory. */
const MISSING = "c".repeat(32);
/** zhangsan's, with an ordinary root directory. */
const FINE = "d".repeat(32);
const OCCUPANT = "occupant-bytes";
const LINKED_SECRET = "behind-the-link";
const FIVE_KEYS = ["id", "name", "dir", "root", "createdAt"];
/** What `withWorld` leaves below the sandbox root, as `contentOf` reads it. */
const START = {
  "u1/": "dir",
  "u1/files": `file:${OCCUPANT}`,
  "u1/fine/": "dir",
  "u1/x": "file:outside",
};

interface RootRequest {
  method: "GET" | "POST" | "DELETE";
  /** Below `/api/workspaces/<id>/`. */
  target: string;
  /** A JSON body. */
  json?: unknown;
  /** A raw body of `application/octet-stream`. */
  octets?: string;
}

/**
 * One request per route below `/api/workspaces/:id/` that goes through the owned-root check; each
 * route that takes a path is given `../x`, which names the file `u1/x` beside the workspace.
 */
const ROUTES: Array<[name: string, request: RootRequest]> = [
  ["tree", { method: "GET", target: "tree?path=..%2Fx" }],
  ["新建目录", { method: "POST", target: "dirs", json: { path: "../x" } }],
  ["file", { method: "GET", target: "file?path=..%2Fx" }],
  ["archive", { method: "GET", target: "archive?path=..%2Fx" }],
  ["download", { method: "GET", target: "download?path=..%2Fx" }],
  ["DELETE entries", { method: "DELETE", target: "entries?path=..%2Fx" }],
  ["move", { method: "POST", target: "move", json: { from: "../x", to: "y" } }],
  ["preview-token", { method: "POST", target: "preview-token" }],
  ["上传", { method: "POST", target: "uploads?name=..%2Fx", octets: "abc" }],
];

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  /** The path of the occupied root. */
  root: string;
  zhangsan: string;
  /** Every `issue` call `preview-token` made. */
  issueCalls: unknown[];
}

afterEach(() => {
  removeTempDirs();
});

/**
 * zhangsan's three workspaces — `files` (root occupied by a regular file), `rootless` (no root)
 * and `fine` — and a file `x` beside them. Assembled with the preview dependency, so
 * `preview-token` is a registered route. Asserts the starting point.
 */
async function withWorld(action: (world: World) => Promise<void>): Promise<void> {
  const registry = createPreviewTokens();
  const issueCalls: unknown[] = [];
  await withWorkspacesApp(
    async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      rmSync(root, { recursive: true });
      writeFileSync(root, OCCUPANT);
      insertWorkspace(db, MISSING, "u1", "rootless", "rootless", 2);
      insertWorkspace(db, FINE, "u1", "fine", "fine", 3);
      mkdirSync(join(sandboxRoot, "u1", "fine"));
      writeFileSync(join(sandboxRoot, "u1", "x"), "outside");
      const zhangsan = await cookieFor(app, "zhangsan");

      expect(contentOf(sandboxRoot)).toEqual(START);
      expect(auditCount(db)).toEqual({ count: 0 });

      await action({ app, db, sandboxRoot, root, zhangsan, issueCalls });
    },
    undefined,
    {
      assembly: {
        preview: {
          tokens: {
            issue(binding, now) {
              issueCalls.push({ ...binding });
              return registry.issue(binding, now);
            },
          },
          port: () => 41_735,
          documentMaxBytes: 104_857_600,
          officeAvailable: false,
        },
      },
    },
  );
}

function send(world: World, id: string, request: RootRequest) {
  const contentType =
    request.json !== undefined
      ? "application/json"
      : request.octets !== undefined
        ? OCTET_STREAM
        : undefined;
  const payload = request.json !== undefined ? JSON.stringify(request.json) : request.octets;
  return world.app.inject({
    method: request.method,
    url: `/api/workspaces/${id}/${request.target}`,
    headers: {
      cookie: world.zhangsan,
      ...(contentType === undefined ? {} : { "content-type": contentType }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** The response headers without the one that carries the time. */
function headersOf(response: LightMyRequestResponse): Record<string, unknown> {
  const { date: _date, ...headers } = response.headers;
  return headers;
}

/** Nothing audited, the occupant's bytes as written, nothing made or moved, no token issued. */
function expectUntouched({ db, sandboxRoot, root, issueCalls }: World): void {
  expect(auditCount(db)).toEqual({ count: 0 });
  expect(readFileSync(root, "utf8")).toBe(OCCUPANT);
  expect(contentOf(sandboxRoot)).toEqual(START);
  expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
  expect(issueCalls).toEqual([]);
}

function listWorkspaces({ app, zhangsan }: World) {
  return app.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: zhangsan } });
}

function workspaceRow(db: DatabaseSync, id: string): unknown {
  const row = db.prepare("SELECT name, temporary FROM workspaces WHERE id = ?").get(id);
  return row === undefined ? undefined : { ...row };
}

describe("workspace routes: 空间根被非目录占据", () => {
  it.each(ROUTES)(
    "%s answers the 404 of a missing root, byte for byte, and changes nothing",
    async (_name, request) => {
      await withWorld(async (world) => {
        const missing = await send(world, MISSING, request);
        expectEnvelope(missing, 404, NOT_FOUND_ENVELOPE, "missing root");

        const occupied = await send(world, OCCUPIED, request);

        expectEnvelope(occupied, 404, NOT_FOUND_ENVELOPE);
        expect(occupied.payload).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
        expect(occupied.payload).toBe(missing.payload);
        expect(headersOf(occupied)).toEqual(headersOf(missing));
        expectUntouched(world);
      });
    },
  );

  it("上传 answers before any byte of the declared body is sent", async () => {
    await withUploadWorld(async (world) => {
      const occupied = await createUploadWorkspace(world, "occupied");
      const gone = await createUploadWorkspace(world, "gone");
      rmSync(occupied.root, { recursive: true });
      writeFileSync(occupied.root, OCCUPANT);
      rmSync(gone.root, { recursive: true });
      const before = uploadAuditCount(world);
      // Heads only: each declares three bytes and sends none, so an answer means none was read.
      const head = (workspaceId: string) => ({
        workspaceId,
        query: "name=..%2Fx",
        cookie: world.owner,
        headers: { "Content-Type": OCTET_STREAM, "Content-Length": "3" },
      });

      const whenGone = await sendUpload(world, head(gone.id));
      const whenOccupied = await sendUpload(world, head(occupied.id));

      expectWire(whenOccupied, 404, NOT_FOUND_ENVELOPE);
      expect(whenOccupied.body).toBe(whenGone.body);
      const { date: _date, ...headers } = whenOccupied.headers;
      const { date: _goneDate, ...goneHeaders } = whenGone.headers;
      expect(headers).toEqual(goneHeaders);
      expect(whenOccupied.closedByServer).toBe(true);
      expect(readFileSync(occupied.root, "utf8")).toBe(OCCUPANT);
      expect(existsSync(gone.root)).toBe(false);
      expect(uploadAuditCount(world)).toBe(before);
    });
  });

  it("promote answers 404 for an occupied root whatever the body, and 200 for a root that is only missing", async () => {
    await withWorld(async (world) => {
      const { app, db, sandboxRoot, zhangsan } = world;
      // Temporary workspaces come from the store's own `createTemporary`, over the same database.
      const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
      db.exec("BEGIN");
      const occupied = store.createTemporary({ id: "u1" }).workspace;
      const missing = store.createTemporary({ id: "u1" }).workspace;
      db.exec("COMMIT");
      rmSync(occupied.root, { recursive: true });
      writeFileSync(occupied.root, OCCUPANT);
      rmSync(missing.root, { recursive: true });
      const promote = (id: string, payload: string) =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${id}/promote`,
          headers: { cookie: zhangsan, "content-type": "application/json" },
          payload,
        });

      for (const payload of [JSON.stringify({ name: "调研资料" }), "[]"]) {
        const response = await promote(occupied.id, payload);
        expectEnvelope(response, 404, NOT_FOUND_ENVELOPE, payload);
        expect(response.payload, payload).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
      }

      expect(auditRows(db, "workspace.promote")).toEqual([]);
      expect(auditCount(db)).toEqual({ count: 0 });
      expect(workspaceRow(db, occupied.id)).toEqual({ name: occupied.name, temporary: 1 });
      expect(readFileSync(occupied.root, "utf8")).toBe(OCCUPANT);
      const listed = (await listWorkspaces(world)).json<{ workspaces: Array<{ id: string }> }>();
      expect(listed.workspaces.map((workspace) => workspace.id)).toEqual([OCCUPIED, MISSING, FINE]);

      // The control: a missing root does not block promote (temporary-workspaces「转正」).
      const control = await promote(missing.id, JSON.stringify({ name: "调研资料" }));

      expect(control.statusCode).toBe(200);
      expect(control.headers["cache-control"]).toBe("no-store");
      expect(control.json()).toEqual({
        id: missing.id,
        name: "调研资料",
        dir: missing.dir,
        root: missing.root,
        createdAt: missing.createdAt,
      });
      expect(workspaceRow(db, missing.id)).toEqual({ name: "调研资料", temporary: 0 });
      expect(auditRows(db, "workspace.promote")).toEqual([
        expect.objectContaining({ actor_id: "u1", workspace_id: missing.id }),
      ]);
      expect(existsSync(missing.root)).toBe(false);
      // And an illegal body on a missing root is still judged as a body.
      expect((await promote(missing.id, "[]")).statusCode).toBe(400);
    });
  });

  it("GET /api/workspaces lists the occupied workspace exactly as while its root was missing", async () => {
    await withWorld(async (world) => {
      const { sandboxRoot, root } = world;
      rmSync(root);
      const whileMissing = await listWorkspaces(world);
      expect(whileMissing.statusCode).toBe(200);
      writeFileSync(root, OCCUPANT);

      const response = await listWorkspaces(world);

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.payload).toBe(whileMissing.payload);
      const { workspaces } = response.json<{ workspaces: object[] }>();
      expect(workspaces).toEqual([
        { id: OCCUPIED, name: "files", dir: "files", root, createdAt: 1 },
        {
          id: MISSING,
          name: "rootless",
          dir: "rootless",
          root: join(sandboxRoot, "u1", "rootless"),
          createdAt: 2,
        },
        {
          id: FINE,
          name: "fine",
          dir: "fine",
          root: join(sandboxRoot, "u1", "fine"),
          createdAt: 3,
        },
      ]);
      expect(Object.keys(workspaces[0] ?? {})).toEqual(FIVE_KEYS);
      expectUntouched(world);
    });
  });

  it("stays a sanitized 500 on every route and on the listing when the root is a symbolic link to a directory (D14-1)", async () => {
    await withWorld(async (world) => {
      const { db, sandboxRoot, root } = world;
      const target = join(sandboxRoot, "u1", "fine");
      writeFileSync(join(target, "keep.md"), LINKED_SECRET);
      rmSync(root);
      symlinkSync(target, root);
      const requests: Array<[name: string, request: RootRequest]> = [
        ...ROUTES,
        // Paths that would be legal below the link's target.
        ["tree of the root", { method: "GET", target: "tree" }],
        ["file keep.md", { method: "GET", target: "file?path=keep.md" }],
        ["download keep.md", { method: "GET", target: "download?path=keep.md" }],
      ];

      for (const [name, request] of requests) {
        const response = await send(world, OCCUPIED, request);
        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE, name);
        expect(response.payload, name).not.toContain(LINKED_SECRET);
        expect(response.payload, name).not.toContain("keep.md");
      }
      expectEnvelope(await listWorkspaces(world), 500, INTERNAL_ERROR_ENVELOPE, "listing");

      expect(auditCount(db)).toEqual({ count: 0 });
      expect(readFileSync(join(target, "keep.md"), "utf8")).toBe(LINKED_SECRET);
      expect(contentOf(target)).toEqual({ "keep.md": `file:${LINKED_SECRET}` });
      expect(world.issueCalls).toEqual([]);
    });
  });
});

describe("会话侧不变: 绑定空间的根被普通文件占据 (task 3.5)", () => {
  it("GET /api/commands?workspaceId= is 200 without project-level commands, as for a missing root", async () => {
    const { app, root, stateDir } = openDirectoryWorld("commands-root-occupied-");
    const cookie = await cookieFor(app, "zhangsan");
    const sandboxRoot = join(root, "sandbox");
    const occupied = await createDirectoryWorkspace(app, cookie, sandboxRoot, "occupied");
    const removed = await createDirectoryWorkspace(app, cookie, sandboxRoot, "removed");
    const skill = (dir: string, name: string) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "SKILL.md"), `---\ndescription: ${name}\n---\n正文\n`);
    };
    skill(join(ompAgentDir(stateDir), "skills"), "code-review");
    skill(join(sandboxRoot, "u1", ".omp", "skills"), "mine");
    rmSync(occupied.root, { recursive: true });
    writeFileSync(occupied.root, OCCUPANT);
    rmSync(removed.root, { recursive: true });
    const namesOf = (response: LightMyRequestResponse) =>
      response.json<{ commands: Array<{ name: string }> }>().commands.map((entry) => entry.name);

    // The control: the owner root's project skill is listed when no workspace is named.
    const unbound = await getDirectory(app, "/api/commands", cookie);
    expect(namesOf(unbound)).toEqual(["compact", "todo", "skill:code-review", "skill:mine"]);

    const response = await getDirectory(app, "/api/commands", cookie, occupied.id);
    const whenRemoved = await getDirectory(app, "/api/commands", cookie, removed.id);

    expect(response.statusCode).toBe(200);
    expect(namesOf(response)).toEqual(["compact", "todo", "skill:code-review"]);
    expect(response.payload).toBe(whenRemoved.payload);
    expect(readFileSync(occupied.root, "utf8")).toBe(OCCUPANT);
  });
});
