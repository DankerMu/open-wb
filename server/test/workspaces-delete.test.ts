import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrash } from "../src/workspaces/trash.js";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  type InjectResponse,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  auditRows,
  insertWorkspace,
  SANDBOX_DENIED_ENVELOPE,
  seedWorkspace,
  FILES_WORKSPACE as WORKSPACE,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const MISSING_WORKSPACE = "b".repeat(32);
const ROOTLESS_WORKSPACE = "c".repeat(32);
const OTHER_WORKSPACE = "d".repeat(32);
// Literals on purpose: the batch-name shape and the mode come from the spec
// (file-operations「删除到回收目录」), not from the module under test.
const BATCH_NAME = /^\d+-[0-9a-f]{16}$/u;
const PRIVATE_MODE = 0o700;
const JSON_TYPE = "application/json";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

function entriesUrl(id: string, path: string): string {
  return `/api/workspaces/${id}/entries?path=${encodeURIComponent(path)}`;
}

function remove(
  app: FastifyInstance,
  cookie: string,
  path: string,
  id = WORKSPACE,
  body?: { headers: Record<string, string>; payload: string },
) {
  return app.inject({
    method: "DELETE",
    url: entriesUrl(id, path),
    headers: { cookie, ...body?.headers },
    ...(body === undefined ? {} : { payload: body.payload }),
  });
}

/** 204 has no body: `expectWorkspaceResponse` would parse one. */
function expectDeleted(response: InjectResponse): void {
  expect(response.statusCode).toBe(204);
  expect(response.payload).toBe("");
  expect(response.headers["cache-control"]).toBe("no-store");
}

function expectEnvelope(response: InjectResponse, status: number, body: object, label = ""): void {
  expect(response.statusCode, label).toBe(status);
  expect(response.json(), label).toEqual(body);
  expect(response.headers["cache-control"], label).toBe("no-store");
}

function trashOf(sandboxRoot: string, id = WORKSPACE): string {
  return join(sandboxRoot, ".trash", "u1", id);
}

function batchesOf(sandboxRoot: string, id = WORKSPACE): string[] {
  return readdirSync(trashOf(sandboxRoot, id)).sort();
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

/** Every entry below `dir` by relative path: a file's content, a link's target, or its kind. */
function contentOf(dir: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      found[`${prefix}${name}`] = `link:${readlinkSync(path)}`;
    } else if (status.isDirectory()) {
      found[`${prefix}${name}/`] = "dir";
      Object.assign(found, contentOf(path, `${prefix}${name}/`));
    } else {
      found[`${prefix}${name}`] = status.isFile()
        ? `file:${readFileSync(path, "utf8")}`
        : "special";
    }
  }
  return found;
}

function auditCount(db: DatabaseSync): unknown {
  return db.prepare("SELECT count(*) AS count FROM audit_events").get();
}

function deleteAudit(path: string, type: "file" | "dir", trashId: string | undefined) {
  return {
    actor_id: "u1",
    workspace_id: WORKSPACE,
    title: `删除 ${path}`,
    detail: { path, type, trashId },
  };
}

