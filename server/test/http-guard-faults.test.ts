import { describe, expect, it } from "vitest";
import {
  BEGIN_DENIED,
  COMMIT_DENIED,
  DELETE_DENIED,
  expectActivity,
  expectGuardServerError,
  expectUnchanged,
  HANDLER_PROBE_ROUTE,
  PRINCIPAL_ROUTE_URL,
  REGISTERED_PROBE_ROUTE,
  request,
  SELECT_DENIED,
  seedExpiredFamily,
  withGuardApp,
} from "./http-guard-helpers.js";
import {
  bearerCookie,
  CLEAR_COOKIE,
  expectUnauthorizedEnvelope,
  FIXED_NOW,
  insertRow,
  loginSessionId,
  row,
  rowsById,
  sessionSnapshot,
  setCookieHeader,
  testId,
  totalChanges,
} from "./session-db-helpers.js";

/**
 * Issue #19 的故障归属与状态边界：guard 只消费 `authenticate` 的返回值，存储/事务异常必须
 * 原样上抛为 generic 5xx —— 绝不降级 401、绝不撤销 cookie、绝不留半提交状态。故障由真实
 * SQLite authorizer 在语句/事务边界 DENY 注入（计数是"尝试次数"，故被拒语句照样计入），
 * 不 mock DB 也不 mock authenticate。
 */

describe("guard 故障归属：异常不得变成 401", () => {
  it("session 点查询失败 -> generic 5xx、无语义 code、无 clear-cookie、快照不变", async () => {
    await withGuardApp(async ({ db, observeConsumerWithSession }) => {
      await observeConsumerWithSession();
      const denied = await observeConsumerWithSession(SELECT_DENIED);
      expectGuardServerError(denied);
      // 尝试一次点查后被拒：guard 未把它降级成"无会话"
      expectActivity(denied.activity, { selects: 1 });
      expectUnchanged(denied, db);
    });
  });

  it("expired row 的条件清理失败 -> generic 5xx，行保留、无 clear-cookie", async () => {
    await withGuardApp(async ({ db, observeConsumer }) => {
      const expired = testId("a");
      insertRow(db, expired, "u1", FIXED_NOW - 1);
      const denied = await observeConsumer(bearerCookie(expired), DELETE_DENIED);
      expectGuardServerError(denied);
      expect(denied.response.payload).not.toContain("unauthorized");
      expectActivity(denied.activity, { selects: 1, deletes: 1 });
      expectUnchanged(denied, db);
    });
  });

  /** BEGIN 被拒时 DELETE 压根不尝试；COMMIT 被拒时 DELETE 已尝试后回滚——两种故障可区分。 */
  it.each([
    ["BEGIN", BEGIN_DENIED, { selects: 1 }],
    ["COMMIT", COMMIT_DENIED, { selects: 1, deletes: 1 }],
  ] as const)(
    "清理事务 %s 失败 -> generic 5xx，行未被删除且事务不残留",
    async (_name, fault, expectedActivity) => {
      await withGuardApp(async ({ db, observeConsumer }) => {
        const expired = testId("a");
        insertRow(db, expired, "u1", FIXED_NOW - 1);

        const denied = await observeConsumer(bearerCookie(expired), fault);
        expectGuardServerError(denied);
        expectActivity(denied.activity, expectedActivity);
        expectUnchanged(denied, db);
      });
    },
  );

  it("故障与真未认证是两条不同终态：me 的 5xx 无撤销，401 才带 no-store+clear", async () => {
    await withGuardApp(async ({ app, db, observe }) => {
      const sessionId = await loginSessionId(app);
      const before = sessionSnapshot(db);

      const faulted = await observe(
        { method: "GET", url: "/api/auth/me", cookie: bearerCookie(sessionId) },
        SELECT_DENIED,
      );
      expect(faulted.response.statusCode).toBe(500);
      expect(faulted.response.payload).not.toContain("unauthorized");
      expect(faulted.response.headers["cache-control"]).toBe("no-store");
      expect(faulted.response.headers["set-cookie"]).toBeUndefined();

      const anonymous = await observe({ method: "GET", url: "/api/auth/me" });
      expectUnauthorizedEnvelope(anonymous.response);
      expect(anonymous.response.headers["cache-control"]).toBe("no-store");
      expect(setCookieHeader(anonymous.response)).toBe(CLEAR_COOKIE);
      expectActivity(anonymous.activity, {});

      expect(sessionSnapshot(db)).toEqual(before);
    });
  });

  it("public 与 non-API 面在 session 读被拒时行为不变：guard 从不查询会话", async () => {
    await withGuardApp(async ({ app, observe }) => {
      const sessionId = await loginSessionId(app);
      const statuses: string[] = [];

      for (const spec of [
        { method: "GET", url: "/api/healthz" },
        { method: "HEAD", url: "/api/info" },
        { method: "GET", url: "/not-an-api" },
        { method: "POST", url: "/not-an-api" },
      ] as const) {
        const denied = await observe({ ...spec, cookie: bearerCookie(sessionId) }, SELECT_DENIED);
        statuses.push(String(denied.response.statusCode));
        expectActivity(denied.activity, {});
      }

      expect(statuses).toEqual(["200", "200", "404", "404"]);
    });
  });

  it("已认证请求的 parser/route-owner 语义不被 guard 改写：registered 仍 5xx、catch-all 仍 404", async () => {
    await withGuardApp(async ({ app, observe }) => {
      const sessionId = await loginSessionId(app);
      const spec = {
        method: "POST" as const,
        payload: '{"a": ',
        contentType: "application/json",
        cookie: bearerCookie(sessionId),
      };

      const registered = await observe({ ...spec, url: REGISTERED_PROBE_ROUTE });
      expect(registered.response.statusCode).toBe(500);
      expect(registered.response.payload).toBe(
        JSON.stringify({ error: { message: "服务器内部错误" } }),
      );
      expectActivity(registered.activity, { selects: 1 });

      const miss = await observe({ ...spec, url: "/api/no-such" });
      expect(miss.response.statusCode).toBe(404);
      expectActivity(miss.activity, { selects: 1 });

      const handler = await observe({ ...spec, url: HANDLER_PROBE_ROUTE });
      expect(handler.response.statusCode).toBe(500);
    });
  });
});

