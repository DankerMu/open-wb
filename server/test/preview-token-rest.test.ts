/**
 * Issue #1067 (s1f-files-page tasks 11.2, 11.3): `POST /api/workspaces/:id/preview-token` through
 * the REST seam — preview-origin 「预览令牌签发端点」 (签发与复用 / 对外来源与转换可用 / 归属与请求体),
 * http-service-skeleton 「工作空间新增两条归属路由」 (the preview-token half) and 「未装配预览的可注入
 * app」. Real `createApp`, real SQLite, real directories and the real token registry behind a
 * wrapper that records every `issue` call. Oracles: the spec's literals, the header values sent
 * here and the pinned clock.
 */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createPreviewTokens, type PreviewTokens } from "../src/preview/tokens.js";
import type { WorkspacePreviewDependencies } from "../src/workspaces/rest-preview-token.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import { removeTempDirs } from "./core-db-helpers.js";
import {
  type BodyInput,
  expectEnvelope,
  INJECT_BODIES,
  PRE_PARSER_BODIES,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";
import { insertWorkspace, withWorkspacesApp } from "./workspaces-http-helpers.js";

const ZHANGSAN = "u1";
const LISI = "u3";
const WORKSPACE = "a".repeat(32);
const LISI_WORKSPACE = "b".repeat(32);
const MISSING_WORKSPACE = "c".repeat(32);
const TEMP_SESSION = "5".repeat(32);
/** The main site in the spec's scenario; the preview listener is on another port. */
const MAIN_HOST = "127.0.0.1:3000";
const MAIN_ORIGIN = "http://127.0.0.1:3000";
const PREVIEW_PORT = 41_735;
const T0 = 1_800_000_000_000;
const TTL_MS = 900_000;
const DEFAULT_DOCUMENT_MAX_BYTES = 104_857_600;
const SIX_KEYS = [
  "token",
  "base",
  "officeBase",
  "expiresAt",
  "documentMaxBytes",
  "officeAvailable",
];
const TOKEN_SHAPE = /^[0-9a-f]{64}$/u;
const DROP_HOST_HEADER = "x-test-drop-host";
const TLS_SOCKET_HEADER = "x-test-tls-socket";

type Binding = Parameters<PreviewTokens["issue"]>[0];

interface Issued {
  token: string;
  base: string;
  officeBase: string;
  expiresAt: number;
  documentMaxBytes: number;
  officeAvailable: boolean;
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  /** The real registry the route issues into. */
  registry: PreviewTokens;
  /** Every `issue` call the route made, in order. */
  issueCalls: Array<{ binding: Binding; now: number }>;
  zhangsan: string;
  lisi: string;
}

type Assembly = NonNullable<Parameters<typeof withWorkspacesApp>[2]>["assembly"];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeTempDirs();
});

/**
 * zhangsan's workspace `files` and lisi's workspace `own`, both with their root directories, on an
 * app assembled with the preview dependency: the real registry, `PREVIEW_PORT`, no external
 * origin, the default document limit and no converter — each replaceable through `preview`.
 */
