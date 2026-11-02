/**
 * `models` 与知识库的联动（s2a-kb-ragflow tasks 8.4–8.5，#1845；design D1、D7、D20）：ragflow-backend「对话模型联动」
 * 「开编译的库锁定对话模型」的轮换一腿、「联动与设置交错」「删除与设置交错」，model-registry「知识库对话模型受保护」
 * 「校验先于下发」「删除不碰 RAGFlow」。
 *
 * 经 `PUT` / `DELETE /api/models` 与 `PUT /api/kb/settings` 这两个公开入口测，只假 RAGFlow。交错用例的次序由假 RAGFlow 的
 * 挂起后放行与设置锁的等待者计数决定：`queued` 确认写者已排在锁后，才发出下一个，不靠定时。
 * 每个用例收尾的 D7 不变量在 `kb-settings-helpers.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import type { ModelWriteGuard } from "../src/models/rest.js";
import { createModelStore } from "../src/models/store.js";
import {
  addCompileBase,
  BAD_REQUEST,
  bodyOf,
  CHAT_BASE_URL,
  CHAT_KEY,
  chatWorld,
  configuredWorld,
  firstRound,
  INSTANCES,
  KB_UNAVAILABLE,
  LEAK,
  LIST_MODELS,
  LOCKED,
  nextRound,
  PATCH_DEFAULT,
  POST_INSTANCE,
  PUT_PROVIDER,
  ROTATED_KEY,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { insertRow, MODEL_ROW } from "./kb-store-helpers.js";

const IN_USE = {
  error: { code: "kb_model_in_use", message: "该模型是知识库对话模型，先在知识库模型设置里换掉它" },
};
const MODEL_IN_USE = { error: { code: "model_in_use", message: expect.any(String) as string } };
const CHAT_MODELS = `GET ${INSTANCES}/owb-chat/models`;
const PUT_CHAT = `PUT ${INSTANCES}/owb-chat`;
const NEW_BASE_URL = "http://chat-next.upstream.test/v1";

const open = useSettingsWorlds();
const withChat = () => chatWorld(open);

async function withoutChat(): Promise<World> {
  const world = await configuredWorld(open);
  world.addChatModel("m2");
  world.forget();
  return world;
}

/** `PUT /api/models` 的整体替换 body，缺省对应 `addChatModel("m2")` 的那一行。 */
const edit = (upstream: unknown, fields: Record<string, unknown> = {}) => ({
  name: "m2",
  reasoning: false,
  vision: false,
  maxTokens: 4096,
  upstream,
  ...fields,
});
const rotation = () => edit({ baseUrl: CHAT_BASE_URL, apiKey: ROTATED_KEY });
const rename = () => edit({ baseUrl: CHAT_BASE_URL }, { name: "新名字" });

const routeOf = (world: World, id = "m2") => createModelStore(world.db).routeOf(id);
const chatInstance = (world: World) =>
  world.fake.instances().find(({ name }) => name === "owb-chat");

/** 确认恰有 `waiters` 个写者排在设置锁后。 */
async function queued(world: World, waiters: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(world.locks.settingsWaiters()).toBe(waiters);
    },
    { timeout: 500, interval: 2 },
  );
}

/** 这段请求里发给 `owb-chat` 的实例写入的 body。 */
function chatInstanceWrites(world: World): unknown[] {
  return world
    .sent()
    .filter(
      ({ method, path, json }) =>
        `${method} ${path}` === PUT_CHAT ||
        (`${method} ${path}` === POST_INSTANCE &&
          (json as { instance_name?: string } | null)?.instance_name === "owb-chat"),
    )
    .map(({ json }) => json);
}

