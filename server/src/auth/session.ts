import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "./index.js";

/**
 * 共享会话层（provider 无关）：cookie 常量、CSPRNG session id、绝对过期时钟校验、
 * 单事务 session INSERT 与只读 session→Principal 投影。dev-stub/OIDC 共用，不 import http。
 */

export const SESSION_COOKIE_NAME = "workbuddy_session";
export const SESSION_TTL_MS = 604_800_000;
const SESSION_ID_BYTE_LENGTH = 32;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/u;

const INSERT_SESSION_SQL = "INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)";
const READ_VALID_SESSION_SQL = `SELECT a.id, a.account, a.role
FROM auth_sessions AS s
JOIN accounts AS a ON a.id = s.user_id
WHERE s.id = ? AND s.expires_at > ? AND a.disabled = 0`;

export type SessionIdSource = (size: number) => Buffer;

export interface NewSession {
  id: string;
  userId: string;
  expiresAt: number;
}

/** 生产默认 = crypto.randomBytes（defaultAuthRuntime 直接持有该函数引用）。 */
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
 * 时钟必须是可表示的非负安全整数；绝对过期 must 同样安全。
 * 任何非法输入在 write/cookie 之前抛错，由调用方转 generic 5xx。
 */
export function sessionExpiry(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("session clock must be a nonnegative safe integer");
  }

  const expiresAt = now + SESSION_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("session expiry overflows the safe integer range");
  }
  return expiresAt;
}

/** 事务失败时回滚；保留原始错误，并在回滚本身失败时聚合报告（不假装清理成功）。 */
function rollbackAfterSessionFailure(
  db: DatabaseSync,
  originalError: unknown,
  message: string,
): void {
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

/** 一个显式 SQLite 事务 + plain INSERT 恰一行；commit 成功后才允许 set-cookie。 */
export function insertSession(db: DatabaseSync, session: NewSession): void {
  db.exec("BEGIN");
  try {
    const receipt = db
      .prepare(INSERT_SESSION_SQL)
      .run(session.id, session.userId, session.expiresAt);
    if (receipt.changes !== 1 && receipt.changes !== 1n) {
      throw new Error("session insert must change exactly one row");
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterSessionFailure(db, error, "session insert rollback failed");
    throw error;
  }
}

/** 只读投影：严格 expires_at > now（相等即过期），账号须存在且未停用。 */
export function findValidSession(db: DatabaseSync, id: string, now: number): Principal | undefined {
  const row = db.prepare(READ_VALID_SESSION_SQL).get(id, now) as
    | { id: unknown; account: unknown; role: unknown }
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  if (
    typeof row.id !== "string" ||
    typeof row.account !== "string" ||
    typeof row.role !== "string"
  ) {
    return undefined;
  }
  return { id: row.id, account: row.account, role: row.role };
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
