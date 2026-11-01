/**
 * s2a-kb-ragflow tasks 6.4（#1843）：`GET /api/kb/status` 与 `/api/kb/*` 的关闭判定（ragflow-backend「知识库状态端点」
 * 「知识库可用性」，design D5）。全部经 `createApp` + `app.inject()` 打假 RAGFlow，设置经 store 直接写入。
 * 期望值是 spec 的字面量；钉住的版本串在这里写死，不从 `src/` 取。
 *
 * 关闭判定的真实路由由组 8–14 注册并进 `kb-disabled.test.ts`；这里用显式登记的探针路由钉住它在钩子次序里的位置：
 * 探针的路由级 preParsing 代表后续各组的管理员判定。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, preParsingHookHandler } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { createKbStore } from "../src/kb/store.js";
import { EMBEDDING, insertRow, MODEL_ROW } from "./kb-store-helpers.js";
import { FIXED_NOW, fixedRuntime, UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";

const KEY = "wb-issue1843-ragflow-key";
const VERSION_ROUTE = "GET /api/v1/system/version";
const STATUS = "/api/kb/status";
const MAX_BYTES = 2_097_152;
const MAX_FILES = 3;
const MISMATCH = { event: "kb_version_mismatch" };
const AUTH_FAILED = { event: "kb_upstream_auth_failed" };
const DISABLED_ENVELOPE = { error: { code: "kb_disabled", message: "知识库未启用" } };
const PROBE_ROUTE = "/api/kb/probe-1843";

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  cookie: string;
}

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

type Kb = NonNullable<Parameters<typeof createApp>[0]["assembly"]>["kb"];

async function openWorld(kb: Kb, prepare?: (app: FastifyInstance) => void): Promise<World> {
  const db = openDb(":memory:");
  const app = createApp({ db, authRuntime: fixedRuntime(() => FIXED_NOW), assembly: { kb } });
  prepare?.(app);
  opened.push(async () => {
    await app.close();
    db.close();
  });
  return { app, db, cookie: await cookieFor(app, "zhangsan") };
}

interface Configured extends World {
  fake: FakeRagflowServer;
  logged: unknown[];
  advance(ms: number): void;
}

type Seams = Partial<Pick<NonNullable<Kb>, "deadlines">>;

async function openConfigured(
  seams: Seams = {},
  prepare?: (app: FastifyInstance) => void,
): Promise<Configured> {
  const fake = await start({ apiKey: KEY });
  opened.push(() => fake.close());
  const logged: unknown[] = [];
  let clock = 5_000_000;
  const world = await openWorld(
    {
      key: { read: () => KEY },
      baseUrl: fake.baseUrl,
      uploadMaxBytes: MAX_BYTES,
      uploadMaxFiles: MAX_FILES,
      log: (record) => {
        logged.push(record);
      },
      now: () => clock,
      ...seams,
    },
    prepare,
  );
  return {
    ...world,
    fake,
    logged,
    advance: (ms) => {
      clock += ms;
    },
  };
}

function status({ app, cookie }: World) {
  return app.inject({ method: "GET", url: STATUS, headers: { cookie } });
}

const availableOf = async (world: World): Promise<unknown> => {
  const response = await status(world);
  expect(response.statusCode).toBe(200);
  return (response.json() as { available?: unknown }).available;
};

function closedProbe(reached: string[]): (app: FastifyInstance) => void {
  const adminCheck: preParsingHookHandler = (_request, _reply, _payload, _done) => {
    reached.push("admin");
    throw new HttpError("forbidden");
  };
  return (app) => {
    app.post(PROBE_ROUTE, { preParsing: adminCheck }, () => {
      reached.push("handler");
      return {};
    });
  };
}

function postMalformed({ app }: World, cookie: string | undefined, url = PROBE_ROUTE) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    payload: "{not json",
  });
}

describe("知识库状态端点：版本钉住", () => {
  it("版本串依次为 v1.0.0-rc2、v1.0.0-rc1，然后 RAGFlow 关闭：三次都是 200", async () => {
    const world = await openConfigured();
    expect(await availableOf(world)).toBe(true);
    expect(world.logged).toEqual([]);

    world.fake.fault(VERSION_ROUTE, { kind: "version", value: "v1.0.0-rc1" });
    expect(await availableOf(world)).toBe(false);
    expect(world.logged).toEqual([MISMATCH]);

    await world.fake.close();
    expect(await availableOf(world)).toBe(false);
    expect(world.logged).toEqual([MISMATCH]);
  });

  it.each(["v1.0.0-RC2", "v1.0.0-rc2 ", "1.0.0-rc2", "v1.0.0"])(
    "版本串 %j 不恰为 v1.0.0-rc2 即不可用",
    async (value) => {
      const world = await openConfigured();
      world.fake.fault(VERSION_ROUTE, { kind: "version", value });
      expect(await availableOf(world)).toBe(false);
      expect(world.logged).toEqual([MISMATCH]);
    },
  );

  it("每次请求恰一次版本接口，不带密钥，也不发别的请求", async () => {
    const world = await openConfigured();
    await status(world);
    await status(world);
    const requests = world.fake.requests();
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      VERSION_ROUTE,
      VERSION_ROUTE,
    ]);
    expect(requests.map(({ bearer }) => bearer)).toEqual(["missing", "missing"]);
  });

  it("kb_version_mismatch 同一进程 60 秒内至多一行，满 60 秒再写", async () => {
    const world = await openConfigured();
    world.fake.fault(VERSION_ROUTE, { kind: "version", value: "v1.0.0-rc1" }, { times: 3 });
    await status(world);
    world.advance(59_999);
    await status(world);
    expect(world.logged).toEqual([MISMATCH]);
    world.advance(1);
    await status(world);
    expect(world.logged).toEqual([MISMATCH, MISMATCH]);
  });

  it.each([
    ["HTTP 500", { kind: "status", status: 500 }],
    ["a non-JSON answer", { kind: "not_json" }],
    ["a redirect", { kind: "redirect", location: "http://127.0.0.1:9/" }],
    ["a dropped connection", { kind: "reset" }],
  ] as const)("%s：不可用，但不是版本不符", async (_label, fault) => {
    const world = await openConfigured();
    world.fake.fault(VERSION_ROUTE, fault);
    expect(await availableOf(world)).toBe(false);
    expect(world.logged).toEqual([]);
  });

  it("版本接口挂起超过总期限：不可用，仍是 200（期限经装配注入缩短）", async () => {
    const world = await openConfigured({ deadlines: { versionTotalMs: 50 } });
    world.fake.fault(VERSION_ROUTE, { kind: "hang" });
    expect(await availableOf(world)).toBe(false);
    expect(world.logged).toEqual([]);
  });

  it("kb 模块只有一个客户端：跨请求的 kb_upstream_auth_failed 在 60 秒内至多一行", async () => {
    const world = await openConfigured();
    world.fake.fault(VERSION_ROUTE, { kind: "combo", code: 401 }, { times: 3 });
    expect(await availableOf(world)).toBe(false);
    expect(await availableOf(world)).toBe(false);
    expect(world.logged).toEqual([AUTH_FAILED]);
    world.advance(60_000);
    expect(await availableOf(world)).toBe(false);
    expect(world.logged).toEqual([AUTH_FAILED, AUTH_FAILED]);
  });
});

describe("知识库状态端点：应答", () => {
  it("开启时应答恰为六个键，两个就绪位随 kb_settings 变化，上限取配置值", async () => {
    const world = await openConfigured();
    const store = createKbStore(world.db);
    const answer = async () => (await status(world)).json();
    const view = { enabled: true, available: true };
    const limits = { uploadMaxBytes: MAX_BYTES, uploadMaxFiles: MAX_FILES };

    expect(await answer()).toEqual({
      ...view,
      embeddingReady: false,
      compileReady: false,
      ...limits,
    });

    store.saveSettings({ embedding: EMBEDDING });
    expect(await answer()).toEqual({
      ...view,
      embeddingReady: true,
      compileReady: false,
      ...limits,
    });

    insertRow(world.db, "models", MODEL_ROW);
    store.saveSettings({ chatModelId: "m1" });
    expect(await answer()).toEqual({
      ...view,
      embeddingReady: true,
      compileReady: true,
      ...limits,
    });

    store.saveSettings({ chatModelId: null });
    expect(await answer()).toEqual({
      ...view,
      embeddingReady: true,
      compileReady: false,
      ...limits,
    });
  });

  it("RAGFlow 不可达时两个就绪位照常读本地设置", async () => {
    const world = await openConfigured();
    createKbStore(world.db).saveSettings({ embedding: EMBEDDING });
    await world.fake.close();
    expect((await status(world)).json()).toEqual({
      enabled: true,
      available: false,
      embeddingReady: true,
      compileReady: false,
      uploadMaxBytes: MAX_BYTES,
      uploadMaxFiles: MAX_FILES,
    });
  });

  it("未配置时应答恰为 {enabled:false}，带 no-store", async () => {
    const world = await openWorld(undefined);
    const response = await status(world);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("开启时应答带 no-store", async () => {
    const response = await status(await openConfigured());
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("未登录 401，带 no-store，不发版本请求", async () => {
    const world = await openConfigured();
    const response = await world.app.inject({ method: "GET", url: STATUS });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(world.fake.requests()).toEqual([]);
  });

  it("未配置时未登录同样 401", async () => {
    const world = await openWorld(undefined);
    const response = await world.app.inject({ method: "GET", url: STATUS });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
  });
});

describe("/api/kb/* 的关闭判定", () => {
  it("未配置：cookie guard 之后、路由级判定与 body 解析之前 503 kb_disabled，带 no-store", async () => {
    const reached: string[] = [];
    const world = await openWorld(undefined, closedProbe(reached));
    const response = await postMalformed(world, world.cookie);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(DISABLED_ENVELOPE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(reached).toEqual([]);
  });

  it("未配置：匿名先得 401，不是 503", async () => {
    const reached: string[] = [];
    const world = await openWorld(undefined, closedProbe(reached));
    const response = await postMalformed(world, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(reached).toEqual([]);
  });

  it("已配置：判定不生效，请求走到路由级判定", async () => {
    const reached: string[] = [];
    const world = await openConfigured({}, closedProbe(reached));
    const response = await postMalformed(world, world.cookie);
    expect(response.statusCode).toBe(403);
    expect(reached).toEqual(["admin"]);
  });

  it("未配置：状态端点的 HEAD 与 GET 同样不受判定", async () => {
    const world = await openWorld(undefined);
    const { app, cookie } = world;
    const response = await app.inject({ method: "HEAD", url: STATUS, headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });

  it("未配置：没有注册的 /api/kb 路径仍是 catch-all 的 404，其它 API 路由不受影响", async () => {
    const world = await openWorld(undefined);
    const { app, cookie } = world;
    const unknown = await app.inject({
      method: "GET",
      url: "/api/kb/nowhere",
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe("not_found");
    const other = await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } });
    expect(other.statusCode).toBe(200);
  });
});
