import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "./index.js";

/**
 * 共享会话层（provider 无关）：cookie 常量与唯一 cookie-options owner、CSPRNG session id、
 * 绝对过期时钟/TTL 校验、单事务 session INSERT、只读+惰性清理的 session→Principal 解析，
 * 以及 logout/过期清理共用的 owned DELETE 事务纪律。dev-stub/OIDC 共用，不 import http。
 */

export const SESSION_COOKIE_NAME = "workbuddy_session";
export const SESSION_TTL_MS = 604_800_000;
const SESSION_ID_BYTE_LENGTH = 32;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/u;

const INSERT_SESSION_SQL = "INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)";
/**
 * 单次定点解析：expiry 判定留在 SQLite 内（`(s.expires_at <= :now)` 只投影 0/1），
 * 绝不把任意 64-bit epoch 读成 JavaScript number；accounts 走 LEFT JOIN，使 orphan
 * 与停用账号在 row 存在的前提下把 Principal 列留空，而不是把行吞成 undefined。
 */
const RESOLVE_SESSION_SQL = `SELECT (s.expires_at <= :now) AS expired, a.id AS id, a.account AS account, a.role AS role
FROM auth_sessions AS s
LEFT JOIN accounts AS a ON a.id = s.user_id AND a.disabled = 0
WHERE s.id = :id`;
const DELETE_SESSION_SQL = "DELETE FROM auth_sessions WHERE id = ?";
/** 条件谓词让并发续期后的竞态自然退化为 0 行，且永不越界到 sibling row。 */
const DELETE_EXPIRED_SESSION_SQL = "DELETE FROM auth_sessions WHERE id = ? AND expires_at <= ?";

export type SessionIdSource = (size: number) => Buffer;

export interface NewSession {
  id: string;
  userId: string;
  expiresAt: number;
}

/** cookie 属性唯一 owner：Path=/、HttpOnly、SameSite=Lax；Secure 只由显式配置决定；Domain 从不出现。 */
export interface SessionCookieOptions {
  path: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure?: boolean;
  maxAge?: number;
  expires?: Date;
}

/** 生产默认源锚 = crypto.randomBytes（defaultAuthRuntime 直接持有该函数引用）。 */
export function generateSessionId(randomBytes: SessionIdSource): string {
  const bytes = randomBytes(SESSION_ID_BYTE_LENGTH);
  if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_ID_BYTE_LENGTH) {
    throw new Error("session id generator must receive exactly 32 random bytes");
  }

  const id = bytes.toString("hex");
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error("session id generator produced an invalid hex encoding");
  }
  return id;
}

/**
 * TTL 唯一配置校验：正安全整数 epoch 毫秒。0/负数/小数/NaN/Infinity/非 number/不安全整数
 * 一律同步抛错，不钳制、不取整、不回退默认值。
 */
export function validateSessionTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("session ttl must be a positive safe integer");
  }
  return ttlMs;
}

/**
 * 时钟必须是可表示的非负安全整数；绝对过期同样必须安全。
 * 任何非法输入在 write/cookie 之前抛错，由调用方转 generic 5xx。
 */
export function sessionExpiry(now: number, ttlMs: number = SESSION_TTL_MS): number {
  const ttl = validateSessionTtl(ttlMs);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("session clock must be a nonnegative safe integer");
  }

  const expiresAt = now + ttl;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("session expiry overflows the safe integer range");
  }
  return expiresAt;
}

/** 事务失败时回滚；保留原始错误，并在回滚本身失败时聚合报告（不假装清理成功）。 */
function rollbackOwnedTransaction(db: DatabaseSync, originalError: unknown, message: string): void {
  if (db.isTransaction) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([originalError, rollbackError], message, {
        cause: originalError,
      });
    }
  }
}

/**
 * 唯一 owned 事务纪律：BEGIN 先于 ownership/try，因此调用方已拥有事务时在 ANY mutation
 * 之前失败且其事务保持活跃不变；写与 COMMIT 同事务，任何失败走回滚。
 */
function runOwnedSessionTransaction(
  db: DatabaseSync,
  rollbackFailureMessage: string,
  write: () => void,
): void {
  db.exec("BEGIN");
  try {
    write();
    db.exec("COMMIT");
  } catch (error) {
    rollbackOwnedTransaction(db, error, rollbackFailureMessage);
    throw error;
  }
}