describe("对话模型联动（ragflow-backend）", () => {
  it("规格的七步：删除与清空上游 409，下发失败不改行，恢复后带新密钥，取消指定后可删", async () => {
    const world = await withChat();
    insertRow(world.db, "models", { ...MODEL_ROW, id: "bare", name: "bare" });

    const removed = await world.models("DELETE", "m2");
    expect(removed.statusCode).toBe(409);
    expect(bodyOf(removed)).toEqual(IN_USE);

    const cleared = await world.models("PUT", "m2", edit(null));
    expect(cleared.statusCode).toBe(409);
    expect(bodyOf(cleared)).toEqual(IN_USE);
    expect(world.sent()).toEqual([]);

    world.fake.fault(PUT_PROVIDER, { kind: "status", status: 500, body: LEAK });
    const failed = await world.models("PUT", "m2", rotation());
    expect(failed.statusCode).toBe(503);
    expect(bodyOf(failed)).toEqual(KB_UNAVAILABLE);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
    expect(world.modelUpdates()).toEqual([]);
    expect(world.publishes()).toBe(0);

    world.forget();
    expect((await world.models("PUT", "m2", rotation())).statusCode).toBe(200);
    expect(routeOf(world)?.apiKey).toBe(ROTATED_KEY);
    expect(chatInstance(world)?.apiKey).toBe(ROTATED_KEY);
    expect(world.publishes()).toBe(1);

    world.forget();
    expect(bodyOf(await world.put({ chatModelId: "bare" }))).toEqual(BAD_REQUEST);
    expect(bodyOf(await world.put({ chatModelId: null }))).toMatchObject({ chatModelId: null });
    expect((await world.models("DELETE", "m2")).statusCode).toBe(204);
    expect(world.sent()).toEqual([]);
    expect(routeOf(world)).toBeUndefined();
  });

  it("下发在第 4 步失败：本地不变，重试同一次修改即收敛", async () => {
    const world = await withChat();
    world.fake.fault(PATCH_DEFAULT, { kind: "status", status: 500 });
    expect((await world.models("PUT", "m2", rotation())).statusCode).toBe(503);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
    expect(world.modelUpdates()).toEqual([]);

    world.forget();
    expect((await world.models("PUT", "m2", rotation())).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));
    expect(routeOf(world)?.apiKey).toBe(ROTATED_KEY);
  });

  it("RAGFlow 拒绝：400 kb_rejected，message 不进响应，行不变", async () => {
    const world = await withChat();
    world.fake.fault(PUT_CHAT, { kind: "combo", code: 102, message: LEAK });
    const response = await world.models("PUT", "m2", rotation());
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual({
      error: { code: "kb_rejected", message: "知识库服务拒绝了这个请求" },
    });
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
    expect(world.publishes()).toBe(0);
  });

  it("换地址保留密钥：下发新地址与已存密钥，审计 upstreamChanged 为真", async () => {
    const world = await withChat();
    const body = edit({ baseUrl: NEW_BASE_URL });
    const response = await world.models("PUT", "m2", body);
    expect(response.statusCode).toBe(200);
    expect(chatInstanceWrites(world)).toEqual([
      {
        instance_name: "owb-chat",
        api_key: CHAT_KEY,
        base_url: NEW_BASE_URL,
        model_info: [{ model_name: "m2", model_type: ["chat"], max_tokens: 4096 }],
      },
    ]);
    expect(routeOf(world)).toEqual({ baseUrl: NEW_BASE_URL, apiKey: CHAT_KEY });
    expect(world.modelUpdates()).toEqual([{ modelId: "m2", name: "m2", upstreamChanged: true }]);
    expect(response.body).not.toContain(CHAT_KEY);
  });

  it("同一次修改带了新 maxTokens：下发的 max_tokens 取修改之后的值", async () => {
    const world = await withChat();
    const body = edit({ baseUrl: CHAT_BASE_URL, apiKey: ROTATED_KEY }, { maxTokens: 2048 });
    expect((await world.models("PUT", "m2", body)).statusCode).toBe(200);
    expect(chatInstance(world)?.models).toEqual([
      { name: "m2", modelType: ["chat"], maxTokens: 2048 },
    ]);
  });

  it("纯空白密钥不发出：503，没有实例写入，RAGFlow 里的密钥与行都不变", async () => {
    const world = await withChat();
    const body = edit({ baseUrl: CHAT_BASE_URL, apiKey: "   " });
    const response = await world.models("PUT", "m2", body);
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    expect(routes(world.sent())).toEqual([PUT_PROVIDER, LIST_MODELS, CHAT_MODELS]);
    expect(chatInstance(world)?.apiKey).toBe(CHAT_KEY);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
  });

  it("带 userinfo 的行：视图地址只改名不下发；换密钥时下发已存地址", async () => {
    const world = await configuredWorld(open);
    const stored = "http://u:p@chat.upstream.test/v1";
    insertRow(world.db, "models", {
      ...MODEL_ROW,
      id: "m2",
      name: "m2",
      upstream_base_url: stored,
      upstream_api_key: CHAT_KEY,
    });
    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
    world.forget();

    expect((await world.models("PUT", "m2", rename())).statusCode).toBe(200);
    expect(world.sent()).toEqual([]);
    expect(routeOf(world)?.baseUrl).toBe(stored);

    const key = edit({ baseUrl: CHAT_BASE_URL, apiKey: "rotated-key" });
    expect((await world.models("PUT", "m2", key)).statusCode).toBe(200);
    expect(chatInstanceWrites(world)).toMatchObject([{ api_key: "rotated-key", base_url: stored }]);
    expect(routeOf(world)).toEqual({ baseUrl: stored, apiKey: "rotated-key" });
  });

  it("既是缺省又被引用的行：删除 409 kb_model_in_use（引用判定先于写入回调），行仍在", async () => {
    const world = await withChat();
    world.db.prepare("UPDATE models SET is_default = 1 WHERE id = 'm2'").run();
    expect(bodyOf(await world.models("DELETE", "m2"))).toEqual(IN_USE);
    expect(world.sent()).toEqual([]);

    expect(bodyOf(await world.put({ chatModelId: null }))).toMatchObject({ chatModelId: null });
    expect(bodyOf(await world.models("DELETE", "m2"))).toEqual(MODEL_IN_USE);
    expect(routeOf(world)).toBeDefined();
  });

  it("没有被引用的行：修改与删除照常，不碰 RAGFlow，未知 id 404", async () => {
    const world = await withChat();
    world.addChatModel("m3");
    const key = edit({ baseUrl: CHAT_BASE_URL, apiKey: ROTATED_KEY }, { name: "m3" });
    expect((await world.models("PUT", "m3", key)).statusCode).toBe(200);
    expect(routeOf(world, "m3")?.apiKey).toBe(ROTATED_KEY);
    expect((await world.models("PUT", "m3", edit(null, { name: "m3" }))).statusCode).toBe(200);
    expect((await world.models("DELETE", "m3")).statusCode).toBe(204);
    expect((await world.models("PUT", "nope", rotation())).statusCode).toBe(404);
    expect((await world.models("DELETE", "nope")).statusCode).toBe(404);
    expect(world.sent()).toEqual([]);
  });
});

