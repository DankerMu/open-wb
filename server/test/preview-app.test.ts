/**
 * Issue #1069 (s1f-files-page tasks 12.1, 12.3, 12.4): the preview listener, preview-origin
 * 「预览监听器」 — its six scenarios, the refusals around them and the bounded shutdown. The real
 * `createPreviewApp` beside a real main app that issues the tokens (see `preview-app-helpers.ts`).
 * Anything a URL parser would rewrite (dot segments, NUL, a bad escape) goes over a real socket;
 * range requests go to the real listener. Oracles: the spec's literals and the bytes written here.
 */
import {
  closeSync,
  ftruncateSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import { createPreviewApp } from "../src/preview/app.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";
import {
  expectFixedFailure,
  expectNoSuccessHeaders,
  FAILURE_HEADERS,
  fromInject,
  LISI,
  LISI_WORKSPACE,
  OUTSIDE_SECRET,
  PNG_BYTES,
  type PreviewWorld,
  README_TEXT,
  rawAnswer,
  rejectRows,
  WORKSPACE_A,
  WORKSPACE_B,
  withPreviewWorld,
  ZHANGSAN,
} from "./preview-app-helpers.js";
import { auditCount } from "./workspaces-http-helpers.js";

/** A well-formed token nobody issued. */
const UNKNOWN_TOKEN = "d".repeat(64);
const TTL_MS = 900_000;
/** The workspace store's one lookup. */
const ROOT_OF_SQL = "SELECT dir FROM workspaces WHERE owner_id = ? AND id = ? LIMIT 1";
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_, index) => (index * 7) & 0xff));
const SPARSE_BYTES = 64 * 1024 * 1024;
const SETTLE_DEADLINE_MS = 2_000;

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

async function tokenForA(world: PreviewWorld): Promise<string> {
  return (await world.issueToken(world.zhangsan, WORKSPACE_A)).token;
}

/** A plain `fetch` to the bound listener: for targets a URL parser leaves alone. */
function get(world: PreviewWorld, target: string, headers: Record<string, string> = {}) {
  return fetch(`${world.origin}${target}`, { headers });
}

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

function rejectOf(relPath: string) {
  return { actor_id: ZHANGSAN, workspace_id: WORKSPACE_A, op: "read", rel_path: relPath };
}

describe("preview listener: 令牌放行，cookie 不放行", () => {
  it("serves the file to a token without a cookie, answers the fixed 404 to a valid cookie without a valid token, and reads no session table", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const cookie = world.zhangsan;
      const prepare = vi.spyOn(world.db, "prepare");

      const admitted = await world.preview.inject({ url: `/w/${token}/readme.md` });
      const refused = [
        await world.preview.inject({ url: `/w/${UNKNOWN_TOKEN}/readme.md`, headers: { cookie } }),
        await world.preview.inject({ url: "/readme.md", headers: { cookie } }),
        await world.preview.inject({ url: "/api/workspaces", headers: { cookie } }),
      ];

      expect(admitted.statusCode).toBe(200);
      expect(admitted.rawPayload.equals(Buffer.from(README_TEXT))).toBe(true);
      expect(admitted.headers["set-cookie"]).toBeUndefined();
      for (const response of refused) {
        expectFixedFailure(fromInject(response), 404);
      }
      const statements = prepare.mock.calls.map(([sql]) => sql);
      // The spy is live: the admitted request looked its workspace up, itself and inside resolve.
      expect(statements).toEqual([ROOT_OF_SQL, ROOT_OF_SQL]);
      expect(statements.filter((sql) => sql.includes("auth_sessions"))).toEqual([]);
    });
  });

  it("answers byte for byte the same with and without a valid session cookie", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      for (const url of [`/w/${token}/readme.md`, `/w/${UNKNOWN_TOKEN}/readme.md`, "/api/info"]) {
        const bare = await world.preview.inject({ url });
        const withCookie = await world.preview.inject({
          url,
          headers: { cookie: world.zhangsan },
        });

        expect(withCookie.statusCode, url).toBe(bare.statusCode);
        expect(withCookie.rawPayload.equals(bare.rawPayload), url).toBe(true);
        const { date: _bareDate, ...bareHeaders } = bare.headers;
        const { date: _cookieDate, ...cookieHeaders } = withCookie.headers;
        expect(cookieHeaders, url).toEqual(bareHeaders);
      }
    });
  });

  it("has no cookie parser, no principal, no database handle and exactly one route", async () => {
    await withPreviewWorld(async ({ preview }) => {
      expect(preview.hasRequestDecorator("cookies")).toBe(false);
      expect(preview.hasReplyDecorator("setCookie")).toBe(false);
      expect(preview.hasRequestDecorator("principal")).toBe(false);
      expect(preview.hasDecorator("db")).toBe(false);
      expect(preview.hasDecorator("authNow")).toBe(false);
      await preview.ready();
      expect(preview.printRoutes()).toBe(
        "└── /\n    └── w/\n        └── :token\n            └── /\n                └── * (GET, HEAD)\n",
      );
      // Its hooks: the method gate and the shutdown's idle sweep — nothing that authenticates.
      expect(preview.printRoutes({ commonPrefix: false, includeHooks: true })).toBe(
        '└── * (GET)\n    • (onRequest) ["anonymous()"]\n    • (onResponse) ["anonymous()"]\n' +
          '    * (HEAD)\n    • (onRequest) ["anonymous()"]\n' +
          '    • (onSend) ["headRouteOnSendHandler()"]\n    • (onResponse) ["anonymous()"]\n',
      );
    });
  });
});

