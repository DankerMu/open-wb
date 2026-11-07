/**
 * s2a-kb-ragflow tasks 14.2（#1852）：嵌入模型更换与全量重建（ragflow-backend「嵌入模型更换与全量重建」，knowledge-bases「知识库
 * 审计」的 `kb.rebuild`，design D7、D8、D9、D20）。`createApp` + `app.inject()`，真实 SQLite，假 RAGFlow；重建器经注入的调度缝
 * 同步驱动（`world.rebuild()`）：确认与重试只排一轮，用例跑完它再断言。失败与续做的边界情形在 `kb-rebuild-failures.test.ts`，与在途
 * 写操作的交错在 `kb-rebuild-writers.test.ts`。期望值是 spec 与实测记录的字面量。
 */
import { describe, expect, it } from "vitest";
import { resourceName } from "../src/kb/pipeline.js";
import {
  auditsOf,
  createdBase,
  createdCompileBase,
  DELETE_DATASETS,
  datasetIdOf,
  deleteCanvasRoute,
  deleteGroupRoute,
  GET_BUILTINS,
  GET_DEFAULTS,
  POST_AGENTS,
  POST_DATASETS,
  POST_GROUPS,
  pipelineRoute,
  REBUILDING,
} from "./kb-bases-helpers.js";
import {
  ADMIN,
  baseOf,
  confirm,
  expectRebuilt,
  NEW_MODEL,
  NEW_NAME,
  NOT_FOUND_BODY,
  plainRebuildOf,
  REBUILD_FAILED,
  rebuildAudits,
  seedDocument,
  seedMissingDocument,
  transferOf,
} from "./kb-rebuild-helpers.js";
import {
  BAD_REQUEST,
  bodyOf,
  chatWorld,
  configuredWorld,
  FORBIDDEN,
  LOCKED,
  nextRound,
  routes,
  useSettingsWorlds,
} from "./kb-settings-helpers.js";
import { UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";

const open = useSettingsWorlds();

const REBUILD_REQUIRED = {
  error: { code: "kb_rebuild_required", message: "更换嵌入模型需要重建全部知识库，请确认后再保存" },
};
const RETRY_ROUTE = "/api/kb/settings/rebuild";

describe("确认开关", () => {
  it("未确认不保存：已有知识库时换名称 409 kb_rebuild_required，设置不变，没有下发", async () => {
    const world = await configuredWorld(open);
    await createdBase(world, "甲");
    world.forget();
    const response = await world.put({ embedding: { ...world.embedding, name: NEW_NAME } });
    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual(REBUILD_REQUIRED);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings()).toMatchObject({
      embedding: { name: "bge-m3" },
      embeddingGeneration: 0,
      rebuildActorId: null,
    });
    expect(auditsOf(world, "kb.rebuild")).toEqual([]);
  });

  it("确认那次保存：照常下发，代数加一，全部库置 rebuilding，记下发起者，恰写 kb.settings 与 kb.rebuild 两条", async () => {
    const world = await configuredWorld(open);
    const first = await createdBase(world, "甲");
    const second = await createdBase(world, "乙");
    seedDocument(world, first.id, "a.md", "alpha");
    const settingsBefore = auditsOf(world, "kb.settings").length;
    world.forget();

    const response = await confirm(world);
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toMatchObject({
      embedding: { name: NEW_NAME, probe: { status: "never" } },
      bases: 2,
      documents: 1,
      rebuilding: 2,
      rebuildFailed: 0,
    });
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(world.store.settings()).toMatchObject({ embeddingGeneration: 1, rebuildActorId: ADMIN });
    expect([first.id, second.id].map((id) => baseOf(world, id).state)).toEqual([
      "rebuilding",
      "rebuilding",
    ]);
    const saved = auditsOf(world, "kb.settings").slice(settingsBefore);
    expect(saved.map(({ actorId, detail }) => ({ actorId, detail }))).toEqual([
      { actorId: ADMIN, detail: { embedding: NEW_NAME } },
    ]);
    expect(rebuildAudits(world)).toEqual([{ actorId: ADMIN, detail: { bases: 2, documents: 1 } }]);
  });

  it("下发失败：本地不变，没有 kb.rebuild，库仍 ready，重建器什么也不做", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    world.fake.fault("PUT /api/v1/providers", { kind: "status", status: 503 });
    expect((await confirm(world)).statusCode).toBe(503);
    world.forget();
    await world.rebuild();
    expect(world.sent()).toEqual([]);
    expect(baseOf(world, base.id).state).toBe("ready");
    expect(world.store.settings()).toMatchObject({ embeddingGeneration: 0, rebuildActorId: null });
    expect(rebuildAudits(world)).toEqual([]);
  });
});

