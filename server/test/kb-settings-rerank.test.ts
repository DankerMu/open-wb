/**
 * s2b-kb-retrieval tasks 6.1（#1917）：重排模型的设置（ragflow-backend「知识库模型设置」的重排各场景，knowledge-bases
 * 「知识库审计」的 `kb.settings` 行与「detail 不含敏感内容」，design D6）。期望值是 spec 的字面量、tasks.md「组 6 首刀约定」
 * 与实测记录 §11.1、§19.3 的请求形状。重排探活（`?target=rerank`，#1919）在 `kb-settings-rerank-probe.test.ts`。
 */
import { describe, expect, it } from "vitest";
import {
  addCompileBase,
  BAD_REQUEST,
  bodyOf,
  chatWorld,
  configuredWorld,
  EMBED_KEY,
  FORBIDDEN,
  INSTANCES,
  KB_UNAVAILABLE,
  LOCKED,
  nextRound,
  PATCH_DEFAULT,
  PROVIDER,
  RERANK_KEY,
  rerankFirstRound,
  rerankNextRound,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { createPlainBase, hex } from "./kb-store-helpers.js";

const open = useSettingsWorlds();

const RERANK_BASE_URL = "http://rerank.upstream.test/v1";
const QWEN = { name: "qwen3-rerank", baseUrl: RERANK_BASE_URL, apiKey: RERANK_KEY };
const ROTATED_RERANK_KEY = "rerank-key-rotated-rerank";
const NEVER = { status: "never", at: null, message: null };
const SEEDED_AT = 1_760_000_000_000;
const OK = { status: "ok", at: SEEDED_AT, message: null };
const info = (name: string) => ({ model_name: name, model_type: ["rerank"], max_tokens: 8192 });

/** 已配置 `qwen3-rerank`、请求记录已清零。 */
async function withRerank(world: World): Promise<World> {
  expect((await world.put({ rerank: QWEN })).statusCode).toBe(200);
  world.forget();
  return world;
}

/** 直接种重排探活 `ok`，不经探活端点；身份必须与已存的一致，否则不写回。 */
function seedRerankOk(world: World): void {
  const { recorded } = world.store.recordRerankProbe(QWEN, {
    status: "ok",
    at: SEEDED_AT,
    message: null,
  });
  expect(recorded).toBe(true);
}

const rerankOf = (response: { body: string }) => (bodyOf(response) as { rerank: unknown }).rerank;

const countAudits = (world: World, kind: string) =>
  Number(
    world.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?").get(kind)?.n ?? 0,
  );

describe("重排模型的下发序列（§11.1、§19.3）", () => {
  it("首次 POST owb-rerank；换模型省略 apiKey 时读模型列表再 PUT；两次都没有 PATCH /models/default", async () => {
    const world = await open();
    const first = await world.put({ rerank: QWEN });
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain(RERANK_KEY);
    expect(world.sent().map(({ method, path, json }) => ({ method, path, json }))).toEqual([
      { method: "PUT", path: "/api/v1/providers", json: { provider_name: PROVIDER } },
      { method: "GET", path: "/api/v1/models", json: null },
      {
        method: "POST",
        path: INSTANCES,
        json: {
          instance_name: "owb-rerank",
          api_key: RERANK_KEY,
          base_url: RERANK_BASE_URL,
          model_info: [info("qwen3-rerank")],
        },
      },
    ]);

    world.forget();
    const second = await world.put({ rerank: { name: "bge-reranker", baseUrl: RERANK_BASE_URL } });
    expect(second.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(rerankNextRound);
    expect(world.sent()[3]?.json).toEqual({
      instance_name: "owb-rerank",
      api_key: RERANK_KEY,
      base_url: RERANK_BASE_URL,
      model_info: [info("qwen3-rerank"), info("bge-reranker")],
    });
    expect(routes(world.fake.requests())).not.toContain(PATCH_DEFAULT);
    expect(world.fake.defaultModels()).toEqual([]);
    expect(rerankOf(await world.get())).toEqual({
      name: "bge-reranker",
      baseUrl: RERANK_BASE_URL,
      probe: NEVER,
    });
    expect(world.audits().map(({ detail }) => detail)).toEqual([
      { rerank: "qwen3-rerank" },
      { rerank: "bge-reranker" },
    ]);
  });

  it("换重排模型不重建：已有两个库，不带 confirmRebuild 也 200，没有库进入 rebuilding，没有 kb.rebuild", async () => {
    const world = await configuredWorld(open);
    createPlainBase(world.store, hex(1));
    createPlainBase(world.store, hex(2));
    expect((await world.put({ rerank: QWEN })).statusCode).toBe(200);
    expect((await world.put({ rerank: { ...QWEN, name: "bge-reranker" } })).statusCode).toBe(200);
    expect(world.store.countBasesInState("rebuilding")).toBe(0);
    expect(world.store.countBasesInState("ready")).toBe(2);
    expect(countAudits(world, "kb.rebuild")).toBe(0);
    expect(world.store.settings().embeddingGeneration).toBe(0);
  });
});

describe("清除重排模型", () => {
  it("null 只改本地：零个请求，一条审计 {rerank:null}；再设 null 是无操作", async () => {
    const world = await withRerank(await open());
    const audits = world.audits().length;
    const cleared = await world.put({ rerank: null });
    expect(cleared.statusCode).toBe(200);
    expect(rerankOf(cleared)).toBeNull();
    expect(world.sent()).toEqual([]);
    expect(world.audits().slice(audits)).toEqual([{ actorId: "u3", detail: { rerank: null } }]);
    expect(world.store.rerankApiKey()).toBeNull();

    const before = world.store.settings().updatedAt;
    const again = await world.put({ rerank: null });
    expect(again.statusCode).toBe(200);
    expect(rerankOf(again)).toBeNull();
    expect(world.sent()).toEqual([]);
    expect(world.audits()).toHaveLength(audits + 1);
    expect(world.store.settings().updatedAt).toBe(before);
  });
});

describe("重排模型的密钥与名称", () => {
  it("首次省略 apiKey、名称含 @、已配置时 apiKey 为空串：都 400，零个请求，设置不变", async () => {
    const world = await open();
    const { apiKey: _key, ...kept } = QWEN;
    for (const body of [{ rerank: kept }, { rerank: { ...QWEN, name: "a@b" } }]) {
      const response = await world.put(body);
      expect(response.statusCode).toBe(400);
      expect(bodyOf(response)).toEqual(BAD_REQUEST);
    }
    expect(world.store.settings().rerank).toBeNull();

    await withRerank(world);
    const audits = world.audits();
    const response = await world.put({ rerank: { ...QWEN, apiKey: "" } });
    expect(response.statusCode).toBe(400);
    expect(world.sent()).toEqual([]);
    expect(world.store.rerankApiKey()).toBe(RERANK_KEY);
    expect(world.audits()).toEqual(audits);
  });
});

describe("重排模型下发失败", () => {
  it("owb-rerank 的实例 PUT 503：本地仍为 qwen3-rerank、探活仍为 ok，没有审计", async () => {
    const world = await withRerank(await open());
    seedRerankOk(world);
    const audits = world.audits();
    world.fake.fault(`PUT ${INSTANCES}/owb-rerank`, { kind: "status", status: 503 });
    const response = await world.put({ rerank: { ...QWEN, name: "bge-reranker" } });
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    expect(rerankOf(await world.get())).toEqual({
      name: "qwen3-rerank",
      baseUrl: RERANK_BASE_URL,
      probe: OK,
    });
    expect(world.audits()).toEqual(audits);
  });

  it("组合保存时重排失败：只有 owb-rerank 一轮，没有 owb-embed 与 PATCH，本地不变，不重建，没有审计", async () => {
    const world = await configuredWorld(open);
    createPlainBase(world.store, hex(1));
    createPlainBase(world.store, hex(2));
    const audits = world.audits();
    world.fake.fault(`POST ${INSTANCES}`, { kind: "status", status: 503 });
    const { apiKey: _key, ...kept } = world.embedding;
    const body = {
      embedding: { ...kept, name: "text-embedding-3-small" },
      rerank: QWEN,
      confirmRebuild: true,
    };
    const response = await world.put(body);
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    expect(routes(world.sent())).toEqual(rerankFirstRound);
    expect(world.sent()[2]?.json).toMatchObject({ instance_name: "owb-rerank" });
    expect(world.store.settings()).toMatchObject({
      embedding: { name: "bge-m3" },
      rerank: null,
      embeddingGeneration: 0,
    });
    expect(world.store.countBasesInState("rebuilding")).toBe(0);
    expect(world.audits()).toEqual(audits);
    expect(countAudits(world, "kb.rebuild")).toBe(0);
  });
});

describe("保存流程（tasks.md「组 6 首刀约定」）", () => {
  it("无操作要三条同时成立：对话模型为 null 时 {rerank, chatModelId:null} 照常下发 owb-rerank 并写库", async () => {
    const world = await configuredWorld(open);
    const response = await world.put({ rerank: QWEN, chatModelId: null });
    expect(response.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(rerankFirstRound);
    expect(world.store.settings().rerank).toEqual({
      name: "qwen3-rerank",
      baseUrl: RERANK_BASE_URL,
    });
    expect(world.audits().at(-1)).toEqual({ actorId: "u3", detail: { rerank: "qwen3-rerank" } });
  });

  it("不含 chatModelId 时不重发对话模型：{rerank} 只有 owb-rerank 一轮，{rerank:null} 零个请求", async () => {
    const world = await chatWorld(open);
    expect((await world.put({ rerank: QWEN })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(rerankFirstRound);
    expect(JSON.stringify(world.sent())).not.toContain("owb-chat");

    world.forget();
    expect((await world.put({ rerank: null })).statusCode).toBe(200);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings().chatModelId).toBe("m2");
  });

  it("反方向：已配重排模型时只含 embedding 或 chatModelId 的保存不发 owb-rerank，序列与审计同既有", async () => {
    const world = await withRerank(await chatWorld(open));
    seedRerankOk(world);
    const { apiKey: _key, ...kept } = world.embedding;
    const audits = world.audits().length;

    const embedded = await world.put({ embedding: kept });
    expect(embedded.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...nextRound("owb-embed"), ...nextRound("owb-chat")]);

    world.forget();
    const chatted = await world.put({ chatModelId: "m2" });
    expect(chatted.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));

    expect(world.audits().slice(audits)).toEqual([
      { actorId: "u3", detail: {} },
      { actorId: "u3", detail: {} },
    ]);
    const expected = { name: "qwen3-rerank", baseUrl: RERANK_BASE_URL, probe: OK };
    expect([embedded, chatted].map(rerankOf)).toEqual([expected, expected]);
    expect(world.store.rerankApiKey()).toBe(RERANK_KEY);
  });

  it("同一身份重存照常下发、保留探活、detail 为空；只换密钥或地址探活回到 never，detail 为名称", async () => {
    const world = await withRerank(await open());
    seedRerankOk(world);
    const audits = world.audits().length;

    const same = await world.put({ rerank: QWEN });
    expect(same.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(rerankNextRound);
    expect(rerankOf(same)).toMatchObject({ probe: OK });
    expect(world.audits().slice(audits)).toEqual([{ actorId: "u3", detail: {} }]);

    world.forget();
    const rotated = await world.put({ rerank: { ...QWEN, apiKey: ROTATED_RERANK_KEY } });
    expect(rotated.statusCode).toBe(200);
    expect(world.sent()[3]?.json).toMatchObject({ api_key: ROTATED_RERANK_KEY });
    expect(rerankOf(rotated)).toMatchObject({ probe: NEVER });
    expect(world.audits().at(-1)?.detail).toEqual({ rerank: "qwen3-rerank" });
    expect(world.store.rerankApiKey()).toBe(ROTATED_RERANK_KEY);

    const moved = `${RERANK_BASE_URL}/moved`;
    const relocated = await world.put({ rerank: { name: "qwen3-rerank", baseUrl: moved } });
    expect(rerankOf(relocated)).toEqual({ name: "qwen3-rerank", baseUrl: moved, probe: NEVER });
    expect(world.audits().at(-1)?.detail).toEqual({ rerank: "qwen3-rerank" });
  });

  it("组合保存成功：重排一轮 → owb-embed 一轮 → owb-chat 一轮，detail 同时含 embedding 与 rerank", async () => {
    const world = await chatWorld(open);
    const { apiKey: _key, ...kept } = world.embedding;
    const body = { embedding: { ...kept, name: "bge-large" }, rerank: QWEN };
    expect((await world.put(body)).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([
      ...rerankFirstRound,
      ...nextRound("owb-embed"),
      ...nextRound("owb-chat"),
    ]);
    expect(world.audits().at(-1)?.detail).toEqual({
      embedding: "bge-large",
      rerank: "qwen3-rerank",
    });
  });

  it("首次配置不带 apiKey：400 先于 kb_chat_model_locked，零个请求", async () => {
    const world = await chatWorld(open);
    addCompileBase(world, 1);
    const response = await world.put({
      rerank: { name: "qwen3-rerank", baseUrl: RERANK_BASE_URL },
      chatModelId: null,
    });
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings()).toMatchObject({ rerank: null, chatModelId: "m2" });
  });

  it("已配对话模型且有开编译的库：{rerank, chatModelId:<另一个>} 409 kb_chat_model_locked，零个请求", async () => {
    const world = await chatWorld(open);
    addCompileBase(world, 1);
    world.addChatModel("m3");
    const audits = world.audits();
    const response = await world.put({ rerank: QWEN, chatModelId: "m3" });
    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual(LOCKED);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings()).toMatchObject({ rerank: null, chatModelId: "m2" });
    expect(world.audits()).toEqual(audits);
  });

  it("已配重排模型时 {embedding, rerank:null}：只有 owb-embed、owb-chat 两轮，没有 owb-rerank，detail 含 rerank:null", async () => {
    const world = await withRerank(await chatWorld(open));
    const { apiKey: _key, ...kept } = world.embedding;
    const response = await world.put({ embedding: kept, rerank: null });
    expect(response.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...nextRound("owb-embed"), ...nextRound("owb-chat")]);
    expect(JSON.stringify(world.sent())).not.toContain("owb-rerank");
    expect(rerankOf(response)).toBeNull();
    expect(world.audits().at(-1)).toEqual({ actorId: "u3", detail: { rerank: null } });
  });

  it("普通用户：403 forbidden，零个请求，设置不变", async () => {
    const world = await open();
    const response = await world.put({ rerank: QWEN }, "member");
    expect(response.statusCode).toBe(403);
    expect(bodyOf(response)).toEqual(FORBIDDEN);
    expect(world.fake.requests()).toEqual([]);
    expect(world.store.settings().rerank).toBeNull();
    expect(world.audits()).toEqual([]);
  });
});

describe("body 校验（与嵌入模型同一规则）", () => {
  it.each<[string, unknown]>([
    ["只有 confirmRebuild", { confirmRebuild: true }],
    ["rerank 不是对象", { rerank: "qwen3-rerank" }],
    ["rerank 是数组", { rerank: [QWEN] }],
    ["rerank 有未知键", { rerank: { ...QWEN, extra: 1 } }],
    ["rerank 缺 name", { rerank: { baseUrl: RERANK_BASE_URL, apiKey: RERANK_KEY } }],
    ["rerank 缺 baseUrl", { rerank: { name: "qwen3-rerank", apiKey: RERANK_KEY } }],
    ["名称为空", { rerank: { ...QWEN, name: "" } }],
    ["名称不是字符串", { rerank: { ...QWEN, name: 1 } }],
    ["名称 129 字节", { rerank: { ...QWEN, name: "a".repeat(129) } }],
    ["名称含控制字符", { rerank: { ...QWEN, name: "a\nb" } }],
    ["名称含 @", { rerank: { ...QWEN, name: "a@b" } }],
    ["地址不是 http(s)", { rerank: { ...QWEN, baseUrl: "ftp://rerank.test" } }],
    ["地址带 userinfo", { rerank: { ...QWEN, baseUrl: "http://u:p@rerank.test" } }],
    ["密钥为空串", { rerank: { ...QWEN, apiKey: "" } }],
    ["密钥纯空白", { rerank: { ...QWEN, apiKey: "   " } }],
    ["密钥只有 U+0085", { rerank: { ...QWEN, apiKey: "\u0085" } }],
    ["密钥含换行", { rerank: { ...QWEN, apiKey: "a\nb" } }],
    ["密钥不是字符串", { rerank: { ...QWEN, apiKey: 1 } }],
  ])("%s：400，零个请求，设置不变", async (_label, body) => {
    const world = await open();
    const response = await world.put(body);
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.fake.requests()).toEqual([]);
    expect(world.audits()).toEqual([]);
    expect(world.store.settings().rerank).toBeNull();
  });

  it("名称恰 128 字节：接受", async () => {
    const world = await open();
    const name = `${"模".repeat(42)}aa`;
    expect(Buffer.byteLength(name)).toBe(128);
    expect((await world.put({ rerank: { ...QWEN, name } })).statusCode).toBe(200);
    expect(world.store.settings().rerank?.name).toBe(name);
  });

  it("{rerank:null} 单独出现合法：未配置时是无操作，200，零个请求，没有审计", async () => {
    const world = await open();
    const response = await world.put({ rerank: null });
    expect(response.statusCode).toBe(200);
    expect(rerankOf(response)).toBeNull();
    expect(world.fake.requests()).toEqual([]);
    expect(world.audits()).toEqual([]);
  });
});

