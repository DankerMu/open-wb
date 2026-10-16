/**
 * Issue 1492 (change sandbox-boundary-closure, S2): `GET /api/workspaces/:id/file` serves what it
 * opened. workspaces 「预览分类元数据与有界字节流」 scenario 「打开只认普通文件」 (`openRegularFile`),
 * and 「文件预览」 scenarios 「lstat 之后目标被换入」 and 「大小以打开的 inode 为准」, plus the new
 * semantics that a path unlinked after the open does not reach the response. Every swap is made by
 * a hook around the open (钩子辅助复现), not by a natural race.
 */
import fs, {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { openRegularFile } from "../src/workspaces/regular-file.js";
import { bearerCookie, loginSessionId, NOT_FOUND_ENVELOPE } from "./auth-lifecycle-helpers.js";
import {
  descriptorsOf,
  expectSwappedUnread,
  type SwapKind,
  spyBodyIo,
  swapIn,
  swapOnFirstOpen,
  workspaceTempDir,
} from "./workspace-file-helpers.js";
import {
  auditCount,
  expectWorkspaceResponse,
  FILES_WORKSPACE,
  seedWorkspace,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

/** 1000 bytes, byte i is i % 251: no two aligned windows of the file are equal. */
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_unused, index) => index % 251));
const README = Buffer.from("# 读我\n\ninside text\n");
const SECRET = "another-owner-secret";
const UNLINK_HEADER = "x-test-unlink";
const SWAP_KINDS: readonly SwapKind[] = ["pipe", "symlink", "directory"];

interface Files {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  root: string;
  cookie: string;
}

/** u1's workspace with `readme.md` and `clip.mp4`, and another owner's file beside it. */
function withFiles(
  action: (files: Files) => Promise<void>,
  beforeRoutes?: Parameters<typeof withWorkspacesApp>[1],
): Promise<void> {
  return withWorkspacesApp(async (fixture) => {
    const root = seedWorkspace(fixture);
    writeFileSync(join(root, "readme.md"), README);
    writeFileSync(join(root, "clip.mp4"), CLIP);
    mkdirSync(join(fixture.sandboxRoot, "u2"));
    writeFileSync(join(fixture.sandboxRoot, "u2", "secret.txt"), SECRET);
    const cookie = bearerCookie(await loginSessionId(fixture.app, "zhangsan"));
    await action({ ...fixture, root, cookie });
  }, beforeRoutes);
}