async function withPreviewWorld(
  action: (world: World) => Promise<void>,
  preview: Partial<WorkspacePreviewDependencies> = {},
  assembly: Assembly = {},
): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const registry = createPreviewTokens();
  const issueCalls: World["issueCalls"] = [];
  await withWorkspacesApp(
    async ({ app, db, sandboxRoot }) => {
      mkdirSync(join(sandboxRoot, ZHANGSAN, "files"), { recursive: true });
      insertWorkspace(db, WORKSPACE, ZHANGSAN, "files", "files", 1);
      mkdirSync(join(sandboxRoot, LISI, "own"), { recursive: true });
      insertWorkspace(db, LISI_WORKSPACE, LISI, "own", "own", 2);
      const zhangsan = await cookieFor(app, "zhangsan");
      const lisi = await cookieFor(app, "lisi");
      await action({ app, db, sandboxRoot, registry, issueCalls, zhangsan, lisi });
    },
    // HTTP/1.0 may come without a Host header; inject always adds one, so a marked request drops it.
    // Inject has no TLS either: a marked request gets the flag a TLS socket carries.
    ({ app }) => {
      app.addHook("onRequest", (request, _reply, done) => {
        if (request.raw.headers[DROP_HOST_HEADER] !== undefined) {
          delete request.raw.headers.host;
        }
        if (request.raw.headers[TLS_SOCKET_HEADER] !== undefined) {
          Object.assign(request.raw.socket, { encrypted: true });
        }
        done();
      });
    },
    {
      assembly: {
        ...assembly,
        preview: {
          tokens: {
            issue(binding, now) {
              issueCalls.push({ binding: { ...binding }, now });
              return registry.issue(binding, now);
            },
          },
          port: () => PREVIEW_PORT,
          documentMaxBytes: DEFAULT_DOCUMENT_MAX_BYTES,
          officeAvailable: false,
          ...preview,
        },
      },
    },
  );
}

/** Injects the route; no `body` sends neither payload nor content type. */
function issueToken(
  app: FastifyInstance,
  workspaceId: string,
  cookie: string | null,
  headers: Record<string, string> = {},
  body?: BodyInput,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/preview-token`,
    headers: {
      host: MAIN_HOST,
      ...(cookie === null ? {} : { cookie }),
      ...(body?.contentType === undefined ? {} : { "content-type": body.contentType }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: body.payload }),
  });
}

/** A 200 with exactly the six keys in the specified order and `no-store`; returns the body. */
function issuedOf(response: LightMyRequestResponse): Issued {
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json() as Issued;
  expect(Object.keys(body)).toEqual(SIX_KEYS);
  expect(body.token).toMatch(TOKEN_SHAPE);
  return body;
}

function auditCount(db: DatabaseSync): unknown {
  return db.prepare("SELECT count(*) AS count FROM audit_events").get();
}

describe("preview-token: 签发与复用", () => {
  it("issues one token per workspace, renews it on the second call and writes no audit row", async () => {
    await withPreviewWorld(async ({ app, db, registry, issueCalls, zhangsan }) => {
      const auditBefore = auditCount(db);

      const first = issuedOf(await issueToken(app, WORKSPACE, zhangsan, { origin: MAIN_ORIGIN }));
      expect(first).toEqual({
        token: first.token,
        base: `http://127.0.0.1:${PREVIEW_PORT}/w/${first.token}/`,
        officeBase: `http://127.0.0.1:${PREVIEW_PORT}/o/${first.token}/`,
        expiresAt: T0 + TTL_MS,
        documentMaxBytes: DEFAULT_DOCUMENT_MAX_BYTES,
        officeAvailable: false,
      });

      vi.setSystemTime(T0 + 300_000);
      const second = issuedOf(await issueToken(app, WORKSPACE, zhangsan, { origin: MAIN_ORIGIN }));
      expect(second).toEqual({ ...first, expiresAt: T0 + 300_000 + TTL_MS });

      expect(auditCount(db)).toEqual(auditBefore);
      expect(issueCalls).toEqual([
        {
          binding: { ownerId: ZHANGSAN, workspaceId: WORKSPACE, embedOrigin: MAIN_ORIGIN },
          now: T0,
        },
        {
          binding: { ownerId: ZHANGSAN, workspaceId: WORKSPACE, embedOrigin: MAIN_ORIGIN },
          now: T0 + 300_000,
        },
      ]);
      expect(registry.lookup(first.token, T0 + 300_000)).toEqual({
        ownerId: ZHANGSAN,
        workspaceId: WORKSPACE,
        embedOrigin: MAIN_ORIGIN,
      });
    });
  });

  it("binds the token to the caller and to the :id of the request, never to another account or workspace", async () => {
    await withPreviewWorld(async ({ app, registry, zhangsan, lisi }) => {
      const own = issuedOf(await issueToken(app, WORKSPACE, zhangsan, { origin: MAIN_ORIGIN }));
      const theirs = issuedOf(
        await issueToken(app, LISI_WORKSPACE, lisi, { origin: "http://lisi.test:3000" }),
      );

      expect(theirs.token).not.toBe(own.token);
      expect(registry.lookup(own.token, T0)).toEqual({
        ownerId: ZHANGSAN,
        workspaceId: WORKSPACE,
        embedOrigin: MAIN_ORIGIN,
      });
      expect(registry.lookup(theirs.token, T0)).toEqual({
        ownerId: LISI,
        workspaceId: LISI_WORKSPACE,
        embedOrigin: "http://lisi.test:3000",
      });
    });
  });

  it("records the Origin header as sent — null without one — and follows it on every renewal", async () => {
    await withPreviewWorld(async ({ app, registry, zhangsan }) => {
      const { token } = issuedOf(await issueToken(app, WORKSPACE, zhangsan));
      expect(registry.lookup(token, T0)?.embedOrigin).toBeNull();

      // Not validated and not normalised here: the trailing slash, the literal and the junk stay.
      for (const origin of ["http://a.test/", "null", "HTTP://A.test:3000", "not an origin", ""]) {
        const renewed = issuedOf(await issueToken(app, WORKSPACE, zhangsan, { origin }));
        expect(renewed.token, origin).toBe(token);
        expect(registry.lookup(token, T0)?.embedOrigin, origin).toBe(origin);
      }

      // Neither Referer nor Host stands in for a missing Origin.
      issuedOf(await issueToken(app, WORKSPACE, zhangsan, { referer: "http://referer.test/x" }));
      expect(registry.lookup(token, T0)?.embedOrigin).toBeNull();
    });
  });

  it("issues for a temporary workspace like for any other", async () => {
    await withPreviewWorld(async ({ app, db, sandboxRoot, registry, zhangsan }) => {
      const store = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
      const temporary = seedTemporaryWorkspaceSession(db, store, ZHANGSAN, TEMP_SESSION);

      const { token } = issuedOf(await issueToken(app, temporary.id, zhangsan));

      expect(registry.lookup(token, T0)).toEqual({
        ownerId: ZHANGSAN,
        workspaceId: temporary.id,
        embedOrigin: null,
      });
    });
  });
});

