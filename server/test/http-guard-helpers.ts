import type { DatabaseSync } from "node:sqlite";
import { constants } from "node:sqlite";
import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { expect } from "vitest";
import { createApp } from "../src/app.js";
import { registerAuth, SESSION_TTL } from "../src/auth/index.js";
import { openDb } from "../src/core/db/index.js";
import { HttpError, handleHttpError } from "../src/http/index.js";
import {
  bearerCookie,
  disableAccount,
  FIXED_NOW,
  fixedRuntime,
  INTERNAL_ERROR_ENVELOPE,
  type InjectResponse,
  insertOrphanRow,
  insertRow,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  row,
  rowsById,
  type SessionRow,
  sessionSnapshot,
  testId,
  totalChanges,
  UNAUTHORIZED_ENVELOPE,
  validatingBodyRouteOptions,
} from "./session-db-helpers.js";

/**
 * Issue #19 守卫测试工具箱：只装配真实 `createApp + openDb(":memory:") + app.inject()`，
 * 会话行/快照/cookie/登录原语的 owner 在 `./session-db-helpers.ts`，wire 面在
 * `./raw-http-helpers.ts`。本文件独有的判据来自探针实测的地基事实：
 * - authorizer 只在语句编译时收到一次 `SQLITE_SELECT`（arg1 为 null；列级访问是
 *   `SQLITE_READ`），产品每条语句都是新 prepare，故 SELECT 事件数 = 语句数。
 *   "public/non-API 零 session 查询" 与 "protected 恰一次 authenticate" 是同一把尺子；
 * - 计数是"尝试次数"（被 DENY 的语句照样计入），所以同一回调既做计数又做故障注入时，
 *   "一次点查后 5xx" 与"零查询"彼此可区分；
 * - 测试侧 protected route 必须在 `createApp` 之后、首次 inject 之前注册：root guard
 *   要照样覆盖它们，Principal consumer 回显 `request.principal`，POST probe 回显解析后的 body。
 */

export const UNAUTHORIZED_PAYLOAD = JSON.stringify(UNAUTHORIZED_ENVELOPE);

/** 测试侧 protected API route：证明 root guard 覆盖 createApp 之后注册的 route。 */
export const PRINCIPAL_ROUTE = "/api/guard-principal";
export const PRINCIPAL_ROUTE_URL = `${PRINCIPAL_ROUTE}?scope=1`;
/** 测试侧 protected POST route：计数 handler 运行次数并回显 body，证明 guard 先于 parser。 */
export const HANDLER_PROBE_ROUTE = "/api/guard-handler-probe";
/** 已注册且携真实 AJV schema 的 protected route（既有 5xx 合同不变）。 */
export const REGISTERED_PROBE_ROUTE = "/api/guard-registered-probe";
/** non-API 状态探针：guarded 形状下绕过 guard 仍必须看到 `principal` 的 request-local 默认值。 */
export const STATE_PROBE_ROUTE = "/guard-state-probe";

/**
 * `request.principal` 的原始运行时形状探针（经 unknown 观察，不受类型增广粉饰）：
 * exact null 序列化为 `{isNull:true,typeName:"object"}`，undefined 则为 `{isNull:false,typeName:"undefined"}`。
 */
export function principalShapeHandler(request: FastifyRequest) {
  const value: unknown = request.principal;
  return { isNull: value === null, typeName: typeof value };
}

/** 逐字节相同的 parser 输入（末项超全局 1 MiB bodyLimit）：同一输入须在四种 route owner 上各给合同。 */
export const PARSER_INPUTS: ReadonlyArray<{
  name: string;
  payload: string;
  contentType: string;
}> = [
  { name: "malformed JSON", payload: '{"account": ', contentType: "application/json" },
  { name: "empty JSON body", payload: "", contentType: "application/json" },
  { name: "unsupported media", payload: "binary", contentType: "application/octet-stream" },
  {
    name: "oversized body",
    payload: `{"a":"${"x".repeat(1_100_000)}"}`,
    contentType: "application/json",
  },
];

