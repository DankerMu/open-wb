/**
 * s2a-kb-ragflow tasks 9.5（#1869）：开了开关的建库与删库，组 9 第二刀（knowledge-bases「知识库端点」的编译部分，ragflow-backend
 * 「知识库模型设置」的账号缺省不变量，design D7、D9、D14）。全部经 `createApp` + `app.inject()` 打假 RAGFlow，期望值是 spec 与
 * 实测记录的字面量；DSL 的逐键期望在 `kb-pipeline.test.ts`，夹具的 Compiler 不校验 DSL。
 *
 * 列表里开了开关的库读一次文档列表与任务日志（第三刀 #1870 接上）；判定的逐项用例在 `kb-compile-status.test.ts`。
 */
import type { LightMyRequestResponse as Reply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { resourceName } from "../src/kb/pipeline.js";
import {
  auditsOf,
  BASES,
  BUILTIN_PIPELINES,
  baseCount,
  COMPILE_OFF,
  COMPILER,
  componentOf,
  createBase,
  createdBase,
  createdCompileBase,
  DELETE_DATASETS,
  type DslShape,
  datasetIdOf,
  deleteBase,
  deleteCanvasRoute,
  deleteGroupRoute,
  EMBEDDING_MODEL,
  expectDeleted,
  GENERIC_500,
  GET_BUILTINS,
  GET_DEFAULTS,
  NOT_FOUND,
  ownerIdOf,
  POST_AGENTS,
  POST_DATASETS,
  POST_GROUPS,
  pipelineRoute,
  type TemplateShape,
} from "./kb-bases-helpers.js";
import {
  BAD_REQUEST,
  bodyOf,
  chatWorld,
  KB_UNAVAILABLE,
  LOCKED,
  nextRound,
  PROVIDER,
  PUT_PROVIDER,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { REBUILD_FAILED } from "./kb-store-helpers.js";
import type { FakeRagflowRequest } from "./support/fake-ragflow.mjs";
import { builtinPipeline } from "./support/fake-ragflow-pipeline.mjs";

const open = useSettingsWorlds();
const compileReady = () => chatWorld(open);

const COMPILED = { name: "规范库", template: "manual", raptor: true };
const NOT_READY = {
  error: {
    code: "kb_not_ready",
    message: "知识库模型未就绪，请管理员在模型设置里保存知识库嵌入模型",
  },
};
const REFUSE_BASE =
  "CREATE TRIGGER refuse_base BEFORE INSERT ON knowledge_bases BEGIN SELECT RAISE(ABORT, 'injected'); END";
const DELETE_ANY_CANVAS = "DELETE /api/v1/agents/*";
const DELETE_ANY_GROUP = "DELETE /api/v1/compilation-template-groups/*";
const ANY_CANVAS_DELETE = expect.stringMatching(/^DELETE \/api\/v1\/agents\/[0-9a-f]{32}$/u);
const ANY_GROUP_DELETE = expect.stringMatching(
  /^DELETE \/api\/v1\/compilation-template-groups\/[0-9a-f]{32}$/u,
);
const sequence = (parserId = "manual") => [
  GET_DEFAULTS,
  GET_BUILTINS,
  POST_GROUPS,
  pipelineRoute(parserId),
  POST_AGENTS,
  POST_DATASETS,
];

type Json = Record<string, unknown>;

/** 这次请求里第 `nth` 个该路由的 JSON body。 */
function bodyAt(requests: FakeRagflowRequest[], route: string, nth = 0): Json {
  const matched = requests.filter(({ method, path }) => `${method} ${path}` === route);
  return matched[nth]?.json as Json;
}

/** 当前一代的三个 RAGFlow id。 */
function generationOf(world: World, id: string) {
  const base = world.store.getBase(id);
  return {
    datasetId: String(base?.datasetId),
    canvasId: String(base?.canvasId),
    templateGroupId: String(base?.templateGroupId),
  };
}

const deletesOf = ({ datasetId, canvasId, templateGroupId }: ReturnType<typeof generationOf>) => [
  { route: DELETE_DATASETS, ids: [datasetId] },
  { route: deleteCanvasRoute(canvasId), ids: null },
  { route: deleteGroupRoute(templateGroupId), ids: null },
];

/** 这次删了什么，按到达次序：删数据集带它的 `ids`。 */
const deletesSent = (world: World) =>
  world.sent().map(({ method, path, json }) => ({
    route: `${method} ${path}`,
    ids: (json as { ids?: unknown } | null)?.ids ?? null,
  }));

function expectNoResources(world: World): void {
  expect(world.fake.datasets()).toEqual([]);
  expect(world.fake.canvases()).toEqual([]);
  expect(world.fake.templateGroups()).toEqual([]);
}

function expectNothingCreated(world: World): void {
  expect(baseCount(world)).toBe(0);
  expect(auditsOf(world, "kb.create")).toEqual([]);
}

describe("建库与列表隔离", () => {
  it("A 建 manual 的 raptor 库：六步请求依次发出，名字都是 owb-<id 前 16 位>-g0，数据集 parse_type:2 指向该画布", async () => {
    const world = await compileReady();
    const view = await createdCompileBase(world, "规范库");
    const name = resourceName(view.id, 0);
    const sent = world.sent();
    expect(routes(sent)).toEqual(sequence());
    const [group] = world.fake.templateGroups();
    const [canvas] = world.fake.canvases();
    const [dataset] = world.fake.datasets();
    expect(bodyAt(sent, POST_GROUPS)).toMatchObject({ name });
    expect(bodyAt(sent, POST_AGENTS)).toMatchObject({
      title: name,
      canvas_category: "dataflow_canvas",
    });
    expect(canvas?.dsl.components).toMatchObject({
      [COMPILER]: { obj: { params: { compilation_template_group_id: group?.id } } },
    });
    expect(bodyAt(sent, POST_DATASETS)).toEqual({
      name,
      parse_type: 2,
      pipeline_id: canvas?.id,
      embedding_model: EMBEDDING_MODEL,
    });
    expect(world.store.getBase(view.id)).toMatchObject({
      raptor: true,
      graph: false,
      datasetId: dataset?.id,
      canvasId: canvas?.id,
      templateGroupId: group?.id,
    });
    expect(auditsOf(world, "kb.create")).toEqual([
      {
        actorId: ownerIdOf(world, view.id),
        title: expect.not.stringContaining("规范库"),
        detail: { id: view.id, template: "manual", raptor: true, graph: false },
        workspaceId: null,
      },
    ]);

    world.forget();
    expect((await world.call("GET", BASES, "peer")).json()).toEqual({ bases: [] });
    const refused = await deleteBase(world, view.id, "peer");
    expect(refused.statusCode).toBe(404);
    expect(bodyOf(refused)).toEqual(NOT_FOUND);
    expect(world.sent()).toEqual([]);
  });
});

describe("建库应答不读 RAGFlow", () => {
  it("raptor 库的 201：ready、null、0、{pending, off}；普通库 {off, off}；没有文档列表与任务日志请求", async () => {
    const world = await compileReady();
    const response = await createBase(world, COMPILED);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      name: "规范库",
      template: "manual",
      raptor: true,
      graph: false,
      state: "ready",
      stateMessage: null,
      documents: 0,
      compile: { raptor: "pending", graph: "off" },
      retrieval: { threshold: 0.2, vectorWeight: 0.7 },
      createdAt: expect.any(Number),
    });
    expect((await createdBase(world, "普通库")).compile).toEqual(COMPILE_OFF);
    const reads = world.fake
      .requests()
      .filter(({ path }) => /\/(documents|ingestions)/u.test(path));
    expect(reads).toEqual([]);
  });

  it("列表里开了开关、还没有文档的库：读一次文档列表与任务日志，compile 为 {pending, pending}；普通库不发请求", async () => {
    const world = await compileReady();
    const view = await createdCompileBase(world, "编译库", { raptor: true, graph: true });
    await createdBase(world, "普通库");
    world.forget();
    const listed = await world.call("GET", BASES, "member");
    expect(listed.statusCode).toBe(200);
    // 两个库同一毫秒建出时次序落到随机 id 上：按名字对，次序由 kb-bases-list 的「按 created_at 升序」钉住。
    const { bases } = listed.json() as { bases: Json[] };
    expect(Object.fromEntries(bases.map(({ name, compile }) => [name, compile]))).toEqual({
      编译库: { raptor: "pending", graph: "pending" },
      普通库: COMPILE_OFF,
    });
    const dataset = `/api/v1/datasets/${datasetIdOf(world, view.id)}`;
    expect(routes(world.sent())).toEqual([`GET ${dataset}/documents`, `GET ${dataset}/ingestions`]);
  });
});