describe("重建器", () => {
  it("确认后重建：两个库共三份文档，逐库建新数据集、转移原件、删旧数据集；actor 都是发起的管理员", async () => {
    const world = await configuredWorld(open);
    const first = await createdBase(world, "甲");
    const second = await createdBase(world, "乙");
    seedDocument(world, first.id, "a1.md", "alpha-1");
    seedDocument(world, first.id, "a2.md", "alpha-22");
    seedDocument(world, second.id, "b1.md", "beta");
    expect((await confirm(world)).statusCode).toBe(200);
    const order = world.store.listBasesInState("rebuilding").map(({ id }) => id);
    const before = order.map((id) => ({
      id,
      dataset: datasetIdOf(world, id),
      documents: world.store.listDocuments(id),
    }));
    world.forget();

    await world.rebuild();

    const expected = before.flatMap(({ id, dataset, documents }) =>
      plainRebuildOf(dataset, datasetIdOf(world, id), documents),
    );
    expect(routes(world.sent())).toEqual(expected);
    const created = world
      .sent()
      .filter((entry) => `${entry.method} ${entry.path}` === POST_DATASETS);
    expect(created.map(({ json }) => json)).toEqual(
      order.map((id) => ({
        name: resourceName(id, 1),
        parser_id: "general",
        parse_type: 1,
        embedding_model: NEW_MODEL,
      })),
    );
    const deleted = world
      .sent()
      .filter((entry) => `${entry.method} ${entry.path}` === DELETE_DATASETS);
    expect(deleted.map(({ json }) => json)).toEqual(
      before.map(({ dataset }) => ({ ids: [dataset] })),
    );
    for (const { id, dataset } of before) {
      expectRebuilt(world, id);
      const next = datasetIdOf(world, id);
      expect(next).not.toBe(dataset);
      const inNew = world.fake.documents(next).map((document) => document.id);
      expect(
        world.store
          .listDocuments(id)
          .map((row) => row.ragflowDocumentId)
          .sort(),
      ).toEqual(inNew.sort());
    }
    expect(world.fake.datasets().map(({ id }) => id)).toEqual(
      order.map((id) => datasetIdOf(world, id)),
    );
    expect(rebuildAudits(world)).toEqual([
      { actorId: ADMIN, detail: { bases: 2, documents: 3 } },
      ...order.map((id) => ({ actorId: ADMIN, detail: { id, result: "ok", skipped: [] } })),
    ]);
    expect(auditsOf(world, "kb.settings").at(-1)).toMatchObject({
      actorId: ADMIN,
      detail: { embedding: NEW_NAME },
    });
    expect(world.logged).toEqual([]);
  });

  it("普通库重建不读账号缺省：没有对话模型、账号缺省只有嵌入模型也照常 ready", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲", "book");
    const document = seedDocument(world, base.id, "a.md", "alpha");
    const old = datasetIdOf(world, base.id);
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();
    await world.rebuild();
    expect(routes(world.sent())).toEqual(
      plainRebuildOf(old, datasetIdOf(world, base.id), [document]),
    );
    expect(routes(world.sent())).not.toContain(GET_DEFAULTS);
    expect(world.sent()[0]?.json).toMatchObject({ parser_id: "book", parse_type: 1 });
    expectRebuilt(world, base.id);
  });

  it("开编译的库重建：新一代读账号缺省、读内置模板、建模板组、读内置 pipeline、建画布、建数据集，切换后逆序删旧一代", async () => {
    const world = await chatWorld(open);
    const base = await createdCompileBase(world, "编译库", { raptor: true, graph: true });
    const document = seedDocument(world, base.id, "a.md", "alpha");
    const old = baseOf(world, base.id);
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();

    await world.rebuild();

    const next = baseOf(world, base.id);
    expect(routes(world.sent())).toEqual([
      GET_DEFAULTS,
      GET_BUILTINS,
      POST_GROUPS,
      pipelineRoute("manual"),
      POST_AGENTS,
      POST_DATASETS,
      ...transferOf(old.datasetId, next.datasetId, document),
      DELETE_DATASETS,
      deleteCanvasRoute(old.canvasId ?? ""),
      deleteGroupRoute(old.templateGroupId ?? ""),
    ]);
    const name = resourceName(base.id, 1);
    const [group, agent, dataset] = [2, 4, 5].map((index) => world.sent()[index]?.json);
    expect(group).toMatchObject({ name });
    expect(agent).toMatchObject({ title: name, canvas_category: "dataflow_canvas" });
    expect(dataset).toEqual({
      name,
      parse_type: 2,
      pipeline_id: next.canvasId,
      embedding_model: NEW_MODEL,
    });
    expect(world.sent()[9]?.json).toEqual({ ids: [old.datasetId] });
    for (const key of ["datasetId", "canvasId", "templateGroupId"] as const) {
      expect(next[key]).not.toBeNull();
      expect(next[key]).not.toBe(old[key]);
    }
    expect(world.fake.canvases().map(({ id }) => id)).toEqual([next.canvasId]);
    expect(world.fake.templateGroups().map(({ id }) => id)).toEqual([next.templateGroupId]);
    expectRebuilt(world, base.id);
  });

  it("原件缺失与下载判别：不带 Content-Disposition 的 404 正文跳过并删行，内容恰为该正文的文件照常上传，字节不变", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    const missing = seedMissingDocument(world, base.id, "gone.md");
    const lookalike = seedDocument(world, base.id, "nf.json", NOT_FOUND_BODY);
    seedDocument(world, base.id, "c.md", "gamma");
    // 逐份按 `created_at`、`id` 处理：同一毫秒插的行由 id 定次序。
    const transferred = world.store.listDocuments(base.id).filter(({ id }) => id !== missing.id);
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();

    await world.rebuild();

    expectRebuilt(world, base.id);
    expect(world.store.listDocuments(base.id).map(({ id }) => id)).toEqual(
      transferred.map(({ id }) => id),
    );
    expect(transferred.map(({ id }) => id)).toContain(lookalike.id);
    expect(rebuildAudits(world).at(-1)).toEqual({
      actorId: ADMIN,
      detail: { id: base.id, result: "ok", skipped: [missing.id] },
    });
    const uploads = world
      .sent()
      .filter(({ method, path }) => method === "POST" && path.endsWith("/documents"));
    expect(uploads.map(({ multipart }) => multipart)).toEqual(
      transferred.map(({ name, size }) => [{ field: "file", filename: name, bytes: size }]),
    );
    for (const upload of uploads) {
      expect(upload.received).toBe(upload.contentLength);
    }
    const sizes = world.fake
      .documents(datasetIdOf(world, base.id))
      .map(({ name, size }) => [name, size]);
    expect(sizes.sort()).toEqual([
      ["c.md", 5],
      ["nf.json", 43],
    ]);
  });
});

