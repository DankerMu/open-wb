import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, onSendHookHandler } from "fastify";
import { AuthError, type AuthErrorCode } from "./errors.js";
import { createDevStubProvider, type PasswordSource } from "./providers/dev-stub.js";
import {
  clearSessionCookieOptions,
  deleteSession,
  generateSessionId,
  insertSession,
  resolveSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionCookieOptions,
  sessionExpiry,
  sessionIdFromCookies,
  validateSessionTtl,
} from "./session.js";

/**
 * auth 模块对外接口（ADR-0007 接缝）：Principal、唯一认证判定出口 authenticate、
 * 共享会话常量、CSPRNG/过期/插入/删除原语与 Fastify 注册面（login/me/logout）。
 * 实现藏于 ./session.ts 与 ./providers/*。
 * http/app -> auth -> core/db 单向；本模块不 import server/src/http。
 */

export type Principal = {
  id: string;
  account: string;
  role: string;
};

/**
 * Principal 的请求级存放点由 auth 拥有：类型增广与运行时默认值同一 owner（默认值在
 * `registerAuth` 中安装，standalone 装配同样生效），#19 的 root guard 是唯一写者，
 * me/后继 handler 是读者。增广放在这里而不是 `http/`，否则会形成 auth → http 的类型依赖，
 * 破坏 `http -> auth -> core/db` 单向。默认值恒为 `null`，绝不共享对象。
 */
declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

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

/**
 * 唯一认证判定出口：只消费 own exact cookie + 单点解析。存储/事务失败向上抛
 * （由调用方转 generic 5xx），不降级为 null；过期 matched row 由 resolveSession
 * 定点清理后返回 null。
 */
export function authenticate(request: AuthRequest): Principal | null {
  const sessionId = sessionIdFromCookies(request.cookies);
  if (sessionId === undefined) {
    return null;
  }
  const now = request.server.authNow?.() ?? Date.now();
  if (!isValidAuthNow(now)) {
    return null;
  }
  return resolveSession(request.server.db, sessionId, now) ?? null;
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
export const SESSION_TTL = SESSION_TTL_MS;

/**
 * clear-cookie 的允许终态集合。数值与 http 层 five-code map 一致，但 auth 不 import
 * http（单向依赖），故以本地字面量常量声明，判定只看最终 reply.statusCode。
 */
const NO_CONTENT_STATUS = 204;
const UNAUTHORIZED_STATUS = 401;

const LOGIN_BODY_LIMIT = 16 * 1024;
/** Fastify 拒绝 bodyLimit 0（须 >0），故取最小合法值；显式 no-body 校验负责 0 字节合同。 */
const LOGOUT_BODY_LIMIT = 1;
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
  sessionTtlMs: number;
  runtime: AuthRuntime;
  mapAuthError: (code: AuthErrorCode) => Error;
  passwordSource?: PasswordSource;
}

/**
 * 注册 auth 面：request-local Principal 默认值 + cookie 解析 + login/me/logout 路由 + 共享时钟装饰。
 * 必须在 API 通配与静态托管之前调用，保持路由优先级。
 * fastifyCookie 在 root 注册（fp skip-override），使 #19 guard 的任意路由都能
 * 读到 request.cookies / reply.setCookie，而不仅限于 auth 插件内部。
 *
 * `principal` 的运行时默认值与类型增广同源：本模块声明 `FastifyRequest.principal: Principal | null`，
 * 就必须由本模块在安装 auth 面时给出 exact `null` 的 request-local 默认值。#19 的 root guard 只在
 * 自己装配时**写入**该属性；standalone `registerAuth` 不装 guard，也必须让任意后续 route 读到
 * `null` 而不是 `undefined`，否则公共类型承诺与运行时不一致。默认值必须是 `null`：
 * `decorateRequest` 对 object 默认值抛 `FST_ERR_DEC_REFERENCE_TYPE`（共享状态），对同一实例
 * 第二次 `decorateRequest("principal")` 抛 `FST_ERR_DEC_ALREADY_PRESENT`，因此这里也是唯一安装点。
 */
export function registerAuth(app: FastifyInstance, options: AuthRegistrationOptions): void {
  app.decorateRequest("principal", null);
  app.decorate("authNow", options.runtime.now);
  void app.register(fastifyCookie);
  void app.register(authPlugin, options);
}

