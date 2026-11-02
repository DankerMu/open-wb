/**
 * s2a-kb-ragflow tasks 8.2（#1844）：`GET` / `PUT /api/kb/settings`（ragflow-backend「知识库模型设置」「嵌入模型更换与全量
 * 重建」的本组一腿，knowledge-bases「知识库审计」的 `kb.settings`，design D7、D15、D20）。期望值是 spec 的字面量与实测记录
 * §11 的请求形状。探活在 `kb-settings-probe.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { PARSER_INPUTS } from "./http-guard-helpers.js";
import {
  BAD_REQUEST,
  CHAT_BASE_URL,
  CHAT_KEY,
  EMBED_KEY,
  expectDefaultNeverCleared,
  FORBIDDEN,
  firstRound,
  INSTANCES,
  KB_UNAVAILABLE,
  LEAK,
  LIST_MODELS,
  nextRound,
  PATCH_DEFAULT,
  POST_INSTANCE,
  PROVIDER,
  PUT_PROVIDER,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { COMPILE_ROW, createPlainBase, hex, insertRow, MODEL_ROW } from "./kb-store-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

const open = useSettingsWorlds();

const NEVER = { status: "never", at: null, message: null };
const EMPTY_VIEW = {
  embedding: null,
  chatModelId: null,
  bases: 0,
  compileBases: 0,
  documents: 0,
  rebuilding: 0,
  rebuildFailed: 0,
};
const LOCKED = {
  error: {
    code: "kb_chat_model_locked",
    message: "已有开启 RAPTOR 或知识图谱的知识库，不能更换或取消知识库对话模型",
  },
};
const REBUILD_REQUIRED = {
  error: {
    code: "kb_rebuild_required",
    message: "更换嵌入模型需要重建全部知识库，请确认后再保存",
  },
};
const REBUILDING = { error: { code: "kb_rebuilding", message: "知识库正在重建，请稍后再试" } };
const INFO = { model_name: "bge-m3", model_type: ["embedding"], max_tokens: 8192 };

const bodyOf = (response: { body: string }) => JSON.parse(response.body) as unknown;

async function configured(): Promise<World> {
  const world = await open();
  expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
  world.forget();
  return world;
}

async function withChat(id = "m2"): Promise<World> {
  const world = await configured();
  world.addChatModel(id);
  expect((await world.put({ chatModelId: id })).statusCode).toBe(200);
  world.forget();
  return world;
}

function addCompileBase(world: World, n: number, fields: Record<string, string | number> = {}) {
  insertRow(world.db, "knowledge_bases", {
    ...COMPILE_ROW,
    id: hex(n),
    name: `库 ${String(n)}`,
    dataset_id: `ds-${String(n)}`,
    ...fields,
  });
}

describe("读视图", () => {
  it("未配置：恰为七个键，全是空值，带 no-store", async () => {
    const world = await open();
    const response = await world.get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(response)).toEqual(EMPTY_VIEW);
  });

  it("配置之后显示名称与地址，不含密钥哨兵", async () => {
    const world = await configured();
    const response = await world.get();
    expect(bodyOf(response)).toEqual({
      ...EMPTY_VIEW,
      embedding: { name: "bge-m3", baseUrl: world.embedding.baseUrl, probe: NEVER },
    });
    expect(response.body).not.toContain(EMBED_KEY);
  });

  it("compileBases 的口径：含重建中与重建失败的库", async () => {
    const world = await open();
    addCompileBase(world, 1);
    addCompileBase(world, 2, { raptor: 0, graph: 1, state: "rebuilding" });
    addCompileBase(world, 3, { raptor: 1, graph: 1, state: "rebuild_failed" });
    createPlainBase(world.store, hex(4));
    world.store.addDocument({
      kbId: hex(1),
      ragflowDocumentId: "rf-1",
      name: "a.txt",
      size: 3,
      source: "upload",
    });
    expect(bodyOf(await world.get())).toMatchObject({
      bases: 4,
      compileBases: 3,
      documents: 1,
      rebuilding: 1,
      rebuildFailed: 1,
    });
  });
});

describe("非管理员与未登录", () => {
  it("GET、PUT：普通用户 403，匿名 401，假 RAGFlow 收到零个请求", async () => {
    const world = await open();
    const body = { embedding: world.embedding };
    const member = [await world.get("member"), await world.put(body, "member")];
    for (const response of member) {
      expect(response.statusCode).toBe(403);
      expect(bodyOf(response)).toEqual(FORBIDDEN);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const anonymous = [await world.get("anonymous"), await world.put(body, "anonymous")];
    for (const response of anonymous) {
      expect(response.statusCode).toBe(401);
      expect(bodyOf(response)).toEqual(UNAUTHORIZED_ENVELOPE);
    }
    expect(world.fake.requests()).toEqual([]);
    expect(world.store.settings().embedding).toBeNull();
  });
});

describe("body 校验", () => {
  const EMBEDDING = { name: "bge-m3", baseUrl: "http://embed.test/v1", apiKey: "key" };

  it.each<[string, unknown]>([
    ["空对象", {}],
    ["只有 confirmRebuild", { confirmRebuild: true }],
    ["未知键", { embedding: EMBEDDING, extra: 1 }],
    ["不是对象", [EMBEDDING]],
    ["embedding 是 null：没有清空入口", { embedding: null }],
    ["embedding 不是对象", { embedding: "bge-m3" }],
    ["embedding 有未知键", { embedding: { ...EMBEDDING, extra: 1 } }],
    ["embedding 缺 name", { embedding: { baseUrl: EMBEDDING.baseUrl, apiKey: "key" } }],
    ["embedding 缺 baseUrl", { embedding: { name: "bge-m3", apiKey: "key" } }],
    ["名称为空", { embedding: { ...EMBEDDING, name: "" } }],
    ["名称不是字符串", { embedding: { ...EMBEDDING, name: 1 } }],
    ["名称 129 字节", { embedding: { ...EMBEDDING, name: "a".repeat(129) } }],
    ["名称含控制字符", { embedding: { ...EMBEDDING, name: "a\nb" } }],
    ["名称含 @", { embedding: { ...EMBEDDING, name: "a@b" } }],
    ["地址不是 http(s)", { embedding: { ...EMBEDDING, baseUrl: "ftp://embed.test" } }],
    ["地址带 userinfo", { embedding: { ...EMBEDDING, baseUrl: "http://u:p@embed.test" } }],
    ["密钥为空串", { embedding: { ...EMBEDDING, apiKey: "" } }],
    ["密钥含换行", { embedding: { ...EMBEDDING, apiKey: "a\nb" } }],
    ["密钥不是字符串", { embedding: { ...EMBEDDING, apiKey: 1 } }],
    ["chatModelId 不是字符串", { chatModelId: 1 }],
    ["chatModelId 为空串", { chatModelId: "" }],
    ["chatModelId 含 @", { chatModelId: "m@2" }],
    ["confirmRebuild 不是 true", { embedding: EMBEDDING, confirmRebuild: false }],
  ])("%s：400，假 RAGFlow 收到零个请求，设置不变", async (_label, body) => {
    const world = await open();
    const response = await world.put(body);
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.fake.requests()).toEqual([]);
    expect(world.audits()).toEqual([]);
    expect(world.store.settings().embedding).toBeNull();
  });

  it("名称恰 128 字节：接受", async () => {
    const world = await open();
    const name = `${"模".repeat(42)}aa`;
    expect(Buffer.byteLength(name)).toBe(128);
    expect((await world.put({ embedding: { ...world.embedding, name } })).statusCode).toBe(200);
  });

  it("首次配置省略 apiKey：400，假 RAGFlow 收到零个请求", async () => {
    const world = await open();
    const { apiKey: _key, ...embedding } = world.embedding;
    const response = await world.put({ embedding });
    expect(response.statusCode).toBe(400);
    expect(world.fake.requests()).toEqual([]);
  });

  it("已配置时 apiKey 为空串或含换行：400，设置不变", async () => {
    const world = await configured();
    for (const apiKey of ["", "a\nb"]) {
      const response = await world.put({ embedding: { ...world.embedding, apiKey } });
      expect(response.statusCode).toBe(400);
    }
    expect(world.sent()).toEqual([]);
    expect(world.store.embeddingApiKey()).toBe(EMBED_KEY);
  });

  it("chatModelId 不存在或该模型没有上游：400，假 RAGFlow 收到零个请求", async () => {
    const world = await open();
    insertRow(world.db, "models", { ...MODEL_ROW, id: "bare" });
    for (const chatModelId of ["missing", "bare"]) {
      const response = await world.put({ chatModelId });
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response)).toEqual(BAD_REQUEST);
    }
    expect(world.fake.requests()).toEqual([]);
    expect(world.store.settings().chatModelId).toBeNull();
  });

  it("名称不能含 @：id 含 @ 的带上游模型同样 400", async () => {
    const world = await open();
    world.addChatModel("m@2");
    expect((await world.put({ chatModelId: "m@2" })).statusCode).toBe(400);
    expect(world.fake.requests()).toEqual([]);
  });
});

describe("归属路由（http-service-skeleton「知识库的归属路由」）", () => {
  it.each(PARSER_INPUTS)(
    "PUT /api/kb/settings 上的 $name：exact 400，发生在出站之前",
    async ({ payload, contentType }) => {
      const world = await open();
      const response = await world.raw("PUT", "/api/kb/settings", payload, contentType);
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response)).toEqual(BAD_REQUEST);
      expect(world.fake.requests()).toEqual([]);
    },
  );

  it("PUT /api/kb/settings 上的 text/plain body：exact 400", async () => {
    const world = await open();
    const response = await world.raw("PUT", "/api/kb/settings", "{}", "text/plain");
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
  });
});

describe("下发的请求序列（§11，design D7）", () => {
  it("首次 POST 实例；再次先读模型列表再 PUT，省略 apiKey 时带已存密钥；对话模型走 owb-chat", async () => {
    const world = await open();
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
    const instance = {
      instance_name: "owb-embed",
      api_key: EMBED_KEY,
      base_url: world.embedding.baseUrl,
      model_info: [INFO],
    };
    const embedDefault = {
      model_provider: PROVIDER,
      model_instance: "owb-embed",
      model_name: "bge-m3",
      model_type: "embedding",
    };
    expect(world.sent().map(({ method, path, json }) => ({ method, path, json }))).toEqual([
      { method: "PUT", path: "/api/v1/providers", json: { provider_name: PROVIDER } },
      { method: "GET", path: "/api/v1/models", json: null },
      { method: "POST", path: INSTANCES, json: instance },
      { method: "PATCH", path: "/api/v1/models/default", json: embedDefault },
    ]);

    world.forget();
    const { apiKey: _key, ...kept } = world.embedding;
    const moved = `${world.embedding.baseUrl}/moved`;
    expect((await world.put({ embedding: { ...kept, baseUrl: moved } })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(world.sent()[3]?.json).toEqual({ ...instance, base_url: moved });
    expect(world.sent()[4]?.json).toEqual(embedDefault);

    world.forget();
    world.addChatModel("m2", 2048);
    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(firstRound());
    expect(world.sent()[2]?.json).toEqual({
      instance_name: "owb-chat",
      api_key: CHAT_KEY,
      base_url: CHAT_BASE_URL,
      model_info: [{ model_name: "m2", model_type: ["chat"], max_tokens: 2048 }],
    });
    expect(world.sent()[3]?.json).toEqual({
      model_provider: PROVIDER,
      model_instance: "owb-chat",
      model_name: "m2",
      model_type: "chat",
    });
    expect(world.fake.defaultModels()).toEqual([
      { modelType: "embedding", instance: "owb-embed", name: "bge-m3" },
      { modelType: "chat", instance: "owb-chat", name: "m2" },
    ]);
  });

  it("重复下发不发 POST：同一 body 再存一次走 PUT，且恰一轮", async () => {
    const world = await configured();
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(routes(world.sent())).not.toContain(POST_INSTANCE);
  });

  it("换模型时 model_info 只增不减，同名项以本次为准", async () => {
    const world = await configured();
    const { apiKey: _key, ...kept } = world.embedding;
    const body = { embedding: { ...kept, name: "text-embedding-3-small" }, confirmRebuild: true };
    expect((await world.put(body)).statusCode).toBe(200);
    const requests = world.sent();
    expect(routes(requests)).toEqual(nextRound("owb-embed"));
    expect(requests[3]?.json).toMatchObject({
      model_info: [INFO, { ...INFO, model_name: "text-embedding-3-small" }],
    });
    expect(requests[4]?.json).toMatchObject({ model_name: "text-embedding-3-small" });
    expect(world.fake.defaultModels()).toEqual([
      { modelType: "embedding", instance: "owb-embed", name: "text-embedding-3-small" },
    ]);
  });

  it("对话模型的 max_tokens 改了：同名项以本次为准，不重复", async () => {
    const world = await withChat();
    world.db.prepare("UPDATE models SET max_tokens = 1024 WHERE id = 'm2'").run();
    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
    expect(world.sent()[3]?.json).toMatchObject({
      model_info: [{ model_name: "m2", model_type: ["chat"], max_tokens: 1024 }],
    });
  });

  it("换对话模型：owb-chat 里两个模型都在，账号缺省切到新模型", async () => {
    const world = await withChat();
    world.addChatModel("m3");
    expect((await world.put({ chatModelId: "m3" })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));
    expect(world.fake.instances().find(({ name }) => name === "owb-chat")?.models).toEqual([
      { name: "m2", modelType: ["chat"], maxTokens: 4096 },
      { name: "m3", modelType: ["chat"], maxTokens: 4096 },
    ]);
  });

  it("这是第一条带密钥的路由：Authorization 恰为 KbDependencies 交下来的 key", async () => {
    const world = await withChat();
    expect(world.fake.requests().length).toBeGreaterThan(0);
    expect(new Set(world.fake.requests().map(({ bearer }) => bearer))).toEqual(new Set(["ok"]));
  });

  it("交下来的 key 不对：假 RAGFlow 回 401，保存 503，不是 200", async () => {
    const world = await open({ key: "wb-issue1844-wrong-key" });
    const response = await world.put({ embedding: world.embedding });
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    expect(world.fake.requests()).toMatchObject([{ bearer: "other" }]);
    expect(world.logged).toEqual([{ event: "kb_upstream_auth_failed" }]);
    expect(world.store.settings().embedding).toBeNull();
  });
});

describe("下发失败不改设置", () => {
  it("HTTP 500：503，GET 仍为 embedding:null，没有审计；恢复后同一 body 200，恰一条审计", async () => {
    const world = await open();
    world.fake.fault(PUT_PROVIDER, { kind: "status", status: 500 });
    const failed = await world.put({ embedding: world.embedding });
    expect(failed.statusCode).toBe(503);
    expect(bodyOf(failed)).toEqual(KB_UNAVAILABLE);
    expect(bodyOf(await world.get())).toEqual(EMPTY_VIEW);
    expect(world.audits()).toEqual([]);

    const saved = await world.put({ embedding: world.embedding });
    expect(saved.statusCode).toBe(200);
    expect(bodyOf(saved)).toMatchObject({ embedding: { name: "bge-m3" } });
    expect(saved.body).not.toContain(EMBED_KEY);
    expect(world.audits()).toEqual([{ actorId: "u3", detail: { embedding: "bge-m3" } }]);
  });

  it.each([PUT_PROVIDER, LIST_MODELS, POST_INSTANCE, PATCH_DEFAULT])(
    "%s 失败：503，后面的步骤不发，本地不变",
    async (route) => {
      const world = await open();
      world.fake.fault(route, { kind: "status", status: 503 });
      expect((await world.put({ embedding: world.embedding })).statusCode).toBe(503);
      const sent = routes(world.sent());
      expect(sent).toEqual(firstRound().slice(0, firstRound().indexOf(route) + 1));
      expect(world.store.settings().embedding).toBeNull();
      expect(world.store.embeddingApiKey()).toBeNull();
      expect(world.audits()).toEqual([]);
    },
  );

  it("改实例时读模型列表或 PUT 失败：503，已存设置不变", async () => {
    for (const route of [`GET ${INSTANCES}/owb-embed/models`, `PUT ${INSTANCES}/owb-embed`]) {
      const world = await configured();
      world.fake.fault(route, { kind: "status", status: 500 });
      const body = { embedding: { ...world.embedding, name: "bge-large" } };
      expect((await world.put(body)).statusCode).toBe(503);
      expect(world.store.settings().embedding?.name).toBe("bge-m3");
      expect(world.audits()).toHaveLength(1);
    }
  });

  it("RAGFlow 的 code:102：400 kb_rejected；message 不进响应与审计", async () => {
    const world = await open();
    world.fake.fault(POST_INSTANCE, { kind: "combo", code: 102, message: LEAK });
    const response = await world.put({ embedding: world.embedding });
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual({
      error: { code: "kb_rejected", message: "知识库服务拒绝了这个请求" },
    });
    expect(response.body).not.toContain(LEAK);
    expect(world.logged).toEqual([]);
  });

  it("没有 model_info 项被读出时（成功应答缺字段）：503，不发 PUT", async () => {
    const world = await configured();
    world.fake.fault(`GET ${INSTANCES}/owb-embed/models`, { kind: "combo", code: 0, data: {} });
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(503);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed").slice(0, 3));
  });

  it("RAGFlow 不可达：503，本地不变", async () => {
    const world = await open();
    await world.fake.close();
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(503);
    expect(world.store.settings().embedding).toBeNull();
  });
});

describe("只含嵌入模型的保存重发对话模型", () => {
  it("同名同址省略 apiKey：依次 owb-embed 一轮、owb-chat 一轮，两种缺省都补回来", async () => {
    const world = await withChat();
    const { apiKey: _key, ...kept } = world.embedding;
    expect((await world.put({ embedding: kept })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...nextRound("owb-embed"), ...nextRound("owb-chat")]);
    const patched = world.sent().filter(({ method }) => method === "PATCH");
    expect(patched.map(({ json }) => json)).toMatchObject([
      { model_type: "embedding" },
      { model_type: "chat" },
    ]);
  });

  it("没有指定对话模型：只有 owb-embed 一轮", async () => {
    const world = await configured();
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
  });

  it("该行的上游被清空（store 直接写入）：200，只有 owb-embed 一轮", async () => {
    const world = await withChat();
    world.db
      .prepare(
        "UPDATE models SET upstream_base_url = NULL, upstream_api_key = NULL WHERE id = 'm2'",
      )
      .run();
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(world.store.settings().chatModelId).toBe("m2");
  });

  it("owb-chat 下发失败：503，本地设置不变，没有 kb.settings 审计", async () => {
    const world = await withChat();
    const before = world.audits();
    world.fake.fault(`PUT ${INSTANCES}/owb-chat`, { kind: "status", status: 503 });
    const body = { embedding: { ...world.embedding, apiKey: "rotated-key" } };
    expect((await world.put(body)).statusCode).toBe(503);
    expect(world.store.embeddingApiKey()).toBe(EMBED_KEY);
    expect(world.audits()).toEqual(before);
  });

  it("同一 PUT 同时给了两者：先嵌入后对话，对话取本次的值", async () => {
    const world = await configured();
    world.addChatModel("m2");
    const body = { embedding: world.embedding, chatModelId: "m2" };
    expect((await world.put(body)).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...nextRound("owb-embed"), ...firstRound()]);
    expect(world.audits().at(-1)?.detail).toEqual({ chatModelId: "m2" });
  });

  it("同一 PUT 里嵌入与 chatModelId:null：不重发对话模型，取消指定只改本地", async () => {
    const world = await withChat();
    const body = { embedding: world.embedding, chatModelId: null };
    expect((await world.put(body)).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(world.store.settings().chatModelId).toBeNull();
  });
});

describe("chatModelId 的取值规则（design D7 的表）", () => {
  it("取消指定的无操作：200，零个请求，没有审计，updated_at 不变", async () => {
    const world = await configured();
    const before = world.store.settings().updatedAt;
    const audits = world.audits();
    const response = await world.put({ chatModelId: null });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({ chatModelId: null });
    expect(world.sent()).toEqual([]);
    expect(world.audits()).toEqual(audits);
    expect(world.store.settings().updatedAt).toBe(before);
  });

  it("取消指定：只改本地，零个请求，账号缺省不动，审计 {chatModelId:null}", async () => {
    const world = await withChat();
    const response = await world.put({ chatModelId: null });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({ chatModelId: null });
    expect(world.sent()).toEqual([]);
    expect(world.fake.defaultModels()).toContainEqual({
      modelType: "chat",
      instance: "owb-chat",
      name: "m2",
    });
    expect(world.audits().at(-1)).toEqual({ actorId: "u3", detail: { chatModelId: null } });
  });

  it("同 id 重存：照常下发并保存，detail 为空", async () => {
    const world = await withChat();
    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));
    expect(world.audits().at(-1)?.detail).toEqual({});
  });

  it("开编译的库锁定对话模型：置 null、换 id 都 409，不下发；同 id 照常下发", async () => {
    const world = await withChat();
    world.addChatModel("m3");
    addCompileBase(world, 1);
    const audits = world.audits();
    for (const chatModelId of [null, "m3"]) {
      const response = await world.put({ chatModelId });
      expect(response.statusCode).toBe(409);
      expect(bodyOf(response)).toEqual(LOCKED);
    }
    expect(world.sent()).toEqual([]);
    expect(world.store.settings().chatModelId).toBe("m2");
    expect(world.audits()).toEqual(audits);

    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));
  });

  it.each(["rebuilding", "rebuild_failed"])("重建状态 %s 的编译库同样锁定", async (state) => {
    const world = await withChat();
    addCompileBase(world, 1, { state });
    expect(bodyOf(await world.put({ chatModelId: null }))).toEqual(LOCKED);
  });

  it("普通库不锁定对话模型", async () => {
    const world = await withChat();
    createPlainBase(world.store, hex(1));
    expect((await world.put({ chatModelId: null })).statusCode).toBe(200);
  });

  it("当前值是 null 时开编译的库不锁定：指定一个新模型即恢复", async () => {
    const world = await configured();
    world.addChatModel("m2");
    addCompileBase(world, 1);
    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
  });
});

describe("账号缺省不被清空（§13）", () => {
  it("走完配置、取消指定、换模型的设置路径：没有 DELETE，每个 PATCH 都带三个非空名字", async () => {
    const world = await open();
    world.addChatModel("m2");
    world.addChatModel("m3");
    const { apiKey: _key, ...kept } = world.embedding;
    const steps = [
      { embedding: world.embedding },
      { chatModelId: "m2" },
      { chatModelId: null },
      { chatModelId: null },
      { chatModelId: "m3" },
      { embedding: { ...kept, name: "text-embedding-3-small" } },
    ];
    for (const body of steps) {
      expect((await world.put(body)).statusCode).toBe(200);
    }
    const requests = world.fake.requests();
    expectDefaultNeverCleared(requests);
    expect(requests.filter(({ method }) => method === "DELETE")).toEqual([]);
    expect(world.fake.defaultModels()).toEqual([
      { modelType: "embedding", instance: "owb-embed", name: "text-embedding-3-small" },
      { modelType: "chat", instance: "owb-chat", name: "m3" },
    ]);
  });
});

describe("嵌入身份（name、baseUrl）的变化", () => {
  const STORED = { name: "bge-m3" };

  it.each([
    ["不带 confirmRebuild", {}],
    ["带 confirmRebuild：组 14 才开放，本组一律 409", { confirmRebuild: true }],
  ])("已有知识库时改名称，%s：409 kb_rebuild_required，不下发，不保存", async (_label, extra) => {
    const world = await configured();
    createPlainBase(world.store, hex(1));
    const body = { embedding: { ...world.embedding, name: "bge-large" }, ...extra };
    const response = await world.put(body);
    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual(REBUILD_REQUIRED);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings().embedding).toMatchObject(STORED);
    expect(world.store.countBasesInState("ready")).toBe(1);
    expect(world.audits()).toHaveLength(1);
  });

  it("已有知识库时改地址：同样 409", async () => {
    const world = await configured();
    createPlainBase(world.store, hex(1));
    const embedding = { ...world.embedding, baseUrl: `${world.embedding.baseUrl}/moved` };
    expect(bodyOf(await world.put({ embedding }))).toEqual(REBUILD_REQUIRED);
  });

  it("已有知识库时只换密钥不是身份变化：200，照常下发", async () => {
    const world = await configured();
    createPlainBase(world.store, hex(1));
    const body = { embedding: { ...world.embedding, apiKey: "rotated-key" } };
    expect((await world.put(body)).statusCode).toBe(200);
    expect(world.sent()[3]?.json).toMatchObject({ api_key: "rotated-key" });
    expect(world.store.embeddingApiKey()).toBe("rotated-key");
    expect(world.audits().at(-1)?.detail).toEqual({ embedding: "bge-m3" });
  });

  it("同名同址同密钥重存是一次写入：一条审计，detail 为空", async () => {
    const world = await configured();
    expect((await world.put({ embedding: world.embedding })).statusCode).toBe(200);
    expect(world.audits().at(-1)).toEqual({ actorId: "u3", detail: {} });
  });

  it("没有知识库时改名称：200，不要确认", async () => {
    const world = await configured();
    const body = { embedding: { ...world.embedding, name: "bge-large" } };
    expect((await world.put(body)).statusCode).toBe(200);
    expect(world.audits().at(-1)?.detail).toEqual({ embedding: "bge-large" });
  });

  it("重建中改身份：带不带 confirmRebuild 都是 409 kb_rebuilding，先于 kb_rebuild_required", async () => {
    const world = await configured();
    addCompileBase(world, 1, { state: "rebuilding" });
    const embedding = { ...world.embedding, name: "bge-large" };
    expect(bodyOf(await world.put({ embedding }))).toEqual(REBUILDING);
    expect(bodyOf(await world.put({ embedding, confirmRebuild: true }))).toEqual(REBUILDING);
    expect(world.sent()).toEqual([]);

    const rotated = { embedding: { ...world.embedding, apiKey: "rotated-key" } };
    expect((await world.put(rotated)).statusCode).toBe(200);
  });

  it("两种 409 同时成立：kb_chat_model_locked 在前（保存流程第 1 步）", async () => {
    const world = await withChat();
    world.addChatModel("m3");
    addCompileBase(world, 1);
    const body = { embedding: { ...world.embedding, name: "bge-large" }, chatModelId: "m3" };
    expect(bodyOf(await world.put(body))).toEqual(LOCKED);
  });
});

describe("审计 kb.settings（knowledge-bases「知识库审计」）", () => {
  it("detail 只含实际变化的键，actor 是请求的 principal，不含密钥哨兵", async () => {
    const world = await open();
    world.addChatModel("m2");
    await world.put({ embedding: world.embedding, chatModelId: "m2" });
    await world.put({ embedding: { ...world.embedding, name: "bge-large" } });
    expect(world.audits()).toEqual([
      { actorId: "u3", detail: { embedding: "bge-m3", chatModelId: "m2" } },
      { actorId: "u3", detail: { embedding: "bge-large" } },
    ]);
    const stored = world.db.prepare("SELECT title, detail FROM audit_events").all();
    expect(JSON.stringify(stored)).not.toContain(EMBED_KEY);
    expect(JSON.stringify(stored)).not.toContain(CHAT_KEY);
  });

  it("密钥只进出站请求：stderr 记录里没有", async () => {
    const world = await withChat();
    expect(JSON.stringify(world.logged)).not.toContain(EMBED_KEY);
    expect(JSON.stringify(world.logged)).not.toContain(CHAT_KEY);
  });
});

describe("并发设置写入（design D20）", () => {
  it("第一个下发挂起时第二个排在锁后：两次下发不重叠，最终值等于最后一次下发", async () => {
    const world = await configured();
    world.addChatModel("m2");
    world.addChatModel("m3");
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const first = world.put({ chatModelId: "m2" });
    await gate.reached;
    const second = world.put({ chatModelId: "m3" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(routes(world.sent())).toEqual(firstRound());
    expect(world.store.settings().chatModelId).toBeNull();

    gate.release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...firstRound(), ...nextRound("owb-chat")]);
    expect(bodyOf(await world.get())).toMatchObject({ chatModelId: "m3" });
    expect(
      world
        .audits()
        .slice(-2)
        .map(({ detail }) => detail),
    ).toEqual([{ chatModelId: "m2" }, { chatModelId: "m3" }]);
  });

  it("锁在失败路径上释放：挂起的那次失败之后，排队者照常执行", async () => {
    const world = await configured();
    world.addChatModel("m2");
    const gate = world.fake.fault(PUT_PROVIDER, { kind: "hold" });
    world.fake.fault(LIST_MODELS, { kind: "status", status: 500 });
    const first = world.put({ chatModelId: "m2" });
    await gate.reached;
    const second = world.put({ chatModelId: "m2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.release();
    expect((await first).statusCode).toBe(503);
    expect((await second).statusCode).toBe(200);
  });

  it("判定在锁内：排队期间才出现的库让 chatModelId 取值规则改判", async () => {
    const world = await withChat();
    world.addChatModel("m3");
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const holder = world.put({ embedding: world.embedding });
    await gate.reached;
    const queued = world.put({ chatModelId: "m3" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    addCompileBase(world, 1);
    gate.release();
    expect((await holder).statusCode).toBe(200);
    expect(bodyOf(await queued)).toEqual(LOCKED);
  });
});
