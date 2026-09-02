import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { type CreateAppOptions, createApp } from "../src/app.js";
import type { AuthErrorCode } from "../src/auth/errors.js";
import { SESSION_TTL, sessionExpiry } from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";
import { HttpError, type HttpErrorCode } from "../src/http/index.js";
import {
  accountSnapshot,
  BAD_REQUEST_ENVELOPE,
  bearerCookie,
  CLEAR_COOKIE,
  CLEAR_COOKIE_SECURE,
  CREDENTIALS,
  cookiePair,
  cookieValueOf,
  denySelect,
  expectDeleteFailureIsServerError,
  expectServerError,
  expectUnauthorizedNoWrite,
  expectUnauthorizedTerminal,
  FIXED_NOW,
  fixedRuntime,
  INT64_MAX,
  INVALID_CLOCKS,
  INVALID_TTLS,
  type InjectResponse,
  insertOrphanRow,
  insertRow,
  loginSessionPair,
  MALFORMED_SESSION_IDS,
  PRINCIPAL_ZHANGSAN,
  rawCookie,
  requestLogout,
  requestMe,
  resetDatabase,
  row,
  rowsById,
  sessionSnapshot,
  setCookieHeader,
  TTL_MESSAGE,
  testId,
  totalChanges,
  withApp,
} from "./auth-lifecycle-helpers.js";

/**
 * Issue #10 HTTP 会话生命周期面：`createApp({sessionTtlMs})` 配置域、
 * `GET /api/auth/me`、`POST /api/auth/logout`、exact clear-cookie 与 Secure 极性。
 * 全部经真实 createApp + openDb(":memory:") + app.inject() 验收。
 * direct authenticate 的 lazy cleanup 与 DELETE 事务纪律在 auth-session.test.ts。
 */

