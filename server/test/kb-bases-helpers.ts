/**
 * `kb-bases*.test.ts` 与 `kb-pipeline.test.ts` 共用（s2a-kb-ragflow tasks 9.2、9.5，#1846、#1869）：世界夹具是
 * `kb-settings-helpers.ts` 的，收尾的不变量断言照用。期望值是 spec 与实测记录的字面量。
 */
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import type { World } from "./kb-settings-helpers.js";

export const BASES = "/api/kb/bases";
export const POST_DATASETS = "POST /api/v1/datasets";
export const DELETE_DATASETS = "DELETE /api/v1/datasets";
/** 开了开关的建库序列（knowledge-bases「知识库端点」）。 */
export const GET_DEFAULTS = "GET /api/v1/models/default";
export const GET_BUILTINS = "GET /api/v1/compilation-templates/builtins";
export const POST_GROUPS = "POST /api/v1/compilation-template-groups";
export const POST_AGENTS = "POST /api/v1/agents";
export const pipelineRoute = (parserId: string) => `GET /api/v1/pipelines/${parserId}`;
export const deleteCanvasRoute = (id: string) => `DELETE /api/v1/agents/${id}`;
export const deleteGroupRoute = (id: string) => `DELETE /api/v1/compilation-template-groups/${id}`;
export const COMPILER = "Compiler:Owb";

/**
 * 实测记录 §5.1 (3) 的表：模板、`parser_id`、chunker 节点、chunker 的下游、内置 `graph` 的节点数与边数。`qa`、`table` 没有
 * Extractor，下游是 Tokenizer。
 */
export const BUILTIN_PIPELINES = [
  ["naive", "general", "GeneralChunker:SixApplesFall", "Extractor:AutoExtractDefault", 5, 4],
  ["book", "book", "TitleChunker:GrumpyGarlicsBake", "Extractor:AutoExtractDefault", 5, 4],
  ["email", "email", "TokenChunker:WarmBreadSmells", "Extractor:AutoExtractDefault", 5, 4],
  ["laws", "laws", "TitleChunker:SpicyKeysKick", "Extractor:AutoExtractDefault", 5, 4],
  ["manual", "manual", "ManualChunker:NineInsectsFind", "Extractor:AutoExtractDefault", 5, 4],
  ["one", "one", "OneChunker:DryDrinksVisit", "Extractor:AutoExtractDefault", 5, 4],
  ["paper", "paper", "TitleChunker:SparklySchoolsTravel", "Extractor:AutoExtractDefault", 5, 4],
  ["picture", "picture", "OneChunker:BrightColorsGlow", "Extractor:AutoExtractDefault", 5, 4],
  [
    "presentation",
    "presentation",
    "PageChunker:HappyHillsGlow",
    "Extractor:AutoExtractDefault",
    5,
    4,
  ],
  ["qa", "qa", "QAChunker:TidyCloudsThink", "Tokenizer:ColdCloudsDream", 4, 3],
  ["table", "table", "TableChunker:FastFoxesJump", "Tokenizer:DeepLakesShine", 4, 3],
] as const;
/** §4.4：`模型@实例@提供方`，模型名是 `configuredWorld` 保存的那个。 */
export const EMBEDDING_MODEL = "bge-m3@owb-embed@OpenAI-API-Compatible";
export const COMPILE_OFF = { raptor: "off", graph: "off" };
export const VALID = { name: "规范库", template: "manual" };
export const NOT_FOUND = { error: { code: "not_found", message: "请求的资源不存在" } };
export const GENERIC_500 = { error: { message: "服务器内部错误" } };
export const REBUILDING = {
  error: { code: "kb_rebuilding", message: "知识库正在重建，请稍后再试" },
};

type Who = Parameters<World["call"]>[2];

export interface BaseBody {
  id: string;
  name: string;
  template: string;
  raptor: boolean;
  graph: boolean;
  state: string;
  stateMessage: string | null;
  documents: number;
  compile: unknown;
  createdAt: number;
}

export function createBase(
  world: World,
  body: unknown,
  who: Who = "member",
): Promise<LightMyRequestResponse> {
  return world.call("POST", BASES, who, body);
}

/** 建成一个库，返回 201 的 `BaseView`。 */
export async function createdBase(
  world: World,
  name: string,
  template = "naive",
  who: Who = "member",
): Promise<BaseBody> {
  const response = await createBase(world, { name, template }, who);
  expect(response.statusCode).toBe(201);
  return response.json();
}

/** 用例读画布 DSL 的形状（§5.1 (3)、(6)）：只列断言要读的键。 */
export interface DslShape {
  components: Record<
    string,
    { upstream: string[]; downstream: string[]; obj: { component_name: string; params: unknown } }
  >;
  graph: {
    nodes: { id: string; [key: string]: unknown }[];
    edges: { id: string; source: string; target: string; [key: string]: unknown }[];
  };
  [key: string]: unknown;
}

/** `components` 里的一个节点；没有即抛，用例当场失败。 */
export function componentOf(dsl: DslShape, id: string): DslShape["components"][string] {
  const node = dsl.components[id];
  if (node === undefined) {
    throw new Error(`no component ${id}`);
  }
  return node;
}

/** 模板组 body 里的一项（§5.1 (2)）。 */
export interface TemplateShape {
  name: string;
  kind: string;
  description: string;
  config: Record<string, unknown>;
}

/** 建成一个开了开关的库（对话模型已指定的世界），返回 201 的 `BaseView`。 */
export async function createdCompileBase(
  world: World,
  name: string,
  switches: { raptor?: boolean; graph?: boolean } = { raptor: true },
  template = "manual",
): Promise<BaseBody> {
  const response = await createBase(world, { name, template, ...switches });
  expect(response.statusCode).toBe(201);
  return response.json();
}

export function deleteBase(
  world: World,
  id: string,
  who: Who = "member",
): Promise<LightMyRequestResponse> {
  return world.call("DELETE", `${BASES}/${id}`, who);
}

export function auditsOf(world: World, kind: string) {
  return world.db
    .prepare("SELECT actor_id, title, detail, workspace_id FROM audit_events WHERE kind = ?")
    .all(kind)
    .map((row) => ({
      actorId: String(row.actor_id),
      title: String(row.title),
      detail: JSON.parse(String(row.detail)) as unknown,
      workspaceId: row.workspace_id,
    }));
}

export function baseCount(world: World): number {
  const row = world.db.prepare("SELECT COUNT(*) AS count FROM knowledge_bases").get();
  return Number(row?.count);
}

export function datasetIdOf(world: World, id: string): string {
  const base = world.store.getBase(id);
  if (base === undefined) {
    throw new Error("no such knowledge base");
  }
  return base.datasetId;
}

/** 这一账号的 id：种子行要写 `owner_id`，不假定账号表的取值。 */
export function ownerIdOf(world: World, id: string): string {
  const base = world.store.getBase(id);
  if (base === undefined) {
    throw new Error("no such knowledge base");
  }
  return base.ownerId;
}
