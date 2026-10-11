/**
 * GET /api/workspaces/:id/archive through the assembled app: the route around the listing that
 * `workspaces-archive*.test.ts` cover as a library. Every archive is built from bytes here and
 * written before anything is spied on (`writeFileSync` opens too).
 */
import { execFileSync, spawn } from "node:child_process";
import fs, {
  constants,
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { tempDir } from "./core-db-helpers.js";
// Its `afterEach` restores the spies and removes the temporary directories of this file too.
import { spyBodyIo, spyMetadataIo } from "./workspace-file-helpers.js";
import {
  emptyMembers,
  TAR_END,
  THREE_MEMBERS,
  tarFile,
  ZIP_THREE_RECORDS,
  zipArchive,
  zipCentral,
} from "./workspaces-archive-helpers.js";
import {
  auditCount,
  auditRows,
  contentOf,
  expectWorkspaceResponse,
  insertWorkspace,
  SANDBOX_DENIED_ENVELOPE,
  seedWorkspace,
  FILES_WORKSPACE as WORKSPACE,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const MISSING_WORKSPACE = "b".repeat(32);
const ROOTLESS_WORKSPACE = "c".repeat(32);
const UNSUPPORTED_ENVELOPE = {
  error: { code: "preview_unsupported", message: "该类型不支持预览" },
};
/** What the spec's first scenario lists for the zip, the tar, the tar.gz and the tgz alike. */
const THREE_ENTRIES = [
  { path: "a.txt", type: "file", size: 5 },
  { path: "dir/", type: "dir", size: 0 },
  { path: "dir/b.md", type: "file", size: 7 },
];
const THREE_ZIP = zipArchive(ZIP_THREE_RECORDS);
/** `THREE_MEMBERS` cut inside its second header: `a.txt` is listed, then the archive is damaged. */
const CUT_TAR = THREE_MEMBERS.subarray(0, 1024 + 100);
/** Cut where `a.txt` ends, on a block boundary: the next header reads as no bytes at all. */
const BLOCK_CUT_TAR = THREE_MEMBERS.subarray(0, 1024);
const DEFAULT_BYTE_LIMITS = { text: 1_048_576, image: 20_971_520, notebook: 10_485_760 };

afterEach(() => {
  vi.unstubAllEnvs();
});

function archiveUrl(id: string, path: string): string {
  return `/api/workspaces/${id}/archive?path=${encodeURIComponent(path)}`;
}

function listing(app: FastifyInstance, cookie: string, path: string, id = WORKSPACE) {
  return app.inject({ method: "GET", url: archiveUrl(id, path), headers: { cookie } });
}

/** Spies the body I/O and `closeSync`; fixtures must already be on disk. */
function spyDescriptors() {
  spyBodyIo();
  const open = vi.mocked(fs.openSync);
  const close = vi.spyOn(fs, "closeSync");
  syncBuiltinESMExports();
  const pathsOf = (spies: readonly unknown[]) =>
    spies.flatMap((spied) =>
      vi.mocked(spied as typeof fs.openSync).mock.calls.map(([path]) => path),
    );
  return {
    open,
    /** What `openSync` returned for `path`, in order. */
    descriptorsOf: (path: string) =>
      open.mock.calls.flatMap(([opened], index) => {
        const result = open.mock.results[index];
        return opened === path && result?.type === "return" ? [result.value as number] : [];
      }),
    closed: () => close.mock.calls.map(([fd]) => fd),
    /** The write bits (`O_WRONLY`, `O_RDWR`) of the flags of each `openSync` of `path`. */
    writeBitsOf: (path: string) =>
      open.mock.calls.flatMap(([opened, flags]) =>
        opened === path ? [(flags as number) & (constants.O_WRONLY | constants.O_RDWR)] : [],
      ),
    /** Reads so far, positional or not, through any descriptor at all. */
    reads: () => vi.mocked(fs.read).mock.calls.length + vi.mocked(fs.readSync).mock.calls.length,
    /** Reads, positional or not, through any of `descriptors`. */
    readsThrough: (descriptors: readonly number[]) =>
      [...vi.mocked(fs.read).mock.calls, ...vi.mocked(fs.readSync).mock.calls].filter(([fd]) =>
        descriptors.includes(fd as number),
      ).length,
    /** Every path-based open or stream below `dir`, whichever call made it. */
    opensBelow: (dir: string) =>
      pathsOf([fs.openSync, fs.open, fs.createReadStream, fs.readFileSync, fs.readFile]).filter(
        (path) => typeof path === "string" && path.startsWith(dir),
      ),
    /** Whole-file reads by path below `dir`. */
    wholeReadsBelow: (dir: string) =>
      pathsOf([fs.readFileSync, fs.readFile]).filter(
        (path) => typeof path === "string" && path.startsWith(dir),
      ),
  };
}

function restoreSpies(): void {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}

describe("archive route: the listing of each format", () => {
  it("lists a zip, a tar, a tar.gz, a tgz and a bare gz, adding no file to the sandbox or the temporary directory", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      const archives: Array<[name: string, bytes: Buffer, format: string]> = [
        ["x.zip", THREE_ZIP, "zip"],
        ["x.tar", THREE_MEMBERS, "tar"],
        ["x.tar.gz", gzipSync(THREE_MEMBERS), "tar.gz"],
        ["x.tgz", gzipSync(THREE_MEMBERS), "tar.gz"],
      ];
      for (const [name, bytes] of archives) {
        writeFileSync(join(root, name), bytes);
      }
      writeFileSync(join(root, "notes.txt.gz"), gzipSync("some notes\n"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const before = contentOf(sandboxRoot);
      // Made before TMPDIR points at it: whatever the route put into the temporary directory
      // from here on would land in this one.
      const scratch = tempDir();
      vi.stubEnv("TMPDIR", scratch);
      const io = spyDescriptors();

      // Counted per request and through any descriptor: a descriptor number is handed out again
      // once it is closed, so the number alone does not tell two archives apart.
      const readsOf: Record<string, number> = {};
      for (const [name, , format] of archives) {
        const readsBefore = io.reads();
        const response = await listing(app, cookie, name);
        readsOf[name] = io.reads() - readsBefore;
        expectWorkspaceResponse(response, 200, {
          format,
          entries: THREE_ENTRIES,
          truncated: false,
        });
        expect(response.headers["content-type"], name).toBe("application/json; charset=utf-8");
      }
      const readsBeforeGz = io.reads();
      expectWorkspaceResponse(await listing(app, cookie, "notes.txt.gz"), 200, {
        format: "gz",
        entries: [{ path: "notes.txt", type: "file", size: null }],
        truncated: false,
      });
      const gzReads = io.reads() - readsBeforeGz;

      const gzDescriptors = io.descriptorsOf(join(root, "notes.txt.gz"));
      const writeBits = [...archives.map(([name]) => name), "notes.txt.gz"].map((name) =>
        io.writeBitsOf(join(root, name)),
      );
      const wholeReads = io.wholeReadsBelow(sandboxRoot);
      const closed = io.closed();
      // The snapshot below reads every file itself: the spies come off first.
      restoreSpies();

      // The bare gz is opened and closed and nothing is read while it is listed; the other four
      // are read, which shows the counter sees the route's reads.
      expect(gzDescriptors).toHaveLength(1);
      expect(gzReads).toBe(0);
      for (const [name] of archives) {
        expect(readsOf[name], name).toBeGreaterThan(0);
      }
      // Each archive is opened once, and for reading only.
      expect(writeBits).toEqual([[0], [0], [0], [0], [0]]);
      expect(closed).toHaveLength(5);
      expect(closed.at(-1)).toBe(gzDescriptors[0]);
      // No archive is read whole by path.
      expect(wholeReads).toEqual([]);
      expect(contentOf(sandboxRoot)).toEqual(before);
      expect(readdirSync(scratch)).toEqual([]);
      // A listing is not audited.
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });

  it("takes the format and a bare gz's item from the resolved entry's name, not from the request path", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "X.TAR"), THREE_MEMBERS);
      writeFileSync(join(root, "docs", "n.txt.gz"), gzipSync("some notes\n"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      // The request ends in `.`, which the resolver skips; the name is matched in lower case.
      expectWorkspaceResponse(await listing(app, cookie, "docs/X.TAR/."), 200, {
        format: "tar",
        entries: THREE_ENTRIES,
        truncated: false,
      });
      // The item is the file's own name without `.gz`: the directory of the request is not in it.
      expectWorkspaceResponse(await listing(app, cookie, "docs/n.txt.gz"), 200, {
        format: "gz",
        entries: [{ path: "n.txt", type: "file", size: null }],
        truncated: false,
      });
    });
  });

  it("lists a tar whose reads each come back at most 100 bytes long", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app } = fixture;
      const target = join(seedWorkspace(fixture), "x.tar");
      writeFileSync(target, THREE_MEMBERS);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const realRead = fs.read;
      const io = spyDescriptors();
      const lengths: number[] = [];
      vi.mocked(fs.read).mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        callback: (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void,
      ) => {
        lengths.push(Math.min(length, 100));
        realRead(fd, buffer, offset, Math.min(length, 100), position, callback);
      }) as typeof fs.read);
      syncBuiltinESMExports();

      const response = await listing(app, cookie, "x.tar");

      expectWorkspaceResponse(response, 200, {
        format: "tar",
        entries: THREE_ENTRIES,
        truncated: false,
      });
      // The route's reads did go through the shortened call: a 512-byte header takes six.
      expect(io.descriptorsOf(target)).toHaveLength(1);
      expect(lengths.length).toBeGreaterThanOrEqual(6);
    });
  });
});