/**
 * 未认证终态只负责映射并抛出错误。`mapAuthError` 的返回类型是 `Error`，因此映射器可以
 * 合法返回 ordinary Error 并被 HTTP 层分类为 generic 5xx；auth 层既不能也不该 import
 * http 去预判最终状态，所以这里绝不发布 clear-cookie。
 */
function sendUnauthorized(options: AuthRegistrationOptions): never {
  throw options.mapAuthError("unauthorized");
}

/**
 * clear-cookie 的唯一发布者：route-local onSend。它在 error handler 生成响应之后仍会
 * 运行（实测 handler throw → 500 路径 hook 照样执行），因此可以按 reply 的**最终**状态
 * 判定：只有落在 terminalStatuses 内才撤销浏览器 cookie。映射器失败 → generic 5xx、
 * body → 400、成功 200/其他状态一律不清。
 * 作用域是 per-route（不是全局 hook），判定只看状态码不看 code，auth 不 import http。
 */
function clearCookieOnFinalStatus(
  options: AuthRegistrationOptions,
  terminalStatuses: readonly number[],
): onSendHookHandler {
  return (_request, reply, payload, done) => {
    if (terminalStatuses.includes(reply.statusCode)) {
      reply.setCookie(SESSION_COOKIE_NAME, "", clearSessionCookieOptions(options.secureCookies));
    }
    done(null, payload);
  };
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
    const expiresAt = sessionExpiry(options.runtime.now(), options.sessionTtlMs);
    insertSession(options.db, {
      id: sessionId,
      userId: outcome.principal.id,
      expiresAt,
    });

    reply.header("Cache-Control", "no-store");
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions(options.secureCookies));
    return outcome.principal;
  });

  /**
   * 优先消费 #19 guard 已绑定的 request-local Principal，因此装配了 root guard 的 app 对
   * me 只调用一次 authenticate（重复调用会把 session 点查询翻倍，可被 authorizer 计数观测）。
   * 未装配 guard 的 standalone `registerAuth` 装配（既有 request-errors 用例形状）下
   * `principal` 是 `registerAuth` 安装的 request-local `null`，故回落到同一个判定出口，
   * 保持 #10 的 me 合同不破。
   * `no-store` 挂在 route-local onRequest：先于 root preParsing，guard 提前 401 时 #10 的
   * cache 合同与 clear-cookie（route-local onSend 按最终状态判定）依然成立。
   */
  instance.get(
    "/api/auth/me",
    {
      onRequest: (_request, reply, done) => {
        reply.header("Cache-Control", "no-store");
        done();
      },
      onSend: clearCookieOnFinalStatus(options, [UNAUTHORIZED_STATUS]),
    },
    async (request) => request.principal ?? authenticate(request) ?? sendUnauthorized(options),
  );

  /**
   * 以 bearer identity 撤销，不消费 Principal/clock eligibility：own exact cookie +
   * 任意 existing row（future/expired/disabled/orphan）→ owned DELETE commit → 204；
   * 0 行收据（无此类行/竞态已输/旧 cookie）→ 同一 unauthorized 终态。
   * `no-store` 挂在 route-local onRequest：先于 Fastify 内容解析，因此 native parser
   * 失败（empty/malformed JSON、unsupported media、body too large）也带 no-store。
   * clear-cookie 挂在 route-local onSend：只有最终 204/401 才撤销，DELETE 事务失败或
   * 映射器失败的 generic 5xx 与 parser 的 400 一律不清。
   */
  instance.post(
    "/api/auth/logout",
    {
      bodyLimit: LOGOUT_BODY_LIMIT,
      onRequest: (_request, reply, done) => {
        reply.header("Cache-Control", "no-store");
        done();
      },
      onSend: clearCookieOnFinalStatus(options, [NO_CONTENT_STATUS, UNAUTHORIZED_STATUS]),
    },
    async (request, reply) => {
      if (request.body !== undefined) {
        throw options.mapAuthError("bad_request");
      }
      const sessionId = sessionIdFromCookies(request.cookies);
      if (sessionId === undefined) {
        return sendUnauthorized(options);
      }

      const revoked = deleteSession(options.db, sessionId);
      if (!revoked) {
        return sendUnauthorized(options);
      }
      return reply.code(204).send();
    },
  );
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
export {
  generateSessionId,
  insertSession,
  sessionExpiry,
  sessionIdFromCookies,
  validateSessionTtl,
};

function asMappedAuthError(error: unknown, mapAuthError: (code: AuthErrorCode) => Error): Error {
  if (error instanceof AuthError) {
    return mapAuthError(error.code);
  }
  throw error;
}
