import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expectActivity,
  expectGuardDenial,
  expectNotFound,
  expectUnchanged,
  HANDLER_PROBE_ROUTE,
  PARSER_INPUTS,
  PRINCIPAL_ROUTE,
  PRINCIPAL_ROUTE_URL,
  REGISTERED_PROBE_ROUTE,
  withGuardApp,
} from "./http-guard-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  CLEAR_COOKIE,
  CREDENTIALS,
  expectUnauthorizedEnvelope,
  FIXED_NOW,
  insertRow,
  loginSessionId,
  PRINCIPAL_ZHANGSAN,
  sessionSnapshot,
  setCookieHeader,
  testId,
} from "./session-db-helpers.js";

/**
 * Issue #19 的 original URL / rewrite / 静态兼容与 hook+parser 顺序。
 * protected 判定只看 `request.originalUrl` 经共享 bounded classifier 得到的 API
 * namespace 与 Fastify matched method/route identity：encoded API identity 受保护，
 * 被 rewrite 到 internal API miss 的 non-API unsafe identity 仍走既有 typed 404。
 */

const INDEX_BYTES = "<!doctype html><html><body>workbuddy spa index</body></html>\n";
const ASSET_BYTES = "body { color: rebeccapurple; }\n";
const API_STATIC_BYTES = "static api content must remain private\n";

/**
 * Phase-2 回归：decoded `%3F` 是路由 query 分隔符，routed pathname 为 exact `/api`，
 * 1–4 轮 encoded 形式必须与 `/api?x=1` 同一 protected 身份。
 */
const QUERY_DELIMITER_API_URLS = [
  "/api%3Fx=1",
  "/%61pi%3Fx=1",
  "/api%253Fx=1",
  "/api%25253Fx=1",
  "/api%2525253Fx=1",
] as const;

/** original pathname 属 API namespace（含 1–4 轮 encoded、backslash 与 dot-segment 形式）。 */
const API_IDENTITY_URLS: readonly string[] = [
  "/api",
  "/api?x=1",
  "/api/",
  "/api/x",
  "/api/no-such",
  "/api%2Fno-such",
  "/api%252Fno-such",
  "/api%25252Fno-such",
  "/%252561pi/no-such",
  "/%61pi/no-such",
  "/api%5Cno-such",
  "/api/%252e%252e/no-such",
  "/api/./no-such",
  "/api%2Fauth%2Fme",
  "/%61pi/healthz",
  "/api%5Cinfo",
  "/api/healthz%2Fx",
  "/api/auth/login/lookalike",
  "/api/healthz/lookalike",
  ...QUERY_DELIMITER_API_URLS,
];

/** original pathname 非 API namespace：ordinary 与 unsafe/multi-encoded（后者内部 rewrite 到 API miss）。 */
const NON_API_URLS = [
  "/not-an-api",
  "/assets/site.css/child",
  "/assets/site%252Ecss",
  "/malformed%ZZ",
  "/assets//inside.txt",
  "/assets/..%2F..%2Foutside.txt",
  "/%2e%2e/outside.txt",
  // Phase-2 兄弟身份：encoded non-API query 保持一轮规范化 fallback；`%23` 不是分隔符；
  // 超出有界解码的 encoded API query 身份 fail closed 到既有 typed 404，均零查询。
  "/files%3Ftab=1",
  "/api%23frag",
  "/api%252525253Fx=1",
] as const;