describe("账号缺省缺失时不建编译资源", () => {
  const defaults = (...types: string[]) => ({
    models: types.map((type) => ({
      model_provider: PROVIDER,
      model_instance: type === "chat" ? "owb-chat" : "owb-embed",
      model_name: type === "chat" ? "m2" : "bge-m3",
      model_id: "model-1",
      model_type: type,
      enable: true,
    })),
  });

  const [chat, embedding] = defaults("chat", "embedding").models;

  it("models 为空、只有 embedding、只有 chat、chat 的 model_name 为空串：409 kb_not_ready，只发这一次读取；两种都在 201；HTTP 503 与 model_name 不是字符串为 503", async () => {
    const world = await compileReady();
    // 空列表是记录里的应答（§11.4，悬空时也是它）；只有一种、一种的名字为空串（§11.2 清空缺省的写法）、名字不是字符串
    // 都是防御性组合（故障注入）。
    world.fake.answer(GET_DEFAULTS, { code: 0, data: { models: [] } });
    world.fake.fault(GET_DEFAULTS, { kind: "combo", code: 0, data: defaults("embedding") });
    world.fake.fault(GET_DEFAULTS, { kind: "combo", code: 0, data: defaults("chat") });
    const emptyChat = { models: [{ ...chat, model_name: "" }, embedding] };
    world.fake.fault(GET_DEFAULTS, { kind: "combo", code: 0, data: emptyChat });
    for (const n of [1, 2, 3, 4]) {
      world.forget();
      const refused = await createBase(world, { ...COMPILED, name: `库 ${String(n)}` });
      expect(refused.statusCode).toBe(409);
      expect(bodyOf(refused)).toEqual(NOT_READY);
      expect(routes(world.sent())).toEqual([GET_DEFAULTS]);
    }
    world.fake.fault(GET_DEFAULTS, { kind: "status", status: 503 });
    const numberName = { models: [chat, { ...embedding, model_name: 3 }] };
    world.fake.fault(GET_DEFAULTS, { kind: "combo", code: 0, data: numberName });
    for (const n of [1, 2]) {
      world.forget();
      const down = await createBase(world, { ...COMPILED, name: `库 503-${String(n)}` });
      expect(down.statusCode).toBe(503);
      expect(bodyOf(down)).toEqual(KB_UNAVAILABLE);
      expect(routes(world.sent())).toEqual([GET_DEFAULTS]);
    }
    expectNoResources(world);
    expectNothingCreated(world);

    world.forget();
    await createdCompileBase(world, "库 5");
    expect(routes(world.sent())).toEqual(sequence());
    expect(baseCount(world)).toBe(1);
  });
});

