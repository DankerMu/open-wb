import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { SESSION_COOKIE } from "../src/auth/index.js";

/**
 * server 测试侧的会话/DB 观察原语唯一 owner（#10 生命周期与 #19 守卫共用）：真实 SQLite
 * 行写入、CAST 快照、`total_changes()`、cookie 头解析、确定性 auth runtime 与
 * authorizer 故障接缝。只操作真实句柄，绝不 mock 被测系统；快照把 `expires_at` CAST 成
 * TEXT，使 int64 满量程行也能逐值比较而不经 JavaScript number 投影。
 */

export const FIXED_NOW = 1_700_000_000_000;
export const INT64_MAX = 9_223_372_036_854_775_807n;
export const CREDENTIALS = { account: "zhangsan", password: "demo" };
export const PRINCIPAL_ZHANGSAN = { id: "u1", account: "zhangsan", role: "成员" };
export const PRINCIPAL_ZHAOLIU = { id: "u2", account: "zhaoliu", role: "成员" };
export const UNAUTHORIZED_ENVELOPE = { error: { code: "unauthorized", message: "请先登录" } };
export const NOT_FOUND_ENVELOPE = { error: { code: "not_found", message: "请求的资源不存在" } };
export const BAD_REQUEST_ENVELOPE = { error: { code: "bad_request", message: "请求格式不正确" } };
export const INTERNAL_ERROR_ENVELOPE = { error: { message: "服务器内部错误" } };
export const CLEAR_COOKIE =
  "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax";
export const CLEAR_COOKIE_SECURE =
  "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax";

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

/** 形状合法但库内不存在的 exact 64 lowercase hex（伪造/篡改/重建后的旧 cookie）。 */
export const UNKNOWN_SESSION_IDS = ["f".repeat(64), "e".repeat(64), "0".repeat(64)] as const;

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

/** 每次调用换填充字节，避免同一 DB 内多次登录的 session ID 碰撞。 */
let randomFillCounter = 0x11;
function distinctRandomBytes(size: number): Buffer {
  const fill = randomFillCounter % 256;
  randomFillCounter += 1;
  return Buffer.alloc(size, fill === 0 ? 0x11 : fill);
}

export function fixedRuntime(now: () => number) {
  return { now, randomBytes: distinctRandomBytes };
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

/** 停用账号：disabled 状态迁移矩阵的唯一写入口。 */
export function disableAccount(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE accounts SET disabled = 1 WHERE id = ?").run(id);
}

export function row(id: string, userId: string, expiresAt: number | bigint): SessionRow {
  return { id, user_id: userId, expires_at: String(expiresAt) };
}

export function rowsById(...rowsToSort: SessionRow[]): SessionRow[] {
  return [...rowsToSort].sort((left, right) => (left.id < right.id ? -1 : 1));
}

export function bearerCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}`;
}

/** 任意 cookie 值（含畸形值）组成的请求头。 */
export function rawCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}`;
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

/** 经 public `POST /api/auth/login` 建立真实会话，返回可直接用作 cookie 头的名值对。 */
export async function loginSessionPair(
  app: FastifyInstance,
  account = CREDENTIALS.account,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: JSON.stringify({ account, password: CREDENTIALS.password }),
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

/** 真实登录得到的 session id（#19 守卫用例在 protected 请求里携带的值）。 */
export async function loginSessionId(
  app: FastifyInstance,
  account = CREDENTIALS.account,
): Promise<string> {
  return cookieValueOf(await loginSessionPair(app, account));
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

export function resetDatabase(db: DatabaseSync): void {
  db.setAuthorizer(null);
  if (db.isTransaction) {
    db.exec("ROLLBACK");
  }
}

/** exact 401 unauthorized 信封：逐字节、恰 `{error:{code,message}}` 两字段。 */
export function expectUnauthorizedEnvelope(response: InjectResponse): void {
  expect(response.statusCode).toBe(401);
  expect(response.payload).toBe(JSON.stringify(UNAUTHORIZED_ENVELOPE));
  const envelope = JSON.parse(response.payload) as Record<string, unknown>;
  expect(Object.keys(envelope)).toEqual(["error"]);
  expect(Object.keys(envelope.error as object)).toEqual(["code", "message"]);
}

/** 有效会话的 me 终态：exact Principal、no-store 且不发 Set-Cookie。 */
export function expectPrincipalResponse(response: InjectResponse, principal: unknown): void {
  expect(response.statusCode).toBe(200);
  expect(response.payload).toBe(JSON.stringify(principal));
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["set-cookie"]).toBeUndefined();
}

/**
 * 真实 AJV body schema 的 route 选项唯一 owner：三个既有用例面（#6 信封面、#10
 * route-owner 面、#19 parser 顺序面）共用同一份会触发 `FST_ERR_VALIDATION` 的 schema，
 * 而不是各写一遍字面量。
 */
export function validatingBodyRouteOptions(): {
  schema: { body: { type: string; required: string[]; properties: object } };
} {
  return {
    schema: {
      body: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    },
  };
}