function denyAuditInserts(db: DatabaseSync): void {
  db.setAuthorizer((actionCode, table) =>
    actionCode === constants.SQLITE_INSERT && table === "audit_events"
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
}

function tree(app: FastifyInstance, cookie: string, id: string, path: string) {
  return app.inject({
    method: "GET",
    url: `/api/workspaces/${id}/tree?path=${encodeURIComponent(path)}`,
    headers: { cookie },
  });
}

describe("workspace delete: 删除文件与目录", () => {
  it("moves a file and a directory into one private batch each and audits both", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "# notes\n");
      mkdirSync(join(root, "out", "sub"), { recursive: true });
      writeFileSync(join(root, "out", "a.md"), "a-content");
      writeFileSync(join(root, "out", "sub", "deep.txt"), "deep-content");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const inodes = ["notes.md", "out"].map((name) => lstatSync(join(root, name)).ino);

      const before = Date.now();
      expectDeleted(await remove(app, cookie, "notes.md"));
      expectDeleted(await remove(app, cookie, "out"));
      const after = Date.now();

      expect(contentOf(root)).toEqual({});
      const batches = batchesOf(sandboxRoot);
      expect(batches).toHaveLength(2);
      for (const batch of batches) {
        expect(batch).toMatch(BATCH_NAME);
        const stamp = Number(batch.split("-")[0]);
        expect(stamp).toBeGreaterThanOrEqual(before);
        expect(stamp).toBeLessThanOrEqual(after);
      }
      const holding = (name: string) =>
        batches.find((batch) => existsSync(join(trashOf(sandboxRoot), batch, name)));
      const notesBatch = holding("notes.md");
      const outBatch = holding("out");
      expect(notesBatch).not.toBe(outBatch);
      expect(contentOf(join(trashOf(sandboxRoot), String(notesBatch)))).toEqual({
        "notes.md": "file:# notes\n",
      });
      expect(contentOf(join(trashOf(sandboxRoot), String(outBatch)))).toEqual({
        "out/": "dir",
        "out/a.md": "file:a-content",
        "out/sub/": "dir",
        "out/sub/deep.txt": "file:deep-content",
      });
      // Renamed, not copied: each is the inode it was.
      expect([
        lstatSync(join(trashOf(sandboxRoot), String(notesBatch), "notes.md")).ino,
        lstatSync(join(trashOf(sandboxRoot), String(outBatch), "out")).ino,
      ]).toEqual(inodes);

      const levels = [
        join(sandboxRoot, ".trash"),
        join(sandboxRoot, ".trash", "u1"),
        trashOf(sandboxRoot),
        ...batches.map((batch) => join(trashOf(sandboxRoot), batch)),
      ];
      for (const level of levels) {
        expect(lstatSync(level).isDirectory(), level).toBe(true);
        expect(modeOf(level), level).toBe(PRIVATE_MODE);
      }
      // Nothing but the owner directory beside the account roots, nothing but this workspace in it.
      expect(readdirSync(join(sandboxRoot, ".trash"))).toEqual(["u1"]);
      expect(readdirSync(join(sandboxRoot, ".trash", "u1"))).toEqual([WORKSPACE]);

      expect(auditRows(db, "file.delete")).toEqual([
        deleteAudit("notes.md", "file", notesBatch),
        deleteAudit("out", "dir", outBatch),
      ]);
      expect(auditCount(db)).toEqual({ count: 2 });
    });
  });

  it("names the trashed entry after the resolved entry and audits the path as it was sent", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "b.md"), "nested");
      // Ordinary entries, whatever their names: a top-level `uploads`, a `.trash` of the workspace.
      mkdirSync(join(root, "uploads"));
      writeFileSync(join(root, "uploads", "u.bin"), "uploaded");
      mkdirSync(join(root, ".trash"));
      writeFileSync(join(root, ".trash", "mine.txt"), "not-the-recycle-directory");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const sent = ["./docs//b.md", "uploads", ".trash"];
      for (const path of sent) {
        expectDeleted(await remove(app, cookie, path));
      }

      expect(contentOf(root)).toEqual({ "docs/": "dir" });
      const rows = auditRows(db, "file.delete");
      expect(rows.map((row) => [row.detail.path, row.detail.type])).toEqual([
        ["./docs//b.md", "file"],
        ["uploads", "dir"],
        [".trash", "dir"],
      ]);
      expect(rows).toMatchObject(sent.map((path) => ({ title: `删除 ${path}` })));
      const trashed = rows.map((row) =>
        contentOf(join(trashOf(sandboxRoot), String(row.detail.trashId))),
      );
      expect(trashed).toEqual([
        { "b.md": "file:nested" },
        { "uploads/": "dir", "uploads/u.bin": "file:uploaded" },
        { ".trash/": "dir", ".trash/mine.txt": "file:not-the-recycle-directory" },
      ]);
    });
  });
});

describe("workspace delete: 同名先后删除互不覆盖", () => {
  it("keeps both contents in two batches, even within one millisecond", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // One instant for both deletions: only the random part of the name tells the batches apart.
      const instant = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(instant);

      writeFileSync(join(root, "a.txt"), "first");
      expectDeleted(await remove(app, cookie, "a.txt"));
      writeFileSync(join(root, "a.txt"), "second");
      expectDeleted(await remove(app, cookie, "a.txt"));

      const batches = batchesOf(sandboxRoot);
      expect(batches).toHaveLength(2);
      expect(batches.every((batch) => batch.startsWith(`${instant}-`))).toBe(true);
      const ids = auditRows(db, "file.delete").map((row) => String(row.detail.trashId));
      expect([...ids].sort()).toEqual(batches);
      expect(ids.map((id) => contentOf(join(trashOf(sandboxRoot), id)))).toEqual([
        { "a.txt": "file:first" },
        { "a.txt": "file:second" },
      ]);
      expect(existsSync(join(root, "a.txt"))).toBe(false);
    });
  });
});