describe("archive route: the entry limit", () => {
  it("stops at three entries of five when assembled with a limit of three", async () => {
    await withWorkspacesApp(
      async (fixture) => {
        const { app } = fixture;
        writeFileSync(
          join(seedWorkspace(fixture), "x.tar"),
          Buffer.concat([...emptyMembers(5), TAR_END]),
        );
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        expectWorkspaceResponse(await listing(app, cookie, "x.tar"), 200, {
          format: "tar",
          entries: [
            { path: "m0", type: "file", size: 0 },
            { path: "m1", type: "file", size: 0 },
            { path: "m2", type: "file", size: 0 },
          ],
          truncated: true,
        });
      },
      undefined,
      { previewLimits: { ...DEFAULT_BYTE_LIMITS, archiveEntries: 3 } },
    );
  });

  it("stops at 1000 entries of 1500 when no limit is configured: tar, tar.gz and zip", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app } = fixture;
      const root = seedWorkspace(fixture);
      const tar = Buffer.concat([...emptyMembers(1500), TAR_END]);
      const names = Array.from({ length: 1500 }, (_, index) => `m${index}`);
      writeFileSync(join(root, "big.tar"), tar);
      writeFileSync(join(root, "big.tar.gz"), gzipSync(tar));
      writeFileSync(join(root, "big.zip"), zipArchive(names.map((name) => zipCentral({ name }))));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      for (const [name, format] of [
        ["big.tar", "tar"],
        ["big.tar.gz", "tar.gz"],
        ["big.zip", "zip"],
      ] as const) {
        const response = await listing(app, cookie, name);
        expect(response.statusCode, name).toBe(200);
        const body = response.json() as {
          format: string;
          entries: Array<{ path: string }>;
          truncated: boolean;
        };
        expect(body.format, name).toBe(format);
        expect(body.entries, name).toHaveLength(1000);
        expect(body.entries[0], name).toEqual({ path: "m0", type: "file", size: 0 });
        expect(body.entries[999], name).toEqual({ path: "m999", type: "file", size: 0 });
        expect(body.truncated, name).toBe(true);
      }
    });
  });

  it("refuses to be assembled with an entry limit that is not a positive safe integer", async () => {
    for (const archiveEntries of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        withWorkspacesApp(async () => "assembled", undefined, {
          previewLimits: { ...DEFAULT_BYTE_LIMITS, archiveEntries },
        }),
        String(archiveEntries),
      ).rejects.toThrow("archive entry limit must be a positive safe integer");
    }
  });
});

