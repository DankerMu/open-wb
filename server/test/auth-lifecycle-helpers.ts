import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { SESSION_COOKIE } from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";

/**
 * Issue #10 生命周期测试的真实接缝工具箱：只装配真实 `createApp/openDb(":memory:")`
 * 与真实 SQLite（authorizer/trigger/total_changes），不 mock 被测系统。
 * HTTP 面断言用 `withApp` + `requestMe/requestLogout`，DB 面断言用 CAST 快照，
 * 使超过 JavaScript 安全整数范围的 `expires_at` 也能逐值比较而不经 number 投影。
 */

export const FIXED_NOW = 1_700_000_000_000;
export const INT64_MAX = 9_223_372_036_854_775_807n;
export const CREDENTIALS = { account: "zhangsan", password: "demo" };
export const PRINCIPAL_ZHANGSAN = { id: "u1", account: "zhangsan", role: "成员" };
const UNAUTHORIZED_ENVELOPE = { error: { code: "unauthorized", message: "请先登录" } };
export const BAD_REQUEST_ENVELOPE = { error: { code: "bad_request", message: "请求格式不正确" } };
const INTERNAL_ERROR_ENVELOPE = { error: { message: "服务器内部错误" } };
export const CLEAR_COOKIE =
  "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax";
export const CLEAR_COOKIE_SECURE =
  "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax";
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

/** 畸形 session id 唯一目录：direct 解析与 HTTP cookie 形状两侧共用同一来源。 */
export const MALFORMED_SESSION_IDS = [
  ["32 位", "a".repeat(32)],
  ["63 位", "a".repeat(63)],
  ["65 位", "a".repeat(65)],
  ["大写 hex", "A".repeat(64)],
  ["非 hex", "g".repeat(64)],
  ["空值", ""],
  ["短 GUID 形", "5777bb89-d0a3-4b5f-8af7-33b23fa6dd5d"],
] as const;

export interface InjectResponse {
  statusCode: number;
  payload: string;
  headers: Record<string, unknown>;
  json: () => unknown;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
}

export interface AppFixtureOptions {
  sessionTtlMs?: number | undefined;
  secureCookies?: boolean;
  now?: () => number;
}

export interface AppFixture {
  app: FastifyInstance;
  db: DatabaseSync;
}

/** 每次调用换填充字节，避免同一 DB 内多次登录的 session ID 碰撞。 */
let randomFillCounter = 0x11;
function distinctRandomBytes(size: number): Buffer {
  const fill = randomFillCounter % 256;
  randomFillCounter += 1;
  return Buffer.alloc(size, fill === 0 ? 0x11 : fill);
}

/** 64 位 lowercase hex 测试 ID：ORDER BY id 下可预测，且互不冲突。 */
export function testId(marker: string): string {
  const id = marker.repeat(64);
  if (!/^[0-9a-f]{64}$/u.test(id)) {
    throw new Error(`test id must be 64 lowercase hex: ${marker}`);
  }
  return id;
}

/** CAST 到 TEXT：int64 满量程行也能逐值比较，不经过 JS number 投影。 */
export function sessionSnapshot(db: DatabaseSync): SessionRow[] {
  return db
    .prepare(
      "SELECT id, user_id, CAST(expires_at AS TEXT) AS expires_at FROM auth_sessions ORDER BY id",
    )
    .all() as unknown as SessionRow[];
}

export function accountSnapshot(db: DatabaseSync): unknown {
  return db
    .prepare("SELECT id, account, role, disabled, password_hash FROM accounts ORDER BY id")
    .all();
}

export function totalChanges(db: DatabaseSync): number {
  return (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

export function insertRow(
  db: DatabaseSync,
  id: string,
  userId: string,
  expiresAt: number | bigint,
): void {
  db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
    id,
    userId,
    expiresAt,
  );
}

/** FK 关闭后写入不存在账号的会话行，得到真实 orphan row。 */
export function insertOrphanRow(
  db: DatabaseSync,
  id: string,
  userId: string,
  expiresAt: number | bigint,
): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    insertRow(db, id, userId, expiresAt);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function row(id: string, userId: string, expiresAt: number | bigint): SessionRow {
  return { id, user_id: userId, expires_at: String(expiresAt) };
}

export function rowsById(...rowsToSort: SessionRow[]): SessionRow[] {
  return [...rowsToSort].sort((left, right) => (left.id < right.id ? -1 : 1));
}

export function fixedRuntime(now: () => number) {
  return { now, randomBytes: distinctRandomBytes };
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

export function setCookieHeader(response: InjectResponse): string | undefined {
  const value = response.headers["set-cookie"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`expected exactly one Set-Cookie header, got ${String(value)}`);
  }
  return value;
}

export function cookiePair(header: string): string {
  const pair = header.split(";")[0];
  if (pair === undefined) {
    throw new Error(`cookie header carries no name=value pair: ${header}`);
  }
  return pair;
}

export function cookieValueOf(pair: string): string {
  const value = pair.split("=")[1];
  if (value === undefined) {
    throw new Error(`cookie pair has no value: ${pair}`);
  }
  return value;
}

export function bearerCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}`;
}

/** 任意 cookie 值（含畸形值）组成的请求头。 */
export function rawCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}`;
}

export async function loginSessionPair(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: JSON.stringify(CREDENTIALS),
    headers: { "content-type": "application/json" },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed with ${response.statusCode}: ${response.payload}`);
  }
  const header = setCookieHeader(response);
  if (header === undefined) {
    throw new Error("login established no session cookie");
  }
  return cookiePair(header);
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

/** 真实 SQLite 接缝：authorizer 拒绝指定语句类别。 */
export function denyStatement(db: DatabaseSync, code: number, arg1: string | null): void {
  db.setAuthorizer((actionCode, authorizerArg1) =>
    actionCode === code && (arg1 === null || authorizerArg1 === arg1)
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
}

/** 真实 SQLite 接缝：拒绝所有 SELECT（读路径失败）。 */
export function denySelect(db: DatabaseSync): void {
  denyStatement(db, constants.SQLITE_SELECT, null);
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

export function resetDatabase(db: DatabaseSync): void {
  db.setAuthorizer(null);
  if (db.isTransaction) {
    db.exec("ROLLBACK");
  }
}
