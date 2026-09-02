import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import {
  accountSnapshot,
  CLEAR_COOKIE,
  denyStatement,
  FIXED_NOW,
  fixedRuntime,
  INTERNAL_ERROR_ENVELOPE,
  type InjectResponse,
  resetDatabase,
  sessionSnapshot,
  setCookieHeader,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";

/**
 * Issue #10 生命周期测试工具箱：真实 `createApp/openDb(":memory:")` 装配、me/logout 请求面、
 * TTL/时钟配置目录与终态断言。会话行写入、CAST 快照、cookie 解析、authorizer 故障接缝等原语的
 * 唯一 owner 在 `./session-db-helpers.js`，此处整体转发以维持既有用例的导入面。
 */

export * from "./session-db-helpers.js";

export const TTL_MESSAGE = /session ttl must be a positive safe integer/u;

export const INVALID_TTLS = [
  ["零", 0],
  ["负数", -1],
  ["负安全整数", -604_800_000],
  ["小数", 1_000.5],
  ["亚毫秒小数", 0.5],
  ["NaN", Number.NaN],
  ["正无穷", Number.POSITIVE_INFINITY],
  ["负无穷", Number.NEGATIVE_INFINITY],
  ["不安全整数", Number.MAX_SAFE_INTEGER + 1],
  ["字符串", "604800000"],
  ["null", null],
  ["布尔", true],
  ["BigInt", 1_000n],
] as const;

export const INVALID_CLOCKS = [
  ["负数", -1],
  ["小数", 1.5],
  ["NaN", Number.NaN],
  ["正无穷", Number.POSITIVE_INFINITY],
  ["不安全整数", Number.MAX_SAFE_INTEGER + 1],
  ["字符串", "1700000000000"],
] as const;

export interface AppFixtureOptions {
  sessionTtlMs?: number | undefined;
  secureCookies?: boolean;
  now?: () => number;
}

export interface AppFixture {
  app: FastifyInstance;
  db: DatabaseSync;
}

/**
 * 真实 createApp 装配。`sessionTtlMs` 原样透传（含 own `undefined`），因此经本 helper
 * 的用例同样覆盖公共入口的显式 undefined 合同，不会因为"值不存在才展开"而退化为省略。
 */
export async function withApp<T>(
  options: AppFixtureOptions,
  action: (fixture: AppFixture) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  let app: FastifyInstance | undefined;
  try {
    app = createApp({
      db,
      authRuntime: fixedRuntime(options.now ?? (() => FIXED_NOW)),
      sessionTtlMs: options.sessionTtlMs,
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    });
    return await action({ app, db });
  } finally {
    try {
      await app?.close();
    } finally {
      db.close();
    }
  }
}

export async function requestMe(app: FastifyInstance, cookie?: string): Promise<InjectResponse> {
  return app.inject({
    method: "GET",
    url: "/api/auth/me",
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

export async function requestLogout(
  app: FastifyInstance,
  cookie?: string,
  payload?: string,
  contentType?: string,
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: "/api/auth/logout",
    ...(payload === undefined ? {} : { payload }),
    headers: {
      ...(contentType === undefined ? {} : { "content-type": contentType }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });
}

export function expectUnauthorizedTerminal(
  response: InjectResponse,
  clearCookie = CLEAR_COOKIE,
): void {
  expect(response.statusCode).toBe(401);
  expect(response.payload).toBe(JSON.stringify(UNAUTHORIZED_ENVELOPE));
  expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(setCookieHeader(response)).toBe(clearCookie);
}

/** 未认证终态且 DB 逐值不变（不写任何会话/账号）。 */
export async function expectUnauthorizedNoWrite(
  app: FastifyInstance,
  db: DatabaseSync,
  cookie: string | undefined,
  route: "me" | "logout",
  clearCookie = CLEAR_COOKIE,
): Promise<void> {
  const beforeSessions = sessionSnapshot(db);
  const beforeAccounts = accountSnapshot(db);
  const response = route === "me" ? await requestMe(app, cookie) : await requestLogout(app, cookie);
  expectUnauthorizedTerminal(response, clearCookie);
  expect(sessionSnapshot(db)).toEqual(beforeSessions);
  expect(accountSnapshot(db)).toEqual(beforeAccounts);
}

export function expectServerError(response: InjectResponse): void {
  expect(response.statusCode).toBe(500);
  expect(response.payload).toBe(JSON.stringify(INTERNAL_ERROR_ENVELOPE));
  expect(response.payload).not.toContain("FST_ERR");
  expect(response.headers["set-cookie"]).toBeUndefined();
}

/** 存储写失败 lane：DELETE 被拒后请求必须 generic 5xx + no-store 且不发 clear-cookie。 */
export async function expectDeleteFailureIsServerError(
  db: DatabaseSync,
  request: () => Promise<InjectResponse>,
): Promise<void> {
  denyStatement(db, constants.SQLITE_DELETE, "auth_sessions");
  try {
    const failed = await request();
    expectServerError(failed);
    expect(failed.headers["cache-control"]).toBe("no-store");
  } finally {
    resetDatabase(db);
  }
}