describe("archive route: refusals and damage", () => {
  it("answers the seven inputs of the specification in order, and the malformed requests", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "readme.md"), "# readme\n");
      mkdirSync(join(root, "out"));
      writeFileSync(join(root, "fake.zip"), "this is not a zip\n");
      writeFileSync(join(root, "cut.tar"), CUT_TAR);
      writeFileSync(join(root, "block-cut.tar"), BLOCK_CUT_TAR);
      writeFileSync(join(root, "x.zip"), THREE_ZIP);
      // Outside the workspace and a valid zip: only the sandbox keeps it from being listed.
      writeFileSync(join(sandboxRoot, "u1", "x.zip"), THREE_ZIP);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator: the role opens no other owner's workspace.
      const foreignCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const base = `/api/workspaces/${WORKSPACE}/archive`;
      const cutListing = {
        format: "tar",
        entries: [{ path: "a.txt", type: "file", size: 5 }],
        truncated: true,
      };
      const cases: Array<
        [label: string, url: string, cookie: string, status: number, body: object]
      > = [
        ["readme.md", `${base}?path=readme.md`, cookie, 415, UNSUPPORTED_ENVELOPE],
        ["out (a directory)", `${base}?path=out`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["gone.zip", `${base}?path=gone.zip`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["fake.zip", `${base}?path=fake.zip`, cookie, 415, UNSUPPORTED_ENVELOPE],
        ["cut.tar", `${base}?path=cut.tar`, cookie, 200, cutListing],
        // No end blocks and nothing after `a.txt`: a read that gets no bytes is not a zero block.
        ["block-cut.tar", `${base}?path=block-cut.tar`, cookie, 200, cutListing],
        ["../x.zip", `${base}?path=..%2Fx.zip`, cookie, 403, SANDBOX_DENIED_ENVELOPE],
        ["another owner's x.zip", `${base}?path=x.zip`, foreignCookie, 404, NOT_FOUND_ENVELOPE],
        // Absent is judged before the name: a missing file that is no archive name is 404 too.
        ["gone.md", `${base}?path=gone.md`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["anonymous", `${base}?path=x.zip`, "", 401, UNAUTHORIZED_ENVELOPE],
        ["no path", base, cookie, 400, BAD_REQUEST_ENVELOPE],
        ["path twice", `${base}?path=x.zip&path=x.zip`, cookie, 400, BAD_REQUEST_ENVELOPE],
        ["empty path (the root)", `${base}?path=`, cookie, 404, NOT_FOUND_ENVELOPE],
        ["below a file", `${base}?path=x.zip%2Fa.txt`, cookie, 404, NOT_FOUND_ENVELOPE],
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
      }

      expect(auditRows(db, "sandbox.reject")).toEqual([
        {
          actor_id: "u1",
          workspace_id: WORKSPACE,
          title: "越界访问被沙箱拦截",
          detail: {
            relPath: "../x.zip",
            op: "read",
            reason: "path is not inside the sandbox root",
          },
        },
      ]);
      expect(auditCount(db)).toEqual({ count: 1 });
    });
  });

  it("closes the descriptor it opened after a listing, after an unsupported archive and after a damaged one", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app } = fixture;
      const root = seedWorkspace(fixture);
      writeFileSync(join(root, "x.zip"), THREE_ZIP);
      writeFileSync(join(root, "fake.zip"), "this is not a zip\n");
      writeFileSync(join(root, "cut.tar"), CUT_TAR);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const io = spyDescriptors();

      const opened: number[] = [];
      for (const [name, status] of [
        ["x.zip", 200],
        ["fake.zip", 415],
        ["cut.tar", 200],
      ] as const) {
        const response = await listing(app, cookie, name);
        expect(response.statusCode, name).toBe(status);
        const descriptors = io.descriptorsOf(join(root, name));
        expect(descriptors, name).toHaveLength(1);
        opened.push(...descriptors);
        expect(io.closed(), name).toEqual(opened);
      }
    });
  });
});

