/**
 * `kb-bases.test.ts`、`kb-bases-list.test.ts` 与 `kb-bases-delete.test.ts` 共用（s2a-kb-ragflow tasks 9.2，#1846）：
 * 世界夹具是 `kb-settings-helpers.ts` 的，收尾的不变量断言照用。期望值是 spec 与实测记录的字面量。
 */
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import type { World } from "./kb-settings-helpers.js";

export const BASES = "/api/kb/bases";
export const POST_DATASETS = "POST /api/v1/datasets";
export const DELETE_DATASETS = "DELETE /api/v1/datasets";
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