describe("preview listener: 相对资源与子目录", () => {
  it("serves a page and the resources it refers to from under the same token prefix", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const page = await get(world, `/w/${token}/site/index.html`);
      const style = await get(world, `/w/${token}/site/style.css`);
      const image = await get(world, `/w/${token}/site/img/a.png`);

      expect([page.status, style.status, image.status]).toEqual([200, 200, 200]);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(await page.text()).toBe(
        '<!doctype html><link rel="stylesheet" href="./style.css"><img src="img/a.png">',
      );
      expect(await style.text()).toBe("body { color: red; }\n");
      expect((await bytesOf(image)).equals(PNG_BYTES)).toBe(true);
    });
  });

  it("answers HEAD with the headers of the GET and no body", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const head = await rawAnswer(world.origin, `/w/${token}/site/style.css`, { method: "HEAD" });

      expect(head.status).toBe(200);
      expect(head.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(head.headers["content-length"]).toBe("21");
      expect(head.body).toBe("");
    });
  });

  it("reads a file named with a trailing slash, typed by its own name", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const response = await get(world, `/w/${token}/readme.md/?ignored=1`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe(README_TEXT);
    });
  });
});

describe("preview listener: 拒绝项", () => {
  it("answers 404 for an empty path, a directory with and without a slash, and a missing target — never a listing or an index.html", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      for (const path of ["", "site", "site/", "missing.html", "site/img/", "site/index.html/x"]) {
        const answer = await rawAnswer(world.origin, `/w/${token}/${path}`);
        expectFixedFailure(answer, 404);
      }
      expect(rejectRows(world.db)).toEqual([]);
    });
  });

  it("answers 403 for traversal and for symlinks, each leaving one sandbox.reject row of the token's account with op read", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const vectors = [
        ["%2e%2e/%2e%2e/etc/passwd", "../../etc/passwd"],
        ["link", "link"],
        ["linkdir/x", "linkdir/x"],
        ["../secret.txt", "../secret.txt"],
        ["site/%2E%2E/%2E%2E/%2E%2E/secret.txt", "site/../../../secret.txt"],
        ["/etc/passwd", "/etc/passwd"],
        [`${"n".repeat(300)}/x`, `${"n".repeat(300)}/x`],
      ] as const;
      for (const [path] of vectors) {
        const answer = await rawAnswer(world.origin, `/w/${token}/${path}`);
        expectFixedFailure(answer, 403);
        expect(answer.body).not.toContain(OUTSIDE_SECRET);
      }
      expect(rejectRows(world.db)).toEqual(vectors.map(([, relPath]) => rejectOf(relPath)));
    });
  });

  it("answers 403 with a sandbox.reject row for a NUL byte in the path", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const answer = await rawAnswer(world.origin, `/w/${token}/readme.md%00.html`);

      expectFixedFailure(answer, 403);
      expect(rejectRows(world.db)).toEqual([
        expect.objectContaining({ actor_id: ZHANGSAN, workspace_id: WORKSPACE_A, op: "read" }),
      ]);
    });
  });

  it("answers 404 to every other method, before any body is parsed", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const url = `/w/${token}/readme.md`;
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        expectFixedFailure(await rawAnswer(world.origin, url, { method }), 404);
      }
      // Bodies the framework would refuse on its own with 415 and 400, were it asked first.
      const bodies = [
        { "content-type": "text/xml", payload: "<a/>" },
        { "content-type": "application/json", payload: "{" },
      ];
      for (const { payload, ...headers } of bodies) {
        for (const target of [url, "/elsewhere"]) {
          const response = await world.preview.inject({
            method: "POST",
            url: target,
            headers,
            payload,
          });
          expectFixedFailure(fromInject(response), 404);
        }
      }
      expect(auditCount(world.db)).toEqual({ count: 0 });
    });
  });

  it("answers 404 once the token has expired", async () => {
    await withPreviewWorld(async (world) => {
      const { token } = world.registry.issue(
        { ownerId: ZHANGSAN, workspaceId: WORKSPACE_A, embedOrigin: null },
        Date.now() - TTL_MS,
      );

      expectFixedFailure(await rawAnswer(world.origin, `/w/${token}/readme.md`), 404);
    });
  });

  it("answers 404 for every path that is not /w/<token>/<path>", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      for (const target of [
        "/",
        `/w/${token}`,
        `/W/${token}/readme.md`,
        `/o/${token}/readme.md`,
        `/w//readme.md`,
        "/readme.md",
        "/api/workspaces",
        "/api/healthz",
        "/index.html",
      ]) {
        expectFixedFailure(await rawAnswer(world.origin, target), 404);
      }
    });
  });

  it("checks the token before the path: an unknown token with a traversal is 404 and writes no audit row", async () => {
    await withPreviewWorld(async (world) => {
      const answer = await rawAnswer(world.origin, `/w/${UNKNOWN_TOKEN}/%2e%2e/%2e%2e/etc/passwd`);

      expectFixedFailure(answer, 404);
      expect(auditCount(world.db)).toEqual({ count: 0 });
    });
  });

  it("decodes the path once: a doubly encoded dot-dot is an ordinary name that does not exist", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const answer = await rawAnswer(world.origin, `/w/${token}/%252e%252e/x`);

      expectFixedFailure(answer, 404);
      expect(auditCount(world.db)).toEqual({ count: 0 });
    });
  });

  it("answers the fixed 404 where the framework would echo the path: a bad escape and an over-long token", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      for (const target of [`/w/${token}/%zz`, `/w/${"a".repeat(101)}/readme.md`]) {
        expectFixedFailure(await rawAnswer(world.origin, target), 404);
      }
    });
  });

  it("never puts the token or the requested path into a body", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const marker = "zq-unique-marker";
      const answers = [
        await rawAnswer(world.origin, `/w/${token}/${marker}.html`),
        await rawAnswer(world.origin, `/w/${token}/${marker}/`),
        await rawAnswer(world.origin, `/w/${token}/../${marker}`),
        await rawAnswer(world.origin, `/w/${token}/${marker}`, { method: "POST" }),
        await rawAnswer(world.origin, `/w/${token}/${marker}%zz`),
        await rawAnswer(world.origin, `/${marker}/${token}`),
      ];

      expect(answers.map(({ status }) => status)).toEqual([404, 404, 403, 404, 404, 404]);
      for (const { body } of answers) {
        expect(body).not.toContain(token);
        expect(body).not.toContain(marker);
      }
    });
  });
});