describe("guard 状态边界：无缓存、无全局清理、DB 所有权不变", () => {
  it("撤销后的同一 cookie 立即失效：guard 不复用任何 Principal 缓存", async () => {
    await withGuardApp(async ({ app, db }) => {
      const sessionId = await loginSessionId(app);
      const consumer = (cookie?: string) =>
        request(app, { method: "GET", url: PRINCIPAL_ROUTE_URL, cookie });
      expect((await consumer(bearerCookie(sessionId))).statusCode).toBe(200);

      const loggedOut = await request(app, {
        method: "POST",
        url: "/api/auth/logout",
        cookie: bearerCookie(sessionId),
      });
      expect(loggedOut.statusCode).toBe(204);

      expectUnauthorizedEnvelope(await consumer(bearerCookie(sessionId)));
      expect(sessionSnapshot(db)).toEqual([]);
    });
  });

  it("expired disabled/orphan row 同样先条件删除再 401，siblings 逐值不变", async () => {
    await withGuardApp(async ({ db, observeConsumer }) => {
      const family = seedExpiredFamily(db);

      // 只请求 disabled 与 orphan：enabled 那条必须仍可寻址（无扫表清理）
      for (const id of [family.expiredDisabled, family.expiredOrphan]) {
        const observed = await observeConsumer(bearerCookie(id));
        expectUnauthorizedEnvelope(observed.response);
        expectActivity(observed.activity, { selects: 1, deletes: 1 });
      }

      expect(sessionSnapshot(db)).toEqual(
        rowsById(row(family.expiredEnabled, "u1", FIXED_NOW - 1), ...family.survivorSnapshot),
      );
    });
  });

  it("未认证/已认证请求都不触发全局会话清理：未被请求的 expired row 仍在", async () => {
    await withGuardApp(async ({ app, db }) => {
      const sessionId = await loginSessionId(app);
      const expiredOther = testId("e");
      insertRow(db, expiredOther, "u2", FIXED_NOW - 1);
      const changes = totalChanges(db);

      for (const spec of [
        { method: "GET", url: PRINCIPAL_ROUTE_URL },
        { method: "GET", url: "/api" },
        { method: "POST", url: "/api/no-such" },
        { method: "GET", url: "/api/no-such", cookie: bearerCookie(sessionId) },
        { method: "GET", url: "/not-an-api", cookie: bearerCookie(sessionId) },
        { method: "GET", url: "/api/auth/me" },
      ] as const) {
        await request(app, spec);
      }

      const ids = sessionSnapshot(db).map((entry) => entry.id);
      expect(ids).toContain(testId("e"));
      expect(ids).toContain(sessionId);
      expect(totalChanges(db)).toBe(changes);
    });
  });

  it("app.close 后 caller 仍可查询：guard 不接管 DB 生命周期也不打开第二个连接", async () => {
    await withGuardApp(async ({ app, db }) => {
      const sessionId = await loginSessionId(app);
      const response = await request(app, {
        method: "GET",
        url: PRINCIPAL_ROUTE_URL,
        cookie: bearerCookie(sessionId),
      });
      expect(response.statusCode).toBe(200);
      await app.close();
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({
        count: 1,
      });
    });
  });
});