describe("建库与设置交错（design D9、D20）", () => {
  /** C 的嵌入设置持锁且下发被挂起；`first`、`second` 依次排到锁后，再放行。 */
  async function interleave(
    world: World,
    first: () => Promise<Reply>,
    second: () => Promise<Reply>,
  ): Promise<[Reply, Reply]> {
    const gate = world.fake.fault(PUT_PROVIDER, { kind: "hold" });
    const saving = world.put({ embedding: world.embedding });
    await gate.reached;
    const a = first();
    await vi.waitFor(() => {
      expect(world.locks.settingsWaiters()).toBe(1);
    });
    const b = second();
    await vi.waitFor(() => {
      expect(world.locks.settingsWaiters()).toBe(2);
    });
    gate.release();
    expect((await saving).statusCode).toBe(200);
    return [await a, await b];
  }
  const settingsRounds = [...nextRound("owb-embed"), ...nextRound("owb-chat")];

  it("B 取消指定排在 A 建库之前：B 200，A 在锁内读到未指定，400，没有发出任何请求", async () => {
    const world = await compileReady();
    const [unassigned, refused] = await interleave(
      world,
      () => world.put({ chatModelId: null }),
      () => createBase(world, COMPILED),
    );
    expect(unassigned.statusCode).toBe(200);
    expect(refused.statusCode).toBe(400);
    expect(bodyOf(refused)).toEqual(BAD_REQUEST);
    expect(routes(world.sent())).toEqual(settingsRounds);
    expect(baseCount(world)).toBe(0);
  });

  it("A 建库排在 B 之前：A 201，B 读到开编译的库，409 kb_chat_model_locked，chatModelId 仍为 m2", async () => {
    const world = await compileReady();
    const [created, locked] = await interleave(
      world,
      () => createBase(world, COMPILED),
      () => world.put({ chatModelId: null }),
    );
    expect(created.statusCode).toBe(201);
    expect(locked.statusCode).toBe(409);
    expect(bodyOf(locked)).toEqual(LOCKED);
    expect(world.store.settings().chatModelId).toBe("m2");
    expect(routes(world.sent())).toEqual([...settingsRounds, ...sequence()]);
  });
});