describe("开编译的库锁定对话模型：轮换一腿（ragflow-backend）", () => {
  it("取消与换模型 409，同 id 照常，换密钥下发；删掉库之后取消指定不发请求", async () => {
    const world = await withChat();
    world.addChatModel("m3");
    addCompileBase(world, 1);

    expect(bodyOf(await world.put({ chatModelId: null }))).toEqual(LOCKED);
    expect(bodyOf(await world.put({ chatModelId: "m3" }))).toEqual(LOCKED);
    expect(world.sent()).toEqual([]);
    expect((await world.put({ chatModelId: "m2" })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));

    world.forget();
    expect((await world.models("PUT", "m2", rotation())).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));
    expect(chatInstance(world)?.apiKey).toBe(ROTATED_KEY);

    world.forget();
    world.db.prepare("DELETE FROM knowledge_bases").run();
    expect(bodyOf(await world.put({ chatModelId: null }))).toMatchObject({ chatModelId: null });
    expect(world.sent()).toEqual([]);
  });
});

describe("知识库对话模型受保护（model-registry）", () => {
  it("只改 name 不下发", async () => {
    const world = await withChat();
    const response = await world.models("PUT", "m2", rename());
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({ name: "新名字" });
    expect(world.sent()).toEqual([]);
    expect(world.modelUpdates()).toEqual([
      { modelId: "m2", name: "新名字", upstreamChanged: false },
    ]);
  });

  it("换密钥：本地写入之前恰一轮 owb-chat 的下发，实例拿到新密钥", async () => {
    const world = await withChat();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const pending = world.models("PUT", "m2", rotation());
    await gate.reached;
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
    expect(world.modelUpdates()).toEqual([]);

    gate.release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-chat"));
    expect(chatInstanceWrites(world)).toMatchObject([{ api_key: ROTATED_KEY }]);
    expect(routeOf(world)?.apiKey).toBe(ROTATED_KEY);
    expect(world.modelUpdates()).toEqual([{ modelId: "m2", name: "m2", upstreamChanged: true }]);
    expect(response.body).not.toContain(ROTATED_KEY);
  });
});