describe("archive route: a read that fails", () => {
  it("answers the generic 500 without the path and closes the descriptor", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db } = fixture;
      const target = join(seedWorkspace(fixture), "x.tar");
      writeFileSync(target, THREE_MEMBERS);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const io = spyDescriptors();
      vi.mocked(fs.read).mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
        callback(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", errno: -5 }));
      }) as typeof fs.read);
      syncBuiltinESMExports();

      const response = await listing(app, cookie, "x.tar");

      expectWorkspaceResponse(response, 500, INTERNAL_ERROR_ENVELOPE);
      expect(response.payload).not.toContain("x.tar");
      const descriptors = io.descriptorsOf(target);
      expect(descriptors).toHaveLength(1);
      expect(io.closed()).toEqual(descriptors);
      expect(auditCount(db)).toEqual({ count: 0 });
    });
  });
});

describe("archive route: stays behind the sandbox", () => {
  it("denies symbolic links, outward or inward, with a read rejection and opens nothing", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      mkdirSync(join(sandboxRoot, "u2"));
      // Each target is a valid zip: followed, it would be listed.
      writeFileSync(join(sandboxRoot, "u2", "x.zip"), THREE_ZIP);
      writeFileSync(join(root, "x.zip"), THREE_ZIP);
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "x.zip"), THREE_ZIP);
      symlinkSync(join(sandboxRoot, "u2", "x.zip"), join(root, "out-link.zip"));
      symlinkSync(join(root, "x.zip"), join(root, "in-link.zip"));
      symlinkSync(join(root, "real"), join(root, "dir-link"));
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const paths = ["out-link.zip", "in-link.zip", "dir-link/x.zip"];
      const io = spyDescriptors();

      for (const path of paths) {
        const response = await listing(app, cookie, path);
        expectWorkspaceResponse(response, 403, SANDBOX_DENIED_ENVELOPE);
        expect(response.payload, path).not.toContain("a.txt");
      }

      expect(auditRows(db, "sandbox.reject").map((row) => row.detail)).toEqual(
        paths.map((relPath) => ({
          relPath,
          op: "read",
          reason: "path is not inside the sandbox root",
        })),
      );
      expect(io.opensBelow(sandboxRoot)).toEqual([]);
    });
  });

  it("answers the same 404 for another owner's, an unknown and a rootless id before any path check, opening nothing", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      writeFileSync(join(seedWorkspace(fixture), "x.zip"), THREE_ZIP);
      writeFileSync(join(sandboxRoot, "u1", "x.zip"), THREE_ZIP);
      // Owned, but its directory is gone: not a sandbox rejection either.
      insertWorkspace(db, ROOTLESS_WORKSPACE, "u1", "rootless", "rootless", 2);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      // lisi is the seeded administrator, zhaoliu an ordinary member: neither owns the workspace.
      const foreignCookie = bearerCookie(await loginSessionId(app, "lisi"));
      const memberCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const io = spyDescriptors();

      const responses = [
        await listing(app, foreignCookie, "../x.zip"),
        await listing(app, foreignCookie, "x.zip"),
        await listing(app, memberCookie, "../x.zip"),
        await listing(app, memberCookie, "x.zip"),
        await listing(app, cookie, "../x.zip", MISSING_WORKSPACE),
        await listing(app, cookie, "x.zip", MISSING_WORKSPACE),
        await listing(app, cookie, "../x.zip", ROOTLESS_WORKSPACE),
        await listing(app, cookie, "x.zip", ROOTLESS_WORKSPACE),
        // Same answer whatever the query is: ownership is judged before the query.
        await app.inject({
          method: "GET",
          url: `/api/workspaces/${WORKSPACE}/archive`,
          headers: { cookie: foreignCookie },
        }),
      ];

      for (const response of responses) {
        expectWorkspaceResponse(response, 404, NOT_FOUND_ENVELOPE);
        expect(response.payload).toBe(responses[0]?.payload);
      }
      expect(auditCount(db)).toEqual({ count: 0 });
      expect(io.opensBelow(sandboxRoot)).toEqual([]);
    });
  });
});

