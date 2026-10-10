import fs, {
  fstatSync,
  mkdirSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { sendFileRange } from "../src/workspaces/range-send.js";
import {
  bearerCookie,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
} from "./auth-lifecycle-helpers.js";
import { rawHttpRequest, withListeningApp } from "./raw-http-helpers.js";
import { spyBodyIo, TEXT_MIME, waitForClose, workspaceTempDir } from "./workspace-file-helpers.js";
import {
  expectWorkspaceResponse,
  insertWorkspace,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

const U1_RANGE = "c3".repeat(16);
const MISSING_RANGE = "d4".repeat(16);
/** 1000 bytes, byte i is i % 251: no two aligned windows of the file are equal. */
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_unused, index) => index % 251));
const SONG = Buffer.from(Array.from({ length: 300 }, (_unused, index) => 255 - (index % 256)));
const README = Buffer.alloc(2048, "r");
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const BIG_BYTES = 64 * 1024 * 1024;

/** The workspace `range` of u1, with the fixtures written before anything is spied on. */
function seed(db: DatabaseSync, sandboxRoot: string): string {
  const root = join(sandboxRoot, "u1", "range");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "clip.mp4"), CLIP);
  writeFileSync(join(root, "song.mp3"), SONG);
  writeFileSync(join(root, "readme.md"), README);
  writeFileSync(join(root, "logo.png"), LOGO);
  writeFileSync(join(root, "empty.mp4"), "");
  insertWorkspace(db, U1_RANGE, "u1", "range", "range", 1);
  return root;
}

/** The seeded workspace behind a real assembly, with u1 (zhangsan) logged in. */
function withRangeWorkspace<T>(
  action: (fixture: {
    app: FastifyInstance;
    db: DatabaseSync;
    sandboxRoot: string;
    root: string;
    cookie: string;
  }) => Promise<T>,
  beforeRoutes?: Parameters<typeof withWorkspacesApp>[1],
): Promise<T> {
  return withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
    const root = seed(db, sandboxRoot);
    const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));
    return action({ app, db, sandboxRoot, root, cookie });
  }, beforeRoutes);
}

function fileUrl(path: string, workspaceId = U1_RANGE): string {
  return `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`;
}

/** `requestWorkspaceFile` with request headers, a method and a workspace id of the caller's choice. */
function requestFile(
  app: FastifyInstance,
  cookie: string,
  path: string,
  options: { range?: string; ifRange?: string; method?: "GET" | "HEAD"; id?: string } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: options.method ?? "GET",
    url: fileUrl(path, options.id),
    headers: {
      cookie,
      ...(options.range === undefined ? {} : { range: options.range }),
      ...(options.ifRange === undefined ? {} : { "if-range": options.ifRange }),
    },
  });
}

function expectGuardHeaders(response: LightMyRequestResponse, label: string): void {
  expect(response.headers["x-content-type-options"], label).toBe("nosniff");
  expect(response.headers["cache-control"], label).toBe("no-store");
}

/** The whole file: 200 with its length, `Accept-Ranges`, and no `Content-Range`. */
function expectWhole(
  response: LightMyRequestResponse,
  label: string,
  contentType: string,
  bytes: Buffer,
): void {
  expect(response.statusCode, label).toBe(200);
  expect(response.headers["content-type"], label).toBe(contentType);
  expect(response.headers["content-range"], label).toBeUndefined();
  expect(response.headers["content-length"], label).toBe(String(bytes.length));
  expect(response.headers["accept-ranges"], label).toBe("bytes");
  expect(response.headers["x-workbuddy-size"], label).toBe(String(bytes.length));
  expectGuardHeaders(response, label);
  expect(response.rawPayload.equals(bytes), label).toBe(true);
}

