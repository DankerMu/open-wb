import { execFileSync, spawn } from "node:child_process";
import fs, {
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { appAssemblyOf, resolveServerConfig } from "../src/server.js";
import {
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { spyBodyIo, TEXT_MIME } from "./workspace-file-helpers.js";
import {
  expectWorkspaceResponse,
  insertWorkspace,
  requestWorkspaceFile,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const U1_SNIFF = "a1".repeat(16);
const MISSING_SNIFF = "b2".repeat(16);
const SNIFF_BYTES = 8192;
const UNSUPPORTED_ENVELOPE = {
  error: { code: "preview_unsupported", message: "该类型不支持预览" },
};
const TOO_LARGE_ENVELOPE = { error: { code: "preview_too_large", message: "文件过大，无法预览" } };
const SOURCE_ENTRY = pathToFileURL(
  join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "server", "src", "server.ts"),
).href;

/** The workspace `sniff` of u1, with `files` written before anything is spied on. */
function seed(
  db: DatabaseSync,
  sandboxRoot: string,
  files: Readonly<Record<string, string | Buffer>>,
): string {
  const root = join(sandboxRoot, "u1", "sniff");
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  insertWorkspace(db, U1_SNIFF, "u1", "sniff", "sniff", 1);
  return root;
}

/** Spies the body I/O (fixtures must already be on disk: `writeFileSync` opens too). */
function spyOpenAndRead() {
  spyBodyIo();
  const open = vi.mocked(fs.openSync);
  const read = vi.mocked(fs.readSync);
  const close = vi.spyOn(fs, "closeSync");
  syncBuiltinESMExports();
  const pathsBelow = (dir: string, spies: readonly unknown[]) =>
    spies
      .flatMap((spied) => vi.mocked(spied as typeof fs.openSync).mock.calls.map(([path]) => path))
      .filter((path) => typeof path === "string" && path.startsWith(dir));
  return {
    open,
    read,
    closed: () => close.mock.calls.map(([fd]) => fd),
    /** Reads of the sniff's length, through whichever descriptor. */
    sniffReads: () => read.mock.calls.filter((call: readonly unknown[]) => call[3] === SNIFF_BYTES),
    opensOf: (path: string) => open.mock.calls.filter(([opened]) => opened === path),
    /** Every path-based open or stream below `dir`, whichever call made it. */
    opensBelow: (dir: string) =>
      pathsBelow(dir, [fs.openSync, fs.open, fs.createReadStream, fs.readFileSync, fs.readFile]),
    /** Whole-file reads by path below `dir`. */
    wholeReadsBelow: (dir: string) => pathsBelow(dir, [fs.readFileSync, fs.readFile]),
    /** Asynchronous opens of `path`: the response stream makes exactly one of its own. */
    asyncOpensOf: (path: string) => pathsBelow(path, [fs.open]),
  };
}

function auditCount(db: DatabaseSync): unknown {
  return db.prepare("SELECT count(*) AS count FROM audit_events").get();
}

describe("file route: sniffing unknown and extensionless files", () => {
  it("serves unknown and extensionless files that read as UTF-8 text as text/plain with their exact bytes", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const files = {
        LICENSE: Buffer.from("MIT License\n\n版权所有\n"),
        ".gitignore": Buffer.from("node_modules\n"),
        "schema.proto": Buffer.from('syntax = "proto3";\n'),
        empty: Buffer.alloc(0),
        // A prototype name with text content: sniffed like any other unknown extension.
        "x.constructor": Buffer.from("plain text\n"),
      };
      seed(db, sandboxRoot, files);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      for (const [path, bytes] of Object.entries(files)) {
        const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, path);
        expect(response.statusCode, path).toBe(200);
        expect(response.headers["content-type"], path).toBe(TEXT_MIME);
        expect(response.headers["x-content-type-options"], path).toBe("nosniff");
        expect(response.headers["cache-control"], path).toBe("no-store");
        expect(response.headers["x-workbuddy-size"], path).toBe(String(bytes.length));
        expect(response.headers["x-workbuddy-truncated"], path).toBeUndefined();
        expect(response.rawPayload.equals(bytes), path).toBe(true);
      }
    });
  });

  it("answers 415 preview_unsupported for unknown and extensionless files that do not read as text", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      seed(db, sandboxRoot, {
        "blob.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
        core: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]),
        // GBK for 中文: no NUL, not UTF-8.
        "gbk.dat": Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      });
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      for (const path of ["blob.bin", "core", "gbk.dat"]) {
        const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, path);
        expectWorkspaceResponse(response, 415, UNSUPPORTED_ENVELOPE);
        expect(response.headers["x-workbuddy-size"], path).toBeUndefined();
        expect(response.headers["content-type"], path).toBe("application/json; charset=utf-8");
      }
    });
  });

  it("judges the first 8192 bytes only: a NUL at offset 8192 is unseen, one at 8191 is not", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const nulAt = (offset: number) => {
        const bytes = Buffer.alloc(10_240, "a");
        bytes[offset] = 0;
        return bytes;
      };
      // 中 is three bytes: its first sits at 8191, the cut falls after it.
      const split = Buffer.concat([Buffer.alloc(8191, "a"), Buffer.from("中文\n")]);
      seed(db, sandboxRoot, {
        "after.dat": nulAt(8192),
        "inside.dat": nulAt(8191),
        "split.dat": split,
      });
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const after = await requestWorkspaceFile(app, U1_SNIFF, cookie, "after.dat");
      expect(after.statusCode).toBe(200);
      expect(after.headers["content-type"]).toBe(TEXT_MIME);
      expect(after.rawPayload.equals(nulAt(8192))).toBe(true);
      expectWorkspaceResponse(
        await requestWorkspaceFile(app, U1_SNIFF, cookie, "inside.dat"),
        415,
        UNSUPPORTED_ENVELOPE,
      );
      const cut = await requestWorkspaceFile(app, U1_SNIFF, cookie, "split.dat");
      expect(cut.statusCode).toBe(200);
      expect(cut.rawPayload.equals(split)).toBe(true);
    });
  });

  it("truncates a sniffed text file at the text limit like any other text", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const bytes = Buffer.alloc(1_572_864, "z");
      seed(db, sandboxRoot, { "big.unknownext": bytes });
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, "big.unknownext");

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(TEXT_MIME);
      expect(response.headers["x-workbuddy-size"]).toBe("1572864");
      expect(response.headers["x-workbuddy-truncated"]).toBe("1");
      expect(response.rawPayload.length).toBe(1_048_576);
      expect(response.rawPayload.equals(bytes.subarray(0, 1_048_576))).toBe(true);
    });
  });
});

