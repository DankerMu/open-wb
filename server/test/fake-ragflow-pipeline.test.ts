/**
 * s2a-kb-ragflow tasks 9.5（#1869）：假 RAGFlow 编译资源路由的自测。期望值都是实测记录
 * `docs/reviews/2026-10-28-ragflow-rc2-api.md` §5.1、表 B 的字面量（§5.1 (3) 的表在 `kb-bases-helpers.ts`），不从夹具导入；用
 * `fetch` 直接打夹具，不经客户端：夹具是建库用例的判据，不能反过来靠它证明。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_PIPELINES, componentOf, type DslShape } from "./kb-bases-helpers.js";
import { type FakeRagflowServer, start } from "./support/fake-ragflow.mjs";
import { callFake, expectUnknownRoute, type FakeCallOptions } from "./support/fake-ragflow-call.js";

const KEY = "wb-issue1869-fixture-key";
const ABSENT = "0123456789abcdef0123456789abcdef";
const GROUPS = "/api/v1/compilation-template-groups";
const AGENTS = "/api/v1/agents";
const DELETED = '{"code":0,"data":true,"message":"success"}';

let fake: FakeRagflowServer;

beforeEach(async () => {
  fake = await start({ apiKey: KEY });
});

afterEach(async () => {
  await fake.close();
});

const call = (method: string, path: string, options?: FakeCallOptions) =>
  callFake(fake.baseUrl, KEY, method, path, options);

type Config = Record<string, unknown>;

/** 内置 `config`，按 `id` 取。 */
async function builtinConfigs(): Promise<Map<string, Config>> {
  const answer = await call("GET", "/api/v1/compilation-templates/builtins");
  const rows = answer.body.data as { id: string; config: Config }[];
  return new Map(rows.map(({ id, config }) => [id, config]));
}

function without(config: Config | undefined, ...keys: string[]): Config {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => !keys.includes(key)));
}

/** §5.1 (2)：本次提交、建组成功的两种 `config`。 */
async function submittedConfigs() {
  const configs = await builtinConfigs();
  return {
    tree: without(configs.get("tree"), "entity", "relation", "llm_id"),
    graph: without(configs.get("knowledge_graph"), "llm_id"),
  };
}

async function createGroup(name: string, templates: unknown[]) {
  return call("POST", GROUPS, { json: { name, description: "", templates } });
}

async function treeGroup(name: string) {
  const { tree } = await submittedConfigs();
  return createGroup(name, [{ name: "t", kind: "tree", description: "", config: tree }]);
}

describe("内置模板（§5.1 (1)）", () => {
  it("code:0；tree 与 knowledge_graph 的 config 是记录的形状，tree 的 entity.fields 带一条空 type", async () => {
    const answer = await call("GET", "/api/v1/compilation-templates/builtins");
    expect(answer.body).toMatchObject({ code: 0 });
    const configs = await builtinConfigs();
    expect(configs.get("tree")).toMatchObject({
      kind: "tree",
      llm_id: expect.any(String),
      global_rules: "",
      raptor: { max_token: 512, clustering_threshold: 0.3, clustering_ratio: 0.5 },
      entity: { description: "", fields: [{ type: "", description: "", rule: "" }] },
      relation: { description: "", fields: [{ type: "", description: "", rule: "" }] },
    });
    expect(Object.keys(configs.get("knowledge_graph") ?? {}).sort()).toEqual([
      "entity",
      "global_rules",
      "kind",
      "llm_id",
      "rechunk_rules",
      "relation",
    ]);
    expect(configs.get("knowledge_graph")).toMatchObject({ kind: "knowledge_graph" });
  });
});