/** 一个显式 SQLite 事务 + plain INSERT 恰一行；commit 成功后才允许 set-cookie。 */
export function insertSession(db: DatabaseSync, session: NewSession): void {
  runOwnedSessionTransaction(db, "session insert rollback failed", () => {
    const receipt = db
      .prepare(INSERT_SESSION_SQL)
      .run(session.id, session.userId, session.expiresAt);
    if (receipt.changes !== 1 && receipt.changes !== 1n) {
      throw new Error("session insert must change exactly one row");
    }
  });
}

/**
 * 共用的 owned DELETE 纪律，返回是否恰有一行被提交删除：收据限于 0（无匹配/竞态已输）
 * 或 1，越界即 programmer failure；COMMIT 失败走回滚，回滚也失败上报 AggregateError。
 */
function runOwnedSessionDelete(
  db: DatabaseSync,
  sql: string,
  params: (string | number)[],
): boolean {
  let deleted = false;
  runOwnedSessionTransaction(db, "session delete rollback failed", () => {
    const { changes } = db.prepare(sql).run(...params);
    const receipt: number | bigint = changes;
    if (receipt !== 0 && receipt !== 0n && receipt !== 1 && receipt !== 1n) {
      throw new Error("session delete must change exactly zero or one row");
    }
    deleted = receipt === 1 || receipt === 1n;
  });
  return deleted;
}

/** bearer 登出：只按 exact session id 删除，不读 expiry、不判账号资格。 */
export function deleteSession(db: DatabaseSync, id: string): boolean {
  return runOwnedSessionDelete(db, DELETE_SESSION_SQL, [id]);
}

/** 惰性清理：`id + expires_at<=now` 条件删除；竞态输掉时提交为 no-op。 */
function deleteExpiredSession(db: DatabaseSync, id: string, now: number): boolean {
  return runOwnedSessionDelete(db, DELETE_EXPIRED_SESSION_SQL, [id, now]);
}

interface SessionResolutionRow {
  expired: unknown;
  id: unknown;
  account: unknown;
  role: unknown;
}

function principalFrom(row: SessionResolutionRow): Principal | undefined {
  if (
    typeof row.id !== "string" ||
    typeof row.account !== "string" ||
    typeof row.role !== "string"
  ) {
    return undefined;
  }
  return { id: row.id, account: row.account, role: row.role };
}

/**
 * 唯一点解析出口：命中且 `expires_at<=now` → 条件删除后 null（含 disabled/orphan）；
 * 未过期且关联启用账号 → exact Principal；未命中/future disabled/orphan → null 且零写入。
 * 绝不扫描全表、不触碰 sibling、不 UPDATE/REPLACE。
 */
export function resolveSession(db: DatabaseSync, id: string, now: number): Principal | undefined {
  const row = db.prepare(RESOLVE_SESSION_SQL).get({ now, id }) as SessionResolutionRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  if (row.expired === 1 || row.expired === 1n) {
    deleteExpiredSession(db, id, now);
    return undefined;
  }
  return principalFrom(row);
}

/** cookie 解析：只接受 own exact name + 64 lowercase hex；原型继承/缺失/畸形一律 undefined。 */
export function sessionIdFromCookies(
  cookies: Record<string, string | undefined> | undefined,
): string | undefined {
  if (cookies === undefined || !Object.hasOwn(cookies, SESSION_COOKIE_NAME)) {
    return undefined;
  }
  const raw = cookies[SESSION_COOKIE_NAME];
  if (typeof raw !== "string" || !SESSION_ID_PATTERN.test(raw)) {
    return undefined;
  }
  return raw;
}

/** 正常 session cookie：服务端绝对过期与浏览器 cookie 生命周期分离，故无 Expires/Max-Age。 */
export function sessionCookieOptions(secureCookies: boolean): SessionCookieOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    ...(secureCookies ? { secure: true } : {}),
  };
}

/** 清 cookie 复用同一 scope owner，只叠加空值语义（Max-Age=0 + Unix epoch Expires）。 */
export function clearSessionCookieOptions(secureCookies: boolean): SessionCookieOptions {
  return { ...sessionCookieOptions(secureCookies), maxAge: 0, expires: new Date(0) };
}
