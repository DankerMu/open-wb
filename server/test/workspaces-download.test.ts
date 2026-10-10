import { execFileSync } from "node:child_process";
import fs, { appendFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { attachmentDisposition } from "../src/workspaces/rest-entries.js";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
// Its `afterEach` restores the spies and removes the temporary directories of this file too.
import { spyBodyIo } from "./workspace-file-helpers.js";
import {
  auditRows,
  expectWorkspaceResponse,
  insertWorkspace,
  SANDBOX_DENIED_ENVELOPE,
  seedWorkspace,
  FILES_WORKSPACE as WORKSPACE,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const MISSING_WORKSPACE = "b".repeat(32);
const ROOTLESS_WORKSPACE = "c".repeat(32);
const DOWNLOAD_ROUTE = "/api/workspaces/:id/download";
const CHINESE_NAME = '季度 报告"v2".pdf';
const BIG_SIZE = 30 * 1024 * 1024;

type Fixture = { app: FastifyInstance; db: DatabaseSync; sandboxRoot: string };

function downloadUrl(id: string, path: string): string {
  return `/api/workspaces/${id}/download?path=${encodeURIComponent(path)}`;
}

function download(
  app: FastifyInstance,
  cookie: string,
  path: string,
  headers: Record<string, string> = {},
  id = WORKSPACE,
) {
  return app.inject({ method: "GET", url: downloadUrl(id, path), headers: { cookie, ...headers } });
}

function downloadAudit(path: string, size: number) {
  return { actor_id: "u1", workspace_id: WORKSPACE, title: `下载 ${path}`, detail: { path, size } };
}

function auditCount(db: DatabaseSync): unknown {
  return db.prepare("SELECT count(*) AS count FROM audit_events").get();
}

/** Bytes that differ along the file, so a short, shifted or repeated stream cannot pass. */
function patternedBytes(size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 7 + (index >>> 16)) & 0xff;
  }
  return bytes;
}

/**
 * For `withWorkspacesApp`: runs `action` once, on the first download, after the handler handed
 * its stream over and before the stream opens the file.
 */
function onceBeforeDownloadSend(action: (root: string) => void) {
  return ({ app, sandboxRoot }: Fixture): void => {
    let done = false;
    app.addHook("onSend", (request, _reply, _payload, next) => {
      if (!done && request.routeOptions.url === DOWNLOAD_ROUTE) {
        done = true;
        action(join(sandboxRoot, "u1", "files"));
      }
      next();
    });
  };
}

/** How often the file was opened for streaming, after `spyBodyIo()`. */
function readStreamOpens(target: string): number {
  return vi.mocked(fs.createReadStream).mock.calls.filter(([path]) => path === target).length;
}