describe("模板组（§5.1 (2)、(7)，表 B）", () => {
  it("两个模板：code:0，message success，scope file，保留提交的模板名", async () => {
    const { tree, graph } = await submittedConfigs();
    const answer = await createGroup("owb-g-both", [
      { name: "owb-g-both-t", kind: "tree", description: "", config: tree },
      { name: "owb-g-both-g", kind: "knowledge_graph", description: "", config: graph },
    ]);
    expect(answer.body).toMatchObject({
      code: 0,
      message: "success",
      data: { name: "owb-g-both", description: "", scope: "file" },
    });
    const { id } = answer.body.data as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(fake.templateGroups()).toMatchObject([
      { id, name: "owb-g-both", templates: [{ name: "owb-g-both-t" }, { name: "owb-g-both-g" }] },
    ]);
  });

  it("同名改名加序号，不区分大小写；单模板组的模板名改写成组名", async () => {
    const names: string[] = [];
    for (const name of ["owb-dupg", "owb-dupg", "owb-dupg2", "owb-DUPG", "owb-dupg"]) {
      names.push(((await treeGroup(name)).body.data as { name: string }).name);
    }
    expect(names).toEqual(["owb-dupg", "owb-dupg(1)", "owb-dupg2", "owb-DUPG(2)", "owb-dupg(3)"]);
    expect(fake.templateGroups().map(({ templates }) => templates[0]?.name)).toEqual(names);
  });

  it("同一组里两个模板同名：102", async () => {
    const { tree, graph } = await submittedConfigs();
    const answer = await createGroup("owb-same", [
      { name: "same", kind: "tree", description: "", config: tree },
      { name: "same", kind: "knowledge_graph", description: "", config: graph },
    ]);
    expect(answer.body).toMatchObject({
      code: 102,
      message: "template name 'same' is duplicated in this group.",
    });
    expect(fake.templateGroups()).toEqual([]);
  });

  it("tree 原样带内置的 entity：102 Entity type is required", async () => {
    const config = without((await builtinConfigs()).get("tree"), "llm_id");
    const answer = await createGroup("owb-raw", [
      { name: "t", kind: "tree", description: "", config },
    ]);
    expect(answer.body).toMatchObject({ code: 102, message: "Entity type is required" });
  });

  it("没有记录的 config（tree 留着 llm_id）：未知路由，没有建组", async () => {
    const config = without((await builtinConfigs()).get("tree"), "entity", "relation");
    const answer = await createGroup("owb-llm", [
      { name: "t", kind: "tree", description: "", config },
    ]);
    expectUnknownRoute(fake, answer, GROUPS);
    expect(fake.templateGroups()).toEqual([]);
  });

  it("删除：code:0、data:true；再删 404；被画布引用也照删（没有引用保护）", async () => {
    const { id } = (await treeGroup("owb-del")).body.data as { id: string };
    await call("POST", AGENTS, {
      json: { title: "owb-cv", canvas_category: "dataflow_canvas", dsl: { group: id } },
    });
    expect((await call("DELETE", `${GROUPS}/${id}`)).text).toBe(DELETED);
    expect((await call("DELETE", `${GROUPS}/${id}`)).body).toMatchObject({
      code: 404,
      message: `Cannot find compilation template group ${id}.`,
    });
    expect(fake.templateGroups()).toEqual([]);
  });

  it("已存在的组的 GET 没有实现：未知路由", async () => {
    const id = fake.addTemplateGroup();
    expectUnknownRoute(fake, await call("GET", `${GROUPS}/${id}`), `${GROUPS}/${id}`);
  });
});

