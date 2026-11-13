/**
 * s2a-kb-ragflow tasks 8.2（#1844）：ragflow-backend「未配置即关闭」的路由表。每个注册知识库路由的组把路由加进这张表
 *（tasks 头部），组 14（#1852）注册 S2a 的最后一条；s2b-kb-retrieval 组 4（#1918）加检索测试端点，表恰十三条。每条都经真实 `createApp`，不靠探针路由；判定次序的探针用例在 `kb-status.test.ts`。
 * 期望值是 spec 的字面量。没有配置 RAGFlow 地址，所以这里不用假 RAGFlow：判定放行了，请求也无处可发，断言的是信封。
 * s2c-kb-session tasks 2.4（#1963）：关闭时 `registerKb` 交回的是 `null`（design D5），经对模块导出的透传 spy 观察。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import * as kb from "../src/kb/index.js";
import { FIXED_NOW, fixedRuntime, UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const DISABLED = { error: { code: "kb_disabled", message: "知识库未启用" } };
const MALFORMED = "{not json";

/** `body`：`POST` / `PUT` 路由带 malformed JSON（spec「未配置即关闭」）。 */
const ROUTES = [
  { method: "GET", url: "/api/kb/settings", body: false },
  { method: "PUT", url: "/api/kb/settings", body: true },
  { method: "POST", url: "/api/kb/settings/probe", body: true },
  { method: "POST", url: "/api/kb/settings/rebuild", body: true },
  { method: "GET", url: "/api/kb/bases", body: false },
  { method: "POST", url: "/api/kb/bases", body: true },
  { method: "DELETE", url: `/api/kb/bases/${"a".repeat(32)}`, body: false },
  { method: "POST", url: `/api/kb/bases/${"a".repeat(32)}/documents`, body: true },
  { method: "GET", url: `/api/kb/bases/${"a".repeat(32)}/documents`, body: false },
  {
    method: "DELETE",
    url: `/api/kb/bases/${"a".repeat(32)}/documents?doc=${"b".repeat(32)}`,
    body: false,
  },
  {
    method: "POST",
    url: `/api/kb/bases/${"a".repeat(32)}/documents/reingest?doc=${"b".repeat(32)}`,
    body: true,
  },
  { method: "POST", url: `/api/kb/bases/${"a".repeat(32)}/uploads?name=a.md`, body: true },
  { method: "POST", url: `/api/kb/bases/${"a".repeat(32)}/retrieval`, body: true },
] as const;

let app: FastifyInstance;
let db: DatabaseSync;

async function openDisabled(): Promise<void> {
  db = openDb(":memory:");
  app = createApp({ db, authRuntime: fixedRuntime(() => FIXED_NOW) });
  await app.ready();
}

afterEach(async () => {
  await app.close();
  db.close();
});

function request(route: (typeof ROUTES)[number], cookie?: string) {
  return app.inject({
    method: route.method,
    url: route.url,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(route.body ? { "content-type": "application/json" } : {}),
    },
    ...(route.body ? { payload: MALFORMED } : {}),
  });
}

describe("未配置即关闭", () => {
  it("路由表恰十三条：GET /api/kb/status 之外的全部知识库路由", async () => {
    await openDisabled();
    expect(ROUTES).toHaveLength(13);
    expect(new Set(ROUTES.map(({ method, url }) => `${method} ${url.split("?")[0]}`)).size).toBe(
      13,
    );
  });

  it.each(ROUTES)("$method $url：管理员 503 kb_disabled，匿名 401 在它之前", async (route) => {
    await openDisabled();
    const response = await request(route, await cookieFor(app, "lisi"));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(DISABLED);
    expect(response.headers["cache-control"]).toBe("no-store");

    const anonymous = await request(route);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual(UNAUTHORIZED_ENVELOPE);
  });

  it.each(ROUTES)("$method $url：普通用户同样 503，判定先于 403", async (route) => {
    await openDisabled();
    const response = await request(route, await cookieFor(app, "zhangsan"));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(DISABLED);
  });
});

describe("关闭时注册没有交回句柄", () => {
  it("registerKb(app, undefined) 返回 null：写入钩子与会话检索都没有", async () => {
    const registered = vi.spyOn(kb, "registerKb");
    try {
      await openDisabled();
      expect(registered).toHaveBeenCalledTimes(1);
      expect(registered.mock.calls[0]?.[1]).toBeUndefined();
      expect(registered.mock.results[0]).toEqual({ type: "return", value: null });
    } finally {
      registered.mockRestore();
    }
  });
});