describe("workspace download: any file as an attachment", () => {
  it("streams every kind and size of file whole, as an octet-stream attachment, auditing each", {
    timeout: 60_000,
  }, async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      const files: Array<[name: string, bytes: Buffer]> = [
        ["readme.md", Buffer.from("# 读我\n")],
        ["archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x00, 0x80])],
        ["page.html", Buffer.from("<!doctype html><script>alert(1)</script>")],
        ["big.bin", patternedBytes(BIG_SIZE)],
        [CHINESE_NAME, Buffer.from("%PDF-1.7\n")],
        ["empty.txt", Buffer.alloc(0)],
      ];
      for (const [name, bytes] of files) {
        writeFileSync(join(root, name), bytes);
      }
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      for (const [name, bytes] of files) {
        const response = await download(app, cookie, name);
        expect(response.statusCode, name).toBe(200);
        expect(response.rawPayload.equals(bytes), name).toBe(true);
        expect(response.headers["content-type"], name).toBe("application/octet-stream");
        expect(response.headers["content-disposition"], name).toMatch(/^attachment; /u);
        expect(response.headers["x-content-type-options"], name).toBe("nosniff");
        expect(response.headers["cache-control"], name).toBe("no-store");
        expect(response.headers["content-length"], name).toBe(String(bytes.length));
      }

      const named = await download(app, cookie, CHINESE_NAME);
      const disposition = String(named.headers["content-disposition"]);
      expect(disposition).toBe(
        "attachment; filename=\"__ ___v2_.pdf\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A%22v2%22.pdf",
      );
      const parts = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.*)$/u.exec(disposition);
      expect(parts?.[1]).toMatch(/^[\x20-\x7e]*$/u);
      expect(decodeURIComponent(parts?.[2] ?? "")).toBe(CHINESE_NAME);

      expect(auditRows(db, "file.download")).toEqual([
        ...files.map(([name, bytes]) => downloadAudit(name, bytes.length)),
        downloadAudit(CHINESE_NAME, 9),
      ]);
    });
  });

  it("opens the file once per download and names it after the resolved entry", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(root, "docs"));
      const target = join(root, "docs", "b.md");
      writeFileSync(target, "nested");
      writeFileSync(join(root, "a\nb.txt"), "odd name");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      spyBodyIo();

      // A trailing slash alone proves little: `basename` of this request is `b.md` already.
      const nested = await download(app, cookie, "docs/b.md/");
      expect(nested.statusCode).toBe(200);
      expect(nested.payload).toBe("nested");
      expect(nested.headers["content-disposition"]).toBe(
        "attachment; filename=\"b.md\"; filename*=UTF-8''b.md",
      );
      expect(readStreamOpens(target)).toBe(1);

      // The request ends in `.`, which the resolver skips: the name is the resolved entry's,
      // not the last segment of the request. The audit keeps the request as it was sent.
      const dotted = await download(app, cookie, "docs/b.md/.");
      expect(dotted.statusCode).toBe(200);
      expect(dotted.payload).toBe("nested");
      expect(dotted.headers["content-disposition"]).toBe(
        "attachment; filename=\"b.md\"; filename*=UTF-8''b.md",
      );
      expect(readStreamOpens(target)).toBe(2);

      // A control character in a real file name must not reach the header.
      const odd = await download(app, cookie, "a\nb.txt");
      expect(odd.statusCode).toBe(200);
      expect(odd.payload).toBe("odd name");
      expect(odd.headers["content-disposition"]).toBe(
        "attachment; filename=\"a_b.txt\"; filename*=UTF-8''a%0Ab.txt",
      );
      expect(auditRows(db, "file.download")).toEqual([
        downloadAudit("docs/b.md/", 6),
        downloadAudit("docs/b.md/.", 6),
        downloadAudit("a\nb.txt", 8),
      ]);
    });
  });

  it("answers html, svg, pdf and xml as octet-stream attachments, never as a document", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app } = fixture;
      const root = seedWorkspace(fixture);
      const files = {
        "page.html": "<!doctype html><h1>page</h1>",
        "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        "doc.pdf": "%PDF-1.7\n%%EOF\n",
        "feed.xml": '<?xml version="1.0"?><rss/>',
      };
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(root, name), content);
        const response = await download(app, cookie, name);
        expect(response.statusCode, name).toBe(200);
        expect(response.payload, name).toBe(content);
        expect(response.headers["content-type"], name).toBe("application/octet-stream");
        expect(response.headers["content-disposition"], name).toBe(
          `attachment; filename="${name}"; filename*=UTF-8''${name}`,
        );
        expect(response.headers["x-content-type-options"], name).toBe("nosniff");
      }
    });
  });

  it("ignores Range: the whole file with 200 and no range headers", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app } = fixture;
      const bytes = patternedBytes(100);
      writeFileSync(join(seedWorkspace(fixture), "hundred.bin"), bytes);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const response = await download(app, cookie, "hundred.bin", { range: "bytes=0-9" });

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.equals(bytes)).toBe(true);
      expect(response.headers["content-length"]).toBe("100");
      expect(response.headers["content-range"]).toBeUndefined();
      expect(response.headers["accept-ranges"]).toBeUndefined();
    });
  });
});

