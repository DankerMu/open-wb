/**
 * Issue #1075 (s1f-files-page tasks 11.4, 11.5): the five routes this change added below
 * `/api/workspaces/:id` — `archive`, `download`, `DELETE entries`, `move`, `preview-token` — against
 * one boundary table (workspaces「工作空间 HTTP 集成边界」, scenario「新增路由沿用同一边界」).
 * Real `createApp`, real SQLite, real directories; the real token registry behind a wrapper that
 * records every `issue` call.
 *
 * What is new here: the five routes compared byte for byte with the 404 of `GET …/tree` for the
 * same id and caller; audit and file system unchanged against an asserted starting point; and
 * `no-store` on every row, `preview-token` included. The 401 and duplicate-`path` 400 rows repeat
 * what each route's own file already pins.
 *
 * What it does not show: it pins the order of the checks, one request at a time, through `inject`
 * and the source handlers. No row opens a window between a check and the open or the rename that
 * follows it (design D22 / D-23, #1286 stays open; nothing here closes or widens it).
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewTokens } from "../src/preview/tokens.js";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import { ZIP_THREE_RECORDS, zipArchive } from "./workspaces-archive-helpers.js";
import {
  auditCount,
  auditRows,
  contentOf,
  expectEnvelope,
  FILES_WORKSPACE,
  insertWorkspace,
  SANDBOX_DENIED_ENVELOPE,
  seedWorkspace,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const MISSING_WORKSPACE = "b".repeat(32);
/** zhangsan's, with a row and no root directory. */
const ROOTLESS_WORKSPACE = "c".repeat(32);
/** The reason a `..` component is rejected with (`core/sandbox/resolve.ts`), as the move tests pin it. */
const NOT_INSIDE = "path is not inside the sandbox root";
const SIX_KEYS = [
  "token",
  "base",
  "officeBase",
  "expiresAt",
  "documentMaxBytes",
  "officeAvailable",
];
const THREE_ZIP = zipArchive(ZIP_THREE_RECORDS);
/** What `seedBoundary` leaves below the sandbox root, as `contentOf` reads it. */
const START = {
  "u1/": "dir",
  "u1/files/": "dir",
  "u1/files/keep.md": "file:keep",
  "u1/files/x.zip": `file:${THREE_ZIP.toString("utf8")}`,
  "u1/x": "file:outside",
};

interface BoundaryRequest {
  label: string;
  method: "GET" | "POST" | "DELETE";
  url: string;
  /** A JSON body; absent sends neither payload nor content type. */
  body?: unknown;
}

interface BoundaryRoute {
  name: string;
  /** Requests whose path (or `from` / `to`) leaves the workspace. */
  escaping(id: string): BoundaryRequest[];
  /** Requests the route answers 400 for on the owner's own workspace. */
  malformed(id: string): BoundaryRequest[];
  /** The owner's legal request and the status it gets. */
  own(id: string): BoundaryRequest;
  ownStatus: number;
  /** The `op` of the rejection an escaping path is audited with; null: the route takes no path. */
  op: "read" | "delete" | "move" | null;
  /** Routes that read `path` from the query: the same `path` given twice. */
  twice?(id: string, path: string): BoundaryRequest;
}

/** A route that takes its path from the query string. */
function queryRoute(
  name: string,
  method: "GET" | "DELETE",
  segment: string,
  target: { path: string; status: number; op: "read" | "delete" },
): BoundaryRoute {
  const base = (id: string) => `/api/workspaces/${id}/${segment}`;
  const twice = (id: string, path: string): BoundaryRequest => ({
    label: `path=${path} twice`,
    method,
    url: `${base(id)}?path=${path}&path=${path}`,
  });
  return {
    name,
    escaping: (id) => [{ label: "path=../x", method, url: `${base(id)}?path=..%2Fx` }],
    malformed: (id) => [twice(id, "a"), { label: "no path", method, url: base(id) }],
    own: (id) => ({ label: `path=${target.path}`, method, url: `${base(id)}?path=${target.path}` }),
    ownStatus: target.status,
    op: target.op,
    twice,
  };
}

function post(id: string, segment: string, label: string, body?: unknown): BoundaryRequest {
  return {
    label,
    method: "POST",
    url: `/api/workspaces/${id}/${segment}`,
    ...(body === undefined ? {} : { body }),
  };
}

