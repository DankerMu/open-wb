import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { HttpError, type HttpErrorCode, rewriteUntrustedUrl } from "../src/http/index.js";
import { classifyUrlPathname, MAX_PERCENT_DECODE_PASSES } from "../src/http/path-classifier.js";
import { SERVICE_INFO } from "../src/service-info.js";
import { rawHttpRequest, withListeningApp } from "./raw-http-helpers.js";
import {
  insertRow,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
  validatingBodyRouteOptions,
} from "./session-db-helpers.js";

const ERROR_CASES = [
  { code: "bad_request", statusCode: 400, message: "请求格式不正确" },
  { code: "invalid_credentials", statusCode: 401, message: "账号或密码不正确" },
  { code: "account_disabled", statusCode: 403, message: "该账号已停用，请联系管理员" },
  { code: "unauthorized", statusCode: 401, message: "请先登录" },
  { code: "not_found", statusCode: 404, message: "请求的资源不存在" },
] as const satisfies ReadonlyArray<{
  code: HttpErrorCode;
  statusCode: number;
  message: string;
}>;

const INDEX_BYTES = "<!doctype html><html><body>workbuddy spa index</body></html>\n";
const ASSET_BYTES = "body { color: rebeccapurple; }\n";
const DOTTED_ASSET_BYTES = "body { color: cornflowerblue; }\n";
const ROOT_DOTFILE_BYTES = "root dotfile must never be served\n";
const NESTED_DOTFILE_BYTES = "nested dotfile must never be served\n";
const API_STATIC_BYTES = "static api content must remain private\n";
const OUTSIDE_SENTINEL_BYTES = "outside-root sentinel must never be served\n";
const ENCODED_SYMLINK_SECRET = "ENCODED-SYMLINK-SECRET";
const PERCENT_NAMED_REGULAR_BYTES = "literal percent-named file must never be served";
const DEEP_ENCODING_ROUNDS = 2_048;
const DEEP_ENCODING_MINIMUM_LENGTH = 8_000;

interface StaticFixture {
  parent: string;
  root: string;
  outsideSentinel: string;
}

