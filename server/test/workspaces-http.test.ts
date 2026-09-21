import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  expectWorkspaceResponse,
  insertWorkspace,
  requestWorkspaceFile,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

afterEach(removeTempDirs);

const U1_OLDER = "1".repeat(32);
const U1_NEWER = "2".repeat(32);
const U2_FOREIGN = "3".repeat(32);
const U1_TREE = "4".repeat(32);
const U1_DIRS = "5".repeat(32);
const U1_DIR_PARSER = "d".repeat(32);
const U1_STREAM_FAILURE = "0".repeat(32);
const U1_PREVIEW = "6".repeat(32);

describe("workspace REST", () => {
  it("lists only the authenticated account's collection and applies no-store before guard", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      mkdirSync(join(sandboxRoot, "u1", "older"), { recursive: true });
      mkdirSync(join(sandboxRoot, "u1", "newer"), { recursive: true });
      mkdirSync(join(sandboxRoot, "u2", "foreign"), { recursive: true });
      insertWorkspace(db, U1_OLDER, "u1", "older", "older", 10);
      insertWorkspace(db, U1_NEWER, "u1", "newer", "newer", 20);
      insertWorkspace(db, U2_FOREIGN, "u2", "foreign", "foreign", 1);

      const response = await app.inject({
        method: "GET",
        url: "/api/workspaces",
        headers: { cookie: bearerCookie(await loginSessionId(app, "zhangsan")) },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        workspaces: [
          {
            id: U1_OLDER,
            name: "older",
            dir: "older",
            root: join(sandboxRoot, "u1", "older"),
            createdAt: 10,
          },
          {
            id: U1_NEWER,
            name: "newer",
            dir: "newer",
            root: join(sandboxRoot, "u1", "newer"),
            createdAt: 20,
          },
        ],
      });
      expect(response.payload).not.toContain("foreign");
      const unauthenticated = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toEqual(UNAUTHORIZED_ENVELOPE);
      expect(unauthenticated.headers["cache-control"]).toBe("no-store");
    });
  });
  it("creates an owner workspace through the canonical store and persisted audit", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const response = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: {
          "content-type": "application/json",
          cookie,
        },
        payload: JSON.stringify({ name: "智能 客服/重构" }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const root = join(sandboxRoot, "u1", "智能-客服-重构");
      expect(response.json()).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f]{32}$/u),
        name: "智能 客服/重构",
        dir: "智能-客服-重构",
        root,
        createdAt: expect.any(Number),
      });
      expect(lstatSync(join(sandboxRoot, "u1")).mode & 0o7777).toBe(0o2770);
      expect(lstatSync(root).mode & 0o7777).toBe(0o2770);
      expect(
        db
          .prepare(
            "SELECT actor_id, kind, title, detail, workspace_id FROM audit_events WHERE kind = 'workspace.create'",
          )
          .get(),
      ).toEqual({
        actor_id: "u1",
        kind: "workspace.create",
        title: "创建工作空间 智能 客服/重构",
        detail: JSON.stringify({ root }),
        workspace_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { "content-type": "application/json", cookie },
        payload: JSON.stringify({ name: "智能 客服/重构" }),
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ error: { code: "conflict", message: "同名资源已存在" } });
      expect(duplicate.headers["cache-control"]).toBe("no-store");
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
    });
  });
  it("adopts an existing ordinary directory through HTTP without changing its content or mode", async () => {
    await withWorkspacesApp(async ({ app, sandboxRoot }) => {
      const ownerRoot = join(sandboxRoot, "u1");
      const adoptedRoot = join(ownerRoot, "smoke-fixture");
      mkdirSync(adoptedRoot, { recursive: true, mode: 0o755 });
      writeFileSync(join(adoptedRoot, "keep.txt"), "adopted");
      chmodSync(ownerRoot, 0o755);
      chmodSync(adoptedRoot, 0o755);

      const response = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: {
          "content-type": "application/json",
          cookie: bearerCookie(await loginSessionId(app, "zhangsan")),
        },
        payload: JSON.stringify({ name: "smoke", dir: "smoke-fixture" }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        name: "smoke",
        dir: "smoke-fixture",
        root: adoptedRoot,
      });
      expect(readFileSync(join(adoptedRoot, "keep.txt"), "utf8")).toBe("adopted");
      expect(lstatSync(ownerRoot).mode & 0o7777).toBe(0o755);
      expect(lstatSync(adoptedRoot).mode & 0o7777).toBe(0o755);
    });
  });
  it("preserves valid Unicode scalars and literal replacement characters through HTTP creation", async () => {
    await withWorkspacesApp(async ({ app }) => {
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const cases = [
        { name: "😀".repeat(64), dir: "emoji64", expectedDir: "emoji64" },
        { name: "😀", expectedDir: "--" },
        { name: "\uFFFD", dir: "replacement", expectedDir: "replacement" },
      ];

      for (const input of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/api/workspaces",
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify(
            input.dir === undefined ? { name: input.name } : { name: input.name, dir: input.dir },
          ),
        });
        expect(response.statusCode).toBe(201);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toMatchObject({ name: input.name, dir: input.expectedDir });
      }
    });
  });
  it("rejects malformed workspace payloads before store, audit, or filesystem effects", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const cases = [
        { contentType: "application/json", payload: JSON.stringify({ name: "ok", actorId: "u2" }) },
        { contentType: "application/json", payload: JSON.stringify({ name: 1 }) },
        { contentType: "application/json", payload: JSON.stringify({ dir: "missing-name" }) },
        { contentType: "application/json", payload: "null" },
        { contentType: "application/json", payload: JSON.stringify(["name"]) },
        { contentType: "application/json", payload: "{" },
        { contentType: "text/plain", payload: JSON.stringify({ name: "ok" }) },
        { contentType: "application/octet-stream", payload: "not-json" },
        { contentType: "application/json", payload: JSON.stringify({ name: "\uD800" }) },
        { contentType: "application/json", payload: JSON.stringify({ name: "x".repeat(17_000) }) },
      ];

      for (const input of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/api/workspaces",
          headers: { "content-type": input.contentType, cookie },
          payload: input.payload,
        });
        expectWorkspaceResponse(response, 400, BAD_REQUEST_ENVELOPE);
      }

      expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
      expect(existsSync(join(sandboxRoot, "u1"))).toBe(false);
    });
  });
  it("lists one owned workspace tree level with production ordering and metadata", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "tree");
      const mtimeSeconds = 1_726_000_000;
      mkdirSync(join(root, "out"), { recursive: true });
      writeFileSync(join(root, "out", "a.md"), "nested");
      writeFileSync(join(root, "b.txt"), "plain");
      symlinkSync(join(root, "b.txt"), join(root, "file-link"));
      symlinkSync(join(root, "out"), join(root, "dir-link"));
      execFileSync("mkfifo", [join(root, "pipe")]);
      utimesSync(join(root, "out"), mtimeSeconds, mtimeSeconds);
      utimesSync(join(root, "b.txt"), mtimeSeconds, mtimeSeconds);
      insertWorkspace(db, U1_TREE, "u1", "tree", "tree", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const rootResponse = await app.inject({
        method: "GET",
        url: `/api/workspaces/${U1_TREE}/tree`,
        headers: { cookie },
      });
      expect(rootResponse.statusCode).toBe(200);
      expect(rootResponse.headers["cache-control"]).toBe("no-store");
      expect(rootResponse.json()).toEqual({
        path: "",
        entries: [
          {
            name: "out",
            type: "dir",
            size: lstatSync(join(root, "out")).size,
            mtime: mtimeSeconds * 1000,
          },
          { name: "b.txt", type: "file", size: 5, mtime: mtimeSeconds * 1000 },
        ],
      });

      const nestedResponse = await app.inject({
        method: "GET",
        url: `/api/workspaces/${U1_TREE}/tree?path=out`,
        headers: { cookie },
      });
      expect(nestedResponse.statusCode).toBe(200);
      expect(nestedResponse.json()).toEqual({
        path: "out",
        entries: [
          {
            name: "a.md",
            type: "file",
            size: 6,
            mtime: lstatSync(join(root, "out", "a.md")).mtimeMs,
          },
        ],
      });
    });
  });
  it("creates one directory, conflicts without auditing, maps missing parents to 404, and audits traversal", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "dirs");
      mkdirSync(join(root, "out"), { recursive: true });
      insertWorkspace(db, U1_DIRS, "u1", "dirs", "dirs", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const postDir = (path: string) =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${U1_DIRS}/dirs`,
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify({ path }),
        });

      const created = await postDir("out/新目录");
      expect(lstatSync(join(root, "out", "新目录")).mode & 0o7777).toBe(0o2770);
      expect(
        db.prepare("SELECT actor_id, kind, title, detail, workspace_id FROM audit_events").all(),
      ).toEqual([
        {
          actor_id: "u1",
          kind: "dir.create",
          title: "新建目录 out/新目录",
          detail: JSON.stringify({ path: "out/新目录" }),
          workspace_id: U1_DIRS,
        },
      ]);
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.json()).toEqual({ path: "out/新目录" });

      const duplicate = await postDir("out/新目录");
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ error: { code: "conflict", message: "同名资源已存在" } });
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 1 });

      const missingParent = await postDir("missing/x");
      expect(missingParent.statusCode).toBe(404);
      expect(missingParent.json()).toEqual(NOT_FOUND_ENVELOPE);
      expect(existsSync(join(root, "missing"))).toBe(false);

      const traversal = await postDir("../x");
      expect(traversal.statusCode).toBe(403);
      expect(traversal.json()).toEqual({
        error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
      });
      expect(existsSync(join(sandboxRoot, "u1", "x"))).toBe(false);
      expect(
        db
          .prepare(
            "SELECT actor_id, kind, title, workspace_id, json_extract(detail, '$.path') AS path, json_extract(detail, '$.relPath') AS rel_path, json_extract(detail, '$.op') AS op FROM audit_events ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          actor_id: "u1",
          kind: "dir.create",
          title: "新建目录 out/新目录",
          workspace_id: U1_DIRS,
          path: "out/新目录",
          rel_path: null,
          op: null,
        },
        {
          actor_id: "u1",
          kind: "sandbox.reject",
          title: "越界访问被沙箱拦截",
          workspace_id: U1_DIRS,
          path: null,
          rel_path: "../x",
          op: "mkdir",
        },
      ]);
    });
  });
  it("streams an owned text preview as exact native bytes with production headers", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "preview");
      const textBytes = Buffer.from([0x6d, 0x64, 0x0a, 0xff, 0x00, 0x61]);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "readme.md"), textBytes);
      insertWorkspace(db, U1_PREVIEW, "u1", "preview", "preview", 1);

      const response = await app.inject({
        method: "GET",
        url: `/api/workspaces/${U1_PREVIEW}/file?path=readme.md`,
        headers: { cookie: bearerCookie(await loginSessionId(app, "zhangsan")) },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-workbuddy-size"]).toBe(String(textBytes.length));
      expect(response.rawPayload.equals(textBytes)).toBe(true);
    });
  });
  it("preserves HTML, image, zero-byte, and bounded-text preview semantics", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "preview");
      const htmlBytes = Buffer.from("<h1>untrusted</h1>");
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x01]);
      const bigBytes = Buffer.alloc(1_572_864, 0xab);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "page.html"), htmlBytes);
      writeFileSync(join(root, "logo.png"), pngBytes);
      writeFileSync(join(root, "photo.JPEG"), jpegBytes);
      writeFileSync(join(root, "empty.txt"), "");
      writeFileSync(join(root, "big.log"), bigBytes);
      insertWorkspace(db, U1_PREVIEW, "u1", "preview", "preview", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const html = await requestWorkspaceFile(app, U1_PREVIEW, cookie, "page.html");
      expect(html.statusCode).toBe(200);
      expect(html.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(html.headers["content-type"]).not.toContain("text/html");
      expect(html.rawPayload.equals(htmlBytes)).toBe(true);

      const png = await requestWorkspaceFile(app, U1_PREVIEW, cookie, "logo.png");
      expect(png.statusCode).toBe(200);
      expect(png.headers["content-type"]).toBe("image/png");
      expect(png.headers["x-workbuddy-size"]).toBe(String(pngBytes.length));
      expect(png.headers["x-content-type-options"]).toBe("nosniff");
      expect(png.headers["cache-control"]).toBe("no-store");
      expect(png.rawPayload.equals(pngBytes)).toBe(true);

      const jpeg = await requestWorkspaceFile(app, U1_PREVIEW, cookie, "photo.JPEG");
      expect(jpeg.statusCode).toBe(200);
      expect(jpeg.headers["content-type"]).toBe("image/jpeg");
      expect(jpeg.headers["x-content-type-options"]).toBe("nosniff");
      expect(jpeg.headers["cache-control"]).toBe("no-store");
      expect(jpeg.rawPayload.equals(jpegBytes)).toBe(true);

      const zero = await requestWorkspaceFile(app, U1_PREVIEW, cookie, "empty.txt");
      expect(zero.statusCode).toBe(200);
      expect(zero.headers["x-workbuddy-size"]).toBe("0");
      expect(zero.headers["x-workbuddy-truncated"]).toBeUndefined();
      expect(zero.rawPayload.length).toBe(0);

      const big = await requestWorkspaceFile(app, U1_PREVIEW, cookie, "big.log");
      expect(big.statusCode).toBe(200);
      expect(big.headers["x-workbuddy-size"]).toBe("1572864");
      expect(big.headers["x-workbuddy-truncated"]).toBe("1");
      expect(big.rawPayload.length).toBe(1_048_576);
      expect(big.rawPayload.equals(bigBytes.subarray(0, 1_048_576))).toBe(true);
      expect(big.headers["cache-control"]).toBe("no-store");
    });
  });
  it("rejects missing, special, unsupported, and oversized previews before body streaming", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = join(sandboxRoot, "u1", "preview");
      mkdirSync(join(root, "out.zip"), { recursive: true });
      writeFileSync(join(root, "archive.zip"), "PK");
      writeFileSync(join(root, "huge.png"), "");
      truncateSync(join(root, "huge.png"), 11 * 1024 * 1024);
      writeFileSync(join(root, "file.__proto__"), "x");
      writeFileSync(join(root, "file.constructor"), "x");
      execFileSync("mkfifo", [join(root, "pipe.zip")]);
      insertWorkspace(db, U1_PREVIEW, "u1", "preview", "preview", 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const cases = [
        {
          path: "missing.zip",
          status: 404,
          body: NOT_FOUND_ENVELOPE,
        },
        {
          path: "out.zip",
          status: 404,
          body: NOT_FOUND_ENVELOPE,
        },
        {
          path: "pipe.zip",
          status: 404,
          body: NOT_FOUND_ENVELOPE,
        },
        {
          path: "archive.zip",
          status: 415,
          body: { error: { code: "preview_unsupported", message: "该类型不支持预览" } },
        },
        {
          path: "huge.png",
          status: 413,
          body: { error: { code: "preview_too_large", message: "文件过大，无法预览" } },
        },
        {
          path: "file.__proto__",
          status: 415,
          body: { error: { code: "preview_unsupported", message: "该类型不支持预览" } },
        },
        {
          path: "file.constructor",
          status: 415,
          body: { error: { code: "preview_unsupported", message: "该类型不支持预览" } },
        },
      ];

      for (const previewCase of cases) {
        const response = await requestWorkspaceFile(app, U1_PREVIEW, cookie, previewCase.path);
        expectWorkspaceResponse(response, previewCase.status, previewCase.body);
      }
    });
  });
  it("uses the exact 16 KiB parser boundary and exact JSON body shapes on both POST routes", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const validJson = JSON.stringify({ name: "at-limit" });
      const atLimit = validJson + " ".repeat(16 * 1024 - Buffer.byteLength(validJson));
      const collectionAtLimit = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { "content-type": "application/json; charset=utf-8", cookie },
        payload: atLimit,
      });
      expect(collectionAtLimit.statusCode).toBe(201);
      expect(collectionAtLimit.headers["cache-control"]).toBe("no-store");
      expect(collectionAtLimit.json()).toMatchObject({ name: "at-limit" });

      const collectionTooLarge = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { "content-type": "application/json", cookie },
        payload: `${atLimit} `,
      });
      expectWorkspaceResponse(collectionTooLarge, 400, BAD_REQUEST_ENVELOPE);

      const root = join(sandboxRoot, "u1", "dir-parser");
      mkdirSync(root, { recursive: true });
      insertWorkspace(db, U1_DIR_PARSER, "u1", "dir-parser", "dir-parser", 1);
      const beforeAudits = db.prepare("SELECT count(*) AS count FROM audit_events").get();
      const invalidDirectories = [
        { contentType: "application/json", payload: JSON.stringify({ path: "out", extra: true }) },
        { contentType: "application/json", payload: JSON.stringify({ path: 1 }) },
        { contentType: "application/json", payload: "null" },
        { contentType: "application/json", payload: JSON.stringify(["out"]) },
        { contentType: "application/json", payload: "{" },
        { contentType: "text/plain", payload: JSON.stringify({ path: "out" }) },
        { contentType: "application/octet-stream", payload: "not-json" },
        { contentType: "application/json", payload: JSON.stringify({ path: "x".repeat(17_000) }) },
      ];
      for (const invalid of invalidDirectories) {
        const response = await app.inject({
          method: "POST",
          url: `/api/workspaces/${U1_DIR_PARSER}/dirs`,
          headers: { "content-type": invalid.contentType, cookie },
          payload: invalid.payload,
        });
        expectWorkspaceResponse(response, 400, BAD_REQUEST_ENVELOPE);
      }

      expect(existsSync(join(root, "out"))).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual(beforeAudits);
    });
  });
  it("maps a real native preview-open failure before headers to the canonical sanitized error", async () => {
    await withWorkspacesApp(
      async ({ app, db, sandboxRoot }) => {
        const root = join(sandboxRoot, "u1", "preview-open-failure");
        const target = join(root, "denied.txt");
        mkdirSync(root, { recursive: true });
        writeFileSync(target, "must-not-stream");
        insertWorkspace(
          db,
          U1_STREAM_FAILURE,
          "u1",
          "preview-open-failure",
          "preview-open-failure",
          1,
        );

        const response = await requestWorkspaceFile(
          app,
          U1_STREAM_FAILURE,
          bearerCookie(await loginSessionId(app, "zhangsan")),
          "denied.txt",
        );

        expectWorkspaceResponse(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-workbuddy-size"]).toBeUndefined();
        expect(response.headers["x-workbuddy-truncated"]).toBeUndefined();
        expect(response.payload).not.toContain(target);
        expect(response.payload).not.toContain("FST_ERR_REP_INVALID_PAYLOAD_TYPE");
        expect(existsSync(target)).toBe(false);
      },
      ({ app, sandboxRoot }) => {
        const target = join(sandboxRoot, "u1", "preview-open-failure", "denied.txt");
        let removed = false;
        app.addHook("onSend", (request, _reply, _payload, done) => {
          if (!removed && request.routeOptions.url === "/api/workspaces/:id/file") {
            removed = true;
            unlinkSync(target);
          }
          done();
        });
      },
    );
  });
});