/** inject 方法联合：所有测试表格以此声明，避免 `as` 断言掩盖真实运行时方法。 */
export type InjectMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "OPTIONS";

export interface GuardRequest {
  method: InjectMethod;
  url: string;
  /** 完整 cookie 头值（`bearerCookie` 或任意原始串）。 */
  cookie?: string | undefined;
  payload?: string | undefined;
  contentType?: string | undefined;
}

/** 一次请求窗口内的真实语句活动。 */
export interface DbActivity {
  selects: number;
  deletes: number;
  inserts: number;
  updates: number;
}

export interface ObservedRequest {
  response: InjectResponse;
  activity: DbActivity;
  /** 请求前的会话快照与写计数：与活动计数合起来区分"零写入"与"写后回滚"。 */
  sessionsBefore: SessionRow[];
  changesBefore: number;
}

export interface AppFixture {
  app: FastifyInstance;
  db: DatabaseSync;
  /** 在真实 authorizer 窗口内执行请求：响应 + 语句活动 + 请求前状态同时可断言。 */
  observe: (spec: GuardRequest, fault?: FaultTarget) => Promise<ObservedRequest>;
  /** protected consumer 的一次 GET：无/畸形/未知/有效 cookie 与故障注入共用此形状。 */
  observeConsumer: (cookie?: string, fault?: FaultTarget) => Promise<ObservedRequest>;
  /** 真实登录后发起 protected consumer GET：guard 测试最常见的观察形状。 */
  observeConsumerWithSession: (
    fault?: FaultTarget,
  ) => Promise<ObservedRequest & { sessionId: string }>;
  handlerProbeCalls: () => number;
  /** protected POST probe 实际解析到的 body（证明 guard 未消费/替换 payload 流）。 */
  handlerProbeBody: () => unknown;
}

export interface GuardAppOptions {
  now?: () => number;
  secureCookies?: boolean;
  staticRoot?: string;
}

export type FaultTarget =
  | { kind: "session-read" }
  | { kind: "begin" }
  | { kind: "commit" }
  | { kind: "session-delete" };

export const SELECT_DENIED: FaultTarget = { kind: "session-read" };
export const BEGIN_DENIED: FaultTarget = { kind: "begin" };
export const COMMIT_DENIED: FaultTarget = { kind: "commit" };
export const DELETE_DENIED: FaultTarget = { kind: "session-delete" };

/** exact expired 家族（enabled/disabled/orphan）+ 两条 sibling，供条件删除矩阵复用。 */
export interface ExpiredFamily {
  expiredEnabled: string;
  expiredDisabled: string;
  expiredOrphan: string;
  /** 三条 expired id，按 enabled → disabled → orphan 顺序。 */
  expiredIds: string[];
  /** 两条未被请求的 sibling 的期望快照。 */
  survivorSnapshot: SessionRow[];
}

export function seedExpiredFamily(db: DatabaseSync): ExpiredFamily {
  const [expiredEnabled, expiredDisabled, expiredOrphan, siblingFuture, siblingExpired] = [
    testId("1"),
    testId("2"),
    testId("3"),
    testId("4"),
    testId("5"),
  ] as const;
  insertRow(db, expiredEnabled, "u1", FIXED_NOW - 1);
  insertRow(db, expiredDisabled, "u4", FIXED_NOW - 1);
  insertOrphanRow(db, expiredOrphan, "u9", FIXED_NOW - 1);
  insertRow(db, siblingFuture, "u2", FIXED_NOW + 60_000);
  insertRow(db, siblingExpired, "u3", FIXED_NOW - 1);
  disableAccount(db, "u4");
  const survivorSnapshot = rowsById(
    row(siblingFuture, "u2", FIXED_NOW + 60_000),
    row(siblingExpired, "u3", FIXED_NOW - 1),
  );
  return {
    expiredEnabled,
    expiredDisabled,
    expiredOrphan,
    expiredIds: [expiredEnabled, expiredDisabled, expiredOrphan],
    survivorSnapshot,
  };
}