describe("file route: sniff reads", () => {
  it("does no sniff read for a known extension or name, and exactly one of 8192 bytes for an unknown one", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = seed(db, sandboxRoot, {
        "readme.md": "# readme\n",
        "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "doc.pdf": "%PDF-1.7\n",
        "a.ipynb": '{"cells":[]}',
        Dockerfile: "FROM scratch\n",
        LICENSE: "MIT License\n",
      });
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const io = spyOpenAndRead();

      for (const [path, status] of [
        ["readme.md", 200],
        ["logo.png", 200],
        ["doc.pdf", 415],
        ["a.ipynb", 200],
        ["Dockerfile", 200],
      ] as const) {
        const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, path);
        expect(response.statusCode, path).toBe(status);
        expect(io.opensOf(join(root, path)), path).toEqual([]);
        // The one asynchronous open is the response stream's; the refused one has no stream.
        expect(io.asyncOpensOf(join(root, path)), path).toHaveLength(status === 200 ? 1 : 0);
      }
      // No descriptor was opened by path, so nothing was read through one either.
      expect(io.open.mock.calls.filter(([opened]) => String(opened).startsWith(root))).toEqual([]);
      expect(io.sniffReads()).toEqual([]);
      // Nor was any of them read whole by path: the response stream is all there is.
      expect(io.wholeReadsBelow(root)).toEqual([]);
      expect(io.opensBelow(join(root, "doc.pdf"))).toEqual([]);

      const license = await requestWorkspaceFile(app, U1_SNIFF, cookie, "LICENSE");
      expect(license.statusCode).toBe(200);
      expect(io.opensOf(join(root, "LICENSE"))).toHaveLength(1);
      const opened = io.open.mock.results.at(-1);
      expect(opened?.type).toBe("return");
      const reads = io.read.mock.calls.filter(([fd]) => fd === opened?.value);
      expect(reads).toHaveLength(1);
      const [, buffer, offset, length, position] = reads[0] as unknown[];
      expect((buffer as Buffer).length).toBe(8192);
      expect([offset, length, position]).toEqual([0, 8192, 0]);
      expect(io.closed()).toEqual([opened?.value]);
    });
  });
});