/** `preview-token` takes no path: a body that names one stands in for both columns. */
const tokenWithPathBody = (id: string) => [
  post(id, "preview-token", 'body {"path":"../x"}', { path: "../x" }),
];

/**
 * The five routes. The order is the order case two runs the owner's legal requests in: the
 * archive is listed before it is deleted, `keep.md` downloaded before it is moved.
 */
const ROUTES: BoundaryRoute[] = [
  queryRoute("archive", "GET", "archive", { path: "x.zip", status: 200, op: "read" }),
  queryRoute("download", "GET", "download", { path: "keep.md", status: 200, op: "read" }),
  queryRoute("DELETE entries", "DELETE", "entries", { path: "x.zip", status: 204, op: "delete" }),
  {
    name: "move",
    escaping: (id) => [
      post(id, "move", "from ../a", { from: "../a", to: "b.md" }),
      post(id, "move", "to ../b", { from: "a.md", to: "../b" }),
    ],
    malformed: (id) => [post(id, "move", "no to", { from: "a.md" })],
    own: (id) => post(id, "move", "keep.md to b.md", { from: "keep.md", to: "b.md" }),
    ownStatus: 200,
    op: "move",
  },
  {
    name: "preview-token",
    escaping: tokenWithPathBody,
    malformed: tokenWithPathBody,
    own: (id) => post(id, "preview-token", "no body"),
    ownStatus: 200,
    op: null,
  },
];

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  /** Every `issue` call the route made, in order. */
  issueCalls: unknown[];
  zhangsan: string;
}

afterEach(() => {
  removeTempDirs();
});

/**
 * zhangsan's workspace `files` holding `keep.md` and `x.zip`, a file `x` beside it — what `../x`
 * names from inside — and a second workspace row of zhangsan's whose directory was never made.
 * The app is assembled with the preview dependency, so `preview-token` is a registered route and
 * not the catch-all. Asserts the starting point every "nothing changed" below is measured from.
 */
async function withBoundaryWorld(action: (world: World) => Promise<void>): Promise<void> {
  const registry = createPreviewTokens();
  const issueCalls: unknown[] = [];
  await withWorkspacesApp(
    async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "keep.md"), "keep");
      writeFileSync(join(root, "x.zip"), THREE_ZIP);
      writeFileSync(join(sandboxRoot, "u1", "x"), "outside");
      insertWorkspace(db, ROOTLESS_WORKSPACE, "u1", "rootless", "rootless", 2);
      const zhangsan = bearerCookie(await loginSessionId(app, "zhangsan"));

      expect(contentOf(sandboxRoot)).toEqual(START);
      expect(auditCount(db)).toEqual({ count: 0 });

      await action({ app, db, sandboxRoot, issueCalls, zhangsan });
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

/** Injects one row; `cookie` null sends none. */
function send(app: FastifyInstance, request: BoundaryRequest, cookie: string | null) {
  return app.inject({
    method: request.method,
    url: request.url,
    headers: {
      ...(cookie === null ? {} : { cookie }),
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }),
  });
}

/** Nothing audited, nothing on disk moved or made, no recycle directory, no token issued. */
function expectUntouched({ db, sandboxRoot, issueCalls }: World): void {
  expect(auditCount(db)).toEqual({ count: 0 });
  expect(contentOf(sandboxRoot)).toEqual(START);
  expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
  expect(issueCalls).toEqual([]);
}