describe("workspace download: refusals", () => {
  it("refuses what is not an ordinary file inside the owner's workspace, without a download audit", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(root, "out"));
      writeFileSync(join(root, "readme.md"), "owner-only");
      writeFileSync(join(sandboxRoot, "u1", "x"), "outside-the-workspace");
      execFileSync("mkfifo", [join(root, "pipe.bin")]);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator: the role opens no other owner's workspace.
      const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const memberCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const base = `/api/workspaces/${WORKSPACE}/download`;
      const cases: Array<
        [label: string, url: string, cookie: string, status: number, body: object]
      > = [
        ["directory", `${base}?path=out`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["missing", `${base}?path=missing.md`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["traversal", `${base}?path=..%2Fx`, cookie, 403, SANDBOX_DENIED_ENVELOPE],
        ["no path", base, cookie, 400, BAD_REQUEST_ENVELOPE],
        ["foreign admin", `${base}?path=readme.md`, adminCookie, 404, NOT_FOUND_ENVELOPE],
        ["foreign member", `${base}?path=readme.md`, memberCookie, 404, NOT_FOUND_ENVELOPE],
        ["anonymous", `${base}?path=readme.md`, "", 401, UNAUTHORIZED_ENVELOPE],
        ["path twice", `${base}?path=readme.md&path=readme.md`, cookie, 400, BAD_REQUEST_ENVELOPE],
        ["empty path", `${base}?path=`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["fifo", `${base}?path=pipe.bin`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["below a file", `${base}?path=readme.md%2Fx`, cookie, 404, NOT_FOUND_ENVELOPE],
      ];

      for (const [label, url, caseCookie, status, body] of cases) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: caseCookie === "" ? {} : { cookie: caseCookie },
        });
        expect(response.statusCode, label).toBe(status);
        expect(response.json(), label).toEqual(body);
        expect(response.headers["cache-control"], label).toBe("no-store");
        expect(response.headers["content-disposition"], label).toBeUndefined();
        expect(response.payload, label).not.toContain("owner-only");
        expect(response.payload, label).not.toContain("outside-the-workspace");
        expect(auditRows(db, "file.download"), label).toEqual([]);
      }

      expect(auditRows(db, "sandbox.reject")).toEqual([
        {
          actor_id: "u1",
          workspace_id: WORKSPACE,
          title: "越界访问被沙箱拦截",
          detail: { relPath: "../x", op: "read", reason: "path is not inside the sandbox root" },
        },
      ]);
      expect(auditCount(db)).toEqual({ count: 1 });
    });
  });

  it("answers the same 404 for another owner's, an unknown and a rootless id before any path check", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      writeFileSync(join(seedWorkspace(fixture), "readme.md"), "owner-only");
      writeFileSync(join(sandboxRoot, "u1", "x"), "outside-the-workspace");
      // Owned, but its directory is gone: not a sandbox rejection either.
      insertWorkspace(db, ROOTLESS_WORKSPACE, "u1", "rootless", "rootless", 2);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator, zhaoliu an ordinary member: neither owns the workspace.
      const foreignCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const memberCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));

      const responses = [
        await download(app, foreignCookie, "../x"),
        await download(app, memberCookie, "../x"),
        await download(app, cookie, "../x", {}, MISSING_WORKSPACE),
        await download(app, cookie, "../x", {}, ROOTLESS_WORKSPACE),
        await download(app, cookie, "readme.md", {}, ROOTLESS_WORKSPACE),
        // Same answer whatever the query is: ownership is judged before the query.
        await app.inject({
          method: "GET",
          url: `/api/workspaces/${WORKSPACE}/download`,
          headers: { cookie: foreignCookie },
        }),
      ];

      for (const response of responses) {
        expectWorkspaceResponse(response, 404, NOT_FOUND_ENVELOPE);
        expect(response.payload).toBe(responses[0]?.payload);
        expect(response.headers["content-disposition"]).toBeUndefined();
      }
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });

  it("denies symbolic links, outward or inward, with a read rejection and no bytes", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(sandboxRoot, "u2"));
      writeFileSync(join(sandboxRoot, "u2", "secret.txt"), "another-owner-secret");
      writeFileSync(join(root, "inside.txt"), "inside-content");
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "deep.txt"), "deep-content");
      symlinkSync(join(sandboxRoot, "u2", "secret.txt"), join(root, "out-link.txt"));
      symlinkSync(join(root, "inside.txt"), join(root, "in-link.txt"));
      symlinkSync(join(root, "real"), join(root, "dir-link"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const paths = ["out-link.txt", "in-link.txt", "dir-link/deep.txt"];

      for (const path of paths) {
        const response = await download(app, cookie, path);
        expectWorkspaceResponse(response, 403, SANDBOX_DENIED_ENVELOPE);
        expect(response.headers["content-disposition"], path).toBeUndefined();
        expect(response.payload, path).not.toContain("secret");
        expect(response.payload, path).not.toContain("content");
      }

      expect(auditRows(db, "sandbox.reject").map((row) => row.detail)).toEqual(
        paths.map((relPath) => ({
          relPath,
          op: "read",
          reason: "path is not inside the sandbox root",
        })),
      );
      expect(auditRows(db, "file.download")).toEqual([]);
    });
  });

  it("has no HEAD: 404 and no download audit", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      writeFileSync(join(seedWorkspace(fixture), "readme.md"), "head");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const response = await app.inject({
        method: "HEAD",
        url: downloadUrl(WORKSPACE, "readme.md"),
        headers: { cookie },
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });
});