describe("校验先于下发（model-registry）", () => {
  it.each([
    ["maxTokens 非法", edit({ baseUrl: CHAT_BASE_URL, apiKey: ROTATED_KEY }, { maxTokens: 0 })],
    ["地址协议非法", edit({ baseUrl: "ftp://x", apiKey: ROTATED_KEY })],
    ["密钥含换行", edit({ baseUrl: CHAT_BASE_URL, apiKey: "bad\nkey" })],
    ["清空上游的 body 同样先校验", edit(null, { maxTokens: 0 })],
  ])("%s：400，假 RAGFlow 收到零个请求，行不变，没有审计", async (_name, body) => {
    const world = await withChat();
    const before = createModelStore(world.db).get("m2");
    const response = await world.models("PUT", "m2", body);
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    expect(world.sent()).toEqual([]);
    expect(createModelStore(world.db).get("m2")).toEqual(before);
    expect(world.modelUpdates()).toEqual([]);
  });
});

describe("删除不碰 RAGFlow（model-registry）", () => {
  it("已取消指定，账号缺省仍指向 m2：204，零个请求", async () => {
    const world = await withChat();
    expect((await world.put({ chatModelId: null })).statusCode).toBe(200);
    world.forget();
    expect((await world.models("DELETE", "m2")).statusCode).toBe(204);
    expect(world.sent()).toEqual([]);
    expect(world.fake.defaultModels()).toContainEqual({
      modelType: "chat",
      instance: "owb-chat",
      name: "m2",
    });
  });
});