describe("preview listener: 作用域只有一个工作空间", () => {
  it("reads nothing of the owner's other workspace nor of another account's, whatever the request names", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      const lisiToken = (await world.issueToken(world.lisi, LISI_WORKSPACE)).token;

      for (const target of [
        `/w/${token}/only-b.txt`,
        `/w/${token}/only-b.txt?workspaceId=${WORKSPACE_B}`,
        `/w/${token}/only-b.txt?workspaceId=${LISI_WORKSPACE}&ownerId=${LISI}`,
      ]) {
        expectFixedFailure(await rawAnswer(world.origin, target), 404);
      }
      // The same name is there to be read, by the token of the workspace it is in.
      const own = await get(world, `/w/${lisiToken}/only-b.txt`);
      expect(own.status).toBe(200);
      expect(await own.text()).toBe("lisi 的文件");
      // And lisi's token reads nothing of zhangsan's A.
      expectFixedFailure(await rawAnswer(world.origin, `/w/${lisiToken}/readme.md`), 404);
      expect(rejectRows(world.db)).toEqual([]);
    });
  });
});

describe("preview listener: 空间消失后令牌失效", () => {
  it("answers 404 without an audit row once the root directory was moved away", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      expect((await get(world, `/w/${token}/readme.md`)).status).toBe(200);
      renameSync(world.root, `${world.root}-moved`);

      expectFixedFailure(await rawAnswer(world.origin, `/w/${token}/readme.md`), 404);
      expect(auditCount(world.db)).toEqual({ count: 0 });
    });
  });

  it("serves nothing and writes no audit row once the root is a file or a symlink: the store refuses such a root and the answer is the empty 500", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      renameSync(world.root, `${world.root}-moved`);
      const replacements = [
        () => writeFileSync(world.root, OUTSIDE_SECRET),
        // A directory elsewhere that holds a readme.md of its own.
        () => symlinkSync(`${world.root}-moved`, world.root),
      ];
      for (const replace of replacements) {
        rmSync(world.root, { force: true });
        replace();
        const answer = await rawAnswer(world.origin, `/w/${token}/readme.md`);

        expect(answer.status).toBe(500);
        expect(answer.body).toBe("");
        expect(answer.headers).toMatchObject(FAILURE_HEADERS);
        expectNoSuccessHeaders(answer);
      }
      expect(auditCount(world.db)).toEqual({ count: 0 });
    });
  });

  it("answers 404 without an audit row once the workspace is no longer the account's", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      world.db.prepare("UPDATE workspaces SET owner_id = ? WHERE id = ?").run(LISI, WORKSPACE_A);

      expectFixedFailure(await rawAnswer(world.origin, `/w/${token}/readme.md`), 404);
      expect(auditCount(world.db)).toEqual({ count: 0 });
    });
  });

  it("answers 404 when the sandbox itself no longer finds the workspace", async () => {
    // The handler runs its checks in one synchronous stretch (as read from the code), so the real
    // store gives no way to make the sandbox's lookup differ from the listener's own: the
    // sandbox's `not_found` comes from a stand-in at the constructor's seam.
    const preview = createPreviewApp({
      store: { rootOf: () => tempDir() },
      sandbox: {
        resolve: () => {
          throw new HttpError("not_found");
        },
      },
      tokens: {
        lookup: () => ({ ownerId: ZHANGSAN, workspaceId: WORKSPACE_A, embedOrigin: null }),
      },
    });
    try {
      const response = await preview.inject({ url: `/w/${UNKNOWN_TOKEN}/readme.md` });

      expectFixedFailure(fromInject(response), 404);
    } finally {
      await preview.close();
    }
  });
});

