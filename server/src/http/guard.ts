import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate } from "../auth/index.js";
import { HttpError } from "./errors.js";
import { classifyOriginalUrl } from "./path-classifier.js";

/**
 * 默认认证守卫（#19）：横切中间件，落 `http/`，由 `app.ts` 在 auth 注册之后装配为
 * **root `preParsing`**。相位是契约的一部分：`@fastify/cookie` 与 route-local `onRequest`
 * 先运行（cookie 可读、me/logout 的 no-store 已落），本守卫先于 body content parser 与
 * handler，因此未认证的 malformed/oversized body 稳定 401，而不是被 raw parser 状态改写。
 *
 * 判定身份只有一条来源：`request.originalUrl`（rewrite 前）经共享 bounded classifier 得到的
 * API namespace，加上 Fastify **实际 matched** 的 method + route url。绝不用 string prefix
 * （`/api/../api/healthz` 命中 public healthz，`/api/healthz/x` 不命中），也绝不采信 rewritten
 * internal route 名（unsafe non-API 被 rewrite 到 `/api/__workbuddy_not_found__` 时仍按原始
 * identity 走既有 404）。豁免是集中且 exact 的，不给任何 route 可自行扩张的 metadata。
 */

/** 唯一 public 豁免表：exact matched method + route identity。HEAD 是 healthz/info 的隐式方法。 */
const PUBLIC_API_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/healthz",
  "HEAD /api/healthz",
  "GET /api/info",
  "HEAD /api/info",
  "POST /api/auth/login",
  "POST /api/auth/logout",
]);

/**
 * 装配守卫。必须在 `registerAuth` 之后于 root 实例调用——做成与 auth 平级的封装 plugin
 * 就看不见 auth 子路由；且 `principal` 的 request-local 默认值由 auth 唯一安装，本函数
 * 绝不重复 `decorateRequest`（同实例重复装饰会抛 FST_ERR_DEC_ALREADY_PRESENT），只负责**写入**。
 * callback 形态 + 原样交还 `payload`：preParsing 绝不消费或替换 body 流。
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook("preParsing", (request, _reply, payload, done) => {
    if (!isProtectedApiRequest(request)) {
      // 原始 non-API（ordinary/unsafe/multi-encoded）与 public route：零 session 查询。
      return done(null, payload);
    }

    // 存储/事务失败由 authenticate 原样上抛，经 error handler 成 generic 5xx，不降级 401。
    const principal = authenticate(request);
    if (principal === null) {
      throw new HttpError("unauthorized");
    }

    request.principal = principal;
    return done(null, payload);
  });
}

function isProtectedApiRequest(request: FastifyRequest): boolean {
  if (!classifyOriginalUrl(request.originalUrl).isApiNamespace) {
    return false;
  }

  const matchedRoute = request.routeOptions.url;
  return matchedRoute === undefined || !PUBLIC_API_ROUTES.has(`${request.method} ${matchedRoute}`);
}
