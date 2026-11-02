/**
 * `kb-settings.test.ts` 与 `kb-settings-probe.test.ts` 共用（s2a-kb-ragflow tasks 8.2，#1844）：`createApp` + `app.inject()`，
 * 真实 SQLite，假 RAGFlow，假嵌入上游。知识库行与 `models` 行由 store / SQL 直接插入。
 *
 * 每个用例收尾都断言 D7 的不变量：所有请求都带着 `KbDependencies` 交下来的密钥，没有落到未知路由，没有 `/providers` 下的
 * `DELETE`，没有 `PATCH /users/me/models`、单实例 `GET`，每个 `PATCH /models/default` 都带非空的三个名字。
 * 夹具把记录里没有的请求判为未知路由，所以序列错了不能悄悄通过。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import type { KbDependencies } from "../src/kb/index.js";
import { createKbStore } from "../src/kb/store.js";
import { insertRow, MODEL_ROW } from "./kb-store-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { type FakeRagflowRequest, type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { type FakeUpstreamServer, start as startUpstream } from "./support/fake-upstream.mjs";

const RAGFLOW_KEY = "wb-issue1844-ragflow-key";
/** 哨兵：嵌入与对话模型的上游密钥，以及假 RAGFlow 的 message。 */
export const EMBED_KEY = "Snt1nelEmbed1844Key";
export const CHAT_KEY = "Snt1nelChat1844Key";
export const LEAK = "Snt1nelRagflowMessage1844";
export const CHAT_BASE_URL = "http://chat.upstream.test/v1";
export const PROVIDER = "OpenAI-API-Compatible";
export const INSTANCES = `/api/v1/providers/${PROVIDER}/instances`;
export const PUT_PROVIDER = "PUT /api/v1/providers";
export const LIST_MODELS = "GET /api/v1/models";
export const PATCH_DEFAULT = "PATCH /api/v1/models/default";
export const POST_INSTANCE = `POST ${INSTANCES}`;

export const BAD_REQUEST = { error: { code: "bad_request", message: "请求格式不正确" } };
export const FORBIDDEN = { error: { code: "forbidden", message: "没有权限执行此操作" } };
export const KB_UNAVAILABLE = { error: { code: "kb_unavailable", message: "知识库服务暂不可用" } };

/** 实例不存在时的一轮下发（D7）。 */
export const firstRound = (): string[] => [PUT_PROVIDER, LIST_MODELS, POST_INSTANCE, PATCH_DEFAULT];
/** 实例已存在时的一轮下发（D7）。 */
export const nextRound = (instance: string): string[] => [
  PUT_PROVIDER,
  LIST_MODELS,
  `GET ${INSTANCES}/${instance}/models`,
  `PUT ${INSTANCES}/${instance}`,
  PATCH_DEFAULT,
];

type Who = "admin" | "member" | "anonymous";

interface AuditRow {
  actorId: string;
  detail: unknown;
}

export interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  store: ReturnType<typeof createKbStore>;
  fake: FakeRagflowServer;
  upstream: FakeUpstreamServer;
  logged: unknown[];
  /** 首次配置的 `embedding`：指向假嵌入上游。 */
  embedding: { name: string; baseUrl: string; apiKey: string };
  get(who?: Who): Promise<LightMyRequestResponse>;
  put(body: unknown, who?: Who): Promise<LightMyRequestResponse>;
  probe(who?: Who): Promise<LightMyRequestResponse>;
  /** 管理员发一个原样的 body：解析错误的用例用。 */
  raw(
    method: "PUT" | "POST",
    url: string,
    payload: string,
    contentType: string,
  ): Promise<LightMyRequestResponse>;
  /** 带上游的 `models` 行。 */
  addChatModel(id: string, maxTokens?: number): void;
  /** 全部 `kb.settings` 审计，旧的在前。 */
  audits(): AuditRow[];
  /** 上次 `forget()` 以来假 RAGFlow 收到的请求。 */
  sent(): FakeRagflowRequest[];
  forget(): void;
}

export const routes = (requests: FakeRagflowRequest[]): string[] =>
  requests.map(({ method, path }) => `${method} ${path}`);

