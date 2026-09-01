import type { DatabaseSync } from "node:sqlite";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
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

  interface ReplyCapture {
    statusCode?: number;
    body?: string;
  }

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
