import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { AuthError, type AuthErrorCode } from "./errors.js";
import { createDevStubProvider, type PasswordSource } from "./providers/dev-stub.js";
import {
  findValidSession,
  generateSessionId,
  insertSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionExpiry,
  sessionIdFromCookies,
} from "./session.js";

/**
 * auth 模块对外接口（ADR-0007 接缝）：Principal、只读 authenticate、共享会话常量、
 * CSPRNG/过期/插入原语与 Fastify 注册面。实现藏于 ./session.ts 与 ./providers/*。
 * http/app -> auth -> core/db 单向；本模块不 import server/src/http。
 */

export type Principal = {
  id: string;
  account: string;
  role: string;
};

/** 唯一认证判定出口：request 形状 = Fastify 结构兼容 + server.db decorator。 */
export interface AuthRequest {
  cookies: Record<string, string | undefined> | undefined;
  server: {
    db: DatabaseSync;
    authNow?: () => number;
  };
}

/** 认证时钟必须是可表示的非负安全整数；非法值 fail closed（null），绝不抛错。 */
function isValidAuthNow(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0;
}

export function authenticate(request: AuthRequest): Principal | null {
  const sessionId = sessionIdFromCookies(request.cookies);
  if (sessionId === undefined) {
    return null;
  }
  const now = request.server.authNow?.() ?? Date.now();
  if (!isValidAuthNow(now)) {
    return null;
  }
  return findValidSession(request.server.db, sessionId, now) ?? null;
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
export const SESSION_TTL = SESSION_TTL_MS;

const LOGIN_BODY_LIMIT = 16 * 1024;
const MAX_ACCOUNT_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;

export interface AuthRuntime {
  now(): number;
  randomBytes(size: number): Buffer;
}

/** 生产默认源锚：now=Date.now，randomBytes=node:crypto.randomBytes；冻结防意外替换。 */
export const DEFAULT_AUTH_RUNTIME: AuthRuntime = Object.freeze({
  now: Date.now,
  randomBytes: nodeRandomBytes,
});

export interface AuthRegistrationOptions {
  db: DatabaseSync;
  secureCookies: boolean;
  runtime: AuthRuntime;
  mapAuthError: (code: AuthErrorCode) => Error;
  passwordSource?: PasswordSource;
}

/**
 * 注册 auth 面：cookie 解析 + login 路由 + 共享时钟装饰。
 * 必须在 API 通配与静态托管之前调用，保持路由优先级。
 * fastifyCookie 在 root 注册（fp skip-override），使未来 #10/#19 的任意路由都能
 * 读到 request.cookies / reply.setCookie，而不仅限于 auth 插件内部。
 */
export function registerAuth(app: FastifyInstance, options: AuthRegistrationOptions): void {
  app.decorate("authNow", options.runtime.now);
  void app.register(fastifyCookie);
  void app.register(authPlugin, options);
}

async function authPlugin(
  instance: FastifyInstance,
  options: AuthRegistrationOptions,
): Promise<void> {
  const provider = createDevStubProvider(options.db, options.passwordSource);

  instance.post("/api/auth/login", { bodyLimit: LOGIN_BODY_LIMIT }, async (request, reply) => {
    let credentials: { account: string; password: string };
    try {
      credentials = parseLoginBody(request.body);
    } catch (error) {
      throw asMappedAuthError(error, options.mapAuthError);
    }

    const outcome = await provider.verify(credentials.account, credentials.password);
    if ("authError" in outcome) {
      throw options.mapAuthError(outcome.authError.code);
    }
    if (outcome.disabled) {
      throw options.mapAuthError("account_disabled");
    }

    const sessionId = generateSessionId(options.runtime.randomBytes);
    const expiresAt = sessionExpiry(options.runtime.now());
    insertSession(options.db, {
      id: sessionId,
      userId: outcome.principal.id,
      expiresAt,
    });

    reply.header("Cache-Control", "no-store");
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      ...(options.secureCookies ? { secure: true } : {}),
    });
    return outcome.principal;
  });
}

/** 手写 exact-shape 校验：观察 Fastify 已解析但未变换的 body。 */
function parseLoginBody(body: unknown): { account: string; password: string } {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw new AuthError("bad_request");
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "account") ||
    !Object.hasOwn(record, "password")
  ) {
    throw new AuthError("bad_request");
  }

  const { account, password } = record;
  if (typeof account !== "string" || typeof password !== "string") {
    throw new AuthError("bad_request");
  }
  if (account.length > MAX_ACCOUNT_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError("bad_request");
  }

  return { account, password };
}

export type { PasswordSource } from "./providers/dev-stub.js";
export { generateSessionId, insertSession, sessionExpiry, sessionIdFromCookies };

function asMappedAuthError(error: unknown, mapAuthError: (code: AuthErrorCode) => Error): Error {
  if (error instanceof AuthError) {
    return mapAuthError(error.code);
  }
  throw error;
}