describe("workspace download: failures around the audit", () => {
  it("sends no file byte and opens nothing when the audit cannot be written", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const target = join(seedWorkspace(fixture), "readme.md");
      writeFileSync(target, "must-not-leave-unaudited");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      spyBodyIo();
      db.setAuthorizer((actionCode, table) =>
        actionCode === constants.SQLITE_INSERT && table === "audit_events"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        const response = await download(app, cookie, "readme.md");

        expectWorkspaceResponse(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(response.payload).not.toContain("must-not-leave-unaudited");
        expect(response.payload).not.toContain("audit_events");
        expect(readStreamOpens(target)).toBe(0);
      } finally {
        db.setAuthorizer(null);
      }
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });

  it("sends only the audited size when the file grows after the audit", async () => {
    await withWorkspacesApp(
      async (fixture) => {
        const { app, db } = fixture;
        writeFileSync(join(seedWorkspace(fixture), "log.txt"), "audited");
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        const response = await download(app, cookie, "log.txt");

        expect(response.statusCode).toBe(200);
        expect(response.headers["content-length"]).toBe("7");
        expect(response.payload).toBe("audited");
        expect(auditRows(db, "file.download")).toEqual([downloadAudit("log.txt", 7)]);
      },
      onceBeforeDownloadSend((root) => appendFileSync(join(root, "log.txt"), "+later")),
    );
  });

  it("answers a clean 500 and keeps the audit row when the file vanishes after the audit", async () => {
    await withWorkspacesApp(
      async (fixture) => {
        const { app, db } = fixture;
        writeFileSync(join(seedWorkspace(fixture), "gone.txt"), "must-not-stream");
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        const response = await download(app, cookie, "gone.txt");

        expectWorkspaceResponse(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(response.headers["content-length"]).toBe(
          String(Buffer.byteLength(JSON.stringify(INTERNAL_ERROR_ENVELOPE))),
        );
        expect(response.payload).not.toContain("gone.txt");
        expect(auditRows(db, "file.download")).toEqual([downloadAudit("gone.txt", 15)]);
      },
      onceBeforeDownloadSend((root) => unlinkSync(join(root, "gone.txt"))),
    );
  });
});

describe("attachmentDisposition", () => {
  const cases: Array<[label: string, name: string, fallback: string, encoded: string]> = [
    ["plain", "readme.md", "readme.md", "readme.md"],
    ["chinese", "报告.txt", "__.txt", "%E6%8A%A5%E5%91%8A.txt"],
    ["space", "a b.txt", "a b.txt", "a%20b.txt"],
    ["quote", 'a"b.txt', "a_b.txt", "a%22b.txt"],
    ["backslash", "a\\b.txt", "a_b.txt", "a%5Cb.txt"],
    ["controls", "a\nb\x7f\tc\x00.txt", "a_b__c_.txt", "a%0Ab%7F%09c%00.txt"],
    ["latin-1", "café.txt", "caf_.txt", "caf%C3%A9.txt"],
    ["emoji is one code point", "😀.png", "_.png", "%F0%9F%98%80.png"],
    ["not attr-char", "a'(b)*.txt", "a'(b)*.txt", "a%27%28b%29%2A.txt"],
    ["attr-char", "!#$&+-.^_`|~", "!#$&+-.^_`|~", "!#$&+-.^_`|~"],
    ["delimiters", "50%;a=b,c.txt", "50%;a=b,c.txt", "50%25%3Ba%3Db%2Cc.txt"],
    ["lone surrogate", "a\ud800b", "a_b", "a%EF%BF%BDb"],
    [
      CHINESE_NAME,
      CHINESE_NAME,
      "__ ___v2_.pdf",
      "%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A%22v2%22.pdf",
    ],
  ];

  it.each(cases)("%s", (_label, name, fallback, encoded) => {
    expect(attachmentDisposition(name)).toBe(
      `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    );
  });
});