describe("十一种模板都能开两个开关", () => {
  it("十一次 201：Compiler 插在该模板的 chunker 与下游之间，边恰多一条，模板组含 tree 与 knowledge_graph", async () => {
    const world = await compileReady();
    for (const [template, parserId, chunker, downstream, , edges] of BUILTIN_PIPELINES) {
      world.forget();
      const view = await createdCompileBase(
        world,
        `库 ${template}`,
        { raptor: true, graph: true },
        template,
      );
      expect(view.compile).toEqual({ raptor: "pending", graph: "pending" });
      const sent = world.sent();
      expect(routes(sent)).toEqual(sequence(parserId));
      const dsl = bodyAt(sent, POST_AGENTS).dsl as DslShape;
      expect(dsl.graph).toBeDefined();
      expect(componentOf(dsl, chunker).downstream).toEqual([COMPILER]);
      expect(dsl.components[COMPILER]).toMatchObject({
        upstream: [chunker],
        downstream: [downstream],
      });
      expect(componentOf(dsl, downstream).upstream).toEqual([COMPILER]);
      expect(dsl.graph.edges).toHaveLength(edges + 1);
      const direct = dsl.graph.edges.filter(
        (edge) => edge.source === chunker && edge.target === downstream,
      );
      expect(direct).toEqual([]);
      const [tree, graph, ...rest] = bodyAt(sent, POST_GROUPS).templates as TemplateShape[];
      expect(rest).toEqual([]);
      expect(tree).toMatchObject({ kind: "tree", description: "" });
      expect(graph).toMatchObject({ kind: "knowledge_graph", description: "" });
      for (const key of ["entity", "relation", "llm_id"]) {
        expect(tree?.config).not.toHaveProperty(key);
      }
      expect(graph?.config).not.toHaveProperty("llm_id");
      expect(graph?.config).toHaveProperty("entity");
      const canvasId = world.store.getBase(view.id)?.canvasId;
      expect(bodyAt(sent, POST_DATASETS)).toMatchObject({ parse_type: 2, pipeline_id: canvasId });
    }
    expect(baseCount(world)).toBe(11);
  });
});