/** One interval of `whole`: 206 with the literal `Content-Range` and length, and exactly those bytes. */
function expectPartial(
  response: LightMyRequestResponse,
  label: string,
  contentType: string,
  whole: Buffer,
  expected: { contentRange: string; length: string; start: number; end: number },
): void {
  expect(response.statusCode, label).toBe(206);
  expect(response.headers["content-type"], label).toBe(contentType);
  expect(response.headers["content-range"], label).toBe(expected.contentRange);
  expect(response.headers["content-length"], label).toBe(expected.length);
  expect(response.headers["accept-ranges"], label).toBe("bytes");
  expect(response.headers["x-workbuddy-size"], label).toBe(String(whole.length));
  expectGuardHeaders(response, label);
  expect(response.rawPayload.length, label).toBe(expected.end - expected.start + 1);
  expect(response.rawPayload.equals(whole.subarray(expected.start, expected.end + 1)), label).toBe(
    true,
  );
}

/** 416: `Content-Range: bytes * /size`, an empty body that is not a JSON envelope, no preview headers. */
function expectUnsatisfiable(
  response: LightMyRequestResponse,
  label: string,
  contentRange: string,
): void {
  expect(response.statusCode, label).toBe(416);
  expect(response.headers["content-range"], label).toBe(contentRange);
  expect(response.payload, label).toBe("");
  expect(response.headers["content-length"], label).toBe("0");
  expect(response.headers["content-type"], label).toBeUndefined();
  expect(response.headers["accept-ranges"], label).toBeUndefined();
  expect(response.headers["x-workbuddy-size"], label).toBeUndefined();
  expectGuardHeaders(response, label);
}

function streamsOpened(): unknown[] {
  return vi.mocked(fs.createReadStream).mock.calls.map(([opened]) => opened);
}

