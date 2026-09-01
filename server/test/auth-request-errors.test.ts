import type { DatabaseSync } from "node:sqlite";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { registerAuth, SESSION_TTL } from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";
import { HttpError, handleHttpError } from "../src/http/index.js";

const BAD_REQUEST_ENVELOPE = {
  error: { code: "bad_request", message: "请求格式不正确" },
};
const NOT_FOUND_ENVELOPE = {
  error: { code: "not_found", message: "请求的资源不存在" },
};
const INTERNAL_ERROR_ENVELOPE = { error: { message: "服务器内部错误" } };

/** 三组逐字节相同的输入：malformed JSON / empty JSON body / unsupported media。
 *  相同输入必须在 login -> 400、unknown /api/* -> 404、unmatched non-GET -> 404、
 *  已注册非 login route -> 5xx 上各给出对应合同，构成 mutation-resistant 分组。 */
const IDENTICAL_INPUTS: ReadonlyArray<{
  name: string;
  payload: string;
  headers: Readonly<Record<string, string>>;
}> = [
  {
    name: "malformed JSON",
    payload: '{"account": ',
    headers: { "content-type": "application/json" },
  },
  { name: "empty JSON body", payload: "", headers: { "content-type": "application/json" } },
  {
    name: "unsupported media",
    payload: "binary",
    headers: { "content-type": "application/octet-stream" },
  },
];

async function withApp<T>(
  action: (app: FastifyInstance, db: DatabaseSync) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  let app: FastifyInstance | undefined;
  try {
    app = createApp({ db });
    return await action(app, db);
  } finally {
    try {
      await app?.close();
    } finally {
      db.close();
    }
  }
}

type HeaderValue = string | string[] | number | undefined;

interface InjectResponse {
  statusCode: number;
  payload: string;
  headers: Record<string, HeaderValue>;
}

async function inject(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload: string | undefined,
  headers: Record<string, string>,
): Promise<InjectResponse> {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers,
  });
  return {
    statusCode: response.statusCode,
    payload: response.payload,
    headers: response.headers,
  };
}

function sessionCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get() as { count: number })
    .count;
}

function expectBadRequest(response: InjectResponse, db: DatabaseSync): void {
  expect(response.statusCode).toBe(400);
  expect(response.payload).toBe(JSON.stringify(BAD_REQUEST_ENVELOPE));
  expect(response.payload).not.toContain("FST_ERR");
  expect(response.payload).not.toContain("Body is not valid JSON");
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(sessionCount(db)).toBe(0);
}

function expectNotFound(response: InjectResponse, db: DatabaseSync): void {
  expect(response.statusCode).toBe(404);
  expect(response.payload).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(sessionCount(db)).toBe(0);
}

function expectGenericServerError(response: InjectResponse): void {
  expect(response.statusCode).toBe(500);
  expect(response.payload).toBe(JSON.stringify(INTERNAL_ERROR_ENVELOPE));
  expect(response.headers["set-cookie"]).toBeUndefined();
}

interface ReplyCapture {
  statusCode?: number;
  body?: string;
}

/** 直接驱动导出的 handleHttpError 时捕获 reply.code/send 的唯一替身。 */
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