describe("读视图", () => {
  it("恰八键；rerank 为 {name, baseUrl, probe}，probe 取自重排探活；不带 rerankProbe 与密钥", async () => {
    const world = await withRerank(await configuredWorld(open));
    seedRerankOk(world);
    const response = await world.get();
    const view = bodyOf(response) as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(
      [
        "embedding",
        "chatModelId",
        "rerank",
        "bases",
        "compileBases",
        "documents",
        "rebuilding",
        "rebuildFailed",
      ].sort(),
    );
    expect(view.rerank).toEqual({ name: "qwen3-rerank", baseUrl: RERANK_BASE_URL, probe: OK });
    expect(view.embedding).toMatchObject({ probe: NEVER });
    expect(response.body).not.toContain(RERANK_KEY);
    expect(response.body).not.toContain("rerankProbe");
  });
});

describe("审计 detail 不含敏感内容（knowledge-bases「知识库审计」）", () => {
  it("带两个密钥哨兵保存 embedding 与 rerank：detail 为两个名称，审计与日志都不含哨兵", async () => {
    const world = await open();
    const response = await world.put({ embedding: world.embedding, rerank: QWEN });
    expect(response.statusCode).toBe(200);
    expect(world.audits()).toEqual([
      { actorId: "u3", detail: { embedding: "bge-m3", rerank: "qwen3-rerank" } },
    ]);
    const stored = JSON.stringify(world.db.prepare("SELECT title, detail FROM audit_events").all());
    for (const secret of [EMBED_KEY, RERANK_KEY]) {
      expect(stored).not.toContain(secret);
      expect(response.body).not.toContain(secret);
      expect(JSON.stringify(world.logged)).not.toContain(secret);
    }
  });
});