/**
 * The target is a valid zip through the sandbox and the route's lstat, and is replaced the moment
 * the route asks to open it — the window between the check and the open by path, held open here
 * by a hook around `openSync` that does the swap itself. Only the last component is swapped: a
 * swapped intermediate directory is not covered by any case in this file.
 */
describe("archive route: the target is swapped between lstat and the open", () => {
  interface Swapped {
    status: number;
    payload: string;
    cacheControl: unknown;
    elapsedMs: number;
    /** Descriptors the open returned for the target, and the reads made through them. */
    descriptors: number[];
    readsThroughThem: number;
    closed: number[];
    audits: unknown;
  }

  async function requestWithSwap(
    swap: (target: string, sandboxRoot: string) => (() => void) | undefined,
  ): Promise<Swapped> {
    return withWorkspacesApp(async (fixture) => {
      const { app, db, sandboxRoot } = fixture;
      const target = join(seedWorkspace(fixture), "x.zip");
      writeFileSync(target, THREE_ZIP);
      // A valid zip outside every workspace, with a name the answer must never carry.
      writeFileSync(
        join(sandboxRoot, "outside.zip"),
        zipArchive([zipCentral({ name: "outside-secret.txt", size: 3 })]),
      );
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const realOpen = fs.openSync;
      const io = spyDescriptors();
      let cleanup: (() => void) | undefined;
      let swaps = 0;
      io.open.mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (path === target && swaps === 0) {
          swaps += 1;
          rmSync(target);
          cleanup = swap(target, sandboxRoot);
        }
        return realOpen(path, flags, mode);
      }) as typeof fs.openSync);

      const started = performance.now();
      try {
        const response = await listing(app, cookie, "x.zip");
        const elapsedMs = performance.now() - started;
        expect(swaps).toBe(1);
        const descriptors = io.descriptorsOf(target);
        return {
          status: response.statusCode,
          payload: response.payload,
          cacheControl: response.headers["cache-control"],
          elapsedMs,
          descriptors,
          readsThroughThem: io.readsThrough(descriptors),
          closed: io.closed(),
          audits: auditCount(db),
        };
      } finally {
        cleanup?.();
      }
    });
  }

  function expectNotFoundUnread(swapped: Swapped): void {
    expect(swapped.payload).not.toContain("secret");
    expect(swapped.status).toBe(404);
    expect(JSON.parse(swapped.payload)).toEqual(NOT_FOUND_ENVELOPE);
    expect(swapped.cacheControl).toBe("no-store");
    expect(swapped.readsThroughThem).toBe(0);
    // Whatever was opened is closed again on the way out.
    expect(swapped.closed).toEqual(swapped.descriptors);
    // Not found, not a sandbox rejection: the same outcome as a target that was never a file.
    expect(swapped.audits).toEqual({ count: 0 });
  }

  it("a symlink to a zip outside the workspace: answers 404 and never opens the target", async () => {
    const swapped = await requestWithSwap((target, sandboxRoot) => {
      symlinkSync(join(sandboxRoot, "outside.zip"), target);
      return undefined;
    });

    expectNotFoundUnread(swapped);
    expect(swapped.descriptors).toEqual([]);
  }, 15_000);

  // A blocking open of a pipe nobody writes to stops the event loop, and with it the test's own
  // timer. The delayed writer below releases such an open after three seconds, so that failure
  // shows as a slow answer instead of a run that never ends.
  it("a named pipe: answers 404 promptly without reading from it", async () => {
    const swapped = await requestWithSwap((target) => {
      execFileSync("mkfifo", [target]);
      const writer = spawn("sh", ["-c", 'sleep 3; exec 3>"$0"', target], { stdio: "ignore" });
      return () => {
        writer.kill("SIGKILL");
      };
    });

    expectNotFoundUnread(swapped);
    // The pipe was opened (not refused by path) and recognised from its descriptor.
    expect(swapped.descriptors).toHaveLength(1);
    expect(swapped.elapsedMs).toBeLessThan(1500);
  }, 15_000);

  it("a directory: answers 404 without reading from it", async () => {
    const swapped = await requestWithSwap((target) => {
      mkdirSync(target);
      return undefined;
    });

    expectNotFoundUnread(swapped);
    expect(swapped.descriptors).toHaveLength(1);
  }, 15_000);

  it("nothing at all (the file was deleted): answers 404 without a descriptor", async () => {
    // The harness has already removed the target; nothing takes its place.
    const swapped = await requestWithSwap(() => undefined);

    expectNotFoundUnread(swapped);
    expect(swapped.descriptors).toEqual([]);
  }, 15_000);

  // Not one of the refusals: what is listed is the file that was opened, at its own size. A zip is
  // read from its end, so the size the lstat saw (of the three-member zip) would not find it.
  it("another zip of a different size: lists the one it opened", async () => {
    const swapped = await requestWithSwap((target, sandboxRoot) => {
      // Copied, not written: `writeFileSync` would go through the hooked `openSync` itself.
      copyFileSync(join(sandboxRoot, "outside.zip"), target);
      return undefined;
    });

    expect(swapped.status).toBe(200);
    expect(JSON.parse(swapped.payload)).toEqual({
      format: "zip",
      entries: [{ path: "outside-secret.txt", type: "file", size: 3 }],
      truncated: false,
    });
    expect(swapped.descriptors).toHaveLength(1);
    expect(swapped.closed).toEqual(swapped.descriptors);
  }, 15_000);
});