describe("route-owner 结果：同一精确 CTP 输入在不同 route identity 上的 contract", () => {
  it("exact POST /api/auth/login：malformed/empty/unsupported/oversized 均归一 exact 400", async () => {
    await withApp(async (app, db) => {
      for (const row of IDENTICAL_INPUTS) {
        const response = await inject(app, "POST", "/api/auth/login", row.payload, {
          ...row.headers,
        });
        expectBadRequest(response, db);
      }
      const oversized = await inject(
        app,
        "POST",
        "/api/auth/login",
        `{"account":"${"x".repeat(17_000)}","password":"demo"}`,
        { "content-type": "application/json" },
      );
      expectBadRequest(oversized, db);
    });
  });

  it("相同输入在 matched /api/*（unknown API）恢复 typed not_found 404", async () => {
    await withApp(async (app, db) => {
      for (const row of IDENTICAL_INPUTS) {
        const response = await inject(app, "POST", "/api/no-such-route", row.payload, {
          ...row.headers,
        });
        expectNotFound(response, db);
      }
      // exact /api 与尾斜杠同为 API fallback（routeOptions.url=/api 或 /api/*）
      const exactApi = await inject(app, "POST", "/api", '{"broken": ', {
        "content-type": "application/json",
      });
      expectNotFound(exactApi, db);
      const apiSlash = await inject(app, "POST", "/api/", '{"broken": ', {
        "content-type": "application/json",
      });
      expectNotFound(apiSlash, db);
    });
  });

  it("相同输入在 unmatched non-GET miss（routeOptions.url undefined）恢复 typed not_found 404", async () => {
    await withApp(async (app, db) => {
      for (const row of IDENTICAL_INPUTS) {
        for (const method of ["POST", "PUT", "DELETE"] as const) {
          const response = await inject(app, method, "/not-an-api", row.payload, {
            ...row.headers,
          });
          expectNotFound(response, db);
        }
      }
      // GET miss 由 not-found handler 负责（不进入 error handler），同样 typed 404
      const getMiss = await inject(app, "GET", "/not-an-api", '{"broken": ', {
        "content-type": "application/json",
      });
      expectNotFound(getMiss, db);
    });
  });

  it("已注册非 login POST route：相同 CTP 输入保持 generic 5xx；真实 schema validation 亦 5xx", async () => {
    await withApp(async (app, db) => {
      app.post("/api/registered", async () => ({ ok: true }));
      app.post(
        "/api/registered-schema",
        {
          schema: {
            body: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          },
        },
        () => ({ ok: true }),
      );

      for (const row of IDENTICAL_INPUTS) {
        const response = await inject(app, "POST", "/api/registered", row.payload, {
          ...row.headers,
        });
        expectGenericServerError(response);
      }
      const validation = await inject(app, "POST", "/api/registered-schema", "{}", {
        "content-type": "application/json",
      });
      expectGenericServerError(validation);
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("route identity 边界基于实际路由：query 精确 login=400；PUT/尾斜杠回 /api/*=404；GET=404", async () => {
    await withApp(async (app, db) => {
      const queried = await inject(app, "POST", "/api/auth/login?x=1", '{"account": ', {
        "content-type": "application/json",
      });
      expectBadRequest(queried, db);

      const putLogin = await inject(app, "PUT", "/api/auth/login", '{"account": ', {
        "content-type": "application/json",
      });
      expectNotFound(putLogin, db);

      const trailingSlash = await inject(app, "POST", "/api/auth/login/", '{"account": ', {
        "content-type": "application/json",
      });
      expectNotFound(trailingSlash, db);

      const getLogin = await inject(app, "GET", "/api/auth/login", '{"account": ', {
        "content-type": "application/json",
      });
      expectNotFound(getLogin, db);
    });
  });

  it("unknown /api/* 的 valid 但 17 KiB body 走既有 /api/* not_found 404（login body-limit 只作用 login）", async () => {
    await withApp(async (app, db) => {
      const response = await inject(
        app,
        "POST",
        "/api/no-such-route",
        `{"a":"${"x".repeat(17_000)}"}`,
        { "content-type": "application/json" },
      );
      expectNotFound(response, db);
    });
  });
});

/** Issue #10：CTP owner 只从 exact POST login 扩到 exact POST logout，其余优先级不变。 */
describe("exact POST /api/auth/logout 加入 route-owner（#10）", () => {
  it("logout 上相同 CTP 输入归一 exact 400，且不写/不清 cookie", async () => {
    await withApp(async (app, db) => {
      for (const row of IDENTICAL_INPUTS) {
        const response = await inject(app, "POST", "/api/auth/logout", row.payload, {
          ...row.headers,
        });
        expectBadRequest(response, db);
      }
    });
  });

  it("route identity 边界：query 精确 logout=400；PUT/尾斜杠/GET 回 404/405 语义不变", async () => {
    await withApp(async (app, db) => {
      const queried = await inject(app, "POST", "/api/auth/logout?x=1", '{"a": ', {
        "content-type": "application/json",
      });
      expectBadRequest(queried, db);

      const trailingSlash = await inject(app, "POST", "/api/auth/logout/", '{"a": ', {
        "content-type": "application/json",
      });
      expectNotFound(trailingSlash, db);

      const putLogout = await inject(app, "PUT", "/api/auth/logout", '{"a": ', {
        "content-type": "application/json",
      });
      expectNotFound(putLogout, db);

      const getLogout = await inject(app, "GET", "/api/auth/logout", '{"a": ', {
        "content-type": "application/json",
      });
      expectNotFound(getLogout, db);
    });
  });

  it("真实构造器-backed CTP error 在 logout=400；/api catch-all 与 unmatched non-GET 仍 404；其他 registered 仍 5xx", () => {
    const requestShaped = (url: string | undefined, method: string) =>
      ({
        method,
        url: url ?? "/unmatched",
        routeOptions: { url },
      }) as unknown as FastifyRequest;

    const ctpConstructor = fastify.errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY as unknown as new (
      message: string,
    ) => Error;
    const realCtpError = Object.assign(
      new ctpConstructor("Body cannot be empty when content-type is set to 'application/json'"),
      { code: "FST_ERR_CTP_EMPTY_JSON_BODY", statusCode: 400 },
    );

    for (const url of ["/api/auth/login", "/api/auth/logout"]) {
      const owned = captureReply();
      handleHttpError(realCtpError, requestShaped(url, "POST"), owned.reply);
      expect(owned.captured.statusCode).toBe(400);
      expect(owned.captured.body).toBe(
        JSON.stringify({ error: { code: "bad_request", message: "请求格式不正确" } }),
      );
    }

    for (const url of ["/api", "/api/*"]) {
      const fallback = captureReply();
      handleHttpError(realCtpError, requestShaped(url, "POST"), fallback.reply);
      expect(fallback.captured.statusCode).toBe(404);
    }

    const unmatched = captureReply();
    handleHttpError(realCtpError, requestShaped(undefined, "POST"), unmatched.reply);
    expect(unmatched.captured.statusCode).toBe(404);

    const registered = captureReply();
    handleHttpError(realCtpError, requestShaped("/api/registered", "POST"), registered.reply);
    expect(registered.captured.statusCode).toBe(500);

    const forged = captureReply();
    handleHttpError(
      Object.assign(new Error("forged logout code"), {
        code: "FST_ERR_CTP_INVALID_JSON_BODY",
        statusCode: 400,
      }),
      requestShaped("/api/auth/logout", "POST"),
      forged.reply,
    );
    expect(forged.captured.statusCode).toBe(500);

    const putOwned = captureReply();
    handleHttpError(realCtpError, requestShaped("/api/auth/logout", "PUT"), putOwned.reply);
    expect(putOwned.captured.statusCode).toBe(500);
  });
});

describe("native error shape discrimination 与 login 路由 scope", () => {
  /** 从真实 schema 路由捕获 FST_ERR_VALIDATION，驱动导出的 handleHttpError。 */
  async function captureRealValidationError(): Promise<unknown> {
    const raw = fastify({ logger: false });
    let captured: unknown;
    raw.addHook("onError", async (_request, _reply, error) => {
      captured = error;
    });
    raw.post(
      "/schema-route",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      () => ({ ok: true }),
    );
    await raw.ready();
    await raw.inject({
      method: "POST",
      url: "/schema-route",
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    await raw.close();
    return captured;
  }

  function requestShaped(routeOptionsUrl: string | undefined, method: string): FastifyRequest {
    return {
      method,
      url: routeOptionsUrl ?? "/unmatched",
      routeOptions: { url: routeOptionsUrl },
    } as unknown as FastifyRequest;
  }

  function expectSendErrorEnvelope(captured: ReplyCapture, code: string, message: string): void {
    expect(captured.statusCode).toBe(400);
    expect(captured.body).toBe(JSON.stringify({ error: { code, message } }));
  }

  function expectNotFoundEnvelope(captured: ReplyCapture): void {
    expect(captured.statusCode).toBe(404);
    expect(captured.body).toBe(
      JSON.stringify({ error: { code: "not_found", message: "请求的资源不存在" } }),
    );
  }

  function expectGeneric(captured: ReplyCapture): void {
    expect(captured.statusCode).toBe(500);
    expect(captured.body).toBe(JSON.stringify({ error: { message: "服务器内部错误" } }));
  }

  it("伪造 validation-shaped programmer Error（code+validation[]）在 login 保持 5xx", async () => {
    const forged = Object.assign(new Error("forged validation"), {
      code: "FST_ERR_VALIDATION",
      validation: [{ instancePath: "/account", message: "must be string" }],
      validationContext: "body",
    });
    const result = captureReply();
    handleHttpError(forged, requestShaped("/api/auth/login", "POST"), result.reply);
    expectGeneric(result.captured);
  });

  it("真实 FST_ERR_VALIDATION 在 login 与非 login 均已注册 route 均保持 5xx（不在 allowlist）", async () => {
    const validationError = await captureRealValidationError();
    expect((validationError as { code?: unknown; validation?: unknown }).code).toBe(
      "FST_ERR_VALIDATION",
    );
    expect(Array.isArray((validationError as { validation?: unknown }).validation)).toBe(true);

    const login = captureReply();
    handleHttpError(validationError, requestShaped("/api/auth/login", "POST"), login.reply);
    expectGeneric(login.captured);

    const registered = captureReply();
    handleHttpError(
      validationError,
      requestShaped("/api/registered-schema", "POST"),
      registered.reply,
    );
    expectGeneric(registered.captured);
  });

  it("真实构造器-backed CTP FastifyError：login=400；/api/*=404；unmatched non-GET=404；registered=5xx", async () => {
    const raw = fastify({ logger: false });
    let captured: unknown;
    raw.addHook("onError", async (_request, _reply, error) => {
      captured = error;
    });
    raw.post("/capture", async () => ({ ok: true }));
    await raw.ready();
    await raw.inject({
      method: "POST",
      url: "/capture",
      payload: "",
      headers: { "content-type": "application/json" },
    });
    await raw.close();
    expect((captured as { code?: unknown }).code).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");

    const login = captureReply();
    handleHttpError(captured, requestShaped("/api/auth/login", "POST"), login.reply);
    expectSendErrorEnvelope(login.captured, "bad_request", "请求格式不正确");

    const apiFallback = captureReply();
    handleHttpError(captured, requestShaped("/api/*", "POST"), apiFallback.reply);
    expectNotFoundEnvelope(apiFallback.captured);

    const exactApi = captureReply();
    handleHttpError(captured, requestShaped("/api", "POST"), exactApi.reply);
    expectNotFoundEnvelope(exactApi.captured);

    const unmatched = captureReply();
    handleHttpError(captured, requestShaped(undefined, "POST"), unmatched.reply);
    expectNotFoundEnvelope(unmatched.captured);

    const registered = captureReply();
    handleHttpError(captured, requestShaped("/api/registered", "POST"), registered.reply);
    expectGeneric(registered.captured);
  });

  it("伪造 allowlist code（非 Fastify errorCodes 构造器实例）保持 5xx", async () => {
    const forged = Object.assign(new Error("forged"), {
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
      statusCode: 413,
    });
    const result = captureReply();
    handleHttpError(forged, requestShaped("/api/auth/login", "POST"), result.reply);
    expectGeneric(result.captured);
  });

  it("显式 typed HttpError（bad_request）保持 route-independent 映射", async () => {
    const result = captureReply();
    handleHttpError(
      new HttpError("bad_request"),
      requestShaped("/api/no-such-route", "POST"),
      result.reply,
    );
    expectSendErrorEnvelope(result.captured, "bad_request", "请求格式不正确");
  });
});

/**
 * auth→HTTP 映射器自身失败走真实 registerAuth 接缝。clear-cookie 的发布已移出 handler
 * 控制流、改由 route-local onSend 按**最终状态**判定，因此映射器无论抛错还是返回 ordinary
 * Error（`mapAuthError: (code) => Error` 允许后者，且 handleHttpError 会分类为 generic
 * 5xx）都不得撤销浏览器会话；同时 no-store 仍在、DB 逐值不变。
 * 两种 cookie 形状都跑：错误路径上 @fastify/cookie 是否真正发出已写入的 Set-Cookie 随
 * 请求形状而变（携 cookie 头的 GET 与不携的形状行为不同），只测其一会是假覆盖。
 */
describe("mapAuthError 失败（抛错或返回 ordinary Error）不得发布 clear-cookie", () => {
  const MAPPER_DETAIL = "private auth mapper detail";
  const NOW = 1_700_000_000_000;

  const mapperThrows = (): never => {
    throw new Error(MAPPER_DETAIL);
  };
  const mapperReturnsOrdinaryError = (): Error => new Error(MAPPER_DETAIL);
  const MAPPER_FAILURES: ReadonlyArray<[string, () => Error]> = [
    ["映射器抛错", mapperThrows],
    // mapAuthError 的签名允许返回 ordinary Error：这是 pass 4 的真实缺陷面
    ["映射器返回 ordinary Error", mapperReturnsOrdinaryError],
  ];

  const UNAUTHENTICATED_CALLS = [
    ["GET /api/auth/me 未认证（无 cookie）", "GET", "/api/auth/me", undefined],
    ["GET /api/auth/me 未认证（携 cookie）", "GET", "/api/auth/me", "b".repeat(64)],
    ["bodyless POST /api/auth/logout 无匹配行", "POST", "/api/auth/logout", "c".repeat(64)],
  ] as const;

  function sessionState(db: DatabaseSync): unknown {
    return db
      .prepare(
        "SELECT group_concat(id || '@' || user_id || '@' || expires_at, '/') AS ids, COUNT(*) AS rows FROM auth_sessions",
      )
      .get();
  }

  async function withMapperFailingApp<T>(
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
      runtime: { now: () => NOW, randomBytes: (size) => Buffer.alloc(size, 0x5a) },
      mapAuthError: () => mapAuthError(),
    });
    try {
      return await action(app, db);
    } finally {
      await app.close();
      db.close();
    }
  }

  function expectMapperFailure(response: {
    statusCode: number;
    payload: string;
    headers: Record<string, unknown>;
  }): void {
    expect(response.statusCode).toBe(500);
    expect(response.payload).toBe(JSON.stringify(INTERNAL_ERROR_ENVELOPE));
    expect(response.payload).not.toContain(MAPPER_DETAIL);
    // 5xx 绝不撤销：clear-cookie 只能由终态 401/204 发布
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
  }

  for (const [mapperName, mapper] of MAPPER_FAILURES) {
    it.each(UNAUTHENTICATED_CALLS)(
      `${mapperName}：%s -> 500/无 Set-Cookie/DB 不变/no-store 仍在`,
      async (_name, method, url, cookieValue) => {
        await withMapperFailingApp(mapper, async (app, db) => {
          db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
            "a".repeat(64),
            "u1",
            NOW + 60_000,
          );
          const before = sessionState(db);

          expectMapperFailure(
            await app.inject({
              method,
              url,
              ...(cookieValue === undefined
                ? {}
                : { headers: { cookie: `workbuddy_session=${cookieValue}` } }),
            }),
          );
          expect(sessionState(db)).toEqual(before);
          expect(db.isTransaction).toBe(false);
        });
      },
    );
  }
});

/**
 * clear-cookie 的 onSend 必须是 route-local，而非全局 hook：若全局按终态 401/204 发布，
 * 任何非 auth route 返回这些状态都会顺带撤销浏览器会话并继承 no-store。exact logout 204
 * 的正常撤销由 auth-lifecycle.test.ts 的 canonical 行验收。
 */
describe("clear-cookie onSend 作用域只限 me/logout", () => {
  const BEARER = "d".repeat(64);

  it("非 auth route 的终态 401/204 不发 clear-cookie、不继承 no-store", async () => {
    await withApp(async (app, db) => {
      app.get("/api/probe-401", () => {
        throw new HttpError("unauthorized");
      });
      app.post("/api/probe-204", (_request, reply) => reply.code(204).send());
      for (const [url, method, statusCode] of [
        ["/api/probe-401", "GET", 401],
        ["/api/probe-204", "POST", 204],
      ] as const) {
        const response = await inject(app, method, url, undefined, {
          cookie: `workbuddy_session=${BEARER}`,
        });
        expect(response.statusCode).toBe(statusCode);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBeUndefined();
      }
      expect(sessionCount(db)).toBe(0);
    });
  });
});