async function withStaticFixture<T>(action: (fixture: StaticFixture) => Promise<T>): Promise<T> {
  const parent = mkdtempSync(join(tmpdir(), "workbuddy-app-test-"));
  const root = join(parent, "static");
  const outsideSentinel = join(parent, "outside-sentinel.txt");
  mkdirSync(root, { recursive: true });
  writeFileSync(outsideSentinel, OUTSIDE_SENTINEL_BYTES);

  try {
    return await action({ parent, root, outsideSentinel });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * #19 后 `/api` 与 `/api/*` 默认要求会话。本文件的错误信封/API 优先级用例观察的是各 route
 * 自己的既有终态，因此装配前直插一行 valid future 会话（不经 HTTP 登录——登录 inject 会冻结
 * 路由表，令用例内的 route 注册失败），并把其 cookie 交给用例。守卫的 401 lane 归
 * http-guard.test.ts；守卫本身仍逐请求判定一次。
 */
const VALID_SESSION_ID = "5a".repeat(32);
const VALID_SESSION_COOKIE = `workbuddy_session=${VALID_SESSION_ID}`;

async function withApp<T>(
  staticRoot: string | undefined,
  action: (app: ReturnType<typeof createApp>, sid: string) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  insertRow(db, VALID_SESSION_ID, "u1", Date.now() + 86_400_000);
  let app: ReturnType<typeof createApp> | undefined;

  try {
    app = staticRoot === undefined ? createApp({ db }) : createApp({ db, staticRoot });
    return await action(app, VALID_SESSION_COOKIE);
  } finally {
    try {
      await app?.close();
    } finally {
      db.close();
    }
  }
}

function registerErrorRoutes(app: FastifyInstance): void {
  for (const errorCase of ERROR_CASES) {
    app.get(`/api/test-errors/${errorCase.code}`, () => {
      throw new HttpError(errorCase.code);
    });
  }
  app.get("/api/test-errors/unexpected", () => {
    throw new Error("private programmer detail");
  });
  app.get("/api/test-errors/status-400", () => {
    throw Object.assign(new Error("status duck typing"), { statusCode: 400 });
  });
  app.get("/api/test-errors/status-413", () => {
    throw Object.assign(new Error("status duck typing"), { statusCode: 413 });
  });
  app.get("/api/test-errors/forged-prefix-code", () => {
    throw Object.assign(new Error("forged prefix code"), {
      code: "FST_ERR_CTP_BODY_TOO_LARGE_FAKE",
      statusCode: 413,
    });
  });
  app.get("/api/test-errors/forged-allowlist-code", () => {
    throw Object.assign(new Error("forged allowlist code"), {
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
      statusCode: 413,
    });
  });
}

function expectNotFound(response: {
  statusCode: number;
  payload: string;
  json: () => unknown;
}): void {
  expect(response.statusCode).toBe(404);
  expect(response.payload).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
  expect(response.json()).toEqual(NOT_FOUND_ENVELOPE);
}

function expectJsonContentType(headers: Record<string, unknown>): void {
  expect(String(headers["content-type"])).toMatch(/^application\/json(?:;\s*charset=utf-8)?$/iu);
}

function expectHtmlContentType(headers: Record<string, unknown>): void {
  expect(String(headers["content-type"])).toMatch(/^text\/html(?:;\s*charset=utf-8)?$/iu);
}

function encodePathnameRounds(pathname: string, rounds: number): string {
  let encoded = pathname;
  for (let round = 0; round < rounds; round += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

function createDeepEncodedPathname(): string {
  return encodePathnameRounds("/api/no-such", DEEP_ENCODING_ROUNDS);
}

describe("createApp", () => {
  it("仅允许非 API path 解码一轮，并对 API namespace 保持四轮有界检测", () => {
    expect(MAX_PERCENT_DECODE_PASSES).toBe(4);

    const encodedStaticPath = "/assets/site%2Ecss";
    expect(classifyUrlPathname(encodedStaticPath)).toEqual({
      pathname: "/assets/site.css",
      decodePasses: 1,
      isApiNamespace: false,
      isUnsafe: false,
    });
    expect(rewriteUntrustedUrl(`${encodedStaticPath}?cache=1`)).toBe("/assets/site.css?cache=1");
    expect(classifyUrlPathname("/assets/site%252Ecss")).toEqual({
      pathname: "/assets/site.css",
      decodePasses: 2,
      isApiNamespace: false,
      isUnsafe: true,
    });
    expect(rewriteUntrustedUrl("/assets/site%252Ecss?cache=1")).toBe(
      "/api/__workbuddy_not_found__?cache=1",
    );
    expect(rewriteUntrustedUrl("/f%69les/?tab=1")).toBe("/files/?tab=1");

    for (let rounds = 1; rounds <= MAX_PERCENT_DECODE_PASSES; rounds += 1) {
      const encodedApi = encodePathnameRounds("/api/no-such", rounds);
      const classification = classifyUrlPathname(encodedApi);
      expect(classification.decodePasses).toBe(rounds);
      expect(classification.pathname).toBe("/api/no-such");
      expect(classification.isApiNamespace).toBe(true);
      expect(classification.isUnsafe).toBe(false);
      expect(rewriteUntrustedUrl(`${encodedApi}?rounds=${rounds}`)).toBe(
        `/api/__workbuddy_not_found__?rounds=${rounds}`,
      );
    }

    const fifthEncodedApi = encodePathnameRounds("/api/no-such", MAX_PERCENT_DECODE_PASSES + 1);
    expect(classifyUrlPathname(fifthEncodedApi)).toMatchObject({
      decodePasses: MAX_PERCENT_DECODE_PASSES,
      isApiNamespace: false,
      isUnsafe: true,
    });
    expect(rewriteUntrustedUrl(`${fifthEncodedApi}?keep=query`)).toBe(
      "/api/__workbuddy_not_found__?keep=query",
    );

    expect(classifyUrlPathname("/malformed%ZZ")).toMatchObject({
      decodePasses: 0,
      isUnsafe: true,
    });
    expect(rewriteUntrustedUrl("/malformed%ZZ?keep=query")).toBe(
      "/api/__workbuddy_not_found__?keep=query",
    );

    const deeplyEncodedPathname = createDeepEncodedPathname();
    expect(deeplyEncodedPathname.length).toBeGreaterThanOrEqual(DEEP_ENCODING_MINIMUM_LENGTH);
    expect(classifyUrlPathname(deeplyEncodedPathname)).toMatchObject({
      decodePasses: MAX_PERCENT_DECODE_PASSES,
      isUnsafe: true,
    });
  });

  it("保留 caller-owned DB identity、迁移回执与 close 所有权", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db });
    let appClosed = false;
    let dbClosed = false;

    try {
      await app.ready();
      expect(app.db).toBe(db);
      const beforeReceipts = db
        .prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence")
        .all();
      const beforeSchema = db
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .all();

      const health = await app.inject({ method: "GET", url: "/api/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.payload).toBe('{"status":"ok"}');
      expect(health.json()).toEqual({ status: "ok" });
      expectJsonContentType(health.headers);

      const info = await app.inject({ method: "GET", url: "/api/info" });
      expect(info.statusCode).toBe(200);
      expect(info.payload).toBe(JSON.stringify(SERVICE_INFO));
      expect(info.json()).toEqual(SERVICE_INFO);
      expectJsonContentType(info.headers);

      expect(
        db.prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence").all(),
      ).toEqual(beforeReceipts);
      expect(
        db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
      ).toEqual(beforeSchema);

      await app.close();
      await app.close();
      appClosed = true;
      expect(db.prepare("SELECT 1 AS still_owned_by_caller").get()).toEqual({
        still_owned_by_caller: 1,
      });

      db.close();
      dbClosed = true;
      expect(() => db.prepare("SELECT 1").get()).toThrow();
    } finally {
      try {
        if (!appClosed) {
          await app.close();
        }
      } finally {
        if (!dbClosed) {
          db.close();
        }
      }
    }
  });

  it("将五种真实 HttpError 映射为唯一的精确 JSON 信封", async () => {
    await withApp(undefined, async (app, sid) => {
      registerErrorRoutes(app);

      for (const errorCase of ERROR_CASES) {
        const response = await app.inject({
          method: "GET",
          url: `/api/test-errors/${errorCase.code}`,
          headers: { cookie: sid },
        });

        expect(response.statusCode).toBe(errorCase.statusCode);
        expect(response.payload).toBe(
          JSON.stringify({
            error: { code: errorCase.code, message: errorCase.message },
          }),
        );
        expect(response.json()).toEqual({
          error: { code: errorCase.code, message: errorCase.message },
        });
        expect(Object.keys(response.json() as object)).toEqual(["error"]);
        expectJsonContentType(response.headers);
      }
    });
  });

  it("不将意外 programmer error 伪装为五种应用错误", async () => {
    await withApp(undefined, async (app, sid) => {
      registerErrorRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/test-errors/unexpected",
        headers: { cookie: sid },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.statusCode).toBeLessThan(600);
      expect(response.payload).toBe('{"error":{"message":"服务器内部错误"}}');
      expect(response.json()).toEqual({ error: { message: "服务器内部错误" } });
      expect(response.payload).not.toContain("private programmer detail");
      expect(response.json()).not.toMatchObject({
        error: {
          code: expect.stringMatching(
            /^(bad_request|invalid_credentials|account_disabled|unauthorized|not_found)$/u,
          ),
        },
      });
      expectJsonContentType(response.headers);
    });
  });

  it("statusCode/status 鸭型 400/413 与伪造/非 allowlist code 的 programmer error 保持 5xx", async () => {
    await withApp(undefined, async (app, sid) => {
      registerErrorRoutes(app);

      const routes = [
        "/api/test-errors/status-400",
        "/api/test-errors/status-413",
        "/api/test-errors/forged-prefix-code",
        "/api/test-errors/forged-allowlist-code",
      ];

      for (const url of routes) {
        const response = await app.inject({ method: "GET", url, headers: { cookie: sid } });
        expect(response.statusCode, url).toBeGreaterThanOrEqual(500);
        expect(response.statusCode, url).toBeLessThan(600);
        expect(response.payload, url).toBe('{"error":{"message":"服务器内部错误"}}');
        expect(response.json(), url).toEqual({ error: { message: "服务器内部错误" } });
        expect(response.json(), url).not.toMatchObject({
          error: {
            code: expect.stringMatching(
              /^(bad_request|invalid_credentials|account_disabled|unauthorized|not_found)$/u,
            ),
          },
        });
      }
    });
  });

  it("允许的 Fastify request error code 在登录路由稳定映射 exact 400 bad_request", async () => {
    await withApp(undefined, async (app) => {
      const malformedJson = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: '{"broken": ',
        headers: { "content-type": "application/json" },
      });
      expect(malformedJson.statusCode).toBe(400);
      expect(malformedJson.payload).toBe(
        JSON.stringify({
          error: { code: "bad_request", message: "请求格式不正确" },
        }),
      );
      expect(malformedJson.payload).not.toContain("FST_ERR");
      expect(malformedJson.payload).not.toContain("Body is not valid JSON");

      const unsupportedMedia = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: "binary",
        headers: { "content-type": "application/octet-stream" },
      });
      expect(unsupportedMedia.statusCode).toBe(400);
      expect(unsupportedMedia.payload).toBe(
        JSON.stringify({
          error: { code: "bad_request", message: "请求格式不正确" },
        }),
      );
    });
  });

  it("真实 FST_ERR_VALIDATION 不在 login allowlist（login 无 schema）：非 login route 保持 generic 5xx", async () => {
    await withApp(undefined, async (app, sid) => {
      app.post("/api/test-errors/schema-validation", validatingBodyRouteOptions(), () => ({
        ok: true,
      }));

      const response = await app.inject({
        method: "POST",
        url: "/api/test-errors/schema-validation",
        payload: "{}",
        headers: { "content-type": "application/json", cookie: sid },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.statusCode).toBeLessThan(600);
      expect(response.payload).toBe('{"error":{"message":"服务器内部错误"}}');
      expect(response.payload).not.toContain("FST_ERR");
      expect(response.payload).not.toContain("required property");
    });
  });

  it("非对象 programmer error（null throw）保持 generic 5xx", async () => {
    await withApp(undefined, async (app, sid) => {
      app.get("/api/test-errors/primitive", () => {
        throw null as unknown as Error;
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/test-errors/primitive",
        headers: { cookie: sid },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.statusCode).toBeLessThan(600);
      expect(response.payload).toBe('{"error":{"message":"服务器内部错误"}}');
    });
  });

  it("直接托管静态资源，并仅将非 API GET miss 回退到 root index", async () => {
    await withStaticFixture(async ({ root }) => {
      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(join(root, "index.html"), INDEX_BYTES);
      writeFileSync(join(root, ".env"), ROOT_DOTFILE_BYTES);
      writeFileSync(join(root, "assets", "site.css"), ASSET_BYTES);
      writeFileSync(join(root, "assets", "site.min.css"), DOTTED_ASSET_BYTES);
      writeFileSync(join(root, "assets", ".secret"), NESTED_DOTFILE_BYTES);

      await withApp(root, async (app) => {
        await app.ready();
        const initialIndex = readFileSync(join(root, "index.html"), "utf8");
        const initialAsset = readFileSync(join(root, "assets", "site.css"), "utf8");

        const asset = await app.inject({ method: "GET", url: "/assets/site.css" });
        expect(asset.statusCode).toBe(200);
        expect(asset.payload).toBe(ASSET_BYTES);
        expect(String(asset.headers["content-type"])).toMatch(/^text\/css/iu);

        const encodedAsset = await app.inject({ method: "GET", url: "/assets/site%2Ecss" });
        expect(encodedAsset.statusCode).toBe(200);
        expect(encodedAsset.payload).toBe(ASSET_BYTES);
        expect(String(encodedAsset.headers["content-type"])).toMatch(/^text\/css/iu);

        const queriedEncodedAsset = await app.inject({
          method: "GET",
          url: "/assets/site%2Ecss?cache=1",
        });
        expect(queriedEncodedAsset.statusCode).toBe(200);
        expect(queriedEncodedAsset.payload).toBe(ASSET_BYTES);
        expect(String(queriedEncodedAsset.headers["content-type"])).toMatch(/^text\/css/iu);

        const dottedAsset = await app.inject({ method: "GET", url: "/assets/site.min.css" });
        expect(dottedAsset.statusCode).toBe(200);
        expect(dottedAsset.payload).toBe(DOTTED_ASSET_BYTES);
        expect(String(dottedAsset.headers["content-type"])).toMatch(/^text\/css/iu);

        const hiddenUrls: ReadonlyArray<{ url: string; hiddenBytes: string }> = [
          { url: "/.env", hiddenBytes: ROOT_DOTFILE_BYTES },
          { url: "/%2eenv", hiddenBytes: ROOT_DOTFILE_BYTES },
          { url: "/%252eenv", hiddenBytes: ROOT_DOTFILE_BYTES },
          { url: "/assets/.secret", hiddenBytes: NESTED_DOTFILE_BYTES },
          { url: "/assets/%2esecret", hiddenBytes: NESTED_DOTFILE_BYTES },
          { url: "/assets/%252esecret", hiddenBytes: NESTED_DOTFILE_BYTES },
        ];
        for (const { url, hiddenBytes } of hiddenUrls) {
          const response = await app.inject({ method: "GET", url });
          expectNotFound(response);
          expectJsonContentType(response.headers);
          expect(response.payload).not.toContain(hiddenBytes);
          expect(response.payload).not.toBe(INDEX_BYTES);
        }

        const fileChild = await app.inject({ method: "GET", url: "/assets/site.css/child" });
        expectNotFound(fileChild);
        expectJsonContentType(fileChild.headers);
        expect(fileChild.payload).not.toBe(INDEX_BYTES);

        const rootResponse = await app.inject({ method: "GET", url: "/" });
        expect(rootResponse.statusCode).toBe(200);
        expect(rootResponse.payload).toBe(INDEX_BYTES);
        expectHtmlContentType(rootResponse.headers);

        const deepLink = await app.inject({ method: "GET", url: "/files" });
        expect(deepLink.statusCode).toBe(200);
        expect(deepLink.payload).toBe(INDEX_BYTES);
        expectHtmlContentType(deepLink.headers);

        const encodedDeepLink = await app.inject({ method: "GET", url: "/f%69les/" });
        expect(encodedDeepLink.statusCode).toBe(200);
        expect(encodedDeepLink.payload).toBe(INDEX_BYTES);
        expectHtmlContentType(encodedDeepLink.headers);

        const queriedDeepLink = await app.inject({ method: "GET", url: "/files?tab=1" });
        expect(queriedDeepLink.statusCode).toBe(200);
        expect(queriedDeepLink.payload).toBe(INDEX_BYTES);
        expectHtmlContentType(queriedDeepLink.headers);

        const trailingSlashDeepLink = await app.inject({ method: "GET", url: "/files/" });
        expect(trailingSlashDeepLink.statusCode).toBe(200);
        expect(trailingSlashDeepLink.payload).toBe(INDEX_BYTES);
        expectHtmlContentType(trailingSlashDeepLink.headers);

        const queriedTrailingSlashDeepLink = await app.inject({
          method: "GET",
          url: "/files/?tab=1",
        });
        expect(queriedTrailingSlashDeepLink.statusCode).toBe(200);
        expect(queriedTrailingSlashDeepLink.payload).toBe(INDEX_BYTES);
        expectHtmlContentType(queriedTrailingSlashDeepLink.headers);

        const repeatedSeparator = await app.inject({ method: "GET", url: "/files//" });
        expectNotFound(repeatedSeparator);
        expectJsonContentType(repeatedSeparator.headers);

        const multiEncodedAsset = await app.inject({
          method: "GET",
          url: "/assets/site%252Ecss",
        });
        expectNotFound(multiEncodedAsset);
        expectJsonContentType(multiEncodedAsset.headers);
        expect(multiEncodedAsset.payload).not.toBe(ASSET_BYTES);
        expect(multiEncodedAsset.payload).not.toBe(INDEX_BYTES);

        const multiEncodedDeepLink = await app.inject({ method: "GET", url: "/f%2569les/" });
        expectNotFound(multiEncodedDeepLink);
        expectJsonContentType(multiEncodedDeepLink.headers);
        expect(multiEncodedDeepLink.payload).not.toBe(INDEX_BYTES);

        expect(readFileSync(join(root, "index.html"), "utf8")).toBe(initialIndex);
        expect(readFileSync(join(root, "assets", "site.css"), "utf8")).toBe(initialAsset);
      });
    });
  });

  it("将 API namespace 的正常、query、编码与 dot-segment 变体置于静态和 fallback 之前", async () => {
    await withStaticFixture(async ({ root }) => {
      mkdirSync(join(root, "api"), { recursive: true });
      writeFileSync(join(root, "index.html"), INDEX_BYTES);
      writeFileSync(join(root, "api", "no-such"), API_STATIC_BYTES);
      writeFileSync(join(root, "api", "healthz"), API_STATIC_BYTES);
      writeFileSync(join(root, "api", "info"), API_STATIC_BYTES);

      await withApp(root, async (app, sid) => {
        const apiMisses = [
          "/api",
          "/api/",
          "/api/no-such",
          "/api/no-such?x=1",
          "/api%2Fno-such",
          "/%61pi/no-such",
          "/api%252Fno-such",
          "/api%25252Fno-such",
          "/%252561pi/no-such",
          "/api/%252e%252e/no-such",
          "/api%5Cno-such",
        ];

        for (const url of apiMisses) {
          const response = await app.inject({ method: "GET", url, headers: { cookie: sid } });
          expectNotFound(response);
          expect(response.payload).not.toContain(API_STATIC_BYTES);
          expect(response.payload).not.toBe(INDEX_BYTES);
        }

        const postMiss = await app.inject({
          method: "POST",
          url: "/api/no-such",
          headers: { cookie: sid },
        });
        expectNotFound(postMiss);
        expectJsonContentType(postMiss.headers);

        const health = await app.inject({ method: "GET", url: "/api/healthz" });
        expect(health.statusCode).toBe(200);
        expect(health.payload).toBe('{"status":"ok"}');

        const info = await app.inject({ method: "GET", url: "/api/info" });
        expect(info.statusCode).toBe(200);
        expect(info.json()).toEqual(SERVICE_INFO);
      });
    });
  });

  it("静态根缺失、不可用、不是目录或没有 regular index 时仍可 ready", async () => {
    await withStaticFixture(async ({ parent, root }) => {
      const nonexistentRoot = join(parent, "does-not-exist");
      const fileRoot = join(parent, "not-a-directory");
      const indexlessRoot = join(parent, "indexless");
      const indexDirectoryRoot = join(parent, "index-is-a-directory");
      writeFileSync(fileRoot, "not a directory");
      mkdirSync(indexlessRoot, { recursive: true });
      mkdirSync(join(indexDirectoryRoot, "index.html"), { recursive: true });
      mkdirSync(join(indexlessRoot, "assets"), { recursive: true });
      writeFileSync(join(indexlessRoot, "assets", "available.txt"), "indexless asset\n");

      const unavailableRoots: ReadonlyArray<{ name: string; staticRoot: string | undefined }> = [
        { name: "absent", staticRoot: undefined },
        { name: "nonexistent", staticRoot: nonexistentRoot },
        { name: "regular file", staticRoot: fileRoot },
        { name: "indexless directory", staticRoot: indexlessRoot },
        { name: "index directory", staticRoot: indexDirectoryRoot },
      ];

      for (const rootCase of unavailableRoots) {
        await withApp(rootCase.staticRoot, async (app) => {
          await app.ready();

          const health = await app.inject({ method: "GET", url: "/api/healthz" });
          expect(health.statusCode, rootCase.name).toBe(200);
          expect(health.payload, rootCase.name).toBe('{"status":"ok"}');

          const info = await app.inject({ method: "GET", url: "/api/info" });
          expect(info.statusCode, rootCase.name).toBe(200);
          expect(info.json(), rootCase.name).toEqual(SERVICE_INFO);

          const deepLink = await app.inject({ method: "GET", url: "/files" });
          expectNotFound(deepLink);
          expectJsonContentType(deepLink.headers);
        });
      }

      await withApp(indexlessRoot, async (app) => {
        const asset = await app.inject({ method: "GET", url: "/assets/available.txt" });
        expect(asset.statusCode).toBe(200);
        expect(asset.payload).toBe("indexless asset\n");
        expect(String(asset.headers["content-type"])).toMatch(/^text\/plain/iu);
      });

      expect(root).toBe(join(parent, "static"));
    });
  });

  it("非 GET miss 不返回 index，HEAD 保留空 body HTTP 语义", async () => {
    await withStaticFixture(async ({ root }) => {
      writeFileSync(join(root, "index.html"), INDEX_BYTES);

      await withApp(root, async (app, sid) => {
        const post = await app.inject({ method: "POST", url: "/files" });
        expectNotFound(post);
        expectJsonContentType(post.headers);

        const head = await app.inject({ method: "HEAD", url: "/files" });
        expect(head.statusCode).toBe(404);
        expect(head.payload).toBe("");
        expect(head.payload).not.toBe(INDEX_BYTES);

        // #19：protected HEAD 先命中守卫 401（wire 侧 body 抑制由 http-guard.test.ts 验收）；
        // 带会话才回到既有 404 空 body 语义。
        const deniedHead = await app.inject({ method: "HEAD", url: "/api/no-such" });
        expect(deniedHead.statusCode).toBe(401);
        expect(deniedHead.payload).toBe(JSON.stringify(UNAUTHORIZED_ENVELOPE));
        expect(deniedHead.payload).not.toBe(INDEX_BYTES);

        const apiHead = await app.inject({
          method: "HEAD",
          url: "/api/no-such",
          headers: { cookie: sid },
        });
        expect(apiHead.statusCode).toBe(404);
        expect(apiHead.payload).toBe("");
      });
    });
  });

  it("拒绝未规范化 traversal 与分隔符，绝不读取 root 外 sentinel 或 fallback", async () => {
    await withStaticFixture(async ({ outsideSentinel, parent, root }) => {
      const encodedSymlinkOutside = join(parent, "encoded-symlink-outside");
      mkdirSync(join(root, "assets"), { recursive: true });
      mkdirSync(encodedSymlinkOutside, { recursive: true });
      writeFileSync(join(root, "index.html"), INDEX_BYTES);
      writeFileSync(join(root, "assets", "inside.txt"), "inside asset\n");
      writeFileSync(join(root, "literal%2dencoded.txt"), PERCENT_NAMED_REGULAR_BYTES);
      writeFileSync(join(encodedSymlinkOutside, "secret.txt"), ENCODED_SYMLINK_SECRET);
      symlinkSync(outsideSentinel, join(root, "outside-link.txt"));
      symlinkSync(join(root, "assets"), join(root, "asset-link"));
      symlinkSync(encodedSymlinkOutside, join(root, "link%2dencoded"));
      expect(readFileSync(outsideSentinel, "utf8")).toBe(OUTSIDE_SENTINEL_BYTES);
      expect(readFileSync(join(encodedSymlinkOutside, "secret.txt"), "utf8")).toBe(
        ENCODED_SYMLINK_SECRET,
      );

      await withApp(root, async (app) => {
        const outsideLink = await app.inject({ method: "GET", url: "/outside-link.txt" });
        expectNotFound(outsideLink);
        expect(outsideLink.payload).not.toContain(OUTSIDE_SENTINEL_BYTES);

        const nestedLink = await app.inject({ method: "GET", url: "/asset-link/inside.txt" });
        expectNotFound(nestedLink);

        const encodedOutsideLink = await app.inject({
          method: "GET",
          url: "/outside%252dlink.txt",
        });
        expectNotFound(encodedOutsideLink);
        expect(encodedOutsideLink.payload).not.toContain(OUTSIDE_SENTINEL_BYTES);

        const encodedNestedLink = await app.inject({
          method: "GET",
          url: "/asset-link%252Finside.txt",
        });
        expectNotFound(encodedNestedLink);

        const encodedSymlink = await app.inject({
          method: "GET",
          url: "/link%252dencoded/secret.txt",
        });
        expectNotFound(encodedSymlink);
        expectJsonContentType(encodedSymlink.headers);
        expect(encodedSymlink.payload).not.toContain(ENCODED_SYMLINK_SECRET);
        expect(encodedSymlink.payload).not.toBe(INDEX_BYTES);

        const percentNamedRegularFile = await app.inject({
          method: "GET",
          url: "/literal%252dencoded.txt",
        });
        expectNotFound(percentNamedRegularFile);
        expectJsonContentType(percentNamedRegularFile.headers);
        expect(percentNamedRegularFile.payload).not.toContain(PERCENT_NAMED_REGULAR_BYTES);
        expect(percentNamedRegularFile.payload).not.toBe(INDEX_BYTES);

        const deeplyEncodedRequest = await app.inject({
          method: "GET",
          url: createDeepEncodedPathname(),
        });
        expectNotFound(deeplyEncodedRequest);
        expectJsonContentType(deeplyEncodedRequest.headers);
        expect(deeplyEncodedRequest.payload).not.toBe(INDEX_BYTES);

        const unsafeUrls = [
          "/assets/..%2F..%2Foutside-sentinel.txt",
          "/assets%5C..%5C..%5Coutside-sentinel.txt",
          "/assets//inside.txt",
          "/malformed%ZZ",
        ];

        for (const url of unsafeUrls) {
          const response = await app.inject({ method: "GET", url });
          expectNotFound(response);
          expectJsonContentType(response.headers);
          expect(response.payload).not.toContain(OUTSIDE_SENTINEL_BYTES);
        }
      });

      const db = openDb(":memory:");
      const listeningApp = createApp({ db, staticRoot: root });
      let appClosed = false;
      try {
        await withListeningApp(listeningApp, async (origin) => {
          // non-API unsafe identity 仍 typed 404；original API identity 未认证是 401（#19）。
          const wireRows = [
            ["/../outside-sentinel.txt", "404 Not Found", NOT_FOUND_ENVELOPE],
            ["/%2e%2e/outside-sentinel.txt", "404 Not Found", NOT_FOUND_ENVELOPE],
            ["/assets/%2e%2e/inside.txt", "404 Not Found", NOT_FOUND_ENVELOPE],
            ["/api/%2e%2e/no-such", "401 Unauthorized", UNAUTHORIZED_ENVELOPE],
            ["/api%5Cno-such", "401 Unauthorized", UNAUTHORIZED_ENVELOPE],
          ] as const;
          for (const [target, statusLine, envelope] of wireRows) {
            const response = await rawHttpRequest(origin, { target });
            expect(response, target).toContain(`HTTP/1.1 ${statusLine}`);
            expect(response, target).toContain(JSON.stringify(envelope));
            expect(response).not.toContain(OUTSIDE_SENTINEL_BYTES);
            expect(response).not.toContain(INDEX_BYTES);
          }
        });
        appClosed = true;
      } finally {
        try {
          if (!appClosed) {
            await listeningApp.close();
          }
        } finally {
          db.close();
        }
      }
    });
  });
});