describe("联动与设置交错（ragflow-backend，design D20）", () => {
  it("A 先持锁：B 在 A 写库之后才判定，判定已被引用，写库前重新下发新密钥", async () => {
    const world = await withoutChat();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const assign = world.put({ chatModelId: "m2" });
    await gate.reached;
    const change = world.models("PUT", "m2", rotation());
    await queued(world, 1);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
    expect(world.store.settings().chatModelId).toBeNull();

    gate.release();
    expect((await assign).statusCode).toBe(200);
    expect((await change).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...firstRound(), ...nextRound("owb-chat")]);
    expect(chatInstanceWrites(world)).toMatchObject([
      { api_key: CHAT_KEY },
      { api_key: ROTATED_KEY },
    ]);
    expect(chatInstance(world)?.apiKey).toBe(ROTATED_KEY);
    expect(routeOf(world)?.apiKey).toBe(ROTATED_KEY);
  });

  it("C 持锁，B、A 依次排队：B 判定未被引用不下发，A 取锁后读到新密钥", async () => {
    const world = await withoutChat();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const holder = world.put({ embedding: world.embedding });
    await gate.reached;
    const change = world.models("PUT", "m2", rotation());
    await queued(world, 1);
    const assign = world.put({ chatModelId: "m2" });
    await queued(world, 2);

    gate.release();
    expect((await holder).statusCode).toBe(200);
    expect((await change).statusCode).toBe(200);
    expect((await assign).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...nextRound("owb-embed"), ...firstRound()]);
    expect(chatInstanceWrites(world)).toMatchObject([{ api_key: ROTATED_KEY }]);
    expect(routeOf(world)?.apiKey).toBe(ROTATED_KEY);
  });

  it("同一行的两次修改串行：最后的下发与最后的写入是同一个密钥", async () => {
    const world = await withChat();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const first = world.models("PUT", "m2", edit({ baseUrl: CHAT_BASE_URL, apiKey: "first-key" }));
    await gate.reached;
    const second = world.models("PUT", "m2", rotation());
    await queued(world, 1);

    gate.release();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual([...nextRound("owb-chat"), ...nextRound("owb-chat")]);
    expect(chatInstance(world)?.apiKey).toBe(ROTATED_KEY);
    expect(routeOf(world)?.apiKey).toBe(ROTATED_KEY);
  });

  it("修改的下发失败之后锁放行：排队的写者照常执行", async () => {
    const world = await withChat();
    const gate = world.fake.fault(PUT_PROVIDER, { kind: "hold" });
    world.fake.fault(LIST_MODELS, { kind: "status", status: 500 });
    const change = world.models("PUT", "m2", rotation());
    await gate.reached;
    const remove = world.models("DELETE", "m2");
    await queued(world, 1);

    gate.release();
    expect((await change).statusCode).toBe(503);
    expect(bodyOf(await remove)).toEqual(IN_USE);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
  });
});

describe("删除与设置交错（ragflow-backend，design D20）", () => {
  it("C 持锁，B 删除、A 指定依次排队：B 204，A 400，没有 m2 的下发", async () => {
    const world = await withoutChat();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const holder = world.put({ embedding: world.embedding });
    await gate.reached;
    const remove = world.models("DELETE", "m2");
    await queued(world, 1);
    const assign = world.put({ chatModelId: "m2" });
    await queued(world, 2);

    gate.release();
    expect((await holder).statusCode).toBe(200);
    expect((await remove).statusCode).toBe(204);
    expect(bodyOf(await assign)).toEqual(BAD_REQUEST);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(world.store.settings().chatModelId).toBeNull();
  });

  it("A 先持锁：下发在途时的删除排在锁后，A 200，B 409，行仍在（不再撞外键）", async () => {
    const world = await withoutChat();
    const gate = world.fake.fault(PATCH_DEFAULT, { kind: "hold" });
    const assign = world.put({ chatModelId: "m2" });
    await gate.reached;
    const remove = world.models("DELETE", "m2");
    await queued(world, 1);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);

    gate.release();
    expect((await assign).statusCode).toBe(200);
    const removed = await remove;
    expect(removed.statusCode).toBe(409);
    expect(bodyOf(removed)).toEqual(IN_USE);
    expect(routeOf(world)?.apiKey).toBe(CHAT_KEY);
    expect(world.store.settings().chatModelId).toBe("m2");
  });
});

describe("知识库关闭时联动不生效", () => {
  it("被引用的行照常修改与删除，经外键置空，不发 RAGFlow 请求", async () => {
    const world = await open({ kbDisabled: true });
    world.addChatModel("m3");
    world.store.saveSettings({ chatModelId: "m3" });

    const body = edit({ baseUrl: CHAT_BASE_URL, apiKey: ROTATED_KEY }, { name: "m3" });
    expect((await world.models("PUT", "m3", body)).statusCode).toBe(200);
    expect(routeOf(world, "m3")?.apiKey).toBe(ROTATED_KEY);
    expect((await world.models("PUT", "m3", edit(null, { name: "m3" }))).statusCode).toBe(200);
    expect((await world.models("DELETE", "m3")).statusCode).toBe(204);
    expect(world.store.settings().chatModelId).toBeNull();
    expect(world.fake.requests()).toEqual([]);
  });
});