describe("preview-token: 对外来源与转换可用", () => {
  it("uses the configured origin verbatim without asking for the port, and reports the injected limit and converter", async () => {
    await withPreviewWorld(
      async ({ app, zhangsan }) => {
        const issued = issuedOf(
          await issueToken(app, WORKSPACE, zhangsan, { origin: MAIN_ORIGIN }),
        );
        expect(issued).toEqual({
          token: issued.token,
          base: `https://preview.example.test/w/${issued.token}/`,
          officeBase: `https://preview.example.test/o/${issued.token}/`,
          expiresAt: T0 + TTL_MS,
          documentMaxBytes: 12_345,
          officeAvailable: true,
        });
      },
      {
        origin: "https://preview.example.test",
        port: () => {
          throw new Error("the port must not be read when an origin is configured");
        },
        documentMaxBytes: 12_345,
        officeAvailable: true,
      },
    );
  });

  it.each([
    ["an IPv4 host with the main port", "127.0.0.1:3000", "http://127.0.0.1"],
    ["an IPv6 literal with the main port", "[::1]:3000", "http://[::1]"],
    ["an IPv6 literal without a port", "[2001:db8::1]", "http://[2001:db8::1]"],
    ["a name without a port", "workbuddy.example.test", "http://workbuddy.example.test"],
    ["a name with the main port", "workbuddy.example.test:8443", "http://workbuddy.example.test"],
    // Not a host name, but it still makes a URL: it goes into the answer as sent.
    ["a name carrying a path", "a.test/x:3000", "http://a.test/x"],
  ])(
    "derives the origin from %s: the host name of the request and the preview port",
    async (_name, host, expected) => {
      await withPreviewWorld(async ({ app, zhangsan }) => {
        const issued = issuedOf(await issueToken(app, WORKSPACE, zhangsan, { host }));
        expect(issued.base).toBe(`${expected}:${PREVIEW_PORT}/w/${issued.token}/`);
        expect(issued.officeBase).toBe(`${expected}:${PREVIEW_PORT}/o/${issued.token}/`);
      });
    },
  );

  it("does not take the host or the protocol from forwarding headers", async () => {
    await withPreviewWorld(async ({ app, zhangsan }) => {
      const issued = issuedOf(
        await issueToken(app, WORKSPACE, zhangsan, {
          "x-forwarded-host": "evil.example.test:9999",
          "x-forwarded-proto": "https",
          "x-forwarded-port": "9999",
          forwarded: "host=evil.example.test;proto=https",
        }),
      );
      expect(issued.base).toBe(`http://127.0.0.1:${PREVIEW_PORT}/w/${issued.token}/`);
      expect(issued.officeBase).toBe(`http://127.0.0.1:${PREVIEW_PORT}/o/${issued.token}/`);
    });
  });

  it("takes the protocol from the connection of the request: https over TLS", async () => {
    await withPreviewWorld(async ({ app, zhangsan }) => {
      const issued = issuedOf(
        await issueToken(app, WORKSPACE, zhangsan, { [TLS_SOCKET_HEADER]: "1" }),
      );
      expect(issued.base).toBe(`https://127.0.0.1:${PREVIEW_PORT}/w/${issued.token}/`);
      expect(issued.officeBase).toBe(`https://127.0.0.1:${PREVIEW_PORT}/o/${issued.token}/`);
    });
  });

  it("reads the preview port on every request", async () => {
    let port = PREVIEW_PORT;
    await withPreviewWorld(
      async ({ app, zhangsan }) => {
        const first = issuedOf(await issueToken(app, WORKSPACE, zhangsan));
        port = 41_999;
        const second = issuedOf(await issueToken(app, WORKSPACE, zhangsan));
        expect(first.base).toBe(`http://127.0.0.1:${PREVIEW_PORT}/w/${first.token}/`);
        expect(second.base).toBe(`http://127.0.0.1:41999/w/${first.token}/`);
      },
      { port: () => port },
    );
  });

  it.each([
    ["no Host header", { [DROP_HOST_HEADER]: "1" }],
    ["a Host header with an empty host name", { host: ":3000" }],
    ["a Host header that is no host name", { host: "a b:3000" }],
  ])("refuses %s with 400 and issues nothing", async (_name, headers) => {
    await withPreviewWorld(async ({ app, issueCalls, zhangsan }) => {
      expectEnvelope(
        await issueToken(app, WORKSPACE, zhangsan, headers),
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expect(issueCalls).toEqual([]);
    });
  });
});

describe("preview-token: 真实 socket", () => {
  it("issues for a body-less POST with the preview port in place of the main one, and refuses {}", async () => {
    await withPreviewWorld(async ({ app, issueCalls, zhangsan }) => {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const mainPort = new URL(address).port;
      expect(mainPort).not.toBe(String(PREVIEW_PORT));
      const url = `${address}/api/workspaces/${WORKSPACE}/preview-token`;

      const response = await fetch(url, {
        method: "POST",
        headers: { cookie: zhangsan, origin: MAIN_ORIGIN },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const issued = (await response.json()) as Issued;
      expect(Object.keys(issued)).toEqual(SIX_KEYS);
      expect(issued.base).toBe(`http://127.0.0.1:${PREVIEW_PORT}/w/${issued.token}/`);
      expect(issueCalls).toHaveLength(1);

      const withBody = await fetch(url, {
        method: "POST",
        headers: { cookie: zhangsan, "content-type": "application/json" },
        body: "{}",
      });
      expect(withBody.status).toBe(400);
      expect(withBody.headers.get("cache-control")).toBe("no-store");
      expect(await withBody.text()).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
      expect(issueCalls).toHaveLength(1);
    });
  });
});

describe("preview-token: 归属与请求体", () => {
  it("answers another account's, an unknown and a traversal id with the 404 of every workspace route, whatever the body", async () => {
    await withPreviewWorld(async ({ app, db, issueCalls, zhangsan, lisi }) => {
      const auditBefore = auditCount(db);
      const bodies: Array<BodyInput | undefined> = [
        ...PRE_PARSER_BODIES,
        { name: "{} JSON", payload: "{}", contentType: "application/json" },
      ];
      // The last two never reach a route: the app refuses an encoded dot segment or slash first.
      const callers: Array<[name: string, id: string, cookie: string, routed: boolean]> = [
        ["lisi on zhangsan's workspace", WORKSPACE, lisi, true],
        ["zhangsan on lisi's workspace", LISI_WORKSPACE, zhangsan, true],
        ["zhangsan on an unknown id", MISSING_WORKSPACE, zhangsan, true],
        ["lisi on an unknown id", MISSING_WORKSPACE, lisi, true],
        ["zhangsan on an encoded ..", "%2e%2e", zhangsan, false],
        ["zhangsan on another account's directory", "%2e%2e%2fu3%2fown", zhangsan, false],
      ];
      for (const [name, id, cookie, routed] of callers) {
        // What every other workspace route answers for this id and this caller.
        const tree = await app.inject({
          method: "GET",
          url: `/api/workspaces/${id}/tree`,
          headers: { cookie },
        });
        expect(tree.statusCode, name).toBe(404);
        expect(tree.headers["cache-control"], name).toBe(routed ? "no-store" : undefined);
        for (const body of bodies) {
          const response = await issueToken(app, id, cookie, { origin: MAIN_ORIGIN }, body);
          expect(
            {
              status: response.statusCode,
              cacheControl: response.headers["cache-control"],
              payload: response.payload,
            },
            `${name} / ${body?.name}`,
          ).toEqual({
            status: 404,
            cacheControl: tree.headers["cache-control"],
            payload: JSON.stringify(NOT_FOUND_ENVELOPE),
          });
          expect(response.payload, `${name} / ${body?.name}`).toBe(tree.payload);
        }
      }

      expect(issueCalls).toEqual([]);
      expect(auditCount(db)).toEqual(auditBefore);
    });
  });

  it("answers 401 without a session, before the workspace is looked at and whatever the body", async () => {
    await withPreviewWorld(async ({ app, issueCalls }) => {
      for (const id of [WORKSPACE, MISSING_WORKSPACE]) {
        for (const body of PRE_PARSER_BODIES) {
          expectEnvelope(
            await issueToken(app, id, null, { origin: MAIN_ORIGIN }, body),
            401,
            UNAUTHORIZED_ENVELOPE,
          );
        }
      }
      expectEnvelope(
        await issueToken(app, WORKSPACE, `workbuddy_session=${"0".repeat(64)}`),
        401,
        UNAUTHORIZED_ENVELOPE,
      );
      expect(issueCalls).toEqual([]);
    });
  });

  it.each(INJECT_BODIES)(
    "refuses $name on the owner's own workspace with 400 and issues nothing",
    async (body) => {
      await withPreviewWorld(async ({ app, db, issueCalls, zhangsan }) => {
        const auditBefore = auditCount(db);
        expectEnvelope(
          await issueToken(app, WORKSPACE, zhangsan, { origin: MAIN_ORIGIN }, body),
          400,
          BAD_REQUEST_ENVELOPE,
        );
        expect(issueCalls).toEqual([]);
        expect(auditCount(db)).toEqual(auditBefore);
      });
    },
  );

  it("answers 404 once the workspace's root directory is gone", async () => {
    await withPreviewWorld(async ({ app, sandboxRoot, issueCalls, zhangsan }) => {
      const root = join(sandboxRoot, ZHANGSAN, "files");
      renameSync(root, join(sandboxRoot, ZHANGSAN, "moved"));
      expectEnvelope(await issueToken(app, WORKSPACE, zhangsan), 404, NOT_FOUND_ENVELOPE);
      expect(issueCalls).toEqual([]);

      renameSync(join(sandboxRoot, ZHANGSAN, "moved"), root);
      issuedOf(await issueToken(app, WORKSPACE, zhangsan));
      expect(issueCalls).toHaveLength(1);
    });
  });

  it("answers the generic 500 without a token when the registry refuses to issue", async () => {
    await withPreviewWorld(
      async ({ app, db, zhangsan }) => {
        const auditBefore = auditCount(db);
        const response = await issueToken(app, WORKSPACE, zhangsan, { origin: MAIN_ORIGIN });
        expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
        expect(auditCount(db)).toEqual(auditBefore);
      },
      {
        tokens: {
          issue() {
            throw new Error("failed to issue preview token");
          },
        },
      },
    );
  });
});

describe("preview-token: 令牌不外泄", () => {
  it("keeps the token and the embedding origin out of every response header, log sink and audit row", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const consoles = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const sinks = { log: vi.fn(), warn: vi.fn(), onError: vi.fn() };
    const embedOrigin = "http://embed-marker.example.test:3000";
    await withPreviewWorld(
      async ({ app, db, zhangsan, lisi }) => {
        const issued = await issueToken(app, WORKSPACE, zhangsan, { origin: embedOrigin });
        const { token } = issuedOf(issued);
        const responses = [
          issued,
          await issueToken(app, WORKSPACE, zhangsan, { origin: embedOrigin }),
          await issueToken(app, WORKSPACE, lisi, { origin: embedOrigin }),
          await issueToken(app, WORKSPACE, null, { origin: embedOrigin }),
          await issueToken(app, WORKSPACE, zhangsan, { origin: embedOrigin }, INJECT_BODIES[0]),
          await issueToken(app, WORKSPACE, zhangsan, { origin: embedOrigin, host: ":3000" }),
        ];
        expect(responses.map((response) => response.statusCode)).toEqual([
          200, 200, 404, 401, 400, 400,
        ]);

        const headerText = responses.map((response) => JSON.stringify(response.headers)).join("\n");
        const written = [...stdout.mock.calls, ...stderr.mock.calls]
          .map(([chunk]) => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()))
          .join("\n");
        const sunk = JSON.stringify(
          [...Object.values(sinks), ...consoles].map((sink) => sink.mock.calls),
        );
        const audited = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
        for (const text of [headerText, written, sunk, audited]) {
          expect(text).not.toContain(token);
          expect(text).not.toContain(embedOrigin);
        }
        // Outside the two 200 bodies the token is in no response body either.
        for (const response of responses.slice(2)) {
          expect(response.payload).not.toContain(token);
        }
        expect(sinks.onError).not.toHaveBeenCalled();
      },
      {},
      sinks,
    );
  });
});

describe("preview-token: 未装配预览的可注入 app", () => {
  it("is a typed 404 without the preview dependency while the tree route answers 200", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      mkdirSync(join(sandboxRoot, ZHANGSAN, "files"), { recursive: true });
      insertWorkspace(db, WORKSPACE, ZHANGSAN, "files", "files", 1);
      const cookie = await cookieFor(app, "zhangsan");

      const response = await issueToken(app, WORKSPACE, cookie, { origin: MAIN_ORIGIN });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(NOT_FOUND_ENVELOPE);

      const tree = await app.inject({
        method: "GET",
        url: `/api/workspaces/${WORKSPACE}/tree`,
        headers: { cookie },
      });
      expect(tree.statusCode).toBe(200);
    });
  });
});