/**
 * standalone `registerAuth` 装配（不装 root guard）：#10 交付且仍被 request-errors 套件使用的
 * 公共形状。auth 拥有 request-local `principal` 的默认值，因此即便没有 guard，`request.principal`
 * 也必须是 `null`，me 则回落到唯一判定出口。用于 me fallback 与 principal 默认值两条判别用例。
 */
export async function withStandaloneAuthApp<T>(
  action: (fixture: { app: FastifyInstance; db: DatabaseSync }) => Promise<T>,
): Promise<T> {
  const db = openDb(":memory:");
  const app = fastify({ logger: false });
  // registerAuth 自带 authNow 与 cookie 插件；此处只提供 caller-owned db，不装配 root guard。
  app.decorate("db", db);
  app.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
  registerAuth(app, {
    db,
    secureCookies: false,
    sessionTtlMs: SESSION_TTL,
    runtime: fixedRuntime(() => FIXED_NOW),
    mapAuthError: (code) => new HttpError(code),
  });
  try {
    return await action({ app, db });
  } finally {
    await app.close();
    db.close();
  }
}

/**
 * 真实 createApp 装配 + 测试侧 protected route。route 注册必须先于任何 inject，
 * 因此会话不在这里建立，由用例按需 `loginSessionId` / `asProtectedConsumer`。
 */
export async function withGuardApp<T>(
  action: (fixture: AppFixture) => Promise<T>,
  options: GuardAppOptions = {},
): Promise<T> {
  const db = openDb(":memory:");
  let app: FastifyInstance | undefined;
  try {
    app = createApp({
      db,
      authRuntime: fixedRuntime(options.now ?? (() => FIXED_NOW)),
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
      ...(options.staticRoot === undefined ? {} : { staticRoot: options.staticRoot }),
    });
    return await assembleGuardProbes(app, db, action);
  } finally {
    try {
      await app?.close();
    } finally {
      db.close();
    }
  }
}

async function assembleGuardProbes<T>(
  app: FastifyInstance,
  db: DatabaseSync,
  action: (fixture: AppFixture) => Promise<T>,
): Promise<T> {
  const probe = { ran: 0, lastBody: undefined as unknown };
  app.get(PRINCIPAL_ROUTE, (request) => ({ principal: request.principal }));
  // non-API 状态探针：与 protected consumer 成对，证明默认值在 guard 不介入时同样存在。
  app.get(STATE_PROBE_ROUTE, principalShapeHandler);
  // 回显解析后的 body：guard 若消费或替换 preParsing payload，这里就会看到差异。
  app.post(HANDLER_PROBE_ROUTE, (request) => {
    probe.ran += 1;
    probe.lastBody = request.body;
    return { ran: probe.ran, body: request.body };
  });
  app.post(REGISTERED_PROBE_ROUTE, validatingBodyRouteOptions(), () => ({ ok: true }));

  const observe = (spec: GuardRequest, fault?: FaultTarget) => observeRequest(db, spec, app, fault);
  return action({
    app,
    db,
    observe,
    observeConsumer: (cookie, fault) =>
      observe({ method: "GET", url: PRINCIPAL_ROUTE_URL, cookie }, fault),
    observeConsumerWithSession: async (fault) => {
      const sessionId = await loginSessionId(app);
      const observed = await observe(
        { method: "GET", url: PRINCIPAL_ROUTE_URL, cookie: bearerCookie(sessionId) },
        fault,
      );
      return { ...observed, sessionId };
    },
    handlerProbeCalls: () => probe.ran,
    handlerProbeBody: () => probe.lastBody,
  });
}

export async function request(app: FastifyInstance, spec: GuardRequest): Promise<InjectResponse> {
  const response = await app.inject({
    method: spec.method,
    url: spec.url,
    ...(spec.payload === undefined ? {} : { payload: spec.payload }),
    headers: {
      ...(spec.contentType === undefined ? {} : { "content-type": spec.contentType }),
      ...(spec.cookie === undefined ? {} : { cookie: spec.cookie }),
    },
  });
  return {
    statusCode: response.statusCode,
    payload: response.payload,
    headers: response.headers as Record<string, unknown>,
    json: () => response.json(),
  };
}

