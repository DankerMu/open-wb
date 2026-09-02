import { describe, expect, it } from "vitest";
import { SERVICE_INFO } from "../src/service-info.js";
import {
  expectActivity,
  expectGuardDenial,
  expectUnchanged,
  HANDLER_PROBE_ROUTE,
  type InjectMethod,
  PRINCIPAL_ROUTE,
  PRINCIPAL_ROUTE_URL,
  principalShapeHandler,
  request,
  STATE_PROBE_ROUTE,
  seedExpiredFamily,
  UNAUTHORIZED_PAYLOAD,
  withGuardApp,
  withStandaloneAuthApp,
} from "./http-guard-helpers.js";
import { rawHttpRequest, withListeningApp } from "./raw-http-helpers.js";
import {
  bearerCookie,
  CLEAR_COOKIE,
  CREDENTIALS,
  disableAccount,
  expectPrincipalResponse,
  expectUnauthorizedEnvelope,
  FIXED_NOW,
  insertOrphanRow,
  insertRow,
  loginSessionId,
  MALFORMED_SESSION_IDS,
  PRINCIPAL_ZHANGSAN,
  PRINCIPAL_ZHAOLIU,
  rawCookie,
  row,
  sessionSnapshot,
  setCookieHeader,
  testId,
  totalChanges,
  UNKNOWN_SESSION_IDS,
} from "./session-db-helpers.js";

/**
 * Issue #19 默认拒绝面 + 集中精确豁免表 + request-local Principal。
 * 全部经真实 `createApp + openDb(":memory:") + app.inject()`：session 点查询次数由真实
 * SQLite authorizer 的 `SQLITE_SELECT` 语句事件计数，Principal 绑定由 protected consumer
 * route 回显，因此"恰一次 authenticate"、"零 session 查询"与"不 cross-bind"都是观测值。
 */

/** 形状层（cookie 解析）即被拒的输入：401 且一次 SQL 都不该发生。 */
const NO_QUERY_COOKIES: ReadonlyArray<readonly [string, string | undefined]> = [
  ["无 cookie", undefined],
  ["错误 cookie 名", `other_session=${"a".repeat(64)}`],
  ["同名多属性串", "sid=1; workbuddy_session=not-hex"],
  ...MALFORMED_SESSION_IDS.map(
    (entry) => [entry[0], rawCookie(entry[1])] as readonly [string, string],
  ),
];

const PROTECTED_URLS = [
  "/api",
  "/api?x=1",
  "/api/",
  "/api/x",
  "/api/no-such",
  PRINCIPAL_ROUTE_URL,
  HANDLER_PROBE_ROUTE,
] as const;