describe("preview listener: requests do not renew the token", () => {
  it("leaves the expiry where the issuing call put it and never calls issue", async () => {
    await withPreviewWorld(async (world) => {
      const { token, expiresAt } = await world.issueToken(world.zhangsan, WORKSPACE_A);
      expect(world.issueCalls).toHaveLength(1);

      for (const target of [`/w/${token}/readme.md`, `/w/${token}/site/index.html`]) {
        expect((await get(world, target)).status).toBe(200);
        expect((await get(world, target, { range: "bytes=0-1" })).status).toBe(206);
        expect((await rawAnswer(world.origin, target, { method: "HEAD" })).status).toBe(200);
      }

      expect(world.issueCalls).toHaveLength(1);
      expect(world.registry.lookup(token, expiresAt - 1)).not.toBeNull();
      // Last: a lookup at the expiry drops the record.
      expect(world.registry.lookup(token, expiresAt)).toBeNull();
    });
  });
});

describe("preview listener: 范围请求", () => {
  it("answers 206 with the interval and nothing else of the file, 416 with an empty body, and 200 with the whole file", async () => {
    await withPreviewWorld(async (world) => {
      const token = await tokenForA(world);
      writeFileSync(join(world.root, "clip.mp4"), CLIP);
      const target = `/w/${token}/clip.mp4`;

      const partial = await get(world, target, { range: "bytes=0-99" });
      const unsatisfiable = await get(world, target, { range: "bytes=1000-" });
      const whole = await get(world, target);

      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-range")).toBe("bytes 0-99/1000");
      expect(partial.headers.get("content-length")).toBe("100");
      expect(partial.headers.get("accept-ranges")).toBe("bytes");
      expect(partial.headers.get("content-type")).toBe("video/mp4");
      expect((await bytesOf(partial)).equals(CLIP.subarray(0, 100))).toBe(true);

      // An interval that does not start at byte 0: a body that restarted from the top would differ.
      for (const [range, start, end] of [
        ["bytes=900-949", 900, 949],
        ["bytes=-10", 990, 999],
      ] as const) {
        const inner = await get(world, target, { range });

        expect(inner.status, range).toBe(206);
        expect(inner.headers.get("content-range"), range).toBe(`bytes ${start}-${end}/1000`);
        expect((await bytesOf(inner)).equals(CLIP.subarray(start, end + 1)), range).toBe(true);
      }

      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe("bytes */1000");
      expect((await bytesOf(unsatisfiable)).length).toBe(0);

      expect(whole.status).toBe(200);
      expect(whole.headers.get("accept-ranges")).toBe("bytes");
      expect(whole.headers.get("content-length")).toBe("1000");
      expect(whole.headers.get("content-range")).toBeNull();
      expect((await bytesOf(whole)).equals(CLIP)).toBe(true);
    });
  });
});