describe("file route: configurable preview limits", () => {
  it("applies the specification defaults when the assembly carries no limits", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const notebook = Buffer.alloc(3000, "n");
      const root = seed(db, sandboxRoot, { "a.ipynb": notebook, "big.ipynb": "" });
      truncateSync(join(root, "big.ipynb"), 11 * 1024 * 1024);
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

      const small = await requestWorkspaceFile(app, U1_SNIFF, cookie, "a.ipynb");
      expect(small.statusCode).toBe(200);
      expect(small.headers["content-type"]).toBe(TEXT_MIME);
      expect(small.headers["x-workbuddy-truncated"]).toBeUndefined();
      expect(small.rawPayload.equals(notebook)).toBe(true);
      expectWorkspaceResponse(
        await requestWorkspaceFile(app, U1_SNIFF, cookie, "big.ipynb"),
        413,
        TOO_LARGE_ENVELOPE,
      );
    });
  });

  it("moves the truncation point and both 413 boundaries with the limits it is assembled with", async () => {
    await withWorkspacesApp(
      async ({ app, db, sandboxRoot }) => {
        const text = Buffer.from("0123456789abcdefghij");
        seed(db, sandboxRoot, {
          "t.txt": text,
          LICENSE: text,
          "p.png": Buffer.alloc(2048, 1),
          "a.ipynb": Buffer.alloc(3000, "n"),
          "ok.png": Buffer.alloc(1024, 1),
          "ok.ipynb": Buffer.alloc(2048, "n"),
        });
        const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

        for (const path of ["t.txt", "LICENSE"]) {
          const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, path);
          expect(response.statusCode, path).toBe(200);
          expect(response.headers["x-workbuddy-size"], path).toBe("20");
          expect(response.headers["x-workbuddy-truncated"], path).toBe("1");
          expect(response.rawPayload.toString(), path).toBe("0123456789abcdef");
        }
        for (const path of ["p.png", "a.ipynb"]) {
          expectWorkspaceResponse(
            await requestWorkspaceFile(app, U1_SNIFF, cookie, path),
            413,
            TOO_LARGE_ENVELOPE,
          );
        }
        // Exactly at the limit is still served whole.
        for (const [path, size] of [
          ["ok.png", 1024],
          ["ok.ipynb", 2048],
        ] as const) {
          const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, path);
          expect(response.statusCode, path).toBe(200);
          expect(response.rawPayload.length, path).toBe(size);
        }
      },
      undefined,
      { previewLimits: { text: 16, image: 1024, notebook: 2048 } },
    );
  });

  it("the entry's assembly carries the three configured preview limits", () => {
    const configured = resolveServerConfig(
      {
        PREVIEW_TEXT_MAX_BYTES: "16",
        PREVIEW_IMAGE_MAX_BYTES: "1024",
        PREVIEW_NOTEBOOK_MAX_BYTES: "2048",
      },
      SOURCE_ENTRY,
    );

    expect(appAssemblyOf(configured).previewLimits).toEqual({
      text: 16,
      image: 1024,
      notebook: 2048,
    });
    expect(appAssemblyOf(resolveServerConfig({}, SOURCE_ENTRY)).previewLimits).toEqual({
      text: 1_048_576,
      image: 20_971_520,
      notebook: 10_485_760,
    });
  });
});