describe("archive route: malicious member names are only data", () => {
  it("returns `..`, absolute and markup names as they are and touches none of the paths they spell", async () => {
    await withWorkspacesApp(async (fixture) => {
      const { app, sandboxRoot } = fixture;
      const root = seedWorkspace(fixture);
      // The last one is not in the specification: it is the one a path normaliser would rewrite.
      const names = ["../../etc/passwd", "/abs/x", "<script>alert(1)</script>", "./a/../../b//c"];
      const zipNames = [...names, "..\\..\\etc\\passwd"];
      writeFileSync(
        join(root, "evil.tar"),
        Buffer.concat([...names.map((name) => tarFile(name)), TAR_END]),
      );
      writeFileSync(
        join(root, "evil.zip"),
        zipArchive(zipNames.map((name) => zipCentral({ name }))),
      );
      // Where `../../etc/passwd` lands when it is joined to the workspace root.
      const sentinel = join(sandboxRoot, "etc", "passwd");
      mkdirSync(join(sandboxRoot, "etc"));
      writeFileSync(sentinel, "sentinel\n");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const before = contentOf(sandboxRoot);
      const spies = [
        ...spyMetadataIo(),
        vi.spyOn(fs.promises, "open"),
        vi.spyOn(fs.promises, "lstat"),
        vi.spyOn(fs.promises, "stat"),
        vi.spyOn(fs.promises, "readFile"),
      ];
      syncBuiltinESMExports();

      const tar = await listing(app, cookie, "evil.tar");
      const zip = await listing(app, cookie, "evil.zip");

      const touched = spies
        .flatMap((spy) => (spy.mock.calls as unknown[][]).map(([path]) => path))
        .filter((path) => typeof path === "string");
      // The snapshot below reads the sentinel itself: the spies come off first.
      restoreSpies();

      expectWorkspaceResponse(tar, 200, {
        format: "tar",
        entries: names.map((path) => ({ path, type: "file", size: 0 })),
        truncated: false,
      });
      expectWorkspaceResponse(zip, 200, {
        format: "zip",
        entries: zipNames.map((path) => ({ path, type: "file", size: 0 })),
        truncated: false,
      });
      // The spies do see the route: both archives were opened by path.
      expect(touched).toContain(join(root, "evil.tar"));
      expect(touched).toContain(join(root, "evil.zip"));
      const spelled = [
        sentinel,
        "/etc/passwd",
        "/abs/x",
        ...zipNames.flatMap((name) => [name, join(root, name), resolve(root, name)]),
      ];
      expect(touched.filter((path) => spelled.includes(path))).toEqual([]);
      expect(
        touched.filter(
          (path) => path.includes("passwd") || path.includes("/abs/") || path.includes("<script"),
        ),
      ).toEqual([]);
      // Nothing was written, inside the workspace or beside it.
      expect(contentOf(sandboxRoot)).toEqual(before);
    });
  });
});