describe("preview listener: bounded shutdown", () => {
  it("closes within the budget while a client holds a download open, reporting the forced close once", async () => {
    let forced = 0;
    await withPreviewWorld(
      async (world) => {
        const token = await tokenForA(world);
        const sparse = openSync(join(world.root, "big.bin"), "w");
        ftruncateSync(sparse, SPARSE_BYTES);
        closeSync(sparse);
        // Reads the first chunk and then nothing: the response can never finish on its own.
        const stalled = await new Promise<{ destroy(): void }>((resolve, reject) => {
          const request = httpGet(`${world.origin}/w/${token}/big.bin`, (response) => {
            response.on("error", () => undefined);
            response.once("data", () => {
              response.pause();
              resolve(request);
            });
          });
          request.on("error", reject);
        });

        try {
          const settled = await Promise.race([
            world.preview.close().then(() => true),
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), SETTLE_DEADLINE_MS).unref();
            }),
          ]);

          expect(settled).toBe(true);
          expect(forced).toBe(1);
        } finally {
          stalled.destroy();
        }
      },
      {
        listenerCloseBudgetMs: 50,
        onListenerForceClose: () => {
          forced += 1;
        },
      },
    );
  });

  it("closes an instance that never listened", async () => {
    const preview = createPreviewApp({
      store: { rootOf: () => null },
      sandbox: {
        resolve: () => {
          throw new Error("unreachable: no token resolves");
        },
      },
      tokens: { lookup: () => null },
    });

    await expect(preview.close()).resolves.toBeUndefined();
  });
});