describe("只开一种编译", () => {
  it("raptor:true 的模板组只含 tree，graph:true 的只含 knowledge_graph", async () => {
    const world = await compileReady();
    const raptor = await createdCompileBase(world, "RAPTOR 库", { raptor: true });
    const graph = await createdCompileBase(world, "图谱库", { graph: true });
    const kinds = (nth: number) =>
      (bodyAt(world.sent(), POST_GROUPS, nth).templates as TemplateShape[]).map(({ kind }) => kind);
    expect(kinds(0)).toEqual(["tree"]);
    expect(kinds(1)).toEqual(["knowledge_graph"]);
    expect(raptor.compile).toEqual({ raptor: "pending", graph: "off" });
    expect(graph.compile).toEqual({ raptor: "off", graph: "pending" });
  });
});

describe("建库中途失败逐步回滚", () => {
  it("建画布 503：删模板组；建数据集 503：先删画布再删模板组；插行失败：依次删数据集、画布、模板组", async () => {
    const world = await compileReady();
    world.fake.fault(POST_AGENTS, { kind: "status", status: 503 });
    const canvasDown = await createBase(world, COMPILED);
    expect(canvasDown.statusCode).toBe(503);
    expect(bodyOf(canvasDown)).toEqual(KB_UNAVAILABLE);
    expect(routes(world.sent())).toEqual([...sequence().slice(0, 5), ANY_GROUP_DELETE]);
    expectNoResources(world);

    world.forget();
    world.fake.fault(POST_DATASETS, { kind: "status", status: 503 });
    const datasetDown = await createBase(world, COMPILED);
    expect(datasetDown.statusCode).toBe(503);
    expect(bodyOf(datasetDown)).toEqual(KB_UNAVAILABLE);
    expect(routes(world.sent())).toEqual([...sequence(), ANY_CANVAS_DELETE, ANY_GROUP_DELETE]);
    expectNoResources(world);

    world.forget();
    world.db.exec(REFUSE_BASE);
    const refused = await createBase(world, COMPILED);
    expect(refused.statusCode).toBe(500);
    expect(bodyOf(refused)).toEqual(GENERIC_500);
    expect(routes(world.sent())).toEqual([
      ...sequence(),
      DELETE_DATASETS,
      ANY_CANVAS_DELETE,
      ANY_GROUP_DELETE,
    ]);
    expectNoResources(world);
    expectNothingCreated(world);
    expect(world.logged).toEqual([]);
  });
});

describe("其余各步失败（design D9：失败即停，删掉这一次已建的，按映射返回）", () => {
  const REJECTED = { error: { code: "kb_rejected", message: "知识库服务拒绝了这个请求" } };
  it.each([
    ["读账号缺省缺 models", GET_DEFAULTS, { kind: "combo", code: 0, data: {} }, 1],
    ["读内置模板 503", GET_BUILTINS, { kind: "status", status: 503 }, 2],
    ["内置模板缺 tree", GET_BUILTINS, { kind: "combo", code: 0, data: [] }, 2],
    ["建模板组 101", POST_GROUPS, { kind: "combo", code: 101 }, 3],
    ["读内置 pipeline 503", pipelineRoute("manual"), { kind: "status", status: 503 }, 4],
  ] as const)(
    "%s：失败应答，之前建好的模板组删掉，没有知识库行",
    async (_label, route, fault, steps) => {
      const world = await compileReady();
      world.fake.fault(route, fault);
      const response = await createBase(world, COMPILED);
      const rejected = fault.kind === "combo" && fault.code === 101;
      expect(response.statusCode).toBe(rejected ? 400 : 503);
      expect(bodyOf(response)).toEqual(rejected ? REJECTED : KB_UNAVAILABLE);
      const rollback = steps > 3 ? [ANY_GROUP_DELETE] : [];
      expect(routes(world.sent())).toEqual([...sequence().slice(0, steps), ...rollback]);
      expectNoResources(world);
      expectNothingCreated(world);
    },
  );
});