function encodePathnameRounds(pathname: string, rounds: number): string {
  let encoded = pathname;
  for (let round = 0; round < rounds; round += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

const DEEP_ENCODED_API = encodePathnameRounds("/api/no-such", 2_048);

describe("original API identity 受保护，rewritten non-API 不误报", () => {
  it.each(API_IDENTITY_URLS)(
    "%s 未认证返回 exact 401 而非既有 404，且零 session 查询",
    async (url) => {
      await withGuardApp(async ({ db, observe }) => {
        const observed = await observe({ method: "GET", url });
        expectGuardDenial(observed);
        expect(observed.response.payload).not.toContain(API_STATIC_BYTES);
        expectActivity(observed.activity, {});
        expectUnchanged(observed, db);
      });
    },
  );

  it.each(API_IDENTITY_URLS)("%s 携未知 session id 恰一次点查后 401", async (url) => {
    await withGuardApp(async ({ observe }) => {
      const observed = await observe({ method: "GET", url, cookie: bearerCookie(testId("f")) });
      expectGuardDenial(observed);
      expectActivity(observed.activity, { selects: 1 });
    });
  });

  it.each(API_IDENTITY_URLS)(
    "%s 携有效会话回到既有 typed 404，且永不落到静态/index",
    async (url) => {
      await withGuardApp(async ({ app, observe }) => {
        const sessionId = await loginSessionId(app);
        const observed = await observe({ method: "GET", url, cookie: bearerCookie(sessionId) });
        expectNotFound(observed);
        expect(observed.response.payload).not.toContain(API_STATIC_BYTES);
        expect(observed.response.payload).not.toBe(INDEX_BYTES);
        expectActivity(observed.activity, { selects: 1 });
      });
    },
  );

  it("约 8KB 的第五轮 encoded API identity 在四次 decode 后 fail closed：typed 404 且零查询", async () => {
    expect(DEEP_ENCODED_API.length).toBeGreaterThanOrEqual(8_000);
    await withGuardApp(async ({ app, observe }) => {
      const anonymous = await observe({ method: "GET", url: DEEP_ENCODED_API });
      expectNotFound(anonymous);
      expectActivity(anonymous.activity, {});

      const sessionId = await loginSessionId(app);
      const authed = await observe({
        method: "GET",
        url: DEEP_ENCODED_API,
        cookie: bearerCookie(sessionId),
      });
      expectNotFound(authed);
      expectActivity(authed.activity, {});
    });
  });

  it.each(NON_API_URLS)(
    "%s 属 non-API：有无 cookie 都绕过 guard、零查询并保持 typed 404",
    async (url) => {
      await withGuardApp(async ({ app, observe }) => {
        const anonymous = await observe({ method: "GET", url });
        expectNotFound(anonymous);
        expect(anonymous.response.payload).not.toContain("unauthorized");
        expectActivity(anonymous.activity, {});

        const malformed = await observe({
          method: "GET",
          url,
          cookie: `workbuddy_session=${"A".repeat(64)}`,
        });
        expectNotFound(malformed);
        expectActivity(malformed.activity, {});

        const sessionId = await loginSessionId(app);
        const authed = await observe({ method: "GET", url, cookie: bearerCookie(sessionId) });
        expectNotFound(authed);
        // 关键判据：被 rewrite 到 internal API miss 的 non-API 路径不得因内部 route 名查询会话
        expectActivity(authed.activity, {});
      });
    },
  );

  it("non-API POST/HEAD miss 携有效/畸形 cookie 仍是既有 typed/HTTP 语义 404，零查询", async () => {
    await withGuardApp(async ({ app, observe }) => {
      const sessionId = await loginSessionId(app);
      for (const cookie of [
        undefined,
        bearerCookie(sessionId),
        `workbuddy_session=${"A".repeat(64)}`,
      ]) {
        const posted = await observe({
          method: "POST",
          url: "/not-an-api",
          payload: '{"a": ',
          contentType: "application/json",
          cookie,
        });
        expectNotFound(posted);
        expectActivity(posted.activity, {});
      }

      const head = await observe({ method: "HEAD", url: "/not-an-api" });
      expect(head.response.statusCode).toBe(404);
      expect(head.response.payload).toBe("");
      expectActivity(head.activity, {});
    });
  });

  it("root index、深链与静态 asset 不受 guard 影响，API miss 仍优先于静态", async () => {
    const parent = mkdtempSync(join(tmpdir(), "workbuddy-guard-static-"));
    const root = join(parent, "static");
    mkdirSync(join(root, "api"), { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), INDEX_BYTES);
    writeFileSync(join(root, "api", "no-such"), API_STATIC_BYTES);
    writeFileSync(join(root, "assets", "inside.txt"), ASSET_BYTES);

    try {
      await withGuardApp(
        async ({ app, db, observe }) => {
          const sessionId = await loginSessionId(app);

          const deepLink = await observe({ method: "GET", url: "/files" });
          expect(deepLink.response.statusCode).toBe(200);
          expect(deepLink.response.payload).toBe(INDEX_BYTES);
          expectActivity(deepLink.activity, {});

          const rootLink = await observe({ method: "GET", url: "/" });
          expect(rootLink.response.statusCode).toBe(200);
          expect(rootLink.response.payload).toBe(INDEX_BYTES);
          expectActivity(rootLink.activity, {});

          const asset = await observe({ method: "GET", url: "/assets/inside%2Etxt" });
          expect(asset.response.statusCode).toBe(200);
          expect(asset.response.payload).toBe(ASSET_BYTES);
          expectActivity(asset.activity, {});

          const apiMissWithSession = await observe({
            method: "GET",
            url: "/api/no-such",
            cookie: bearerCookie(sessionId),
          });
          expectNotFound(apiMissWithSession);
          expect(apiMissWithSession.response.payload).not.toContain(API_STATIC_BYTES);
          expectActivity(apiMissWithSession.activity, { selects: 1 });

          const apiMissAnonymous = await observe({ method: "GET", url: "/api/no-such" });
          expectGuardDenial(apiMissAnonymous);
          expectActivity(apiMissAnonymous.activity, {});

          // Phase-2：decoded query 分隔符的 encoded API 身份永不落到静态/index——
          // 未认证 401、有效会话回到既有 typed 404；兄弟 non-API encoded query 保持
          // 一轮规范化 fallback（200 index、零查询）。
          for (const url of QUERY_DELIMITER_API_URLS) {
            const denied = await observe({ method: "GET", url });
            expectGuardDenial(denied);
            expect(denied.response.payload, url).not.toBe(INDEX_BYTES);
            expect(denied.response.payload, url).not.toContain(API_STATIC_BYTES);
            expectActivity(denied.activity, {});

            const opened = await observe({ method: "GET", url, cookie: bearerCookie(sessionId) });
            expectNotFound(opened);
            expect(opened.response.payload, url).not.toBe(INDEX_BYTES);
            expect(opened.response.payload, url).not.toContain(API_STATIC_BYTES);
            expectActivity(opened.activity, { selects: 1 });
          }

          const encodedQueryFallback = await observe({ method: "GET", url: "/files%3Ftab=1" });
          expect(encodedQueryFallback.response.statusCode).toBe(200);
          expect(encodedQueryFallback.response.payload).toBe(INDEX_BYTES);
          expectActivity(encodedQueryFallback.activity, {});

          const posted = await observe({ method: "POST", url: "/files" });
          expectNotFound(posted);
          expectActivity(posted.activity, {});

          expect(readFileSync(join(root, "index.html"), "utf8")).toBe(INDEX_BYTES);
          expect(sessionSnapshot(db)).toHaveLength(1);
        },
        { staticRoot: root },
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("matched route identity 而非原始前缀决定豁免：/api/../api/healthz 命中 public healthz", async () => {
    await withGuardApp(async ({ observe }) => {
      for (const method of ["GET", "HEAD"] as const) {
        const { response, activity } = await observe({ method, url: "/api/../api/healthz" });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toBe(method === "HEAD" ? "" : '{"status":"ok"}');
        expect(response.headers["content-length"]).toBe(
          String(Buffer.byteLength('{"status":"ok"}')),
        );
        expectActivity(activity, {});
      }
      expectGuardDenial(await observe({ method: "POST", url: "/api/../api/healthz" }));
    });
  });
});

describe("hook 与 parser 顺序：guard 在 cookie/route onRequest 之后、parser/handler 之前", () => {
  it.each(PARSER_INPUTS)(
    "未认证 protected 携 %s 在 parser 前 401，handler 不运行、零写入",
    async (input) => {
      await withGuardApp(async ({ db, observe, handlerProbeCalls }) => {
        for (const url of ["/api/no-such", "/api", PRINCIPAL_ROUTE_URL, HANDLER_PROBE_ROUTE]) {
          const observed = await observe({
            method: "POST",
            url,
            payload: input.payload,
            contentType: input.contentType,
          });
          expectUnauthorizedEnvelope(observed.response);
          expect(observed.response.payload, url).not.toContain("bad_request");
          expect(observed.response.payload, url).not.toContain("not_found");
          expect(observed.response.payload, url).not.toContain("FST_ERR");
          expectActivity(observed.activity, {});
        }
        expect(handlerProbeCalls()).toBe(0);
        expect(sessionSnapshot(db)).toEqual([]);
      });
    },
  );

  it("有效会话携相同输入回到各 route owner 的既有语义：catch-all 404、registered 5xx、non-API 404", async () => {
    await withGuardApp(async ({ app, db, observe, handlerProbeCalls }) => {
      const sessionId = await loginSessionId(app);
      const before = sessionSnapshot(db);

      for (const input of PARSER_INPUTS.slice(0, 3)) {
        const spec = {
          method: "POST" as const,
          payload: input.payload,
          contentType: input.contentType,
          cookie: bearerCookie(sessionId),
        };

        const miss = await observe({ ...spec, url: "/api/no-such" });
        expectNotFound(miss);
        expectActivity(miss.activity, { selects: 1 });

        const exactApi = await observe({ ...spec, url: "/api" });
        expectNotFound(exactApi);

        const registered = await observe({ ...spec, url: REGISTERED_PROBE_ROUTE });
        expect(registered.response.statusCode, input.name).toBeGreaterThanOrEqual(500);
        expect(registered.response.statusCode, input.name).toBeLessThan(600);
        expect(registered.response.payload).toBe('{"error":{"message":"服务器内部错误"}}');
        expectActivity(registered.activity, { selects: 1 });

        const nonApi = await observe({ ...spec, url: "/not-an-api" });
        expectNotFound(nonApi);
        expectActivity(nonApi.activity, {});
      }
      expect(handlerProbeCalls()).toBe(0);
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("有效会话的合法 body 继续走原 route handler：guard 不消费也不替换 body 流", async () => {
    await withGuardApp(async ({ app, observe, handlerProbeCalls, handlerProbeBody }) => {
      const sessionId = await loginSessionId(app);
      const body = { name: "ok", nested: { bytes: "x".repeat(64) } };
      const { response, activity } = await observe({
        method: "POST",
        url: HANDLER_PROBE_ROUTE,
        payload: JSON.stringify(body),
        contentType: "application/json",
        cookie: bearerCookie(sessionId),
      });
      expect(response.statusCode).toBe(200);
      // handler 看到的必须是 guard 交还的同一条未受扰动 body：逐字段回显即其判据
      expect(response.payload).toBe(JSON.stringify({ ran: 1, body }));
      expect(handlerProbeCalls()).toBe(1);
      expect(handlerProbeBody()).toEqual(body);
      expectActivity(activity, { selects: 1 });

      const consumer = await observe({
        method: "GET",
        url: PRINCIPAL_ROUTE,
        cookie: bearerCookie(sessionId),
      });
      expect(JSON.parse(consumer.response.payload)).toEqual({ principal: PRINCIPAL_ZHANGSAN });
      expectActivity(consumer.activity, { selects: 1 });
    });
  });

  it("public login/logout 携相同 parser 输入仍是 route-owned 400，guard 零 authenticate", async () => {
    await withGuardApp(async ({ db, observe }) => {
      const before = sessionSnapshot(db);
      for (const input of PARSER_INPUTS.slice(0, 3)) {
        for (const url of ["/api/auth/login", "/api/auth/logout"]) {
          const { response, activity } = await observe({
            method: "POST",
            url,
            payload: input.payload,
            contentType: input.contentType,
          });
          expect(response.statusCode, url).toBe(400);
          expect(response.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
          expect(response.payload).not.toContain(CREDENTIALS.password);
          expectActivity(activity, {});
        }
      }
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("me 的 route-local onRequest 先于 guard：guard 拒绝仍保 #10 no-store 与 exact clear-cookie", async () => {
    await withGuardApp(async ({ db, observe }) => {
      insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
      const { response, activity } = await observe({ method: "GET", url: "/api/auth/me" });
      expectUnauthorizedEnvelope(response);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
      expectActivity(activity, {});
      // 未认证 me 不消耗那条 valid 会话行
      expect(sessionSnapshot(db)).toHaveLength(1);
    });
  });

  it("guard 的拒绝不给其它 route 继承 me/logout 专属 no-store 与 clear-cookie", async () => {
    await withGuardApp(async ({ observe }) => {
      for (const url of [PRINCIPAL_ROUTE, "/api/no-such", "/api"]) {
        const { response } = await observe({ method: "GET", url });
        expectUnauthorizedEnvelope(response);
        expect(response.headers["cache-control"], url).toBeUndefined();
        expect(response.headers["set-cookie"], url).toBeUndefined();
      }
    });
  });
});