describe("workspace delete: 拒绝项", () => {
  it("refuses the nine cases in order, changes nothing and creates no recycle directory", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "owner-only");
      mkdirSync(join(root, "a"));
      writeFileSync(join(root, "a", "inner.md"), "inner");
      symlinkSync(join(root, "notes.md"), join(root, "link"));
      writeFileSync(join(sandboxRoot, "u1", "x"), "outside-the-workspace");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator: the role opens no other owner's workspace.
      const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const base = `/api/workspaces/${WORKSPACE}/entries`;
      const before = contentOf(join(sandboxRoot, "u1"));
      const cases: Array<
        [label: string, url: string, cookie: string, status: number, body: object]
      > = [
        ["empty path", `${base}?path=`, cookie, 403, SANDBOX_DENIED_ENVELOPE],
        ["traversal", `${base}?path=..%2Fx`, cookie, 403, SANDBOX_DENIED_ENVELOPE],
        ["dot-dot last", `${base}?path=a%2F..`, cookie, 403, SANDBOX_DENIED_ENVELOPE],
        ["symlink", `${base}?path=link`, cookie, 403, SANDBOX_DENIED_ENVELOPE],
        ["missing", `${base}?path=missing.md`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["no path", base, cookie, 400, BAD_REQUEST_ENVELOPE],
        ["path twice", `${base}?path=notes.md&path=notes.md`, cookie, 400, BAD_REQUEST_ENVELOPE],
        ["foreign admin", `${base}?path=notes.md`, adminCookie, 404, NOT_FOUND_ENVELOPE],
        ["anonymous", `${base}?path=notes.md`, "", 401, UNAUTHORIZED_ENVELOPE],
      ];

      for (const [label, url, caseCookie, status, body] of cases) {
        const response = await app.inject({
          method: "DELETE",
          url,
          headers: caseCookie === "" ? {} : { cookie: caseCookie },
        });
        expectEnvelope(response, status, body, label);
        expect(contentOf(join(sandboxRoot, "u1")), label).toEqual(before);
        expect(existsSync(join(sandboxRoot, ".trash")), label).toBe(false);
      }

      expect(auditRows(db, "sandbox.reject")).toEqual(
        [
          ["", "mkdir name is invalid"],
          ["../x", "path is not inside the sandbox root"],
          ["a/..", "mkdir name is invalid"],
          ["link", "path is not inside the sandbox root"],
        ].map(([relPath, reason]) => ({
          actor_id: "u1",
          workspace_id: WORKSPACE,
          title: "越界访问被沙箱拦截",
          detail: { relPath, op: "delete", reason },
        })),
      );
      expect(auditCount(db)).toEqual({ count: 4 });
    });
  });

  it("answers the same 404 for another owner's, an unknown and a rootless id before any path check", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      writeFileSync(join(seedWorkspace(fixture), "notes.md"), "owner-only");
      writeFileSync(join(sandboxRoot, "u1", "x"), "outside-the-workspace");
      // Owned, but its directory is gone: not a sandbox rejection either.
      insertWorkspace(db, ROOTLESS_WORKSPACE, "u1", "rootless", "rootless", 2);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator, zhaoliu an ordinary member: neither owns the workspace.
      const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const memberCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const before = contentOf(join(sandboxRoot, "u1"));

      const responses = [
        await remove(app, adminCookie, "notes.md"),
        await remove(app, memberCookie, "notes.md"),
        await remove(app, adminCookie, "../x"),
        await remove(app, memberCookie, "../x"),
        await remove(app, cookie, "notes.md", MISSING_WORKSPACE),
        await remove(app, cookie, "../x", MISSING_WORKSPACE),
        await remove(app, cookie, "notes.md", ROOTLESS_WORKSPACE),
        await remove(app, cookie, "../x", ROOTLESS_WORKSPACE),
        // Same answer whatever the query is: ownership is judged before the query.
        await app.inject({
          method: "DELETE",
          url: `/api/workspaces/${WORKSPACE}/entries`,
          headers: { cookie: adminCookie },
        }),
      ];

      for (const response of responses) {
        expectEnvelope(response, 404, NOT_FOUND_ENVELOPE);
        expect(response.payload).toBe(responses[0]?.payload);
      }
      expect(auditCount(db)).toEqual({ count: 0 });
      expect(contentOf(join(sandboxRoot, "u1"))).toEqual(before);
      expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
    });
  });

  it("answers 404 for a named pipe and leaves it where it is", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      execFileSync("mkfifo", [join(root, "pipe.bin")]);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const response = await remove(app, cookie, "pipe.bin");

      expectEnvelope(response, 404, NOT_FOUND_ENVELOPE);
      expect(lstatSync(join(root, "pipe.bin")).isFIFO()).toBe(true);
      expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });
});