/** 在真实 authorizer 窗口内执行请求：响应、语句活动与请求前状态。 */
async function observeRequest(
  db: DatabaseSync,
  spec: GuardRequest,
  app: FastifyInstance,
  fault?: FaultTarget,
): Promise<ObservedRequest> {
  const activity: DbActivity = { selects: 0, deletes: 0, inserts: 0, updates: 0 };
  const sessionsBefore = sessionSnapshot(db);
  const changesBefore = totalChanges(db);
  db.setAuthorizer((actionCode, argument) => {
    if (actionCode === constants.SQLITE_SELECT && argument === null) {
      activity.selects += 1;
    } else if (actionCode === constants.SQLITE_DELETE) {
      activity.deletes += 1;
    } else if (actionCode === constants.SQLITE_INSERT) {
      activity.inserts += 1;
    } else if (actionCode === constants.SQLITE_UPDATE) {
      activity.updates += 1;
    }
    return fault !== undefined && matchesFault(actionCode, argument, fault)
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK;
  });
  try {
    return { response: await request(app, spec), activity, sessionsBefore, changesBefore };
  } finally {
    resetAuthorizer(db);
  }
}

function matchesFault(actionCode: number, argument: string | null, fault: FaultTarget): boolean {
  switch (fault.kind) {
    case "session-read":
      return actionCode === constants.SQLITE_SELECT;
    case "begin":
      return actionCode === constants.SQLITE_TRANSACTION && argument === "BEGIN";
    case "commit":
      return actionCode === constants.SQLITE_TRANSACTION && argument === "COMMIT";
    case "session-delete":
      return actionCode === constants.SQLITE_DELETE && argument === "auth_sessions";
  }
}

function resetAuthorizer(db: DatabaseSync): void {
  db.setAuthorizer(null);
  if (db.isTransaction) {
    db.exec("ROLLBACK");
  }
}

/** 语句活动画像：session 读/写面的精确次数（未列出的类别一律 0）。 */
export function expectActivity(activity: DbActivity, expected: Partial<DbActivity>): void {
  expect({ ...activity }).toEqual({
    selects: expected.selects ?? 0,
    deletes: expected.deletes ?? 0,
    inserts: expected.inserts ?? 0,
    updates: expected.updates ?? 0,
  });
}

/**
 * 观察窗口前后持久行逐值不变且事务不残留。写"尝试"次数由 activity 计数负责：
 * `total_changes()` 会计入被回滚的 DELETE，因此 rollback 用例必须用本函数而非写计数。
 */
export function expectUnchanged(observed: ObservedRequest, db: DatabaseSync): void {
  expect(sessionSnapshot(db)).toEqual(observed.sessionsBefore);
  expect(db.isTransaction).toBe(false);
}

/** guard 自身的 401 只发信封：不得撤销 cookie，也不得继承 me/logout 专属 no-store。 */
export function expectGuardDenial(observed: ObservedRequest): void {
  expect(observed.response.statusCode).toBe(401);
  expect(observed.response.payload).toBe(UNAUTHORIZED_PAYLOAD);
  expect(observed.response.headers["set-cookie"]).toBeUndefined();
  expect(observed.response.headers["cache-control"]).toBeUndefined();
}

/** generic 5xx：不带任何语义 code、不清 cookie、不泄漏 SQL/表名/内部细节。 */
export function expectGuardServerError(observed: ObservedRequest): void {
  expect(observed.response.statusCode).toBe(500);
  expect(observed.response.payload).toBe(JSON.stringify(INTERNAL_ERROR_ENVELOPE));
  expect(observed.response.payload).not.toContain("unauthorized");
  expect(observed.response.payload).not.toContain("auth_sessions");
  expect(observed.response.headers["set-cookie"]).toBeUndefined();
}

/** typed 404：既不是 401（guard 抢先）也不是 5xx。 */
export function expectNotFound(observed: ObservedRequest): void {
  expect(observed.response.statusCode).toBe(404);
  expect(observed.response.payload).toBe(JSON.stringify(NOT_FOUND_ENVELOPE));
}
