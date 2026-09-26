import type { DatabaseSync } from "node:sqlite";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuth, SESSION_TTL } from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { handleHttpError } from "../src/http/index.js";

/** spec「统一错误信封」码表逐字抄录：独立于 core/errors 的期望来源。 */
const THIRTEEN_TYPED_ERRORS = [
  ["bad_request", 400, "请求格式不正确"],
  ["invalid_credentials", 401, "账号或密码不正确"],
  ["account_disabled", 403, "该账号已停用，请联系管理员"],
  ["unauthorized", 401, "请先登录"],
  ["not_found", 404, "请求的资源不存在"],
  ["session_busy", 409, "会话正在生成，请稍候"],
  ["agent_unavailable", 502, "Agent 运行时不可用"],
  ["sandbox_denied", 403, "目标路径不在你的沙箱内，操作已拒绝"],
  ["conflict", 409, "同名资源已存在"],
  ["preview_too_large", 413, "文件过大，无法预览"],
  ["preview_unsupported", 415, "该类型不支持预览"],
  ["agent_capacity", 503, "Agent 容量已满，请稍后重试"],
  ["approval_settled", 409, "该审批已处理"],
] as const;

const NEW_TYPED_ERRORS = THIRTEEN_TYPED_ERRORS.filter(
  ([code]) => code === "agent_capacity" || code === "approval_settled",
);

const GENERIC_BODY = JSON.stringify({ error: { message: "服务器内部错误" } });

const ALLOWLISTED_CTP_CODES = [
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_BODY_TOO_LARGE",
] as const;

const LEGACY_OWNERS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/sessions/:id/prompt",
  "/v1/chat/completions",
  "/api/workspaces",
  "/api/workspaces/:id/dirs",
] as const;

const TURN_CONTROL_OWNERS = [
  "/api/sessions/:id/stop",
  "/api/sessions/:id/regenerate",
  "/api/sessions/:id/fork",
  "/api/sessions/:id/approvals/:approvalId",
] as const;

interface ReplyCapture {
  statusCode?: number;
  body?: string;
}