describe("workspace delete: 改名失败不丢文件", () => {
  it("answers 500 on EXDEV with the entry in place, no copy, no batch left and no audit row", async () => {
    let failing = false;
    const renames: Array<[from: string, to: string]> = [];
    const rename = (from: string, to: string): void => {
      renames.push([from, to]);
      if (failing) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), {
          code: "EXDEV",
        });
      }
      renameSync(from, to);
    };
    await withWorkspacesApp(
      async (fixture) => {
        const { app, db, sandboxRoot } = fixture;
        const root = seedWorkspace(fixture);
        writeFileSync(join(root, "earlier.md"), "deleted-before-the-failure");
        writeFileSync(join(root, "notes.md"), "must-stay");
        mkdirSync(join(root, "out"));
        writeFileSync(join(root, "out", "a.md"), "must-stay-too");
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        // A batch that is already there must survive the cleanup of the failed ones.
        expectDeleted(await remove(app, cookie, "earlier.md"));
        const [earlier] = batchesOf(sandboxRoot);
        const before = contentOf(root);
        failing = true;

        for (const path of ["notes.md", "out"]) {
          const response = await remove(app, cookie, path);
          expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE, path);
          expect(response.payload, path).not.toContain("EXDEV");
          expect(response.payload, path).not.toContain(sandboxRoot);
        }

        expect(contentOf(root)).toEqual(before);
        expect(before).toEqual({
          "notes.md": "file:must-stay",
          "out/": "dir",
          "out/a.md": "file:must-stay-too",
        });
        expect(contentOf(trashOf(sandboxRoot))).toEqual({
          [`${earlier}/`]: "dir",
          [`${earlier}/earlier.md`]: "file:deleted-before-the-failure",
        });
        expect(auditRows(db, "file.delete")).toEqual([deleteAudit("earlier.md", "file", earlier)]);
        expect(auditCount(db)).toEqual({ count: 1 });

        // One rename per deletion, from the resolved entry to its name inside a fresh batch.
        expect(renames.map(([from]) => from)).toEqual(
          ["earlier.md", "notes.md", "out"].map((name) => join(root, name)),
        );
        for (const [index, name] of ["earlier.md", "notes.md", "out"].entries()) {
          const target = renames[index]?.[1] ?? "";
          expect(target.startsWith(`${trashOf(sandboxRoot)}/`), name).toBe(true);
          const [batch, entry, ...rest] = target.slice(trashOf(sandboxRoot).length + 1).split("/");
          expect(batch, name).toMatch(BATCH_NAME);
          expect([entry, ...rest], name).toEqual([name]);
        }
      },
      undefined,
      {
        assemblyOf: (sandboxRoot) => ({
          trash: createTrash({ sandboxRoot, retentionDays: 30, rename }),
        }),
      },
    );
  });

  it("leaves the workspace's trash directory empty when the first deletion fails", async () => {
    await withWorkspacesApp(
      async (fixture) => {
        const { app, db, sandboxRoot } = fixture;
        const root = seedWorkspace(fixture);
        writeFileSync(join(root, "notes.md"), "must-stay");
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        const response = await remove(app, cookie, "notes.md");

        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("must-stay");
        expect(readdirSync(trashOf(sandboxRoot))).toEqual([]);
        expect(auditCount(db)).toEqual({ count: 0 });
      },
      undefined,
      {
        assemblyOf: (sandboxRoot) => ({
          trash: createTrash({
            sandboxRoot,
            retentionDays: 30,
            rename: () => {
              throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
            },
          }),
        }),
      },
    );
  });
});

