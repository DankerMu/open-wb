import { execFileSync } from "node:child_process";
import fs, { lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
// Imported for its `afterEach`: it restores the `fs` spies and removes the temporary directories.
import "./workspace-file-helpers.js";
import {
  auditCount,
  auditRows,
  contentOf,
  denyAuditInserts,
  expectEnvelope,
  insertWorkspace,
  SANDBOX_DENIED_ENVELOPE,
  seedWorkspace,
  FILES_WORKSPACE as WORKSPACE,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const MISSING_WORKSPACE = "b".repeat(32);
const ROOTLESS_WORKSPACE = "c".repeat(32);
const TEMPORARY_WORKSPACE = "d".repeat(32);
// Literals on purpose: they come from the spec (http-service-skeleton, file-operations「重命名与移动」).
const CONFLICT_ENVELOPE = { error: { code: "conflict", message: "同名资源已存在" } };
const BODY_LIMIT = 16 * 1024;
const JSON_TYPE = "application/json";

type Raw = { payload: string; contentType?: string };

function moveRaw(app: FastifyInstance, cookie: string, raw: Raw, id = WORKSPACE) {
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${id}/move`,
    headers: {
      ...(cookie === "" ? {} : { cookie }),
      ...(raw.contentType === "" ? {} : { "content-type": raw.contentType ?? JSON_TYPE }),
    },
    payload: raw.payload,
  });
}

function move(app: FastifyInstance, cookie: string, body: unknown, id = WORKSPACE) {
  return moveRaw(app, cookie, { payload: JSON.stringify(body) }, id);
}

/** A well-formed `{from,to}` body padded with trailing spaces to exactly `bytes` bytes. */
function paddedMove(from: string, to: string, bytes: number): string {
  const json = JSON.stringify({ from, to });
  return json + " ".repeat(bytes - Buffer.byteLength(json));
}

function moveAudit(title: string, from: string, to: string, type: "file" | "dir") {
  return { actor_id: "u1", workspace_id: WORKSPACE, title, detail: { from, to, type } };
}

function rejection(relPath: string, reason: string) {
  return {
    actor_id: "u1",
    workspace_id: WORKSPACE,
    title: "越界访问被沙箱拦截",
    detail: { relPath, op: "move", reason },
  };
}

const NOT_INSIDE = "path is not inside the sandbox root";
const INVALID_NAME = "mkdir name is invalid";

describe("workspace move: 重命名与移动", () => {
  it("renames a file, moves it and moves a directory, auditing each after its rename", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "a-content");
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "x.md"), "x-content");
      mkdirSync(join(root, "out"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const inodes = ["a.md", "docs"].map((name) => lstatSync(join(root, name)).ino);

      const steps: Array<[from: string, to: string]> = [
        ["a.md", "b.md"],
        ["b.md", "out/b.md"],
        ["docs", "out/docs"],
      ];
      for (const [from, to] of steps) {
        const response = await move(app, cookie, { from, to });
        expectEnvelope(response, 200, { path: to }, `${from} -> ${to}`);
      }

      expect(contentOf(root)).toEqual({
        "out/": "dir",
        "out/b.md": "file:a-content",
        "out/docs/": "dir",
        "out/docs/x.md": "file:x-content",
      });
      // Renamed, not copied: each is the inode it was.
      expect(["out/b.md", "out/docs"].map((name) => lstatSync(join(root, name)).ino)).toEqual(
        inodes,
      );
      expect(auditRows(db, "file.move")).toEqual([
        moveAudit("重命名 a.md → b.md", "a.md", "b.md", "file"),
        moveAudit("移动 b.md → out/b.md", "b.md", "out/b.md", "file"),
        moveAudit("移动 docs → out/docs", "docs", "out/docs", "dir"),
      ]);
      expect(auditCount(db)).toEqual({ count: 3 });
    });
  });

  it("decides the title on the resolved parents and answers and audits the strings as sent", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "a-content");
      mkdirSync(join(root, "out"));
      writeFileSync(join(root, "out", "b.md"), "b-content");
      // No name rule beyond the sandbox's: a top-level `uploads` moves, a dot name is a target.
      mkdirSync(join(root, "uploads"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const steps: Array<[from: string, to: string, title: string, type: "file" | "dir"]> = [
        ["a.md", "./c.md", "重命名 a.md → c.md", "file"],
        ["out/b.md", "./out//d.md", "重命名 out/b.md → d.md", "file"],
        ["./c.md", "out/./c.md", "移动 ./c.md → out/./c.md", "file"],
        ["uploads", ".hidden", "重命名 uploads → .hidden", "dir"],
      ];
      for (const [from, to] of steps) {
        expectEnvelope(await move(app, cookie, { from, to }), 200, { path: to }, from);
      }

      expect(contentOf(root)).toEqual({
        ".hidden/": "dir",
        "out/": "dir",
        "out/c.md": "file:a-content",
        "out/d.md": "file:b-content",
      });
      expect(auditRows(db, "file.move")).toEqual(
        steps.map(([from, to, title, type]) => moveAudit(title, from, to, type)),
      );
    });
  });

  it("moves inside a temporary workspace like inside any other", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const dir = `tmp-${TEMPORARY_WORKSPACE}`;
      const root = join(sandboxRoot, "u1", dir);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "a.md"), "temporary");
      db.prepare(
        "INSERT INTO workspaces(id, owner_id, name, dir, created_at, temporary) VALUES (?, ?, ?, ?, ?, 1)",
      ).run(TEMPORARY_WORKSPACE, "u1", dir, dir, 1);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const response = await move(app, cookie, { from: "a.md", to: "b.md" }, TEMPORARY_WORKSPACE);

      expectEnvelope(response, 200, { path: "b.md" });
      expect(contentOf(root)).toEqual({ "b.md": "file:temporary" });
      expect(auditRows(db, "file.move")).toEqual([
        {
          ...moveAudit("重命名 a.md → b.md", "a.md", "b.md", "file"),
          workspace_id: TEMPORARY_WORKSPACE,
        },
      ]);
    });
  });
});

describe("workspace move: 同名拒绝", () => {
  it("answers 409 for every existing target and overwrites, merges and audits nothing", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "a-content");
      writeFileSync(join(root, "b.md"), "b-content");
      mkdirSync(join(root, "d1"));
      writeFileSync(join(root, "d1", "in1.md"), "in-d1");
      // Empty on purpose: a bare `rename` of a directory onto an empty one succeeds.
      mkdirSync(join(root, "d2"));
      execFileSync("mkfifo", [join(root, "pipe.bin")]);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const before = contentOf(root);

      const pairs: Array<[from: string, to: string]> = [
        ["a.md", "b.md"],
        ["d1", "d2"],
        ["a.md", "d2"],
        ["a.md", "a.md"],
        // Beyond the scenario: the same path spelled differently, and a target of any other type.
        ["a.md", "./a.md"],
        ["d1", "d1"],
        ["a.md", "pipe.bin"],
      ];
      for (const [from, to] of pairs) {
        const response = await move(app, cookie, { from, to });
        expectEnvelope(response, 409, CONFLICT_ENVELOPE, `${from} -> ${to}`);
        expect(contentOf(root), `${from} -> ${to}`).toEqual(before);
      }

      expect(before).toEqual({
        "a.md": "file:a-content",
        "b.md": "file:b-content",
        "d1/": "dir",
        "d1/in1.md": "file:in-d1",
        "d2/": "dir",
        "pipe.bin": "special",
      });
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });
});

describe("workspace move: 其它拒绝", () => {
  it("refuses each case with its own status, one sandbox.reject per denial and no change", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "a-content");
      mkdirSync(join(root, "d1"));
      execFileSync("mkfifo", [join(root, "pipe.bin")]);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator: the role opens no other owner's workspace.
      const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const before = contentOf(join(sandboxRoot, "u1"));
      const cases: Array<[body: unknown, status: number, envelope: object, cookie?: string]> = [
        [{ from: "missing", to: "x" }, 404, NOT_FOUND_ENVELOPE],
        [{ from: "a.md", to: "nodir/a.md" }, 404, NOT_FOUND_ENVELOPE],
        [{ from: "d1", to: "d1/sub/d1" }, 400, BAD_REQUEST_ENVELOPE],
        [{ from: "", to: "x" }, 403, SANDBOX_DENIED_ENVELOPE],
        [{ from: "a.md", to: "" }, 403, SANDBOX_DENIED_ENVELOPE],
        [{ from: "a.md", to: "../a.md" }, 403, SANDBOX_DENIED_ENVELOPE],
        [{ from: "a.md", to: "x/" }, 403, SANDBOX_DENIED_ENVELOPE],
        // Both ends are resolved before the source is looked up: a missing source is still 403.
        [{ from: "missing", to: "../x" }, 403, SANDBOX_DENIED_ENVELOPE],
        [{ from: "a.md" }, 400, BAD_REQUEST_ENVELOPE],
        [{ from: "a.md", to: "b", extra: 1 }, 400, BAD_REQUEST_ENVELOPE],
        [{ from: 1, to: "b" }, 400, BAD_REQUEST_ENVELOPE],
        [{ from: "a.md", to: "b.md" }, 404, NOT_FOUND_ENVELOPE, adminCookie],
        // Beyond the scenario. The body shape is judged before the sandbox: no audit row for these.
        [{ from: "../a.md", to: 1 }, 400, BAD_REQUEST_ENVELOPE],
        [{ from: "a.md", dest: "b.md" }, 400, BAD_REQUEST_ENVELOPE],
        [{ to: "b.md" }, 400, BAD_REQUEST_ENVELOPE],
        [{ from: "a.md", to: null }, 400, BAD_REQUEST_ENVELOPE],
        [["a.md", "b.md"], 400, BAD_REQUEST_ENVELOPE],
        [null, 400, BAD_REQUEST_ENVELOPE],
        ["a.md", 400, BAD_REQUEST_ENVELOPE],
        // A source that is neither a file nor a directory, and a parent that is a file.
        [{ from: "pipe.bin", to: "pipe2.bin" }, 404, NOT_FOUND_ENVELOPE],
        [{ from: "d1", to: "a.md/d1" }, 404, NOT_FOUND_ENVELOPE],
        // The source is judged before the target: 404, not the 409 of an existing target.
        [{ from: "missing", to: "a.md" }, 404, NOT_FOUND_ENVELOPE],
        [{ from: "pipe.bin", to: "a.md" }, 404, NOT_FOUND_ENVELOPE],
        [{ from: "a.md", to: "b.md" }, 401, UNAUTHORIZED_ENVELOPE, ""],
      ];

      for (const [body, status, envelope, caseCookie] of cases) {
        const label = JSON.stringify(body);
        const response = await move(app, caseCookie ?? cookie, body);
        expectEnvelope(response, status, envelope, label);
        expect(contentOf(join(sandboxRoot, "u1")), label).toEqual(before);
      }

      expect(auditRows(db, "sandbox.reject")).toEqual([
        rejection("", INVALID_NAME),
        rejection("", INVALID_NAME),
        rejection("../a.md", NOT_INSIDE),
        rejection("x/", INVALID_NAME),
        rejection("../x", NOT_INSIDE),
      ]);
      expect(auditCount(db)).toEqual({ count: 5 });
    });
  });

  it("answers the same 404 for another owner's, an unknown and a rootless id whatever the body is", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      writeFileSync(join(seedWorkspace(fixture), "a.md"), "owner-only");
      // Owned, but its directory is gone: not a sandbox rejection either.
      insertWorkspace(db, ROOTLESS_WORKSPACE, "u1", "rootless", "rootless", 2);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator, zhaoliu an ordinary member: neither owns the workspace.
      const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const memberCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const before = contentOf(sandboxRoot);
      const callers: Array<[label: string, cookie: string, id: string]> = [
        ["foreign admin", adminCookie, WORKSPACE],
        ["foreign member", memberCookie, WORKSPACE],
        ["unknown id", cookie, MISSING_WORKSPACE],
        ["rootless id", cookie, ROOTLESS_WORKSPACE],
      ];
      const bodies: Array<[label: string, raw: Raw]> = [
        ["a legal move", { payload: JSON.stringify({ from: "a.md", to: "b.md" }) }],
        ["an escaping from", { payload: JSON.stringify({ from: "../a", to: "b.md" }) }],
        ["an escaping to", { payload: JSON.stringify({ from: "a.md", to: "../b" }) }],
        ["a wrong shape", { payload: JSON.stringify({ from: "a.md" }) }],
        ["malformed JSON", { payload: "{" }],
        ["an empty JSON body", { payload: "" }],
        ["no body at all", { payload: "", contentType: "" }],
        ["text/plain", { payload: "x", contentType: "text/plain" }],
        ["an unsupported media type", { payload: "x", contentType: "application/octet-stream" }],
        ["a body over 16 KiB", { payload: paddedMove("a.md", "b.md", BODY_LIMIT + 1) }],
      ];

      for (const [caller, callerCookie, id] of callers) {
        for (const [kind, raw] of bodies) {
          const response = await moveRaw(app, callerCookie, raw, id);
          expectEnvelope(response, 404, NOT_FOUND_ENVELOPE, `${caller}, ${kind}`);
          expect(response.payload, `${caller}, ${kind}`).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
        }
      }
      // Not signed in: 401 before the body is looked at.
      const anonymous = await moveRaw(app, "", { payload: "{" });
      expectEnvelope(anonymous, 401, UNAUTHORIZED_ENVELOPE);

      expect(auditCount(db)).toEqual({ count: 0 });
      expect(contentOf(sandboxRoot)).toEqual(before);
    });
  });
});

describe("workspace move: 子树判断先于存在性", () => {
  it("answers 400 for a target inside the source before any existence check, and renames d1 to d10", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(root, "d1", "sub"), { recursive: true });
      writeFileSync(join(root, "d1", "sub", "deep.md"), "deep");
      writeFileSync(join(root, "a.md"), "a-content");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const before = contentOf(root);

      const inside: Array<[from: string, to: string]> = [
        ["d1", "d1/sub/d1"],
        ["d1", "d1/nodir/x"],
        // An existing target inside the source: 400, not the 409 of an existing target.
        ["d1", "d1/sub"],
        ["missing", "missing/x"],
        // Beyond the scenario: a file as the source, and the comparison on the resolved paths.
        ["a.md", "a.md/x"],
        ["./d1", "d1//sub/./x"],
      ];
      for (const [from, to] of inside) {
        const response = await move(app, cookie, { from, to });
        expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE, `${from} -> ${to}`);
        expect(contentOf(root), `${from} -> ${to}`).toEqual(before);
      }
      expect(auditCount(db)).toEqual({ count: 0 });

      // Only a name that starts with `d1`: not inside it.
      const renamed = await move(app, cookie, { from: "d1", to: "d10" });
      expectEnvelope(renamed, 200, { path: "d10" });
      expect(contentOf(root)).toEqual({
        "a.md": "file:a-content",
        "d10/": "dir",
        "d10/sub/": "dir",
        "d10/sub/deep.md": "file:deep",
      });
      expect(auditRows(db, "file.move")).toEqual([
        moveAudit("重命名 d1 → d10", "d1", "d10", "dir"),
      ]);
      expect(auditCount(db)).toEqual({ count: 1 });
    });
  });
});

describe("workspace move: 不能经符号链接移出", () => {
  it("denies either end through or at a symlink, audits each once and moves nothing", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "a-content");
      // Outside the workspace, inside the owner's root: what the links point at.
      const outside = join(sandboxRoot, "u1", "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "x.md"), "outside-content");
      symlinkSync(outside, join(root, "link"));
      symlinkSync(join(root, "nowhere"), join(root, "dangling"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const before = contentOf(join(sandboxRoot, "u1"));

      const denied: Array<[from: string, to: string, relPath: string, reason?: string]> = [
        ["a.md", "link/a.md", "link/a.md"],
        ["link", "renamed", "link"],
        // Beyond the scenario: out of the outside directory, onto a link, and both ends escaping.
        ["link/x.md", "x.md", "link/x.md"],
        ["a.md", "link", "link"],
        ["a.md", "dangling", "dangling"],
        ["../a", "../b", "../a"],
        ["a.md", "../outside/a.md", "../outside/a.md"],
        ["../outside/x.md", "x.md", "../outside/x.md"],
      ];
      for (const [from, to] of denied) {
        const response = await move(app, cookie, { from, to });
        expectEnvelope(response, 403, SANDBOX_DENIED_ENVELOPE, `${from} -> ${to}`);
        expect(contentOf(join(sandboxRoot, "u1")), `${from} -> ${to}`).toEqual(before);
      }

      expect(before).toEqual({
        "files/": "dir",
        "files/a.md": "file:a-content",
        "files/dangling": `link:${join(root, "nowhere")}`,
        "files/link": `link:${outside}`,
        "outside/": "dir",
        "outside/x.md": "file:outside-content",
      });
      // One row per request, for the end that was refused first: `from` before `to`.
      expect(auditRows(db, "sandbox.reject")).toEqual(
        denied.map(([, , relPath]) => rejection(relPath, NOT_INSIDE)),
      );
      expect(auditCount(db)).toEqual({ count: denied.length });
    });
  });
});

describe("workspace move: 改名失败", () => {
  it.each(["EACCES", "EXDEV"])(
    "answers a generic 500 on %s with the source in place, no target and no file.move row",
    async (code) => {
      await withWorkspacesApp(async (fixture) => {
        const { app, db, sandboxRoot } = fixture;
        const root = seedWorkspace(fixture);
        writeFileSync(join(root, "a.md"), "must-stay");
        mkdirSync(join(root, "out"));
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
        const before = contentOf(root);
        const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
          throw Object.assign(new Error(`${code}: refused, rename`), { code });
        });
        syncBuiltinESMExports();

        const response = await move(app, cookie, { from: "a.md", to: "out/a.md" });

        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.payload).not.toContain(code);
        expect(response.payload).not.toContain(sandboxRoot);
        // One rename, by the two resolved paths, and nothing in its place afterwards.
        expect(rename.mock.calls).toEqual([[join(root, "a.md"), join(root, "out", "a.md")]]);
        expect(contentOf(root)).toEqual(before);
        expect(before).toEqual({ "a.md": "file:must-stay", "out/": "dir" });
        expect(auditCount(db)).toEqual({ count: 0 });
      });
    },
  );
});

describe("workspace move: audit failure and the request body", () => {
  it("answers 500 with the entry already at its target when the audit cannot be written", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "moved-unaudited");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      denyAuditInserts(db);
      try {
        const response = await move(app, cookie, { from: "a.md", to: "b.md" });

        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.payload).not.toContain("audit_events");
      } finally {
        db.setAuthorizer(null);
      }

      expect(contentOf(root)).toEqual({ "b.md": "file:moved-unaudited" });
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });

  it.each([
    ["malformed JSON", { payload: "{" }],
    ["an empty JSON body", { payload: "" }],
    [
      "text/plain",
      { payload: JSON.stringify({ from: "a.md", to: "b.md" }), contentType: "text/plain" },
    ],
    ["an unsupported media type", { payload: "binary", contentType: "application/octet-stream" }],
    ["no body at all", { payload: "", contentType: "" }],
    ["a well-formed body over 16 KiB", { payload: paddedMove("a.md", "b.md", BODY_LIMIT + 1) }],
  ] as ReadonlyArray<[string, Raw]>)(
    "answers an exact 400 for %s on the owner's workspace and moves nothing",
    async (_label, raw) => {
      await withWorkspacesApp(async (fixture) => {
        const { app, db } = fixture;
        const root = seedWorkspace(fixture);
        writeFileSync(join(root, "a.md"), "must-stay");
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        const response = await moveRaw(app, cookie, raw);

        expectEnvelope(response, 400, BAD_REQUEST_ENVELOPE);
        expect(response.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
        expect(contentOf(root)).toEqual({ "a.md": "file:must-stay" });
        expect(auditCount(db)).toEqual({ count: 0 });
      });
    },
  );

  it("accepts a well-formed body of exactly 16 KiB", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "a.md"), "at-limit");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const payload = paddedMove("a.md", "b.md", BODY_LIMIT);
      expect(Buffer.byteLength(payload)).toBe(16384);

      const response = await moveRaw(app, cookie, {
        payload,
        contentType: "application/json; charset=utf-8",
      });

      expectEnvelope(response, 200, { path: "b.md" });
      expect(contentOf(root)).toEqual({ "b.md": "file:at-limit" });
      expect(auditRows(db, "file.move")).toEqual([
        moveAudit("重命名 a.md → b.md", "a.md", "b.md", "file"),
      ]);
    });
  });
});