describe("workspace routes: 新增路由沿用同一边界", () => {
  it("answers another owner's, an unknown and a rootless id with the 404 of the tree route on all five routes, whatever the path, and changes nothing", async () => {
    await withBoundaryWorld(async (world) => {
      const { app, zhangsan } = world;
      // lisi is the seeded administrator: the role opens no other owner's workspace.
      const callers: Array<[label: string, cookie: string, id: string]> = [
        ["foreign admin", bearerCookie(await loginSessionId(app, "lisi")), FILES_WORKSPACE],
        ["foreign member", bearerCookie(await loginSessionId(app, "zhaoliu")), FILES_WORKSPACE],
        ["unknown id", zhangsan, MISSING_WORKSPACE],
        ["rootless id", zhangsan, ROOTLESS_WORKSPACE],
      ];

      for (const [caller, cookie, id] of callers) {
        // What a route that predates this change answers for this id and this caller.
        const tree = await app.inject({
          method: "GET",
          url: `/api/workspaces/${id}/tree`,
          headers: { cookie },
        });
        expectEnvelope(tree, 404, NOT_FOUND_ENVELOPE, caller);
        for (const route of ROUTES) {
          for (const request of [...route.escaping(id), ...route.malformed(id)]) {
            const label = `${caller}, ${route.name}, ${request.label}`;
            const response = await send(app, request, cookie);
            expectEnvelope(response, 404, NOT_FOUND_ENVELOPE, label);
            expect(response.payload, label).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
            expect(response.payload, label).toBe(tree.payload);
          }
        }
      }

      expectUntouched(world);
    });
  });

  it("lets the owner through on all five routes and audits one rejection per escaping path", async () => {
    await withBoundaryWorld(async ({ app, db, sandboxRoot, issueCalls, zhangsan }) => {
      const id = FILES_WORKSPACE;
      const rejectedOps: string[] = [];
      const escapes = ROUTES.flatMap((route) =>
        route.escaping(id).map((request) => ({ route, request })),
      );
      for (const { route, request } of escapes) {
        const label = `${route.name}, ${request.label}`;
        const response = await send(app, request, zhangsan);
        if (route.op === null) {
          // No path to judge. The body the 404 rows carry is answered 400 here: it is looked at
          // only once the id is the caller's own.
          expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE, label);
        } else {
          expectEnvelope(response, 403, SANDBOX_DENIED_ENVELOPE, label);
          rejectedOps.push(route.op);
        }
        // Exactly one more rejection per denied request, under the route's own `op`, for `..`.
        expect(auditRows(db, "sandbox.reject"), label).toEqual(
          rejectedOps.map((op) =>
            expect.objectContaining({
              actor_id: "u1",
              workspace_id: id,
              detail: expect.objectContaining({ op, reason: NOT_INSIDE }),
            }),
          ),
        );
      }
      expect(rejectedOps).toEqual(["read", "read", "delete", "move", "move"]);
      expect(auditCount(db)).toEqual({ count: rejectedOps.length });
      expect(contentOf(sandboxRoot)).toEqual(START);
      expect(issueCalls).toEqual([]);

      for (const route of ROUTES) {
        const response = await send(app, route.own(id), zhangsan);
        expect(response.statusCode, route.name).toBe(route.ownStatus);
        expect(response.headers["cache-control"], route.name).toBe("no-store");
        if (route.name === "preview-token") {
          expect(Object.keys(response.json())).toEqual(SIX_KEYS);
        }
      }
      // The legal requests did what they name: these URLs reach the handlers.
      expect(contentOf(join(sandboxRoot, "u1"))).toEqual({
        "files/": "dir",
        "files/b.md": "file:keep",
        x: "file:outside",
      });
      expect(auditRows(db, "file.download").map((row) => row.detail.path)).toEqual(["keep.md"]);
      expect(auditRows(db, "file.delete").map((row) => row.detail.path)).toEqual(["x.zip"]);
      expect(auditRows(db, "file.move").map((row) => row.detail)).toEqual([
        { from: "keep.md", to: "b.md", type: "file" },
      ]);
      expect(issueCalls).toEqual([{ ownerId: "u1", workspaceId: id, embedOrigin: null }]);
    });
  });

  it("answers 401 without a session on all five routes, before the id and the path are looked at", async () => {
    await withBoundaryWorld(async (world) => {
      for (const route of ROUTES) {
        for (const request of [
          ...route.escaping(FILES_WORKSPACE),
          ...route.malformed(FILES_WORKSPACE),
        ]) {
          expectEnvelope(
            await send(world.app, request, null),
            401,
            UNAUTHORIZED_ENVELOPE,
            `${route.name}, ${request.label}`,
          );
        }
      }

      expectUntouched(world);
    });
  });

  it("answers 400 for a path given twice on the three query routes and leaves the named file alone", async () => {
    await withBoundaryWorld(async (world) => {
      const asked: string[] = [];
      for (const route of ROUTES) {
        // `move` and `preview-token` read no query string.
        if (route.twice === undefined) {
          continue;
        }
        asked.push(route.name);
        const request = route.twice(FILES_WORKSPACE, "keep.md");
        expectEnvelope(
          await send(world.app, request, world.zhangsan),
          400,
          BAD_REQUEST_ENVELOPE,
          `${route.name}, ${request.label}`,
        );
      }
      expect(asked).toEqual(["archive", "download", "DELETE entries"]);

      // `keep.md` is still there, and no `file.download` or `file.delete` row among zero rows.
      expectUntouched(world);
    });
  });
});