describe("workspace delete: 回收目录被预先占位", () => {
  const occupied: Array<[label: string, occupy: (sandboxRoot: string, elsewhere: string) => void]> =
    [
      [
        "`.trash` is a symlink",
        (sandboxRoot, elsewhere) => {
          symlinkSync(elsewhere, join(sandboxRoot, ".trash"));
        },
      ],
      [
        "`.trash` is a file",
        (sandboxRoot) => {
          writeFileSync(join(sandboxRoot, ".trash"), "occupied");
        },
      ],
      [
        "the owner level is a symlink",
        (sandboxRoot, elsewhere) => {
          mkdirSync(join(sandboxRoot, ".trash"), PRIVATE_MODE);
          symlinkSync(elsewhere, join(sandboxRoot, ".trash", "u1"));
        },
      ],
      [
        "the workspace level is a symlink",
        (sandboxRoot, elsewhere) => {
          mkdirSync(join(sandboxRoot, ".trash"), PRIVATE_MODE);
          mkdirSync(join(sandboxRoot, ".trash", "u1"), PRIVATE_MODE);
          symlinkSync(elsewhere, join(sandboxRoot, ".trash", "u1", WORKSPACE));
        },
      ],
    ];

  it.each(occupied)("answers 500 and moves nothing when %s", async (_label, occupy) => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "must-stay");
      // A private directory of this uid: only the link in front of it makes it the wrong place.
      const elsewhere = join(sandboxRoot, "elsewhere");
      mkdirSync(elsewhere, PRIVATE_MODE);
      occupy(sandboxRoot, elsewhere);
      const placed = contentOf(sandboxRoot);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const response = await remove(app, cookie, "notes.md");

      expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
      expect(response.payload).not.toContain(sandboxRoot);
      expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("must-stay");
      expect(readdirSync(elsewhere)).toEqual([]);
      // The whole sandbox root, links unfollowed: no entry appeared, moved or changed kind.
      expect(contentOf(sandboxRoot)).toEqual(placed);
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });

  it("corrects a 0777 owner directory of this uid to 0700 and then deletes", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "moved");
      mkdirSync(join(sandboxRoot, ".trash"), PRIVATE_MODE);
      // chmod, not the mkdir mode: the umask would narrow that.
      mkdirSync(join(sandboxRoot, ".trash", "u1"));
      chmodSync(join(sandboxRoot, ".trash", "u1"), 0o777);
      expect(modeOf(join(sandboxRoot, ".trash", "u1"))).toBe(0o777);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      expectDeleted(await remove(app, cookie, "notes.md"));

      expect(modeOf(join(sandboxRoot, ".trash", "u1"))).toBe(PRIVATE_MODE);
      expect(existsSync(join(root, "notes.md"))).toBe(false);
      const [batch] = batchesOf(sandboxRoot);
      expect(contentOf(trashOf(sandboxRoot))).toEqual({
        [`${batch}/`]: "dir",
        [`${batch}/notes.md`]: "file:moved",
      });
      expect(auditRows(db, "file.delete")).toEqual([deleteAudit("notes.md", "file", batch)]);
    });
  });
});

