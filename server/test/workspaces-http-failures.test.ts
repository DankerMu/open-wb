import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  expectWorkspaceNotFound,
  insertWorkspace,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

afterEach(removeTempDirs);

const U1_INVALID_DIR = "9".repeat(32);
const U1_MISSING_ROOT = "7".repeat(32);
const U1_OWNED = "a".repeat(32);
const MISSING_WORKSPACE = "b".repeat(32);
const U1_FILE_PARENT = "c".repeat(32);
const U1_RAW_PATH = "e".repeat(32);
const U1_AUDIT_FAILURE = "f".repeat(32);

describe("workspace REST structural absence", () => {
  it("returns no-store 404 for an owned missing root without creating or auditing", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      insertWorkspace(db, U1_MISSING_ROOT, "u1", "missing", "missing", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const requests = [
        {
          method: "GET" as const,
          url: `/api/workspaces/${U1_MISSING_ROOT}/tree?path=child`,
        },
        {
          method: "POST" as const,
          url: `/api/workspaces/${U1_MISSING_ROOT}/dirs`,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ path: "child" }),
        },
        {
          method: "GET" as const,
          url: `/api/workspaces/${U1_MISSING_ROOT}/file?path=child.txt`,
        },
      ];

      await expectWorkspaceNotFound(app, cookie, requests);

      expect(existsSync(join(sandboxRoot, "u1", "missing"))).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
    });
  });
  it("returns indistinguishable 404 before filesystem or audit effects for foreign and missing scoped IDs", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "owned");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "keep.txt"), "keep");
      insertWorkspace(db, U1_OWNED, "u1", "owned", "owned", 1);
      const ownerCookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const foreignCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const requestKinds = [
        (id: string) => ({
          method: "GET" as const,
          url: `/api/workspaces/${id}/tree?path=../escape`,
          headers: {},
        }),
        (id: string) => ({
          method: "POST" as const,
          url: `/api/workspaces/${id}/dirs`,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ path: "../escape" }),
        }),
        (id: string) => ({
          method: "GET" as const,
          url: `/api/workspaces/${id}/file?path=keep.txt`,
          headers: {},
        }),
      ];

      for (const [id, cookie] of [
        [U1_OWNED, foreignCookie],
        [MISSING_WORKSPACE, ownerCookie],
      ] as const) {
        await expectWorkspaceNotFound(
          app,
          cookie,
          requestKinds.map((requestForId) => requestForId(id)),
        );
      }

      expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(sandboxRoot, "u1", "escape"))).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
    });
  });

  it("maps descendants below an ordinary file to 404 without a sandbox rejection audit", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "file-parent");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "regular-file"), "not-a-directory");
      insertWorkspace(db, U1_FILE_PARENT, "u1", "file-parent", "file-parent", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const requests = [
        {
          method: "GET" as const,
          url: `/api/workspaces/${U1_FILE_PARENT}/tree?path=regular-file/child`,
        },
        { method: "GET" as const, url: `/api/workspaces/${U1_FILE_PARENT}/tree?path=regular-file` },
        { method: "GET" as const, url: `/api/workspaces/${U1_FILE_PARENT}/tree?path=missing` },
        {
          method: "POST" as const,
          url: `/api/workspaces/${U1_FILE_PARENT}/dirs`,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ path: "regular-file/child" }),
        },
        {
          method: "GET" as const,
          url: `/api/workspaces/${U1_FILE_PARENT}/file?path=regular-file/child.txt`,
        },
      ];

      await expectWorkspaceNotFound(app, cookie, requests);

      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
    });
  });
  it("preserves the one-time decoded path, rejects repeats, and persists tree traversal audit detail", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "raw-path");
      const percentNameBytes = Buffer.from([0x25, 0x32, 0x45]);
      mkdirSync(join(root, "out", "sub"), { recursive: true });
      writeFileSync(join(root, "out", "sub", "note.txt"), "note");
      writeFileSync(join(root, "%2E.txt"), percentNameBytes);
      insertWorkspace(db, U1_RAW_PATH, "u1", "raw-path", "raw-path", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const rawTree = await app.inject({
        method: "GET",
        url: `/api/workspaces/${U1_RAW_PATH}/tree?path=out%2F%2F.%2Fsub`,
        headers: { cookie },
      });
      expect(rawTree.statusCode).toBe(200);
      expect(rawTree.json()).toMatchObject({ path: "out//./sub" });

      const literalPercent = await app.inject({
        method: "GET",
        url: `/api/workspaces/${U1_RAW_PATH}/file?path=%252E.txt`,
        headers: { cookie },
      });
      expect(literalPercent.statusCode).toBe(200);
      expect(literalPercent.rawPayload.equals(percentNameBytes)).toBe(true);

      for (const url of [
        `/api/workspaces/${U1_RAW_PATH}/tree?path=out&path=sub`,
        `/api/workspaces/${U1_RAW_PATH}/file?path=out&path=sub`,
        `/api/workspaces/${U1_RAW_PATH}/file`,
      ]) {
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual(BAD_REQUEST_ENVELOPE);
        expect(response.headers["cache-control"]).toBe("no-store");
      }

      const traversal = await app.inject({
        method: "GET",
        url: `/api/workspaces/${U1_RAW_PATH}/tree?path=../outside`,
        headers: { cookie },
      });
      expect(traversal.statusCode).toBe(403);
      expect(traversal.json()).toEqual({
        error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
      });
      expect(traversal.headers["cache-control"]).toBe("no-store");
      expect(
        db
          .prepare(
            "SELECT actor_id, kind, workspace_id, json_extract(detail, '$.relPath') AS rel_path, json_extract(detail, '$.op') AS op FROM audit_events",
          )
          .all(),
      ).toEqual([
        {
          actor_id: "u1",
          kind: "sandbox.reject",
          workspace_id: U1_RAW_PATH,
          rel_path: "../outside",
          op: "list",
        },
      ]);
    });
  });
  it("keeps empty, dot, and traversal directory names in resolver denial with persisted audits", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "invalid-dir");
      mkdirSync(root, { recursive: true });
      insertWorkspace(db, U1_INVALID_DIR, "u1", "invalid-dir", "invalid-dir", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      for (const path of ["", ".", "../x"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/workspaces/${U1_INVALID_DIR}/dirs`,
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify({ path }),
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
        });
        expect(response.headers["cache-control"]).toBe("no-store");
      }

      expect(
        db
          .prepare(
            "SELECT json_extract(detail, '$.relPath') AS rel_path, json_extract(detail, '$.op') AS op FROM audit_events ORDER BY id",
          )
          .all(),
      ).toEqual([
        { rel_path: "", op: "mkdir" },
        { rel_path: ".", op: "mkdir" },
        { rel_path: "../x", op: "mkdir" },
      ]);
      expect(existsSync(join(root, "x"))).toBe(false);
    });
  });

  it("sets no-store before the guard on all five routes and keeps malformed anonymous posts at 401", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const requests = [
        { method: "GET" as const, url: "/api/workspaces" },
        {
          method: "POST" as const,
          url: "/api/workspaces",
          headers: { "content-type": "application/json" },
          payload: "{",
        },
        { method: "GET" as const, url: "/api/workspaces/unknown/tree?path=../outside" },
        {
          method: "POST" as const,
          url: "/api/workspaces/unknown/dirs",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ path: "x".repeat(17_000) }),
        },
        { method: "GET" as const, url: "/api/workspaces/unknown/file?path=../outside.txt" },
      ];

      for (const request of requests) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
      }

      expect(existsSync(join(sandboxRoot, "u1"))).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
    });
  });
  it("returns sanitized 500 when genuine denial or directory audit insertion fails", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "audit-failure");
      mkdirSync(join(root, "out"), { recursive: true });
      insertWorkspace(db, U1_AUDIT_FAILURE, "u1", "audit-failure", "audit-failure", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      db.setAuthorizer((actionCode, arg1) => {
        if (actionCode === constants.SQLITE_INSERT && arg1 === "audit_events") {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
      try {
        const denied = await app.inject({
          method: "GET",
          url: `/api/workspaces/${U1_AUDIT_FAILURE}/tree?path=../outside`,
          headers: { cookie },
        });
        expect(denied.statusCode).toBe(500);
        expect(denied.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expect(denied.headers["cache-control"]).toBe("no-store");
        expect(denied.payload).not.toContain("audit_events");
        expect(denied.payload).not.toContain("outside");

        const directory = await app.inject({
          method: "POST",
          url: `/api/workspaces/${U1_AUDIT_FAILURE}/dirs`,
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify({ path: "out/kept-after-audit-failure" }),
        });
        expect(directory.statusCode).toBe(500);
        expect(directory.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expect(directory.headers["cache-control"]).toBe("no-store");
        expect(lstatSync(join(root, "out", "kept-after-audit-failure")).isDirectory()).toBe(true);
        expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
          count: 0,
        });
      } finally {
        db.setAuthorizer(null);
      }
    });
  });

  it("does not report workspace creation success when the real store rollback also fails", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      db.setAuthorizer((actionCode, arg1) => {
        if (
          actionCode === constants.SQLITE_TRANSACTION &&
          (arg1 === "COMMIT" || arg1 === "ROLLBACK")
        ) {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/workspaces",
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify({ name: "rollback-failure" }),
        });
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(db.isTransaction).toBe(true);
        expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
        expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
          count: 1,
        });
        expect(existsSync(join(sandboxRoot, "u1"))).toBe(false);
      } finally {
        db.setAuthorizer(null);
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
        expect(db.isTransaction).toBe(false);
      }
    });
  });
});