/** 直接驱动共享 handleHttpError 时捕获 reply.code/send。 */
function captureReply(): { reply: FastifyReply; captured: ReplyCapture } {
  const captured: ReplyCapture = {};
  const reply = {
    code(statusCode: number) {
      captured.statusCode = statusCode;
      return this;
    },
    send(body: unknown) {
      captured.body = JSON.stringify(body);
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

/** matched route identity 只由 routeOptions.url + method 表达，不挂载产品端点。 */
function matchedRequest(routeUrl: string, method: string): FastifyRequest {
  return { method, url: routeUrl, routeOptions: { url: routeUrl } } as unknown as FastifyRequest;
}

/** 以 fastify.errorCodes 的真实构造器生成 CTP 错误实例（code/statusCode 由构造器自带）。 */
function genuineCtpError(code: (typeof ALLOWLISTED_CTP_CODES)[number]): Error {
  const ctpConstructor = fastify.errorCodes[code] as unknown as new () => Error;
  return new ctpConstructor();
}

function mapError(error: unknown, routeUrl: string, method: string): ReplyCapture {
  const { reply, captured } = captureReply();
  handleHttpError(error, matchedRequest(routeUrl, method), reply);
  return captured;
}

function expectGenericNoDetail(captured: ReplyCapture): void {
  expect(captured.statusCode).toBe(500);
  expect(captured.body).toBe(GENERIC_BODY);
  expect(captured.body).not.toContain("FST_ERR");
  for (const [code] of THIRTEEN_TYPED_ERRORS) {
    expect(captured.body).not.toContain(code);
  }
}

async function withTestErrorApp<T>(action: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const app = fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  app.get<{ Params: { code: string } }>("/api/test-errors/:code", (request) => {
    throw new HttpError(request.params.code as HttpErrorCode);
  });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

describe("typed definition map 恰十三码", () => {
  it("core/errors 的码集合与 spec 码表逐一相等", () => {
    expect(Object.keys(HTTP_ERROR_MESSAGES).sort()).toEqual(
      THIRTEEN_TYPED_ERRORS.map(([code]) => code).sort(),
    );
  });

  it.each(THIRTEEN_TYPED_ERRORS)(
    "测试路由抛 HttpError(%s) -> exact %i 信封，无 Fastify 默认字段",
    async (code, statusCode, message) => {
      await withTestErrorApp(async (app) => {
        const response = await app.inject({ method: "GET", url: `/api/test-errors/${code}` });
        expect(response.statusCode).toBe(statusCode);
        expect(response.payload).toBe(JSON.stringify({ error: { code, message } }));
        const body = response.json() as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["error"]);
        expect(Object.keys(body.error as object).sort()).toEqual(["code", "message"]);
      });
    },
  );

  it("三种 409 以 code 区分，各自保留独立文案", () => {
    const conflicts = THIRTEEN_TYPED_ERRORS.filter(([, statusCode]) => statusCode === 409);
    expect(conflicts.map(([code]) => code)).toEqual([
      "session_busy",
      "conflict",
      "approval_settled",
    ]);
    for (const [code, , message] of conflicts) {
      const captured = mapError(new HttpError(code), "/api/no-such-route", "POST");
      expect(captured.statusCode).toBe(409);
      expect(captured.body).toBe(JSON.stringify({ error: { code, message } }));
    }
  });
});

/** 守卫，预期始终为绿：伪造 code/statusCode 在改动前后都只能得到 generic 5xx。 */
describe("伪造新码形状的普通对象不被误标（守卫）", () => {
  it.each(NEW_TYPED_ERRORS)(
    "普通对象与普通 Error 携 code=%s/statusCode=%i 保持 generic 500",
    (code, statusCode) => {
      const forgedObject = { code, statusCode, message: "forged typed code" };
      const forgedError = Object.assign(new Error("forged typed code"), { code, statusCode });
      for (const forged of [forgedObject, forgedError]) {
        expectGenericNoDetail(mapError(forged, "/api/test-errors/:code", "GET"));
        expectGenericNoDetail(mapError(forged, "/api/sessions/:id/stop", "POST"));
      }
    },
  );
});

describe("content-parser 归属集恰十条身份（共享 handleHttpError 接缝）", () => {
  const OWNER_CASES = [...LEGACY_OWNERS, ...TURN_CONTROL_OWNERS].flatMap((url) =>
    ALLOWLISTED_CTP_CODES.map((ctpCode) => [url, ctpCode] as const),
  );

  it.each(OWNER_CASES)("POST %s 上真实 %s -> exact 400 bad_request", (url, ctpCode) => {
    const captured = mapError(genuineCtpError(ctpCode), url, "POST");
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toBe(
      JSON.stringify({ error: { code: "bad_request", message: "请求格式不正确" } }),
    );
  });

  /** 守卫，预期始终为绿：非 POST、lookalike、raw-concrete 与已注册非归属模板。 */
  const NON_OWNER_CASES = [
    ...TURN_CONTROL_OWNERS.flatMap((url) => [["GET", url] as const, ["PUT", url] as const]),
    ["POST", "/api/sessions/:id/stop/"],
    ["POST", "/api/sessions/:id/stopx"],
    ["POST", "/api/sessions/:id/regenerate/"],
    ["POST", "/api/sessions/:id/forks"],
    ["POST", "/api/sessions/:id/approvals"],
    ["POST", "/api/sessions/:id/approvals/:approvalId/"],
    ["POST", "/api/sessions/abc/stop"],
    ["POST", "/api/sessions/abc/approvals/ap1"],
    ["POST", "/api/sessions"],
  ] as const;

  it.each(NON_OWNER_CASES)("守卫：%s %s 保持 generic 500 且不回显细节", (method, url) => {
    for (const ctpCode of ALLOWLISTED_CTP_CODES) {
      expectGenericNoDetail(mapError(genuineCtpError(ctpCode), url, method));
    }
  });
});

const MAPPER_NOW = 1_700_000_000_000;

async function withMappedLoginApp<T>(
  mapAuthError: () => Error,
  action: (app: FastifyInstance, db: DatabaseSync) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  const app = fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  registerAuth(app, {
    db,
    secureCookies: false,
    sessionTtlMs: SESSION_TTL,
    runtime: { now: () => MAPPER_NOW, randomBytes: (size) => Buffer.alloc(size, 0x5a) },
    mapAuthError: () => mapAuthError(),
  });
  try {
    return await action(app, db);
  } finally {
    await app.close();
    db.close();
  }
}

describe("两新码经 no-store 路由保持 route-owned no-store", () => {
  it.each(NEW_TYPED_ERRORS)(
    "POST /api/auth/login 注入 %s -> exact %i 信封、no-store、无 set-cookie",
    async (code, statusCode, message) => {
      await withMappedLoginApp(
        () => new HttpError(code),
        async (app) => {
          const response = await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: JSON.stringify({ account: "zhangsan", password: "wrong" }),
            headers: { "content-type": "application/json" },
          });
          expect(response.statusCode).toBe(statusCode);
          expect(response.payload).toBe(JSON.stringify({ error: { code, message } }));
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(response.headers["set-cookie"]).toBeUndefined();
        },
      );
    },
  );
});