describe("内置 pipeline（§5.1 (3)）", () => {
  it.each(BUILTIN_PIPELINES)(
    "%s：无须鉴权；chunker 恰一个，名与下游、节点数与边数同表",
    async (_template, parserId, chunker, downstream, nodes, edges) => {
      const answer = await call("GET", `/api/v1/pipelines/${parserId}`, { key: null });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ code: 0 });
      const { dsl } = answer.body.data as { dsl: DslShape };
      const chunkers = Object.entries(dsl.components).filter(([, node]) =>
        node.obj.component_name.includes("Chunker"),
      );
      expect(chunkers.map(([id]) => id)).toEqual([chunker]);
      expect(componentOf(dsl, chunker).downstream).toEqual([downstream]);
      expect(Object.keys(dsl.components)).toHaveLength(nodes);
      expect(dsl.graph.nodes).toHaveLength(nodes);
      expect(dsl.graph.edges).toHaveLength(edges);
      expect(fake.unknownRoutes()).toEqual([]);
    },
  );

  it("naive 回的 DSL 与 general 相同；tag 回 102 pipeline not found", async () => {
    const naive = await call("GET", "/api/v1/pipelines/naive");
    const general = await call("GET", "/api/v1/pipelines/general");
    expect(naive.body.data).toEqual(general.body.data);
    expect((await call("GET", "/api/v1/pipelines/tag")).body).toMatchObject({
      code: 102,
      message: "pipeline not found",
    });
  });
});

describe("画布（§5.1 (4)、(7)，表 B）", () => {
  const canvas = (title: string, dsl: unknown = { components: {} }) =>
    call("POST", AGENTS, { json: { title, canvas_category: "dataflow_canvas", dsl } });

  it("建：code:0，带 id、title、canvas_category 与原样的 dsl；同名标题加后缀", async () => {
    const answer = await canvas("owb-cv-life");
    expect(answer.body).toMatchObject({
      code: 0,
      message: "success",
      data: {
        canvas_category: "dataflow_canvas",
        dsl: { components: {} },
        permission: "me",
        title: "owb-cv-life",
      },
    });
    const again = await canvas("owb-cv-life");
    expect((again.body.data as { title: string }).title).toBe("owb-cv-life(1)");
    expect(fake.canvases().map(({ title }) => title)).toEqual(["owb-cv-life", "owb-cv-life(1)"]);
  });

  it("不带 dsl：101 no DSL data in request", async () => {
    const answer = await call("POST", AGENTS, {
      json: { title: "owb-cv", canvas_category: "dataflow_canvas" },
    });
    expect(answer.body).toMatchObject({ code: 101, message: "no DSL data in request" });
    expect(fake.canvases()).toEqual([]);
  });

  it("删：code:0、data:true；再删 103；已存在画布的 GET 没有实现", async () => {
    const { id } = (await canvas("owb-cv")).body.data as { id: string };
    expectUnknownRoute(fake, await call("GET", `${AGENTS}/${id}`), `${AGENTS}/${id}`);
    expect((await call("DELETE", `${AGENTS}/${id}`)).text).toBe(DELETED);
    expect((await call("DELETE", `${AGENTS}/${id}`)).body).toMatchObject({
      code: 103,
      message: "Only the owner of the agent is authorized for this operation.",
    });
    expect(fake.canvases()).toEqual([]);
  });
});

describe("以 pipeline 建数据集（§5.1 (5)、§4.6）", () => {
  const create = (json: unknown) => call("POST", "/api/v1/datasets", { json });

  it("pipeline_id 为夹具里的画布：code:0，应答多 pipeline_id，parser_id 读回 general", async () => {
    const pipelineId = fake.addCanvas();
    const answer = await create({ name: "owb-c-both", parse_type: 2, pipeline_id: pipelineId });
    expect(answer.body).toMatchObject({
      code: 0,
      data: { name: "owb-c-both", parser_id: "general", pipeline_id: pipelineId },
    });
    expect(fake.datasets()).toMatchObject([{ name: "owb-c-both", parserId: "general" }]);
  });

  it("画布不存在：102；同时带 parser_id：未知路由", async () => {
    const missing = await create({ name: "n", parse_type: 2, pipeline_id: ABSENT });
    expect(missing.body).toMatchObject({ code: 102 });
    const pipelineId = fake.addCanvas();
    const both = await create({
      name: "n",
      parse_type: 2,
      pipeline_id: pipelineId,
      parser_id: "qa",
    });
    expectUnknownRoute(fake, both, "/api/v1/datasets");
    expect(fake.datasets()).toEqual([]);
  });
});