describe("createApp({sessionTtlMs}) 绝对 TTL 配置", () => {
  /**
   * 真实公共入口调用：`sessionTtlMs` 以对象字面量 own property 的形式原样传入
   * `createApp`。`exactOptionalPropertyTypes` 下，显式 `undefined` 必须是可接受的配置，
   * 且与省略同落到恰 604800000 绝对过期；两者都以真实登录 + exact 行断言验收。
   */
  it.each([
    ["省略属性", false],
    ["显式 undefined own property", true],
  ] as const)("TTL %s -> 登录写入恰 now+604800000", async (_name, passExplicitUndefined) => {
    expect(SESSION_TTL).toBe(604_800_000);
    const db = openDb(":memory:");
    let app: FastifyInstance | undefined;
    try {
      const options: CreateAppOptions = passExplicitUndefined
        ? { db, sessionTtlMs: undefined, authRuntime: fixedRuntime(() => FIXED_NOW) }
        : { db, authRuntime: fixedRuntime(() => FIXED_NOW) };
      expect(Object.hasOwn(options, "sessionTtlMs")).toBe(passExplicitUndefined);

      app = createApp(options);
      const pair = await loginSessionPair(app);
      expect(sessionSnapshot(db)).toEqual([
        row(cookieValueOf(pair), "u1", FIXED_NOW + SESSION_TTL),
      ]);
    } finally {
      await app?.close();
      db.close();
    }
  });

  it.each([
    ["最小值 1", 1, FIXED_NOW + 1],
    ["自定义一天", 86_400_000, FIXED_NOW + 86_400_000],
    ["逼近安全上界", Number.MAX_SAFE_INTEGER - FIXED_NOW, Number.MAX_SAFE_INTEGER],
  ])("自定义 TTL %s 写入 exact now+ttl 行", async (_name, ttl, expected) => {
    await withApp({ sessionTtlMs: ttl }, async ({ app, db }) => {
      const pair = await loginSessionPair(app);
      expect(sessionSnapshot(db)).toEqual([row(cookieValueOf(pair), "u1", expected)]);
    });
  });

  it.each(INVALID_TTLS)("非法 TTL %s 在 app 装配与任何 DB 写入前同步抛错", (_name, ttl) => {
    const db = openDb(":memory:");
    try {
      expect(() =>
        createApp({
          db,
          sessionTtlMs: ttl as number,
          authRuntime: fixedRuntime(() => FIXED_NOW),
        }),
      ).toThrow(TTL_MESSAGE);
      expect(sessionSnapshot(db)).toEqual([]);
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("直接 sessionExpiry 保持默认兼容并逐操作数校验 TTL", () => {
    expect(sessionExpiry(0)).toBe(604_800_000);
    expect(sessionExpiry(FIXED_NOW)).toBe(FIXED_NOW + 604_800_000);
    expect(sessionExpiry(FIXED_NOW, undefined)).toBe(FIXED_NOW + 604_800_000);
    expect(sessionExpiry(FIXED_NOW, 1)).toBe(FIXED_NOW + 1);
    expect(sessionExpiry(FIXED_NOW, 86_400_000)).toBe(FIXED_NOW + 86_400_000);

    for (const [_name, ttl] of INVALID_TTLS) {
      expect(() => sessionExpiry(FIXED_NOW, ttl as number)).toThrow(TTL_MESSAGE);
    }
    expect(() => sessionExpiry(-1, 1)).toThrow(/nonnegative safe integer/u);
    expect(() => sessionExpiry(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(
      /nonnegative safe integer/u,
    );
    expect(() => sessionExpiry(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      /session expiry overflows the safe integer range/u,
    );
  });

  it("合法 TTL 与 now 相加溢出 safe integer 时登录 generic 5xx，无写无 cookie", async () => {
    await withApp({ sessionTtlMs: 1, now: () => Number.MAX_SAFE_INTEGER }, async ({ app, db }) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: JSON.stringify(CREDENTIALS),
        headers: { "content-type": "application/json" },
      });
      expectServerError(response);
      expect(sessionSnapshot(db)).toEqual([]);
    });
  });

  it("TTL 配置只影响新会话，绝不回写既有行", async () => {
    const db = openDb(":memory:");
    let firstApp: FastifyInstance | undefined;
    let secondApp: FastifyInstance | undefined;
    try {
      firstApp = createApp({ db, authRuntime: fixedRuntime(() => FIXED_NOW) });
      const firstPair = await loginSessionPair(firstApp);
      const existing = sessionSnapshot(db);
      await firstApp.close();
      firstApp = undefined;

      secondApp = createApp({
        db,
        sessionTtlMs: 1,
        authRuntime: fixedRuntime(() => FIXED_NOW),
      });
      const secondPair = await loginSessionPair(secondApp);

      const rows = sessionSnapshot(db);
      expect(rows).toHaveLength(2);
      expect(rows.find((candidate) => candidate.id === cookieValueOf(firstPair))).toEqual(
        existing[0],
      );
      expect(rows.find((candidate) => candidate.id === cookieValueOf(secondPair))).toEqual(
        row(cookieValueOf(secondPair), "u1", FIXED_NOW + 1),
      );
    } finally {
      await firstApp?.close();
      await secondApp?.close();
      db.close();
    }
  });

  it("正常 cookie 在自定义 TTL 下仍无 Domain/Expires/Max-Age，Secure 随配置", async () => {
    const login = async (app: FastifyInstance) =>
      setCookieHeader(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: JSON.stringify(CREDENTIALS),
          headers: { "content-type": "application/json" },
        }),
      );

    await withApp({ sessionTtlMs: 86_400_000 }, async ({ app }) => {
      const header = await login(app);
      expect(header).toContain("Path=/");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
      expect(header).not.toContain("Domain");
      expect(header).not.toContain("Expires");
      expect(header).not.toContain("Max-Age");
      expect(header).not.toContain("Secure");
    });

    await withApp({ secureCookies: true }, async ({ app }) => {
      const header = await login(app);
      expect(header).toContain("; Secure;");
      expect(header).not.toContain("Max-Age");
      expect(header).not.toContain("Expires");
    });
  });
});

describe("GET /api/auth/me", () => {
  it("有效 future-enabled cookie -> exact 200 直接 Principal、no-store、无 Set-Cookie、DB 逐值不变", async () => {
    await withApp({}, async ({ app, db }) => {
      const pair = await loginSessionPair(app);
      const beforeSessions = sessionSnapshot(db);
      const beforeAccounts = accountSnapshot(db);

      const response = await requestMe(app, pair);
      expect(response.statusCode).toBe(200);
      expect(response.payload).toBe(JSON.stringify(PRINCIPAL_ZHANGSAN));
      expect(response.json()).toEqual(PRINCIPAL_ZHANGSAN);
      expect(Object.keys(response.json() as object)).toEqual(["id", "account", "role"]);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(String(response.headers["content-type"])).toMatch(
        /^application\/json(?:;\s*charset=utf-8)?$/u,
      );
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(sessionSnapshot(db)).toEqual(beforeSessions);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);

      const repeated = await requestMe(app, pair);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.payload).toBe(JSON.stringify(PRINCIPAL_ZHANGSAN));
      expect(sessionSnapshot(db)).toEqual(beforeSessions);
    });
  });

  it("login/me/authenticate 共用同一 app authNow 时钟，并在 now == expires_at 翻转为清理", async () => {
    const db = openDb(":memory:");
    let currentNow = FIXED_NOW;
    let app: FastifyInstance | undefined;
    try {
      app = createApp({ db, sessionTtlMs: 1, authRuntime: fixedRuntime(() => currentNow) });
      const pair = await loginSessionPair(app);
      expect(sessionSnapshot(db)).toEqual([row(cookieValueOf(pair), "u1", FIXED_NOW + 1)]);

      const future = await requestMe(app, pair);
      expect(future.statusCode).toBe(200);
      expect(future.payload).toBe(JSON.stringify(PRINCIPAL_ZHANGSAN));

      currentNow = FIXED_NOW + 1;
      expectUnauthorizedTerminal(await requestMe(app, pair));
      expect(sessionSnapshot(db)).toEqual([]);
    } finally {
      await app?.close();
      db.close();
    }
  });

  it("me 只使用会话身份：停用账号的 future 行不会成为 Principal", async () => {
    await withApp({}, async ({ app, db }) => {
      insertRow(db, testId("a"), "u4", FIXED_NOW + 1);
      await expectUnauthorizedNoWrite(app, db, bearerCookie(testId("a")), "me");
    });
  });

  it.each([
    ["无 cookie 头", undefined],
    ["wrong cookie 名", "other_session=5a5a5a5a"],
    ["unknown 行", bearerCookie(testId("f"))],
  ])("me cookie %s -> exact 401 unauthorized + clear-cookie，DB 不变", async (_name, cookie) => {
    await withApp({}, async ({ app, db }) => {
      insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
      await expectUnauthorizedNoWrite(app, db, cookie, "me");
    });
  });

  it.each(MALFORMED_SESSION_IDS)(
    "me 畸形 cookie %s -> exact 401 + clear-cookie，DB 不变",
    async (_name, value) => {
      await withApp({}, async ({ app, db }) => {
        insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
        await expectUnauthorizedNoWrite(app, db, rawCookie(value), "me");
      });
    },
  );

  it("原型继承的 cookie 名视为不存在（own property 检查）", async () => {
    await withApp({}, async ({ app, db }) => {
      insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
      const inherited = Object.create({ workbuddy_session: testId("a") });
      expect(Object.hasOwn(inherited, "workbuddy_session")).toBe(false);
      await expectUnauthorizedNoWrite(app, db, undefined, "me");
    });
  });

  it.each(INVALID_CLOCKS)("非法时钟 %s -> 401 + clear-cookie，DB 逐值不变", async (_name, now) => {
    await withApp({ now: () => now as number }, async ({ app, db }) => {
      insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
      await expectUnauthorizedNoWrite(app, db, bearerCookie(testId("a")), "me");
    });
  });

  it.each([
    ["恰等过期（expires_at == now）", FIXED_NOW],
    ["已过期（expires_at < now）", FIXED_NOW - 60_000],
  ])(
    "exact row %s -> 只删除该 matched 行后 401/clear，sibling 逐值不变",
    async (_name, expiresAt) => {
      await withApp({}, async ({ app, db }) => {
        const matched = testId("a");
        const siblingFuture = testId("b");
        const siblingExpired = testId("c");
        insertRow(db, matched, "u1", expiresAt);
        insertRow(db, siblingFuture, "u2", FIXED_NOW + 1);
        insertRow(db, siblingExpired, "u3", FIXED_NOW - 1);
        const beforeAccounts = accountSnapshot(db);

        expectUnauthorizedTerminal(await requestMe(app, bearerCookie(matched)));
        expect(sessionSnapshot(db)).toEqual(
          rowsById(
            row(siblingFuture, "u2", FIXED_NOW + 1),
            row(siblingExpired, "u3", FIXED_NOW - 1),
          ),
        );
        expect(accountSnapshot(db)).toEqual(beforeAccounts);
        expect(db.isTransaction).toBe(false);
      });
    },
  );

  it("expired 清理不扫描全表：其他 expired sibling 存活，重复调用不再写入", async () => {
    await withApp({}, async ({ app, db }) => {
      const matched = testId("a");
      const sibling = testId("b");
      insertRow(db, matched, "u1", FIXED_NOW - 1);
      insertRow(db, sibling, "u2", FIXED_NOW - 2);
      const changesBefore = totalChanges(db);
      const survivor = [row(sibling, "u2", FIXED_NOW - 2)];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expectUnauthorizedTerminal(await requestMe(app, bearerCookie(matched)));
        expect(sessionSnapshot(db)).toEqual(survivor);
        expect(totalChanges(db) - changesBefore).toBe(1);
      }
    });
  });

  it("expired 清理覆盖账号状态：enabled/disabled/orphan 的 exact 行都被删除", async () => {
    await withApp({}, async ({ app, db }) => {
      const enabled = testId("a");
      const disabled = testId("b");
      const orphan = testId("c");
      insertRow(db, enabled, "u1", FIXED_NOW - 1);
      insertRow(db, disabled, "u4", FIXED_NOW);
      insertOrphanRow(db, orphan, "ghost", FIXED_NOW - 9);
      expect(sessionSnapshot(db)).toHaveLength(3);

      for (const id of [enabled, disabled, orphan]) {
        expectUnauthorizedTerminal(await requestMe(app, bearerCookie(id)));
      }
      expect(sessionSnapshot(db)).toEqual([]);
    });
  });

  it("future disabled/orphan 行不删除 -> 401/clear 且逐值不变", async () => {
    await withApp({}, async ({ app, db }) => {
      const disabled = testId("a");
      const orphan = testId("b");
      insertRow(db, disabled, "u4", FIXED_NOW + 1);
      insertOrphanRow(db, orphan, "ghost", INT64_MAX);
      await expectUnauthorizedNoWrite(app, db, bearerCookie(disabled), "me");
      await expectUnauthorizedNoWrite(app, db, bearerCookie(orphan), "me");
    });
  });

  it("清理 DELETE 失败 -> generic 5xx、无 clear-cookie、快照不变、事务不残留", async () => {
    await withApp({}, async ({ app, db }) => {
      const matched = testId("a");
      insertRow(db, matched, "u1", FIXED_NOW - 1);
      const beforeSessions = sessionSnapshot(db);
      const beforeAccounts = accountSnapshot(db);
      await expectDeleteFailureIsServerError(db, () => requestMe(app, bearerCookie(matched)));
      expect(db.isTransaction).toBe(false);
      expect(sessionSnapshot(db)).toEqual(beforeSessions);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);
    });
  });

  it("me 会话查询失败 -> generic 5xx、no-store、无 clear-cookie、快照不变", async () => {
    await withApp({}, async ({ app, db }) => {
      const pair = await loginSessionPair(app);
      const before = sessionSnapshot(db);
      // 读路径被拒：authenticate 不得把存储失败降级为未认证，更不得清 cookie。
      denySelect(db);
      let failed: InjectResponse;
      try {
        failed = await requestMe(app, pair);
      } finally {
        resetDatabase(db);
      }
      expectServerError(failed);
      expect(failed.headers["cache-control"]).toBe("no-store");
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("超出 JS 安全整数的 expiry 在 SQLite 内分类为 future：不投影、不抛错", async () => {
    await withApp({}, async ({ app, db }) => {
      const beyondSafe = testId("a");
      const int64Max = testId("b");
      insertRow(db, beyondSafe, "u1", INT64_MAX);
      insertRow(db, int64Max, "u1", 9_007_199_254_740_993n);

      for (const id of [beyondSafe, int64Max]) {
        const response = await requestMe(app, bearerCookie(id));
        expect(response.statusCode).toBe(200);
        expect(response.payload).toBe(JSON.stringify(PRINCIPAL_ZHANGSAN));
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect(sessionSnapshot(db)).toEqual(
        rowsById(row(beyondSafe, "u1", INT64_MAX), row(int64Max, "u1", 9_007_199_254_740_993n)),
      );
    });
  });
});

describe("POST /api/auth/logout", () => {
  it("canonical bodyless 请求 -> owned DELETE commit 后 exact 204/empty/no-store/clear", async () => {
    await withApp({}, async ({ app, db }) => {
      const pair = await loginSessionPair(app);
      const beforeAccounts = accountSnapshot(db);

      const response = await requestLogout(app, pair);
      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe("");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toBeUndefined();
      expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
      expect(sessionSnapshot(db)).toEqual([]);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("登出后旧 cookie：me 401/clear，重复 logout 401/clear 且无额外写入", async () => {
    await withApp({}, async ({ app, db }) => {
      const pair = await loginSessionPair(app);
      expect((await requestLogout(app, pair)).statusCode).toBe(204);
      const changesAfterLogout = totalChanges(db);

      expectUnauthorizedTerminal(await requestMe(app, pair));
      expectUnauthorizedTerminal(await requestLogout(app, pair));
      expect(sessionSnapshot(db)).toEqual([]);
      expect(totalChanges(db)).toBe(changesAfterLogout);
    });
  });

  it("bearer identity 而非 Principal eligibility：expired/disabled/orphan 行都删除并 204", async () => {
    await withApp({}, async ({ app, db }) => {
      const expired = testId("a");
      const disabled = testId("b");
      const orphan = testId("c");
      const orphanExpired = testId("d");
      const unrelated = testId("e");
      insertRow(db, expired, "u1", FIXED_NOW - 1);
      insertRow(db, disabled, "u4", FIXED_NOW + 1);
      insertOrphanRow(db, orphan, "ghost", FIXED_NOW + 1);
      insertOrphanRow(db, orphanExpired, "ghost", FIXED_NOW - 1);
      insertRow(db, unrelated, "u3", INT64_MAX);

      for (const id of [expired, disabled, orphan, orphanExpired]) {
        const response = await requestLogout(app, bearerCookie(id));
        expect(response.statusCode).toBe(204);
        expect(response.payload).toBe("");
        expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
      }
      expect(sessionSnapshot(db)).toEqual([row(unrelated, "u3", INT64_MAX)]);
    });
  });

  it.each(INVALID_CLOCKS)(
    "非法时钟 %s 不影响 logout：existing 行仍删除并 204",
    async (_name, now) => {
      await withApp({ now: () => now as number }, async ({ app, db }) => {
        const id = testId("a");
        insertRow(db, id, "u1", FIXED_NOW + 1);
        const response = await requestLogout(app, bearerCookie(id));
        expect(response.statusCode).toBe(204);
        expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
        expect(sessionSnapshot(db)).toEqual([]);
      });
    },
  );

  it.each([
    ["无 cookie 头", undefined],
    ["wrong cookie 名", "other_session=5a5a5a5a"],
    ["unknown 行", bearerCookie(testId("f"))],
  ])("logout cookie %s -> exact 401/clear，DB 逐值不变", async (_name, cookie) => {
    await withApp({}, async ({ app, db }) => {
      insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
      await expectUnauthorizedNoWrite(app, db, cookie, "logout");
    });
  });

  it.each(MALFORMED_SESSION_IDS)(
    "logout 畸形 cookie %s -> exact 401/clear，DB 不变",
    async (_name, value) => {
      await withApp({}, async ({ app, db }) => {
        insertRow(db, testId("a"), "u1", FIXED_NOW + 60_000);
        await expectUnauthorizedNoWrite(app, db, rawCookie(value), "logout");
      });
    },
  );

  it("并发同 cookie logout 结果 multiset 204+401 且恰删一行", async () => {
    await withApp({}, async ({ app, db }) => {
      const id = testId("a");
      insertRow(db, id, "u1", FIXED_NOW + 1);
      const changesBefore = totalChanges(db);

      const responses = await Promise.all([
        requestLogout(app, bearerCookie(id)),
        requestLogout(app, bearerCookie(id)),
      ]);
      expect(responses.map((response) => response.statusCode).sort((x, y) => x - y)).toEqual([
        204, 401,
      ]);
      for (const response of responses) {
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
      }
      expect(responses.find((response) => response.statusCode === 204)?.payload).toBe("");
      expect(sessionSnapshot(db)).toEqual([]);
      expect(totalChanges(db) - changesBefore).toBe(1);
    });
  });

  /**
   * 一字节省入 body 的三条 lane 都必须 exact 400 且早于 cookie lookup/DELETE/clear：
   * json/text 由 Fastify 解析出 body 后落 handler 的显式 no-body 校验；无 content-type
   * 则由 allowlisted media-type parser 错误经 exact POST logout route owner 归一为 400。
   * 该 400 不构成撤销——同一 cookie 随后仍能正常登出并恰删一行。
   */
  it("一字节省入 body -> exact 400/无 clear/无写，且不构成撤销", async () => {
    await withApp({}, async ({ app, db }) => {
      const pair = await loginSessionPair(app);
      const before = sessionSnapshot(db);
      const changesBefore = totalChanges(db);

      for (const contentType of ["application/json", "text/plain", undefined]) {
        const rejected = await requestLogout(app, pair, "1", contentType);
        expect(rejected.statusCode).toBe(400);
        expect(rejected.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
        expect(rejected.headers["cache-control"]).toBe("no-store");
        expect(rejected.headers["set-cookie"]).toBeUndefined();
        expect(sessionSnapshot(db)).toEqual(before);
        expect(totalChanges(db)).toBe(changesBefore);
      }

      expect((await requestLogout(app, pair)).statusCode).toBe(204);
      expect(sessionSnapshot(db)).toEqual([]);
      expect(totalChanges(db) - changesBefore).toBe(1);
    });
  });

  it.each([
    ["empty JSON body", "", "application/json"],
    ["malformed JSON body", "{", "application/json"],
    ["unsupported media", "a", "application/octet-stream"],
    ["超过一字节 limit", "ab", "application/json"],
  ])(
    "native parser error %s -> exact 400/no-store 且早于 cookie lookup/DELETE/clear",
    async (_n, p, ct) => {
      await withApp({}, async ({ app, db }) => {
        const pair = await loginSessionPair(app);
        const before = sessionSnapshot(db);

        const response = await requestLogout(app, pair, p, ct);
        expect(response.statusCode).toBe(400);
        expect(response.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
        expect(response.payload).not.toContain("FST_ERR");
        // parser 失败发生在 handler 之前，route-local onRequest 仍必须先落 no-store
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(sessionSnapshot(db)).toEqual(before);
      });
    },
  );

  it("no-store 作用域只限 exact POST logout：其他 route 的 parser 失败不被全局加头", async () => {
    await withApp({}, async ({ app, db }) => {
      app.post("/api/registered-no-store-probe", async () => ({ ok: true }));
      const pair = await loginSessionPair(app);
      const afterLogin = sessionSnapshot(db);

      const owned = await requestLogout(app, pair, "{", "application/json");
      expect(owned.statusCode).toBe(400);
      expect(owned.headers["cache-control"]).toBe("no-store");

      // 已注册非 auth route 上同样的 parser 失败不得继承 logout 的 no-store
      const registered = await app.inject({
        method: "POST",
        url: "/api/registered-no-store-probe",
        payload: "{",
        headers: { "content-type": "application/json" },
      });
      expect(registered.statusCode).toBe(500);
      expect(registered.headers["cache-control"]).toBeUndefined();

      // API catch-all 的 parser 失败仍是 typed 404，且无 no-store
      const fallback = await app.inject({
        method: "POST",
        url: "/api/no-such-route",
        payload: "{",
        headers: { "content-type": "application/json" },
      });
      expect(fallback.statusCode).toBe(404);
      expect(fallback.headers["cache-control"]).toBeUndefined();

      // 尾斜杠 miss 回到 /api/*，不是 exact logout route
      const trailingSlash = await requestLogout(app, pair, "{", "application/json");
      expect(trailingSlash.statusCode).toBe(400);
      const miss = await app.inject({
        method: "POST",
        url: "/api/auth/logout/",
        payload: "{",
        headers: { "content-type": "application/json" },
      });
      expect(miss.statusCode).toBe(404);
      expect(miss.headers["cache-control"]).toBeUndefined();

      // 以上全部是 parser/路由层失败：bearer 行始终未被撤销
      expect(sessionSnapshot(db)).toEqual(afterLogin);
    });
  });

  it("caller 拥有事务时 logout owned BEGIN 先于 DELETE 失败 -> 5xx/无 clear-cookie，caller 状态完整", async () => {
    await withApp({}, async ({ app, db }) => {
      const bearer = testId("a");
      insertRow(db, bearer, "u1", FIXED_NOW + 1);
      const preCaller = sessionSnapshot(db);
      const beforeAccounts = accountSnapshot(db);
      const callerRow = testId("b");

      db.exec("BEGIN");
      try {
        insertRow(db, callerRow, "u2", FIXED_NOW + 2);
        const response = await requestLogout(app, bearerCookie(bearer));
        // BEGIN 失败在 DELETE 之前：不得撤销、不得发布 cookie，也不得伪装 204
        expectServerError(response);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(db.isTransaction).toBe(true);
        expect(sessionSnapshot(db)).toEqual(
          rowsById(row(bearer, "u1", FIXED_NOW + 1), row(callerRow, "u2", FIXED_NOW + 2)),
        );
      } finally {
        db.exec("ROLLBACK");
      }
      // auth 既未提交也未回滚 caller 的效果：回滚后回到 caller 之前
      expect(db.isTransaction).toBe(false);
      expect(sessionSnapshot(db)).toEqual(preCaller);
      expect(accountSnapshot(db)).toEqual(beforeAccounts);

      const after = await requestLogout(app, bearerCookie(bearer));
      expect(after.statusCode).toBe(204);
      expect(sessionSnapshot(db)).toEqual([]);
    });
  });

  it("DELETE 失败 -> generic 5xx、无 clear-cookie、snapshot 不变、事务不残留", async () => {
    await withApp({}, async ({ app, db }) => {
      const id = testId("a");
      insertRow(db, id, "u1", FIXED_NOW + 1);
      const before = sessionSnapshot(db);
      await expectDeleteFailureIsServerError(db, () => requestLogout(app, bearerCookie(id)));
      expect(db.isTransaction).toBe(false);
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("app.close() 后 caller DB 仍可用并可自行关闭", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, authRuntime: fixedRuntime(() => FIXED_NOW) });
    try {
      const pair = await loginSessionPair(app);
      expect((await requestLogout(app, pair)).statusCode).toBe(204);
      await app.close();
      expect(sessionSnapshot(db)).toEqual([]);
      expect(() => db.prepare("SELECT 1 FROM auth_sessions").get()).not.toThrow();
    } finally {
      try {
        await app.close();
      } catch {
        // 已在测试体内关闭；重复 close 允许。
      }
      db.close();
    }
  });
});

describe("HTTP typed error map 恰五码（auth 域只复用既有 unauthorized）", () => {
  const codes: Record<HttpErrorCode, { statusCode: number; message: string }> = {
    bad_request: { statusCode: 400, message: "请求格式不正确" },
    invalid_credentials: { statusCode: 401, message: "账号或密码不正确" },
    account_disabled: { statusCode: 403, message: "该账号已停用，请联系管理员" },
    unauthorized: { statusCode: 401, message: "请先登录" },
    not_found: { statusCode: 404, message: "请求的资源不存在" },
  };

  /**
   * 编译期双向穷尽守卫：HTTP typed map 增码会让 `HttpCodesNotListed` 非 never，
   * 从而使下面的赋值在 `make typecheck` 失败；删码则由上面的 `Record<HttpErrorCode,…>`
   * 注解失败。auth 域同理：#10 只允许扩到既有 unauthorized。
   */
  type HttpCodesNotListed = Exclude<HttpErrorCode, keyof typeof codes>;
  type AuthCodesNotListed = Exclude<
    AuthErrorCode,
    "bad_request" | "invalid_credentials" | "account_disabled" | "unauthorized"
  >;
  const noExtraHttpCodes: [HttpCodesNotListed] extends [[]] ? true : false = true;
  const noExtraAuthCodes: [AuthCodesNotListed] extends [[]] ? true : false = true;

  it("typed map 双向穷尽：既不多码也不少码", () => {
    expect([noExtraHttpCodes, noExtraAuthCodes]).toEqual([true, true]);
    expect(Object.keys(codes)).toHaveLength(5);
  });

  it.each(Object.entries(codes))(
    "typed code %s 的 exact 信封逐字节稳定（me/logout 复用同一 unauthorized 定义）",
    async (code, definition) => {
      await withApp({}, async ({ app }) => {
        app.get(`/api/test-envelope/${code}`, () => {
          throw new HttpError(code as HttpErrorCode);
        });
        const response = await app.inject({ method: "GET", url: `/api/test-envelope/${code}` });
        expect(response.statusCode).toBe(definition.statusCode);
        expect(response.payload).toBe(
          JSON.stringify({ error: { code, message: definition.message } }),
        );
      });
    },
  );
});

describe("clear-cookie 共享 scope 与 Secure 极性", () => {
  it("省略/false/true：me 与 logout 的 clear-cookie 共享 exact 序列化，Domain 缺席", async () => {
    expect(cookiePair(CLEAR_COOKIE)).toBe("workbuddy_session=");
    expect(CLEAR_COOKIE).toContain("Max-Age=0");
    expect(CLEAR_COOKIE).toContain("Path=/");
    expect(CLEAR_COOKIE).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(CLEAR_COOKIE).toContain("HttpOnly");
    expect(CLEAR_COOKIE).toContain("SameSite=Lax");
    expect(CLEAR_COOKIE).not.toContain("Domain");
    expect(CLEAR_COOKIE).not.toContain("Secure");

    await withApp({}, async ({ app }) => {
      expectUnauthorizedTerminal(await requestMe(app), CLEAR_COOKIE);
      expectUnauthorizedTerminal(await requestLogout(app), CLEAR_COOKIE);
    });

    await withApp({ secureCookies: false }, async ({ app }) => {
      expectUnauthorizedTerminal(await requestLogout(app), CLEAR_COOKIE);
    });

    await withApp({ secureCookies: true }, async ({ app }) => {
      expectUnauthorizedTerminal(await requestMe(app), CLEAR_COOKIE_SECURE);
      expectUnauthorizedTerminal(await requestLogout(app), CLEAR_COOKIE_SECURE);
    });
  });
});