describe("file route: the sniff stays behind the sandbox", () => {
  it("opens nothing for traversal, an outward symlink, a directory, a pipe, or another owner's id", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = seed(db, sandboxRoot, {});
      // Both targets exist and would sniff as text: only the sandbox keeps them unread.
      writeFileSync(join(sandboxRoot, "u1", "OUTSIDE"), "outside text\n");
      writeFileSync(join(sandboxRoot, "secret.proto"), "secret text\n");
      symlinkSync(join(sandboxRoot, "secret.proto"), join(root, "link.proto"));
      mkdirSync(join(root, "dir.proto"));
      execFileSync("mkfifo", [join(root, "pipe.proto")]);
      const ownerCookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const foreignCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const rejected = () =>
        db
          .prepare(
            "SELECT kind, actor_id, workspace_id, json_extract(detail, '$.op') AS op, json_extract(detail, '$.relPath') AS rel_path FROM audit_events ORDER BY rowid",
          )
          .all();
      const escapes = ["../OUTSIDE", "link.proto"];
      const expectedRows = escapes.map((path) => ({
        kind: "sandbox.reject",
        actor_id: "u1",
        workspace_id: U1_SNIFF,
        op: "read",
        rel_path: path,
      }));
      const io = spyOpenAndRead();

      for (const [index, path] of escapes.entries()) {
        const denied = await requestWorkspaceFile(app, U1_SNIFF, ownerCookie, path);
        expectWorkspaceResponse(denied, 403, {
          error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
        });
        expect(denied.payload, path).not.toContain("text");
        expect(rejected()).toEqual(expectedRows.slice(0, index + 1));
      }
      for (const path of ["dir.proto", "pipe.proto", "absent.proto"]) {
        expectWorkspaceResponse(
          await requestWorkspaceFile(app, U1_SNIFF, ownerCookie, path),
          404,
          NOT_FOUND_ENVELOPE,
        );
      }
      for (const [id, cookie] of [
        [U1_SNIFF, foreignCookie],
        [MISSING_SNIFF, ownerCookie],
      ] as const) {
        expectWorkspaceResponse(
          await requestWorkspaceFile(app, id, cookie, "../x.proto"),
          404,
          NOT_FOUND_ENVELOPE,
        );
      }

      expect(rejected()).toEqual(expectedRows);
      expect(io.opensBelow(sandboxRoot)).toEqual([]);
      expect(io.sniffReads()).toEqual([]);
    });
  });
});

/**
 * The target is a regular text file through the sandbox and the route's lstat, and is replaced
 * the moment the sniff asks to open it — the window between the check and the open by path.
 */