/** D7 的不变量，对全部请求：见文件头。 */
export function expectDefaultNeverCleared(requests: FakeRagflowRequest[]): void {
  const lines = routes(requests);
  expect(lines.filter((line) => line.startsWith("DELETE /api/v1/providers"))).toEqual([]);
  expect(lines.filter((line) => line.includes("/users/me/models"))).toEqual([]);
  expect(lines.filter((line) => /^GET .*\/instances\/[^/]+$/u.test(line))).toEqual([]);
  for (const { json } of requests.filter(
    (entry) => `${entry.method} ${entry.path}` === PATCH_DEFAULT,
  )) {
    expect(json).toMatchObject({
      model_provider: PROVIDER,
      model_instance: expect.stringMatching(/^owb-(embed|chat)$/u),
      model_name: expect.stringMatching(/./u),
    });
  }
}

interface Options {
  /** 省略时是 `RAGFLOW_KEY`，与假 RAGFlow 一致。 */
  key?: string;
  probeDeadlines?: KbDependencies["probeDeadlines"];
}

/** 在所在文件登记收尾，返回开世界函数。 */
export function useSettingsWorlds(): (options?: Options) => Promise<World> {
  const opened: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of opened.splice(0).reverse()) await close();
  });

  return async (options = {}) => {
    const key = options.key ?? RAGFLOW_KEY;
    const fake = await start({ apiKey: RAGFLOW_KEY });
    const upstream = await startUpstream({ apiKey: EMBED_KEY });
    const db = openDb(":memory:");
    const logged: unknown[] = [];
    const app = createApp({
      db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: {
        kb: {
          key: { read: () => key },
          baseUrl: fake.baseUrl,
          uploadMaxBytes: 1024,
          uploadMaxFiles: 2,
          log: (record) => {
            logged.push(record);
          },
          ...(options.probeDeadlines === undefined
            ? {}
            : { probeDeadlines: options.probeDeadlines }),
        },
      },
    });
    opened.push(async () => {
      await app.close();
      db.close();
      await upstream.close();
      await fake.close();
    });
    if (key === RAGFLOW_KEY) {
      opened.push(async () => {
        const requests = fake.requests();
        expect(fake.unknownRoutes()).toEqual([]);
        expect(requests.filter(({ bearer }) => bearer !== "ok")).toEqual([]);
        expectDefaultNeverCleared(requests);
      });
    }
    const cookies = {
      admin: await cookieFor(app, "lisi"),
      member: await cookieFor(app, "zhangsan"),
    };
    const headers = (who: Who) => (who === "anonymous" ? {} : { cookie: cookies[who] });
    let mark = 0;
    return {
      app,
      db,
      store: createKbStore(db),
      fake,
      upstream,
      logged,
      embedding: {
        name: "bge-m3",
        baseUrl: `http://127.0.0.1:${String(upstream.port)}/v1`,
        apiKey: EMBED_KEY,
      },
      get: (who = "admin") =>
        app.inject({ method: "GET", url: "/api/kb/settings", headers: headers(who) }),
      put: (payload, who = "admin") =>
        app.inject({
          method: "PUT",
          url: "/api/kb/settings",
          headers: headers(who),
          payload: payload as object,
        }),
      probe: (who = "admin") =>
        app.inject({ method: "POST", url: "/api/kb/settings/probe", headers: headers(who) }),
      raw: (method, url, payload, contentType) =>
        app.inject({
          method,
          url,
          headers: { ...headers("admin"), "content-type": contentType },
          payload,
        }),
      addChatModel(id, maxTokens = 4096) {
        insertRow(db, "models", {
          ...MODEL_ROW,
          id,
          name: id,
          max_tokens: maxTokens,
          upstream_base_url: CHAT_BASE_URL,
          upstream_api_key: CHAT_KEY,
        });
      },
      audits: () =>
        db
          .prepare(
            "SELECT actor_id, detail FROM audit_events WHERE kind = 'kb.settings' ORDER BY id",
          )
          .all()
          .map((row) => ({
            actorId: String(row.actor_id),
            detail: JSON.parse(String(row.detail)) as unknown,
          })),
      sent: () => fake.requests().slice(mark),
      forget() {
        mark = fake.requests().length;
      },
    };
  };
}