function requestFile(
  { app, cookie }: Files,
  path: string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/api/workspaces/${FILES_WORKSPACE}/file?path=${encodeURIComponent(path)}`,
    headers: { cookie, ...headers },
  });
}

describe("openRegularFile: only a regular file opens", () => {
  /** Opens `path` with every body read and both closes spied; what came of it. */
  function open(path: string) {
    spyBodyIo();
    const closeSync = vi.spyOn(fs, "closeSync");
    syncBuiltinESMExports();
    const started = performance.now();
    let outcome: unknown;
    try {
      outcome = openRegularFile(path);
    } catch (error) {
      outcome = error;
    }
    return {
      outcome,
      elapsedMs: performance.now() - started,
      descriptors: descriptorsOf(path),
      closed: closeSync.mock.calls.map(([fd]) => fd),
      reads: vi.mocked(fs.read).mock.calls.length + vi.mocked(fs.readSync).mock.calls.length,
    };
  }

  function expectNotFound(outcome: unknown): void {
    expect(outcome).toBeInstanceOf(HttpError);
    expect(outcome).toMatchObject({ code: "not_found" });
  }

  it("returns the descriptor of a regular file and the size its fstat gives", () => {
    const path = join(workspaceTempDir(), "readme.md");
    writeFileSync(path, README);
    const opened = open(path);

    expect(opened.outcome).toEqual({ fd: opened.descriptors[0], size: README.length });
    expect(fstatSync(opened.descriptors[0] as number).isFile()).toBe(true);
    expect(opened.closed).toEqual([]);
    expect(opened.reads).toBe(0);
    fs.closeSync(opened.descriptors[0] as number);
  });

  it.each(["pipe", "directory"] as const)(
    "opens a %s once, closes it again and throws not_found, promptly and reading nothing",
    (kind) => {
      const path = join(workspaceTempDir(), "entry");
      writeFileSync(path, "");
      const cleanup = swapIn(kind, path, "");
      try {
        const opened = open(path);

        expectNotFound(opened.outcome);
        expect(opened.descriptors).toHaveLength(1);
        expect(opened.closed).toEqual(opened.descriptors);
        expect(() => fstatSync(opened.descriptors[0] as number)).toThrow(/EBADF/);
        expect(opened.reads).toBe(0);
        expect(opened.elapsedMs).toBeLessThan(1500);
      } finally {
        cleanup?.();
      }
    },
    15_000,
  );

  it.each<[string, (path: string) => (() => void) | undefined]>([
    [
      "a symlink to a regular file",
      (path) => {
        writeFileSync(`${path}.target`, "linked");
        symlinkSync(`${path}.target`, path);
        return undefined;
      },
    ],
    // Moved here from the two stream helpers (owner B5): they no longer open anything.
    ["a path where nothing is", () => undefined],
    [
      "a unix socket",
      (path) => {
        const server = createServer().on("error", () => undefined);
        server.listen(path);
        expect(lstatSync(path).isSocket()).toBe(true);
        return () => {
          server.close();
        };
      },
    ],
  ] as const)(
    "refuses %s with not_found, leaving no descriptor and reading nothing",
    (_label, make) => {
      const path = join(workspaceTempDir(), "entry");
      const cleanup = make(path);
      try {
        const opened = open(path);

        expectNotFound(opened.outcome);
        expect(vi.mocked(fs.openSync)).toHaveBeenCalledTimes(1);
        expect(opened.descriptors).toEqual([]);
        expect(opened.closed).toEqual([]);
        expect(opened.reads).toBe(0);
      } finally {
        cleanup?.();
      }
    },
  );
});

describe("file route: the target is swapped between the lstat and the open", () => {
  const cases = [
    ["readme.md", "the text stream", {}],
    ["clip.mp4", "the range path", { range: "bytes=0-99" }],
  ] as const;

  for (const [path, label, headers] of cases) {
    for (const kind of SWAP_KINDS) {
      it(`${label} (${path}), swapped for a ${kind}: 404 not_found with nothing opened as a stream or read`, async () => {
        await withFiles(async (files) => {
          const linkTo = join(files.sandboxRoot, "u2", "secret.txt");
          const swapped = swapOnFirstOpen(join(files.root, path), (target) =>
            swapIn(kind, target, linkTo),
          );
          const started = performance.now();
          try {
            const response = await requestFile(files, path, headers);
            const elapsedMs = performance.now() - started;

            expectWorkspaceResponse(response, 404, NOT_FOUND_ENVELOPE);
            expect(response.payload).not.toContain(SECRET);
            expect(response.headers["content-range"]).toBeUndefined();
            expectSwappedUnread(swapped.record(), kind, elapsedMs);
            expect(auditCount(files.db)).toEqual({ count: 0 });
          } finally {
            swapped.cleanup();
          }
        });
      }, 15_000);
    }
  }
});

describe("file route: the size is the opened inode's", () => {
  /**
   * Cuts clip.mp4 to `size` bytes or grows it with `z`s, the moment the route opens it: through a
   * descriptor opened beforehand, so that no open of the change itself shows up among the route's.
   */
  function resizeOnOpen(target: string, size: number) {
    const writer = openSync(target, "r+");
    const swapped = swapOnFirstOpen(target, () => {
      if (size < CLIP.length) {
        ftruncateSync(writer, size);
      } else {
        writeSync(
          writer,
          Buffer.alloc(size - CLIP.length, 0x7a),
          0,
          size - CLIP.length,
          CLIP.length,
        );
      }
      return () => closeSync(writer);
    });
    return swapped;
  }

  it.each([
    ["cut to 600 bytes", 600],
    ["grown to 1400 bytes", 1400],
  ] as const)(
    "answers 200 for a clip %s after the lstat with the length and bytes it has when opened",
    async (_label, size) => {
      await withFiles(async (files) => {
        const expected = Buffer.concat([CLIP, Buffer.alloc(400, 0x7a)]).subarray(0, size);
        const swapped = resizeOnOpen(join(files.root, "clip.mp4"), size);
        try {
          const response = await requestFile(files, "clip.mp4");

          expect(swapped.record().swaps).toBe(1);
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-length"]).toBe(String(size));
          expect(response.headers["x-workbuddy-size"]).toBe(String(size));
          expect(response.rawPayload.equals(expected)).toBe(true);
        } finally {
          swapped.cleanup();
        }
      });
    },
  );

  it("judges a range against the opened size: 416 with bytes */600 for bytes=900- of a file cut to 600", async () => {
    await withFiles(async (files) => {
      const swapped = resizeOnOpen(join(files.root, "clip.mp4"), 600);
      try {
        const response = await requestFile(files, "clip.mp4", { range: "bytes=900-" });

        expect(response.statusCode).toBe(416);
        expect(response.headers["content-range"]).toBe("bytes */600");
        expect(response.payload).toBe("");
        const io = swapped.record();
        expect(io.swaps).toBe(1);
        // Opened once to learn the size, closed, nothing read.
        expect(io.descriptors).toHaveLength(1);
        expect(io.closed).toEqual(io.descriptors);
        expect(io.reads).toBe(0);
        expect(io.streams).toBe(0);
      } finally {
        swapped.cleanup();
      }
    });
  });
});

describe("file route: a sniffed 415 closes the one descriptor it read", () => {
  it("answers 415 for blob.bin after one read of at most 8192 bytes through its only descriptor, then closes it", async () => {
    await withFiles(async (files) => {
      const target = join(files.root, "blob.bin");
      // Longer than the sniff, with a NUL inside it: not text.
      const bytes = Buffer.alloc(10_000, 0x61);
      bytes[100] = 0;
      writeFileSync(target, bytes);
      spyBodyIo();
      const closeSync = vi.spyOn(fs, "closeSync");
      syncBuiltinESMExports();

      const response = await requestFile(files, "blob.bin");

      expect(response.statusCode).toBe(415);
      const [fd] = descriptorsOf(target);
      expect(descriptorsOf(target)).toHaveLength(1);
      const reads = vi.mocked(fs.readSync).mock.calls.filter(([read]) => read === fd);
      expect(reads.map((call) => (call as unknown[])[3])).toEqual([8192]);
      expect(vi.mocked(fs.read)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.createReadStream)).not.toHaveBeenCalled();
      expect(closeSync.mock.calls.map(([closed]) => closed)).toEqual([fd]);
    });
  });
});

describe("file route: the path unlinked after the open", () => {
  /** After the handler opened the file and handed its descriptor over: unlinks what was asked for. */
  function unlinkOnSend({ app, sandboxRoot }: { app: FastifyInstance; sandboxRoot: string }) {
    app.addHook("onSend", (request, _reply, _payload, next) => {
      const { path } = request.query as { path?: string };
      if (request.headers[UNLINK_HEADER] !== undefined && path !== undefined) {
        unlinkSync(join(sandboxRoot, "u1", "files", path));
      }
      next();
    });
  }

  it("still answers 200 with the whole text of readme.md from the opened inode", async () => {
    await withFiles(async (files) => {
      const response = await requestFile(files, "readme.md", { [UNLINK_HEADER]: "1" });

      // A text stream carries no Content-Length; its size header is the opened inode's.
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-workbuddy-size"]).toBe(String(README.length));
      expect(response.rawPayload.equals(README)).toBe(true);
      expect(await requestFile(files, "readme.md")).toMatchObject({ statusCode: 404 });
    }, unlinkOnSend);
  });

  it("still answers 206 with bytes 0-99 of clip.mp4 from the opened inode", async () => {
    await withFiles(async (files) => {
      const response = await requestFile(files, "clip.mp4", {
        range: "bytes=0-99",
        [UNLINK_HEADER]: "1",
      });

      expect(response.statusCode).toBe(206);
      expect(response.headers["content-range"]).toBe("bytes 0-99/1000");
      expect(response.headers["content-length"]).toBe("100");
      expect(response.headers["x-workbuddy-size"]).toBe("1000");
      expect(response.rawPayload.equals(CLIP.subarray(0, 100))).toBe(true);
      expect(await requestFile(files, "clip.mp4")).toMatchObject({ statusCode: 404 });
    }, unlinkOnSend);
  });
});