describe("workspace delete: 回收目录不可见", () => {
  it("shows no trash in any tree and reads none of it through tree or file", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "trashed-secret");
      mkdirSync(join(root, "docs", "sub"), { recursive: true });
      writeFileSync(join(root, "docs", "b.md"), "kept");
      writeFileSync(join(root, "docs", "sub", "c.md"), "trashed-secret-too");
      const other = join(sandboxRoot, "u1", "other");
      mkdirSync(join(other, "keep"), { recursive: true });
      writeFileSync(join(other, "o.md"), "other");
      insertWorkspace(db, OTHER_WORKSPACE, "u1", "other", "other", 2);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      expectDeleted(await remove(app, cookie, "notes.md"));
      expectDeleted(await remove(app, cookie, "docs/sub"));
      const batches = batchesOf(sandboxRoot);
      expect(batches).toHaveLength(2);

      const levels: Array<[id: string, path: string, names: string[]]> = [
        [WORKSPACE, "", ["docs"]],
        [WORKSPACE, "docs", ["b.md"]],
        [OTHER_WORKSPACE, "", ["keep", "o.md"]],
        [OTHER_WORKSPACE, "keep", []],
      ];
      for (const [id, path, names] of levels) {
        const response = await tree(app, cookie, id, path);
        expect(response.statusCode, `${id} ${path}`).toBe(200);
        const body = response.json() as { entries: Array<{ name: string }> };
        expect(body.entries.map((entry) => entry.name)).toEqual(names);
        expect(response.payload).not.toContain(".trash");
        expect(batches.filter((batch) => response.payload.includes(batch))).toEqual([]);
      }

      const notesBatch = batches.find((batch) =>
        existsSync(join(trashOf(sandboxRoot), batch, "notes.md")),
      );
      const probes: Array<[path: string, status: number, body: object]> = [
        [".trash", 404, NOT_FOUND_ENVELOPE],
        ["../.trash", 403, SANDBOX_DENIED_ENVELOPE],
        ["../../.trash", 403, SANDBOX_DENIED_ENVELOPE],
        [`../../.trash/u1/${WORKSPACE}/${notesBatch}/notes.md`, 403, SANDBOX_DENIED_ENVELOPE],
      ];
      const routes = [WORKSPACE, OTHER_WORKSPACE].flatMap((id) =>
        ["tree", "file"].map((route) => `/api/workspaces/${id}/${route}`),
      );
      const requests = routes.flatMap((route) =>
        probes.map(([path, status, body]) => ({
          url: `${route}?path=${encodeURIComponent(path)}`,
          status,
          body,
        })),
      );
      expect(requests).toHaveLength(16);
      for (const { url, status, body } of requests) {
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        expectEnvelope(response, status, body, url);
        expect(response.payload, url).not.toContain("trashed-secret");
      }

      // Nor can the delete route reach it: the recycle directory and its batches stay as they are.
      const trashed = contentOf(join(sandboxRoot, ".trash"));
      for (const [path] of probes.slice(1)) {
        const response = await remove(app, cookie, path);
        expectEnvelope(response, 403, SANDBOX_DENIED_ENVELOPE, path);
      }
      expect(contentOf(join(sandboxRoot, ".trash"))).toEqual(trashed);
      expect(auditRows(db, "file.delete")).toHaveLength(2);
    });
  });
});

describe("workspace delete: audit failure and request bodies", () => {
  it("answers 500 with the entry already in the trash when the audit cannot be written", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "trashed-unaudited");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      denyAuditInserts(db);
      try {
        const response = await remove(app, cookie, "notes.md");

        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.payload).not.toContain("audit_events");
      } finally {
        db.setAuthorizer(null);
      }

      expect(contentOf(root)).toEqual({});
      const [batch, ...rest] = batchesOf(sandboxRoot);
      expect(rest).toEqual([]);
      expect(batch).toMatch(BATCH_NAME);
      expect(contentOf(join(trashOf(sandboxRoot), String(batch)))).toEqual({
        "notes.md": "file:trashed-unaudited",
      });
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });

  it("ignores a well-formed JSON body; a malformed one is a generic 500 that moves nothing", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "notes.md"), "target");
      writeFileSync(join(root, "other.md"), "named-in-the-body-only");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const malformed = { headers: { "content-type": JSON_TYPE }, payload: "{" };

      // Not an owned-parser route: the parser fails before the handler, for any caller alike.
      for (const caller of [cookie, adminCookie]) {
        const response = await remove(app, caller, "notes.md", WORKSPACE, malformed);
        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.payload).not.toContain("FST_ERR");
      }
      expect(contentOf(root)).toEqual({
        "notes.md": "file:target",
        "other.md": "file:named-in-the-body-only",
      });
      expect(existsSync(join(sandboxRoot, ".trash"))).toBe(false);
      expect(auditCount(db)).toEqual({ count: 0 });

      const ignored = await remove(app, cookie, "notes.md", WORKSPACE, {
        headers: { "content-type": JSON_TYPE },
        payload: JSON.stringify({ path: "other.md" }),
      });
      expectDeleted(ignored);
      expect(contentOf(root)).toEqual({ "other.md": "file:named-in-the-body-only" });
      const [batch] = batchesOf(sandboxRoot);
      expect(auditRows(db, "file.delete")).toEqual([deleteAudit("notes.md", "file", batch)]);
    });
  });
});