describe("file route: the target is swapped between lstat and the sniff open", () => {
  interface Swapped {
    status: number;
    headers: Record<string, unknown>;
    payload: string;
    elapsedMs: number;
    /** Descriptors the sniff open returned for the target, and the reads made through them. */
    descriptors: number[];
    readsThroughThem: number;
    /** Reads of the sniff's length through any descriptor at all. */
    sniffReads: number;
    closed: number[];
    streamsOfTarget: number;
    audits: unknown;
  }

  async function requestWithSwap(
    swap: (target: string, sandboxRoot: string) => (() => void) | undefined,
  ): Promise<Swapped> {
    return withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      const root = seed(db, sandboxRoot, { "notes.proto": "inside text\n" });
      writeFileSync(join(sandboxRoot, "secret.proto"), "outside secret\n");
      const target = join(root, "notes.proto");
      const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
      const realOpen = fs.openSync;
      const io = spyOpenAndRead();
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
        const response = await requestWorkspaceFile(app, U1_SNIFF, cookie, "notes.proto");
        const elapsedMs = performance.now() - started;
        expect(swaps).toBe(1);
        const descriptors = io.open.mock.calls.flatMap(([opened], index) => {
          const result = io.open.mock.results[index];
          return opened === target && result?.type === "return" ? [result.value as number] : [];
        });
        return {
          status: response.statusCode,
          headers: response.headers,
          payload: response.payload,
          elapsedMs,
          descriptors,
          readsThroughThem: io.read.mock.calls.filter(([fd]) => descriptors.includes(fd)).length,
          sniffReads: io.sniffReads().length,
          closed: io.closed(),
          streamsOfTarget: vi
            .mocked(fs.createReadStream)
            .mock.calls.filter(([opened]) => opened === target).length,
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
    expect(swapped.readsThroughThem).toBe(0);
    // Whatever was opened is closed again on the way out.
    expect(swapped.closed).toEqual(swapped.descriptors);
    expect(swapped.streamsOfTarget).toBe(0);
    // Not found, not a sandbox rejection: the same outcome as a target that was never a file.
    expect(swapped.audits).toEqual({ count: 0 });
  }

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

  it("a symlink to a file outside the workspace: answers 404 and never opens the target", async () => {
    const swapped = await requestWithSwap((target, sandboxRoot) => {
      symlinkSync(join(sandboxRoot, "secret.proto"), target);
      return undefined;
    });

    expectNotFoundUnread(swapped);
    expect(swapped.descriptors).toEqual([]);
  }, 15_000);

  it("a directory: answers 404 without reading from it", async () => {
    const swapped = await requestWithSwap((target) => {
      mkdirSync(target);
      return undefined;
    });

    expectNotFoundUnread(swapped);
    expect(swapped.descriptors).toHaveLength(1);
  }, 15_000);

  /** Refused by the open itself: no descriptor, so nothing to read from or to close. */
  function expectNotFoundUnopened(swapped: Swapped): void {
    expectNotFoundUnread(swapped);
    expect(swapped.descriptors).toEqual([]);
    expect(swapped.sniffReads).toBe(0);
  }

  it("nothing at all (the file was deleted): answers 404 without a descriptor", async () => {
    // The harness has already removed the target; nothing takes its place.
    expectNotFoundUnopened(await requestWithSwap(() => undefined));
  }, 15_000);

  it("a regular file where its parent directory was: answers 404 without a descriptor", async () => {
    const swapped = await requestWithSwap((target) => {
      rmSync(dirname(target), { recursive: true });
      writeFileSync(dirname(target), "no longer a directory\n");
      return undefined;
    });

    expectNotFoundUnopened(swapped);
  }, 15_000);

  it("a unix socket: answers 404 without a descriptor", async () => {
    let boundAsSocket = false;
    const swapped = await requestWithSwap((target) => {
      // The bind is synchronous; a refused one is reported later and leaves nothing at the path.
      const server = createServer().on("error", () => undefined);
      server.listen(target);
      boundAsSocket = lstatSync(target, { throwIfNoEntry: false })?.isSocket() === true;
      return () => {
        server.close();
      };
    });

    expect(boundAsSocket).toBe(true);
    expectNotFoundUnopened(swapped);
  }, 15_000);

  it("an open refused for any other reason is the generic 500, not a 404", async () => {
    const swapped = await requestWithSwap((target) => {
      // Put the file back: the path is a regular text file again and only the open fails.
      writeFileSync(target, "inside text\n");
      throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
        code: "EACCES",
        errno: -13,
        syscall: "open",
        path: target,
      });
    });

    expect(swapped.status).toBe(500);
    expect(JSON.parse(swapped.payload)).toEqual(INTERNAL_ERROR_ENVELOPE);
    expect(swapped.payload).not.toContain("notes.proto");
    expect(swapped.payload).not.toContain("sniff");
    expect(swapped.headers["x-workbuddy-size"]).toBeUndefined();
    expect(swapped.headers["x-workbuddy-truncated"]).toBeUndefined();
    expect(swapped.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(swapped.sniffReads).toBe(0);
    expect(swapped.streamsOfTarget).toBe(0);
    expect(swapped.audits).toEqual({ count: 0 });
  }, 15_000);
});