describe("回滚里的删除失败", () => {
  it("建数据集 503、删画布也 503：恰一行 kb_pipeline_leak，两个 id 都在，没有发出删模板组", async () => {
    const world = await compileReady();
    world.fake.fault(POST_DATASETS, { kind: "status", status: 503 });
    world.fake.fault(DELETE_ANY_CANVAS, { kind: "status", status: 503 });
    const response = await createBase(world, COMPILED);
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    const [canvas] = world.fake.canvases();
    const [group] = world.fake.templateGroups();
    expect(world.logged).toEqual([
      { event: "kb_pipeline_leak", canvasId: canvas?.id, groupId: group?.id },
    ]);
    expect(canvas?.id).toEqual(expect.any(String));
    expect(group?.id).toEqual(expect.any(String));
    expect(routes(world.sent())).toEqual([...sequence(), ANY_CANVAS_DELETE]);
    expectNothingCreated(world);
  });

  it("建画布 503、删模板组也 503：恰一行 kb_pipeline_leak，canvasId 为 null", async () => {
    const world = await compileReady();
    world.fake.fault(POST_AGENTS, { kind: "status", status: 503 });
    world.fake.fault(DELETE_ANY_GROUP, { kind: "status", status: 503 });
    const response = await createBase(world, COMPILED);
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    const [group] = world.fake.templateGroups();
    expect(world.logged).toEqual([
      { event: "kb_pipeline_leak", canvasId: null, groupId: group?.id },
    ]);
    expect(group?.id).toEqual(expect.any(String));
    expectNothingCreated(world);
  });

  it("插行失败、删数据集 503：恰一行 kb_dataset_leak，没有发出删画布与删模板组", async () => {
    const world = await compileReady();
    world.db.exec(REFUSE_BASE);
    world.fake.fault(DELETE_DATASETS, { kind: "status", status: 503 });
    const response = await createBase(world, COMPILED);
    expect(response.statusCode).toBe(500);
    expect(bodyOf(response)).toEqual(GENERIC_500);
    const [dataset] = world.fake.datasets();
    expect(world.logged).toEqual([{ event: "kb_dataset_leak", datasetId: dataset?.id }]);
    expect(dataset?.id).toEqual(expect.any(String));
    expect(routes(world.sent())).toEqual([...sequence(), DELETE_DATASETS]);
    expectNothingCreated(world);
  });
});

describe("DSL 无法改写（故障注入：记录里全部内置模板都带 graph、恰一个 chunker）", () => {
  const noGraph = () => {
    const { graph: _graph, ...rest } = builtinPipeline("manual") ?? {};
    return rest;
  };
  const twoChunkers = () => {
    const dsl = builtinPipeline("manual") as DslShape;
    componentOf(dsl, "Extractor:AutoExtractDefault").obj.component_name = "TokenChunker";
    return dsl;
  };

  it.each([
    ["不带 graph", noGraph],
    ["两个 chunker", twoChunkers],
  ])("%s：503 kb_unavailable，没有建画布与建数据集，建好的模板组已删除", async (_label, dsl) => {
    const world = await compileReady();
    world.fake.fault(pipelineRoute("manual"), { kind: "combo", code: 0, data: { dsl: dsl() } });
    const response = await createBase(world, COMPILED);
    expect(response.statusCode).toBe(503);
    expect(bodyOf(response)).toEqual(KB_UNAVAILABLE);
    expect(routes(world.sent())).toEqual([...sequence().slice(0, 4), ANY_GROUP_DELETE]);
    expectNoResources(world);
    expectNothingCreated(world);
  });
});