describe("默认拒绝：original API namespace 一律要求有效会话", () => {
  it.each(PROTECTED_URLS)("protected %s 无 cookie 返回 exact 401，而非既有 404", async (url) => {
    await withGuardApp(async ({ db, observe }) => {
      const observed = await observe({ method: "GET", url });
      expectGuardDenial(observed);
      expectActivity(observed.activity, {});
      expectUnchanged(observed, db);

      const posted = await observe({
        method: "POST",
        url,
        payload: '{"account": ',
        contentType: "application/json",
      });
      expectGuardDenial(posted);
      expectUnchanged(posted, db);
    });
  });

  it.each(NO_QUERY_COOKIES)(
    "protected exact /api 携 %s 返回逐字相同 401 且零 session 查询",
    async (_name, cookie) => {
      await withGuardApp(async ({ db, observe }) => {
        const observed = await observe({ method: "GET", url: "/api", cookie });
        expectGuardDenial(observed);
        expectActivity(observed.activity, {});
        expectUnchanged(observed, db);
      });
    },
  );

  it.each(NO_QUERY_COOKIES)(
    "protected consumer %s 携 %s 返回逐字相同 401 且零 session 查询",
    async (_name, cookie) => {
      await withGuardApp(async ({ observeConsumer }) => {
        const observed = await observeConsumer(cookie);
        expectGuardDenial(observed);
        expectActivity(observed.activity, {});
      });
    },
  );

  it.each([...UNKNOWN_SESSION_IDS.entries()])(
    "protected consumer 携第 %i 个未知 exact 64 hex：恰一次点查后 401，零写入",
    async (_index, id) => {
      await withGuardApp(async ({ db, observeConsumer }) => {
        const observed = await observeConsumer(bearerCookie(id));
        expectGuardDenial(observed);
        expectActivity(observed.activity, { selects: 1 });
        expectUnchanged(observed, db);
      });
    },
  );

  it("未认证 protected 请求的 handler 不运行", async () => {
    await withGuardApp(async ({ observe, handlerProbeCalls }) => {
      const observed = await observe({
        method: "POST",
        url: HANDLER_PROBE_ROUTE,
        payload: JSON.stringify({ name: "x" }),
        contentType: "application/json",
      });
      expectGuardDenial(observed);
      expect(handlerProbeCalls()).toBe(0);
    });
  });

  it("HEAD protected API 返回 401 而非 404 bypass，并按待发长度保留 HTTP 语义", async () => {
    await withGuardApp(async ({ observe }) => {
      for (const url of ["/api/no-such", "/api", PRINCIPAL_ROUTE_URL, "/api/auth/login"]) {
        const observed = await observe({ method: "HEAD", url });
        expect(observed.response.statusCode, url).toBe(401);
        expect(observed.response.headers["content-length"]).toBe(
          String(Buffer.byteLength(UNAUTHORIZED_PAYLOAD)),
        );
        expect(observed.response.payload).not.toContain("not_found");
        expect(observed.response.headers["set-cookie"]).toBeUndefined();
        expectActivity(observed.activity, {});
      }
    });
  });

  it("真实 HTTP/1.1 下 HEAD 401 只发 header 无 body", async () => {
    await withGuardApp(async ({ app }) => {
      await withListeningApp(app, async (origin) => {
        const wire = await rawHttpRequest(origin, { method: "HEAD", target: "/api/no-such" });
        expect(wire.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
        expect(wire).toContain(`content-length: ${Buffer.byteLength(UNAUTHORIZED_PAYLOAD)}`);
        expect(wire.endsWith("\r\n\r\n")).toBe(true);
      });
    });
  });

  it("guard 401 不伪装成其它语义 code", async () => {
    await withGuardApp(async ({ observe }) => {
      const { response } = await observe({ method: "GET", url: "/api/x" });
      expect(response.payload).toBe(UNAUTHORIZED_PAYLOAD);
      expect(response.payload).not.toContain("not_found");
      expect(response.payload).not.toContain("服务器内部错误");
      expect(String(response.headers["content-type"])).toMatch(/application\/json/iu);
    });
  });
});

describe("集中精确豁免表：matched method + route identity 完全相等才 public", () => {
  const PUBLIC_ROWS: ReadonlyArray<readonly [InjectMethod, string, string]> = [
    ["GET", "/api/healthz", '{"status":"ok"}'],
    ["GET", "/api/healthz?probe=1", '{"status":"ok"}'],
    ["GET", "/api/info", JSON.stringify(SERVICE_INFO)],
    ["GET", "/api/info?probe=1", JSON.stringify(SERVICE_INFO)],
  ];

  it.each(PUBLIC_ROWS)(
    "%s %s 携有效会话仍返回原 body 且零 session 查询",
    async (method, url, payload) => {
      await withGuardApp(async ({ app, observe }) => {
        const sessionId = await loginSessionId(app);
        const { response, activity } = await observe({
          method,
          url,
          cookie: bearerCookie(sessionId),
        });
        expect(response.statusCode).toBe(200);
        expect(response.payload).toBe(payload);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expectActivity(activity, {});
      });
    },
  );

  it("HEAD healthz/info 继承豁免：原状态与 content-length，零查询", async () => {
    await withGuardApp(async ({ app, observe }) => {
      const sessionId = await loginSessionId(app);
      const rows: ReadonlyArray<readonly [string, string]> = [
        ["/api/healthz", '{"status":"ok"}'],
        ["/api/info", JSON.stringify(SERVICE_INFO)],
      ];
      for (const [url, body] of rows) {
        const { response, activity } = await observe({
          method: "HEAD",
          url,
          cookie: bearerCookie(sessionId),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
        expectActivity(activity, {});
      }
    });
  });

  it("public 面携任意畸形 cookie、非法认证时钟与 expired row 仍 200 且零读取零清理", async () => {
    await withGuardApp(
      async ({ db, observe }) => {
        insertRow(db, testId("a"), "u1", FIXED_NOW - 1);
        const before = sessionSnapshot(db);
        const changes = totalChanges(db);

        for (const [method, url] of [
          ["GET", "/api/healthz"],
          ["HEAD", "/api/healthz"],
          ["GET", "/api/info?x=1"],
          ["HEAD", "/api/info"],
        ] as const) {
          const { response, activity } = await observe({
            method,
            url,
            cookie: `workbuddy_session=${"z".repeat(9)}; other=1`,
          });
          expect(response.statusCode).toBe(200);
          expectActivity(activity, {});
        }
        expect(sessionSnapshot(db)).toEqual(before);
        expect(totalChanges(db)).toBe(changes);
      },
      { now: () => Number.NaN },
    );
  });

  const NEAR_MISS_ROWS: ReadonlyArray<readonly [InjectMethod, string]> = [
    ["GET", "/api/auth/login"],
    ["GET", "/api/auth/logout"],
    ["PUT", "/api/auth/login"],
    ["DELETE", "/api/auth/logout"],
    ["POST", "/api/healthz"],
    ["POST", "/api/healthz?probe=1"],
    ["PUT", "/api/info"],
    ["POST", "/api/healthz/"],
    ["GET", "/api/healthz/"],
    ["GET", "/api/info/"],
    ["POST", "/api/auth/login/"],
    ["POST", "/api/auth/logout/"],
  ];

  it.each(NEAR_MISS_ROWS)("%s %s 不继承豁免，按 protected 返回 401", async (method, url) => {
    await withGuardApp(async ({ observe }) => {
      const { response, activity } = await observe({ method, url });
      expectUnauthorizedEnvelope(response);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expectActivity(activity, {});
    });
  });

  it("login 豁免保留自身合同：query 变体成功写恰一行，非法 shape 在 KDF/写入前 exact 400", async () => {
    await withGuardApp(async ({ db, observe }) => {
      const changesBefore = totalChanges(db);
      const ok = await observe({
        method: "POST",
        url: "/api/auth/login?redirect=1",
        payload: JSON.stringify(CREDENTIALS),
        contentType: "application/json",
      });
      expect(ok.response.statusCode).toBe(200);
      expect(ok.response.payload).toBe(JSON.stringify(PRINCIPAL_ZHANGSAN));
      expect(setCookieHeader(ok.response)).toContain("workbuddy_session=");
      expectActivity(ok.activity, { selects: 1, inserts: 1 });
      expect(sessionSnapshot(db)).toHaveLength(1);

      const shape = await observe({
        method: "POST",
        url: "/api/auth/login",
        payload: JSON.stringify({ account: CREDENTIALS.account }),
        contentType: "application/json",
      });
      expect(shape.response.statusCode).toBe(400);
      expect(shape.response.payload).toBe(
        JSON.stringify({ error: { code: "bad_request", message: "请求格式不正确" } }),
      );
      // guard 未参与，且 login 的形状失败发生在账号查询之前：SQL 活动为 0
      expectActivity(shape.activity, {});
      expect(sessionSnapshot(db)).toHaveLength(1);
      expect(totalChanges(db) - changesBefore).toBe(1);
    });
  });

  it("logout 豁免绕过 Principal eligibility：expired/disabled/orphan 与非法时钟下 existing row 仍 204 删除", async () => {
    await withGuardApp(
      async ({ db, observe }) => {
        const expired = testId("a");
        const disabled = testId("b");
        const orphan = testId("c");
        insertRow(db, expired, "u1", FIXED_NOW - 1);
        insertRow(db, disabled, "u4", FIXED_NOW + 60_000);
        insertOrphanRow(db, orphan, "u9", FIXED_NOW + 60_000);
        disableAccount(db, "u4");

        for (const id of [expired, disabled, orphan]) {
          const { response, activity } = await observe({
            method: "POST",
            url: "/api/auth/logout?scope=1",
            cookie: bearerCookie(id),
          });
          expect(response.statusCode, id).toBe(204);
          expect(response.payload).toBe("");
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
          // selects === 0 即 guard 从未对 logout 调用 authenticate；deletes 是 handler 的撤销
          expectActivity(activity, { deletes: 1 });
        }
        expect(sessionSnapshot(db)).toEqual([]);
      },
      { now: () => -5 },
    );
  });

  it("logout 未认证合同不变：missing/unknown/畸形 cookie 401+clear，guard 不额外查询", async () => {
    await withGuardApp(async ({ db, observe }) => {
      const existing = testId("a");
      insertRow(db, existing, "u1", FIXED_NOW + 60_000);
      const before = sessionSnapshot(db);
      const changes = totalChanges(db);

      for (const [cookie, deletes] of [
        [undefined, 0],
        [bearerCookie("e".repeat(64)), 1],
        [rawCookie("short"), 0],
      ] as const) {
        const { response, activity } = await observe({
          method: "POST",
          url: "/api/auth/logout",
          cookie,
        });
        expectUnauthorizedEnvelope(response);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(setCookieHeader(response)).toBe(CLEAR_COOKIE);
        // 唯一 SQL 活动是 handler 自身的 bearer DELETE 尝试；guard 零 authenticate
        expectActivity(activity, { deletes });
      }
      expect(sessionSnapshot(db)).toEqual(before);
      expect(totalChanges(db)).toBe(changes);
    });
  });

  it("logout body/parser 失败仍是 route-owned 400，先于 cookie 查询与 DELETE", async () => {
    await withGuardApp(async ({ app, db, observe }) => {
      const sessionId = await loginSessionId(app);
      const before = sessionSnapshot(db);

      for (const payload of ['{"a": ', "", "binary"]) {
        const { response, activity } = await observe({
          method: "POST",
          url: "/api/auth/logout",
          payload,
          contentType: payload === "binary" ? "application/octet-stream" : "application/json",
          cookie: bearerCookie(sessionId),
        });
        expect(response.statusCode).toBe(400);
        expect(response.payload).toBe(
          JSON.stringify({ error: { code: "bad_request", message: "请求格式不正确" } }),
        );
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
        expectActivity(activity, {});
      }
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });
});

describe("request-local Principal 与会话状态迁移", () => {
  it("valid future cookie 只判定一次并把 exact Principal 绑给 consumer", async () => {
    await withGuardApp(async ({ db, observeConsumer, observeConsumerWithSession }) => {
      const first = await observeConsumerWithSession();
      expect(first.response.statusCode).toBe(200);
      expect(JSON.parse(first.response.payload)).toEqual({ principal: PRINCIPAL_ZHANGSAN });
      expectActivity(first.activity, { selects: 1 });
      expectUnchanged(first, db);

      const again = await observeConsumer(bearerCookie(first.sessionId));
      expect(JSON.parse(again.response.payload)).toEqual({ principal: PRINCIPAL_ZHANGSAN });
      expectActivity(again.activity, { selects: 1 });
      expectUnchanged(again, db);
    });
  });

  it("并行不同 cookie 各自绑定自己的 Principal，绝不 cross-bind", async () => {
    await withGuardApp(async ({ app, db }) => {
      const zhangsan = await loginSessionId(app, "zhangsan");
      const zhaoliu = await loginSessionId(app, "zhaoliu");
      const before = sessionSnapshot(db);
      const call = (cookie?: string) =>
        request(app, { method: "GET", url: PRINCIPAL_ROUTE, cookie });

      const results = await Promise.all([
        call(bearerCookie(zhangsan)),
        call(bearerCookie(zhaoliu)),
        call(bearerCookie(zhangsan)),
        call(bearerCookie(zhaoliu)),
        call(),
      ]);

      expect(results.map((entry) => entry.payload)).toEqual([
        JSON.stringify({ principal: PRINCIPAL_ZHANGSAN }),
        JSON.stringify({ principal: PRINCIPAL_ZHAOLIU }),
        JSON.stringify({ principal: PRINCIPAL_ZHANGSAN }),
        JSON.stringify({ principal: PRINCIPAL_ZHAOLIU }),
        UNAUTHORIZED_PAYLOAD,
      ]);
      expect(results[4]?.statusCode).toBe(401);
      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("Principal 绑定是 request-local：未认证请求永不见到其它请求的绑定", async () => {
    await withGuardApp(async ({ app }) => {
      const sessionId = await loginSessionId(app);
      const valid = await request(app, {
        method: "GET",
        url: PRINCIPAL_ROUTE,
        cookie: bearerCookie(sessionId),
      });
      expect(JSON.parse(valid.payload)).toEqual({ principal: PRINCIPAL_ZHANGSAN });

      for (const second of [
        await request(app, { method: "GET", url: PRINCIPAL_ROUTE }),
        await request(app, {
          method: "GET",
          url: PRINCIPAL_ROUTE,
          cookie: bearerCookie("9".repeat(64)),
        }),
      ]) {
        expect(second.statusCode).toBe(401);
        expect(second.payload).not.toContain(PRINCIPAL_ZHANGSAN.account);
      }
    });
  });

  it("me 消费 guard 已绑定的 Principal：valid 200/no-store/无 Set-Cookie 且只一次点查", async () => {
    await withGuardApp(async ({ app, db, observe }) => {
      const sessionId = await loginSessionId(app);
      const { response, activity } = await observe({
        method: "GET",
        url: "/api/auth/me",
        cookie: bearerCookie(sessionId),
      });
      expectPrincipalResponse(response, PRINCIPAL_ZHANGSAN);
      // 二次 authenticate 会翻倍 SELECT 计数，这条断言即其判据
      expectActivity(activity, { selects: 1 });
      expect(sessionSnapshot(db)).toHaveLength(1);
    });
  });

  it("future disabled/orphan row：401、恰一次点查且零写入", async () => {
    await withGuardApp(async ({ db, observeConsumer }) => {
      const disabled = testId("b");
      const orphan = testId("c");
      insertRow(db, disabled, "u4", FIXED_NOW + 60_000);
      insertOrphanRow(db, orphan, "u9", FIXED_NOW + 60_000);
      disableAccount(db, "u4");
      const before = sessionSnapshot(db);
      const changes = totalChanges(db);

      for (const id of [disabled, orphan]) {
        const observed = await observeConsumer(bearerCookie(id));
        expectGuardDenial(observed);
        expectActivity(observed.activity, { selects: 1 });
      }
      expect(sessionSnapshot(db)).toEqual(before);
      expect(totalChanges(db)).toBe(changes);
    });
  });

  it("非法认证时钟：protected 在查询前 401，me 仍保 no-store/clear，consumer 无 clear", async () => {
    await withGuardApp(
      async ({ db, observe, observeConsumer }) => {
        const valid = testId("a");
        insertRow(db, valid, "u1", FIXED_NOW + 60_000);
        const before = sessionSnapshot(db);

        const consumer = await observeConsumer(bearerCookie(valid));
        expectGuardDenial(consumer);
        expectActivity(consumer.activity, {});

        const me = await observe({
          method: "GET",
          url: "/api/auth/me",
          cookie: bearerCookie(valid),
        });
        expectUnauthorizedEnvelope(me.response);
        expect(me.response.headers["cache-control"]).toBe("no-store");
        expect(setCookieHeader(me.response)).toBe(CLEAR_COOKIE);
        expectActivity(me.activity, {});

        expect(sessionSnapshot(db)).toEqual(before);
      },
      { now: () => Number.POSITIVE_INFINITY },
    );
  });

  it("exact expired（enabled/disabled/orphan）先条件删除再 401，siblings 逐值不变", async () => {
    await withGuardApp(async ({ db, observeConsumer }) => {
      const family = seedExpiredFamily(db);

      for (const id of family.expiredIds) {
        const observed = await observeConsumer(bearerCookie(id));
        expectGuardDenial(observed);
        // 一次点查 + 一次条件删除；绝不 UPDATE、绝不扫表
        expectActivity(observed.activity, { selects: 1, deletes: 1 });
      }

      expect(sessionSnapshot(db)).toEqual(family.survivorSnapshot);
    });
  });

  it("重复请求 expired row 只由首次调用删除一行", async () => {
    await withGuardApp(async ({ db, observeConsumer }) => {
      const expired = testId("a");
      insertRow(db, expired, "u1", FIXED_NOW - 1);
      const first = await observeConsumer(bearerCookie(expired));
      const changesAfterFirst = totalChanges(db);
      const second = await observeConsumer(bearerCookie(expired));

      expectGuardDenial(first);
      expectGuardDenial(second);
      expectActivity(first.activity, { selects: 1, deletes: 1 });
      expectActivity(second.activity, { selects: 1 });
      expect(sessionSnapshot(db)).toEqual([]);
      expect(totalChanges(db)).toBe(changesAfterFirst);
    });
  });

  it("valid-auth 的未知 API 仍是既有 typed 404；未认证有意变成 401", async () => {
    await withGuardApp(async ({ app, observe }) => {
      const sessionId = await loginSessionId(app);
      const { response, activity } = await observe({
        method: "GET",
        url: "/api/no-such",
        cookie: bearerCookie(sessionId),
      });
      expect(response.statusCode).toBe(404);
      expect(response.payload).toBe(
        JSON.stringify({ error: { code: "not_found", message: "请求的资源不存在" } }),
      );
      expectActivity(activity, { selects: 1 });

      const denied = await observe({ method: "GET", url: "/api/no-such" });
      expectUnauthorizedEnvelope(denied.response);
      expectActivity(denied.activity, {});
    });
  });

  /**
   * standalone `registerAuth`（不装配 root guard）是 #10 交付且仍被 request-errors 套件使用的
   * 公共形状：没有 guard 绑定 Principal 时 me 必须自行调用唯一判定出口，而不是恒定 401。
   * 与上一条用例（guarded me 恰一次点查）成对——去掉 me 的 Principal 回落会红本条，
   * 让 me 无条件二次 authenticate 会红上一条。
   */
  it("standalone registerAuth 未绑定 Principal 时 me 仍返回 exact Principal", async () => {
    await withStandaloneAuthApp(async ({ app, db }) => {
      const valid = testId("a");
      insertRow(db, valid, "u1", FIXED_NOW + 60_000);
      const response = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: bearerCookie(valid) },
      });
      expectPrincipalResponse(response, PRINCIPAL_ZHANGSAN);
      expect(sessionSnapshot(db)).toEqual([row(valid, "u1", FIXED_NOW + 60_000)]);
    });
  });

  /**
   * Phase-2 finding 2：auth 拥有 `request.principal` 的类型增广（`Principal | null`），
   * 就必须拥有其运行时默认值。standalone `registerAuth` 之后注册的任意 route 观察到的
   * 必须是 exact `null`（`typeof` 是 "object"、`=== null` 为 true），而不是 undefined ——
   * 否则公共类型承诺与运行时不符，下游会省掉 undefined 分支。
   */
  it("standalone registerAuth 为每个 request 安装 exact null principal 默认值", async () => {
    await withStandaloneAuthApp(async ({ app }) => {
      app.get(STATE_PROBE_ROUTE, principalShapeHandler);

      const response = await app.inject({ method: "GET", url: STATE_PROBE_ROUTE });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ isNull: true, typeName: "object" });
    });
  });

  /**
   * decoration 归 auth 后，createApp（auth + guard 都装配）不得重复 decorate：同实例第二次
   * `decorateRequest` 会在装配时同步抛 FST_ERR_DEC_ALREADY_PRESENT，因此 ready 成功本身就是
   * 判据；再验证 guarded 与绕过 guard 的 non-API 请求各自看到 request-local 默认值，
   * 一次有效请求写入的 Principal 不外泄，且 guarded consumer 仍恰一次点查。
   */
  it("createApp 不重复 decoration：ready 后 guarded/绕过请求各自 request-local", async () => {
    await withGuardApp(async ({ app, observe }) => {
      await expect(app.ready()).resolves.toBe(app);

      const bypassed = await app.inject({ method: "GET", url: STATE_PROBE_ROUTE });
      expect(bypassed.statusCode).toBe(200);
      expect(JSON.parse(bypassed.payload)).toEqual({ isNull: true, typeName: "object" });

      const sessionId = await loginSessionId(app);
      const bound = await observe({
        method: "GET",
        url: PRINCIPAL_ROUTE_URL,
        cookie: bearerCookie(sessionId),
      });
      expect(JSON.parse(bound.response.payload)).toEqual({ principal: PRINCIPAL_ZHANGSAN });
      expectActivity(bound.activity, { selects: 1 });

      const isolated = await app.inject({ method: "GET", url: STATE_PROBE_ROUTE });
      expect(JSON.parse(isolated.payload)).toEqual({ isNull: true, typeName: "object" });
    });
  });
});