describe("file route: range requests for audio and video", () => {
  it("answers 200, 206 and 416 for a 1000-byte clip.mp4 as the Range header asks", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      expectWhole(await requestFile(app, cookie, "clip.mp4"), "no Range", "video/mp4", CLIP);
      for (const [range, contentRange, length, start, end] of [
        ["bytes=0-99", "bytes 0-99/1000", "100", 0, 99],
        ["bytes=900-", "bytes 900-999/1000", "100", 900, 999],
        ["bytes=-100", "bytes 900-999/1000", "100", 900, 999],
        ["bytes=990-2000", "bytes 990-999/1000", "10", 990, 999],
        ["bytes=0-0", "bytes 0-0/1000", "1", 0, 0],
      ] as const) {
        const response = await requestFile(app, cookie, "clip.mp4", { range });
        expectPartial(response, range, "video/mp4", CLIP, { contentRange, length, start, end });
      }
      expectUnsatisfiable(
        await requestFile(app, cookie, "clip.mp4", { range: "bytes=1000-" }),
        "bytes=1000-",
        "bytes */1000",
      );
      // Several ranges are not served in part: the header is disregarded.
      expectWhole(
        await requestFile(app, cookie, "clip.mp4", { range: "bytes=0-1,5-6" }),
        "bytes=0-1,5-6",
        "video/mp4",
        CLIP,
      );
    });
  });

  it("serves audio in ranges too", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      expectWhole(await requestFile(app, cookie, "song.mp3"), "no Range", "audio/mpeg", SONG);
      expectPartial(
        await requestFile(app, cookie, "song.mp3", { range: "bytes=10-19" }),
        "bytes=10-19",
        "audio/mpeg",
        SONG,
        { contentRange: "bytes 10-19/300", length: "10", start: 10, end: 19 },
      );
    });
  });

  it("answers an unsatisfiable range with an empty 416 and opens nothing", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      spyBodyIo();

      for (const range of ["bytes=1000-", "bytes=-0", "bytes=5000-6000"]) {
        const response = await requestFile(app, cookie, "clip.mp4", { range });
        expectUnsatisfiable(response, range, "bytes */1000");
        expect(response.rawPayload.length, range).toBe(0);
      }

      expect(streamsOpened()).toEqual([]);
      expect(vi.mocked(fs.openSync).mock.calls).toEqual([]);
    });
  });

  it("ignores Range for every other category: readme.md and logo.png come whole", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      for (const [path, contentType, bytes] of [
        ["readme.md", TEXT_MIME, README],
        ["logo.png", "image/png", LOGO],
      ] as const) {
        for (const range of ["bytes=0-9", "bytes=5000-"]) {
          const response = await requestFile(app, cookie, path, { range });
          const label = `${path} ${range}`;
          expect(response.statusCode, label).toBe(200);
          expect(response.headers["content-type"], label).toBe(contentType);
          expect(response.headers["content-range"], label).toBeUndefined();
          expect(response.headers["accept-ranges"], label).toBeUndefined();
          expect(response.headers["x-workbuddy-size"], label).toBe(String(bytes.length));
          expectGuardHeaders(response, label);
          expect(response.rawPayload.equals(bytes), label).toBe(true);
        }
      }
    });
  });

  it("an empty clip is 200 with a zero length, and 416 for any range", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      expectWhole(
        await requestFile(app, cookie, "empty.mp4"),
        "no Range",
        "video/mp4",
        Buffer.alloc(0),
      );
      expectUnsatisfiable(
        await requestFile(app, cookie, "empty.mp4", { range: "bytes=0-" }),
        "bytes=0-",
        "bytes */0",
      );
    });
  });

  it("does not read If-Range: the range is served whatever validator comes with it", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      for (const ifRange of ['"some-etag"', "Wed, 21 Oct 2015 07:28:00 GMT"]) {
        const response = await requestFile(app, cookie, "clip.mp4", {
          range: "bytes=0-99",
          ifRange,
        });
        expectPartial(response, ifRange, "video/mp4", CLIP, {
          contentRange: "bytes 0-99/1000",
          length: "100",
          start: 0,
          end: 99,
        });
      }
    });
  });

  it("HEAD carries the status and headers of its GET with no body and without opening the file", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      spyBodyIo();

      const whole = await requestFile(app, cookie, "clip.mp4", { method: "HEAD" });
      expect(whole.statusCode).toBe(200);
      expect(whole.headers["content-type"]).toBe("video/mp4");
      expect(whole.headers["content-length"]).toBe("1000");
      expect(whole.headers["accept-ranges"]).toBe("bytes");
      expect(whole.headers["content-range"]).toBeUndefined();
      expectGuardHeaders(whole, "HEAD");
      expect(whole.rawPayload.length).toBe(0);

      const partial = await requestFile(app, cookie, "clip.mp4", {
        method: "HEAD",
        range: "bytes=0-99",
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers["content-type"]).toBe("video/mp4");
      expect(partial.headers["content-range"]).toBe("bytes 0-99/1000");
      expect(partial.headers["content-length"]).toBe("100");
      expect(partial.headers["accept-ranges"]).toBe("bytes");
      expectGuardHeaders(partial, "HEAD bytes=0-99");
      expect(partial.rawPayload.length).toBe(0);

      const unsatisfiable = await requestFile(app, cookie, "clip.mp4", {
        method: "HEAD",
        range: "bytes=1000-",
      });
      expectUnsatisfiable(unsatisfiable, "HEAD bytes=1000-", "bytes */1000");

      expect(streamsOpened()).toEqual([]);
    });
  });

  it("an open failure on a ranged request is the sanitized 500 without any range header", async () => {
    await withRangeWorkspace(
      async ({ app, cookie, root }) => {
        const response = await requestFile(app, cookie, "clip.mp4", { range: "bytes=0-99" });

        expectWorkspaceResponse(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.headers["content-range"]).toBeUndefined();
        expect(response.headers["accept-ranges"]).toBeUndefined();
        expect(response.headers["x-workbuddy-size"]).toBeUndefined();
        expect(response.headers["content-length"]).toBe(
          String(Buffer.byteLength(JSON.stringify(INTERNAL_ERROR_ENVELOPE))),
        );
        expect(response.payload).not.toContain(root);
        expect(fs.existsSync(join(root, "clip.mp4"))).toBe(false);
      },
      ({ app, sandboxRoot }) => {
        const target = join(sandboxRoot, "u1", "range", "clip.mp4");
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

describe("file route: a ranged request stays behind the sandbox", () => {
  it("answers the same 404 for another owner's id and a missing id, and 403 with an audit row for traversal and an outward symlink", async () => {
    await withRangeWorkspace(async ({ app, db, sandboxRoot, root, cookie: ownerCookie }) => {
      // Both targets exist and are playable: only the sandbox keeps a byte of them from going out.
      writeFileSync(join(sandboxRoot, "u1", "outside.mp4"), CLIP);
      writeFileSync(join(sandboxRoot, "secret.mp4"), CLIP);
      symlinkSync(join(sandboxRoot, "secret.mp4"), join(root, "link.mp4"));
      const foreignCookie = bearerCookie(await loginSessionId(app, "zhaoliu"));
      const audits = () =>
        db
          .prepare(
            "SELECT kind, actor_id, workspace_id, json_extract(detail, '$.op') AS op, json_extract(detail, '$.relPath') AS rel_path FROM audit_events ORDER BY rowid",
          )
          .all();
      spyBodyIo();

      for (const [id, cookie] of [
        [U1_RANGE, foreignCookie],
        [MISSING_RANGE, ownerCookie],
      ] as const) {
        const response = await requestFile(app, cookie, "../x.mp4", { range: "bytes=0-9", id });
        expectWorkspaceResponse(response, 404, NOT_FOUND_ENVELOPE);
        expect(response.headers["content-range"], id).toBeUndefined();
        expect(response.headers["accept-ranges"], id).toBeUndefined();
      }
      expect(audits()).toEqual([]);

      const escapes = ["../outside.mp4", "link.mp4"];
      for (const path of escapes) {
        const denied = await requestFile(app, ownerCookie, path, { range: "bytes=0-9" });
        expectWorkspaceResponse(denied, 403, {
          error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
        });
        expect(denied.headers["content-range"], path).toBeUndefined();
        expect(denied.headers["accept-ranges"], path).toBeUndefined();
        expect(denied.headers["content-type"], path).toContain("application/json");
      }

      expect(audits()).toEqual(
        escapes.map((path) => ({
          kind: "sandbox.reject",
          actor_id: "u1",
          workspace_id: U1_RANGE,
          op: "read",
          rel_path: path,
        })),
      );
      expect(streamsOpened()).toEqual([]);
    });
  });
});

describe("sendFileRange: a caller other than the file route", () => {
  it("adds Accept-Ranges and the lengths to whatever headers it is handed, and only the 416 headers to a 416", async () => {
    const absPath = join(workspaceTempDir(), "doc.bin");
    writeFileSync(absPath, CLIP);
    const app = fastify();
    app.get("/doc", (request, reply) =>
      sendFileRange(request, reply, {
        absPath,
        size: CLIP.length,
        headers: { "Content-Type": "application/pdf", "X-Frame-Options": "DENY" },
        unsatisfiableHeaders: { "Referrer-Policy": "no-referrer" },
      }),
    );
    try {
      const whole = await app.inject({ method: "GET", url: "/doc" });
      expect(whole.statusCode).toBe(200);
      expect(whole.headers["content-type"]).toBe("application/pdf");
      expect(whole.headers["x-frame-options"]).toBe("DENY");
      expect(whole.headers["accept-ranges"]).toBe("bytes");
      expect(whole.headers["content-length"]).toBe("1000");
      expect(whole.headers["referrer-policy"]).toBeUndefined();
      expect(whole.rawPayload.equals(CLIP)).toBe(true);

      const partial = await app.inject({
        method: "GET",
        url: "/doc",
        headers: { range: "bytes=250-259" },
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.headers["content-type"]).toBe("application/pdf");
      expect(partial.headers["accept-ranges"]).toBe("bytes");
      expect(partial.headers["content-range"]).toBe("bytes 250-259/1000");
      expect(partial.headers["content-length"]).toBe("10");
      // Byte i is i % 251: the interval crosses the wrap at 251.
      expect([...partial.rawPayload]).toEqual([250, 0, 1, 2, 3, 4, 5, 6, 7, 8]);

      const unsatisfiable = await app.inject({
        method: "GET",
        url: "/doc",
        headers: { range: "bytes=1000-" },
      });
      expect(unsatisfiable.statusCode).toBe(416);
      expect(unsatisfiable.headers["content-range"]).toBe("bytes */1000");
      expect(unsatisfiable.headers["referrer-policy"]).toBe("no-referrer");
      expect(unsatisfiable.headers["content-type"]).toBeUndefined();
      expect(unsatisfiable.headers["x-frame-options"]).toBeUndefined();
      expect(unsatisfiable.headers["accept-ranges"]).toBeUndefined();
      expect(unsatisfiable.payload).toBe("");
    } finally {
      await app.close();
    }
  });
});

describe("file route: range requests over a real connection", () => {
  it("a real HTTP client receives 206 with the Content-Range and exactly the first 100 bytes", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      await withListeningApp(app, async (origin) => {
        const response = await fetch(`${origin}${fileUrl("clip.mp4")}`, {
          headers: { cookie, range: "bytes=0-99" },
        });
        const body = Buffer.from(await response.arrayBuffer());

        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 0-99/1000");
        expect(response.headers.get("content-length")).toBe("100");
        expect(response.headers.get("content-type")).toBe("video/mp4");
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(body.length).toBe(100);
        expect(body.equals(CLIP.subarray(0, 100))).toBe(true);
      });
    });
  });

  it("a Range header sent twice reaches the route as one list and is disregarded", async () => {
    await withRangeWorkspace(async ({ app, cookie }) => {
      await withListeningApp(app, async (origin) => {
        // `rawHttpRequest` writes one header per entry: two spellings make two Range lines.
        const raw = await rawHttpRequest(origin, {
          target: fileUrl("clip.mp4"),
          cookie,
          headers: { Range: "bytes=0-9", range: "bytes=20-29" },
        });
        const head = raw.slice(0, raw.indexOf("\r\n\r\n")).toLowerCase();

        expect(head.startsWith("http/1.1 200 ")).toBe(true);
        expect(head).toContain("\r\ncontent-length: 1000");
        expect(head).not.toContain("content-range");
      });
    });
  });

  it("releases the descriptor when the client aborts before the range has been read", async () => {
    await withRangeWorkspace(async ({ app, cookie, root }) => {
      const big = join(root, "big.mp4");
      writeFileSync(big, "");
      truncateSync(big, BIG_BYTES);
      await withListeningApp(app, async (origin) => {
        spyBodyIo();
        const served = () => {
          const spied = vi.mocked(fs.createReadStream);
          const index = spied.mock.calls.findIndex(([opened]) => opened === big);
          // `fd` is the descriptor while the stream is open; the typings leave it out.
          return spied.mock.results[index]?.value as
            | (fs.ReadStream & { fd: number | null })
            | undefined;
        };

        // Aborts at the first body chunk and reports the descriptor the server held open then.
        const descriptor = await new Promise<number>((resolve, reject) => {
          const request = httpGet(
            `${origin}${fileUrl("big.mp4")}`,
            { headers: { cookie, range: "bytes=0-" } },
            (response) => {
              response.once("data", () => {
                const fd = served()?.fd;
                response.destroy();
                if (
                  response.statusCode === 206 &&
                  response.headers["content-range"] === `bytes 0-${BIG_BYTES - 1}/${BIG_BYTES}` &&
                  typeof fd === "number"
                ) {
                  resolve(fd);
                } else {
                  reject(new Error(`unexpected answer ${response.statusCode} or no open stream`));
                }
              });
            },
          );
          request.once("error", reject);
        });

        const stream = served();
        if (stream === undefined) {
          throw new Error("the route opened no stream for big.mp4");
        }
        if (!stream.closed) {
          await waitForClose(stream);
        }
        expect(stream.destroyed).toBe(true);
        // Otherwise the stream simply ran to its end and closed on its own.
        expect(stream.bytesRead).toBeLessThan(BIG_BYTES);
        expect(() => fstatSync(descriptor)).toThrow(/EBADF/);
      });
      // `withListeningApp` has closed the app: an open stream would have kept it from returning.
    });
  }, 15_000);
});