describe("modelWriteGuard 的接缝", () => {
  it("装配注入的钩子包住写入：PUT 先拿 plan 再写，DELETE 没有 plan，钩子拒绝时不写", async () => {
    const calls: unknown[] = [];
    let refuse = false;
    const guard: ModelWriteGuard = (id, write, plan) => {
      const planned = plan?.();
      calls.push([id, planned?.changed]);
      if (refuse) {
        return Promise.reject(new Error("refused"));
      }
      const written = write();
      calls.push("written");
      return Promise.resolve(written);
    };
    const world = await open({ kbDisabled: true, modelWriteGuard: guard });
    world.addChatModel("m3");

    const body = edit({ baseUrl: CHAT_BASE_URL, apiKey: ROTATED_KEY }, { name: "m3" });
    expect((await world.models("PUT", "m3", body)).statusCode).toBe(200);
    expect((await world.models("DELETE", "m3")).statusCode).toBe(204);
    expect(calls).toEqual([["m3", true], "written", ["m3", undefined], "written"]);
    expect(world.publishes()).toBe(2);

    refuse = true;
    world.addChatModel("m4");
    expect((await world.models("DELETE", "m4")).statusCode).toBe(500);
    expect(routeOf(world, "m4")?.apiKey).toBe(CHAT_KEY);
    expect(world.publishes()).toBe(2);
  });
});

describe("planUpdate（models/store）", () => {
  const seeded = () => {
    const db = openDb(":memory:");
    const row = { ...MODEL_ROW, id: "m2", name: "m2" };
    insertRow(db, "models", {
      ...row,
      upstream_base_url: "https://u:p@host.example/v1",
      upstream_api_key: "stored-key",
    });
    insertRow(db, "models", { ...row, id: "bare", name: "bare" });
    return { db, store: createModelStore(db) };
  };
  const put = (upstream: unknown) => edit(upstream, { maxTokens: 2048 });

  it.each([
    [
      "视图地址、不带密钥：沿用已存地址与密钥，没有变化",
      "m2",
      { baseUrl: "https://host.example/v1" },
      { baseUrl: "https://u:p@host.example/v1", apiKey: "stored-key" },
      false,
    ],
    [
      "视图地址、带密钥：只换密钥，算变化",
      "m2",
      { baseUrl: "https://host.example/v1", apiKey: "new-key" },
      { baseUrl: "https://u:p@host.example/v1", apiKey: "new-key" },
      true,
    ],
    [
      "换地址、不带密钥：密钥沿用，算变化",
      "m2",
      { baseUrl: "https://next.example/v1" },
      { baseUrl: "https://next.example/v1", apiKey: "stored-key" },
      true,
    ],
    ["清空上游：算变化", "m2", null, null, true],
    ["没有上游的行再置 null：没有变化", "bare", null, null, false],
    [
      "没有上游的行配上游：算变化",
      "bare",
      { baseUrl: "https://next.example/v1", apiKey: "new-key" },
      { baseUrl: "https://next.example/v1", apiKey: "new-key" },
      true,
    ],
  ])("%s", (_name, id, upstream, next, changed) => {
    const { db, store } = seeded();
    const before = store.list();
    expect(store.planUpdate(id, put(upstream))).toMatchObject({
      model: { maxTokens: 2048 },
      next,
      changed,
    });
    expect(store.list()).toEqual(before);
    db.close();
  });

  it("次序同 update：body 非法 400 先于未知 id 404；不写库", () => {
    const { db, store } = seeded();
    expect(() => store.planUpdate("nope", { name: "x" })).toThrowError(
      expect.objectContaining({ code: "bad_request" }) as Error,
    );
    expect(() => store.planUpdate("nope", put(null))).toThrowError(
      expect.objectContaining({ code: "not_found" }) as Error,
    );
    expect(() => store.planUpdate("bare", put({ baseUrl: "https://x/v1" }))).toThrowError(
      expect.objectContaining({ code: "bad_request" }) as Error,
    );
    db.close();
  });
});