describe("删除次序", () => {
  it("开了开关的库：依次删数据集、画布、模板组，204，恰一条 kb.delete", async () => {
    const world = await compileReady();
    const view = await createdCompileBase(world, "规范库");
    const generation = generationOf(world, view.id);
    world.forget();
    const response = await deleteBase(world, view.id);
    expect(response.statusCode).toBe(204);
    expect(deletesSent(world)).toEqual(deletesOf(generation));
    expectNoResources(world);
    expect(world.store.getBase(view.id)).toBeUndefined();
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });

  it("删画布时不可达：503，行仍在，没有发出删模板组；恢复后重试依次得到数据集不存在、删画布、删模板组，204", async () => {
    const world = await compileReady();
    const view = await createdCompileBase(world, "规范库");
    const generation = generationOf(world, view.id);
    world.forget();
    world.fake.fault(deleteCanvasRoute(generation.canvasId), { kind: "reset" });
    const down = await deleteBase(world, view.id);
    expect(down.statusCode).toBe(503);
    expect(bodyOf(down)).toEqual(KB_UNAVAILABLE);
    expect(deletesSent(world)).toEqual(deletesOf(generation).slice(0, 2));
    expect(world.store.getBase(view.id)).toBeDefined();
    expect(world.fake.datasets()).toEqual([]);
    expect(auditsOf(world, "kb.delete")).toEqual([]);

    world.forget();
    expect((await deleteBase(world, view.id)).statusCode).toBe(204);
    expect(deletesSent(world)).toEqual(deletesOf(generation));
    expectNoResources(world);
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });

  it("三步分别回 code:403、code:103、code:404：都视为已删，204，不写 kb_upstream_auth_failed", async () => {
    const world = await compileReady();
    const view = await createdCompileBase(world, "规范库");
    const generation = generationOf(world, view.id);
    world.forget();
    world.fake.answer(DELETE_DATASETS, { code: 403, message: "Permission denied" });
    world.fake.answer(DELETE_ANY_CANVAS, {
      code: 103,
      message: "Only the owner of the agent is authorized for this operation.",
    });
    world.fake.answer(DELETE_ANY_GROUP, {
      code: 404,
      message: "Cannot find compilation template group x.",
    });
    await expectDeleted(world, view.id);
    expect(deletesSent(world)).toEqual(deletesOf(generation));
  });
});

describe("重建失败时删库", () => {
  /** 开了 RAPTOR、处于 `rebuild_failed` 的库，三个 `rebuild_*` 列指向假 RAGFlow 里的新一代。 */
  async function failedCompileBase(world: World) {
    const view = await createdCompileBase(world, "重建失败的库");
    const name = resourceName(view.id, 1);
    const next = {
      datasetId: world.fake.addDataset(name),
      canvasId: world.fake.addCanvas(name),
      templateGroupId: world.fake.addTemplateGroup(name),
    };
    const current = generationOf(world, view.id);
    world.store.setRebuildGeneration(view.id, next);
    world.store.failRebuild(view.id, REBUILD_FAILED);
    world.forget();
    return { id: view.id, current, next };
  }

  it("先删新一代的数据集、画布、模板组，再删当前一代的同样三步，204", async () => {
    const world = await compileReady();
    const { id, current, next } = await failedCompileBase(world);
    expect((await deleteBase(world, id)).statusCode).toBe(204);
    expect(deletesSent(world)).toEqual([...deletesOf(next), ...deletesOf(current)]);
    expectNoResources(world);
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });

  it("新一代的删数据集回 code:403：视为已删，两代都发过删除，204，恰一条 kb.delete", async () => {
    const world = await compileReady();
    const { id, current, next } = await failedCompileBase(world);
    world.fake.answer(DELETE_DATASETS, { code: 403, message: "Permission denied" });
    expect((await deleteBase(world, id)).statusCode).toBe(204);
    expect(deletesSent(world)).toEqual([...deletesOf(next), ...deletesOf(current)]);
    expect(world.store.getBase(id)).toBeUndefined();
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });
});