describe("POST /api/kb/settings/rebuild", () => {
  it("非管理员 403，匿名 401，假 RAGFlow 收到零个请求", async () => {
    const world = await configuredWorld(open);
    const member = await world.retry("member");
    expect(member.statusCode).toBe(403);
    expect(bodyOf(member)).toEqual(FORBIDDEN);
    expect(member.headers["cache-control"]).toBe("no-store");
    const anonymous = await world.retry("anonymous");
    expect(anonymous.statusCode).toBe(401);
    expect(bodyOf(anonymous)).toEqual(UNAUTHORIZED_ENVELOPE);
    expect(world.sent()).toEqual([]);
  });

  it.each([
    ["{}", "{}", "application/json"],
    ["在 body 上限内的 1", "1", "application/json"],
    ["malformed JSON", '{"a":', "application/json"],
    ["text/plain body", "{}", "text/plain"],
  ])("归属路由 %s：exact 400，不改状态、不审计、不唤醒", async (_label, payload, contentType) => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    world.store.failRebuild(base.id, REBUILD_FAILED);
    world.forget();
    const response = await world.raw("POST", RETRY_ROUTE, payload, contentType);
    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual(BAD_REQUEST);
    await world.rebuild();
    expect(world.sent()).toEqual([]);
    expect(baseOf(world, base.id).state).toBe("rebuild_failed");
    expect(rebuildAudits(world)).toEqual([]);
  });

  it("没有失败库时重试：200 读视图，没有 kb.rebuild，rebuild_actor_id 不变，假 RAGFlow 收到零个请求", async () => {
    const world = await configuredWorld(open);
    await createdBase(world, "甲");
    world.forget();
    const response = await world.retry();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(bodyOf(response)).toMatchObject({ bases: 1, rebuilding: 0, rebuildFailed: 0 });
    await world.rebuild();
    expect(world.sent()).toEqual([]);
    expect(rebuildAudits(world)).toEqual([]);
    expect(world.store.settings().rebuildActorId).toBeNull();
  });
});

describe("重建中的设置", () => {
  it("重建中改嵌入身份：不带与带 confirmRebuild 都 409 kb_rebuilding，不下发；只换 apiKey 照常 200", async () => {
    const world = await configuredWorld(open);
    await createdBase(world, "甲");
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();
    const embedding = { ...world.embedding, name: "text-embedding-3-small" };
    expect(bodyOf(await world.put({ embedding }))).toEqual(REBUILDING);
    expect(bodyOf(await world.put({ embedding, confirmRebuild: true }))).toEqual(REBUILDING);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings()).toMatchObject({
      embedding: { name: NEW_NAME },
      embeddingGeneration: 1,
    });

    const rotated = { ...world.embedding, name: NEW_NAME, apiKey: "wb-issue1852-rotated-key" };
    expect((await world.put({ embedding: rotated })).statusCode).toBe(200);
    expect(routes(world.sent())).toEqual(nextRound("owb-embed"));
    expect(rebuildAudits(world)).toHaveLength(1);
  });

  it("重建中改 chatModelId 仍按 D7 锁定：换模型与取消指定都 409 kb_chat_model_locked", async () => {
    const world = await chatWorld(open);
    world.addChatModel("m3");
    await createdCompileBase(world, "编译库");
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();
    expect(bodyOf(await world.put({ chatModelId: "m3" }))).toEqual(LOCKED);
    expect(bodyOf(await world.put({ chatModelId: null }))).toEqual(LOCKED);
    expect(world.sent()).toEqual([]);
    expect(world.store.settings().chatModelId).toBe("m2");
  });
});
