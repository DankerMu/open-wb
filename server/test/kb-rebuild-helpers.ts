/**
 * `kb-rebuild*.test.ts` 共用（s2a-kb-ragflow tasks 14.2，#1852）：世界是 `kb-settings-helpers.ts` 的，收尾的不变量断言照用；重建器
 * 经世界的调度缝 `world.rebuild()` 同步驱动。知识库经真实建库建出，文档行与假 RAGFlow 旧数据集里的原件由种子直接写入：这里关心
 * 的是重建的出站序列，不是入库。期望值是 spec 与实测记录（§9、§9.1）的字面量。
 */
import { expect } from "vitest";
import type { KbDocument } from "../src/kb/store.js";
import { auditsOf, DELETE_DATASETS, POST_DATASETS } from "./kb-bases-helpers.js";
import type { World } from "./kb-settings-helpers.js";

export const NEW_NAME = "bge-large";
/** §4.4：新一代数据集引用的三段式。 */
export const NEW_MODEL = `${NEW_NAME}@owb-embed@OpenAI-API-Compatible`;
export const DOWNLOAD = "GET /api/v1/datasets/*/documents/*";
export const UPLOAD = "POST /api/v1/datasets/*/documents";
export const PARSE = "POST /api/v1/datasets/*/documents/parse";
export const DATASETS = "DELETE /api/v1/datasets";
export const REBUILD_FAILED = "重建失败，可在模型设置里重试";
/** §9.1：文档不存在时的下载正文；文件内容也可以恰好是它。 */
export const NOT_FOUND_BODY = '{"code":404,"message":"Resource not found"}';
/** §9：0 字节文件的下载正文（HTTP 200，没有 Content-Disposition）。 */
export const EMPTY_FILE_BODY = '{"code":500,"message":"Failed to download document"}';
/** 假 RAGFlow 里没有的、形状合法的 id。 */
export const ABSENT = "0123456789abcdef0123456789abcdef";
/** 种子账号：lisi 是管理员（`u3`），zhangsan 是建库的普通用户。 */
export const ADMIN = "u3";

/** 带 `confirmRebuild:true` 把嵌入名称换成 `NEW_NAME`。 */
export function confirm(world: World) {
  const embedding = { ...world.embedding, name: NEW_NAME };
  return world.put({ embedding, confirmRebuild: true });
}

/** 该库的行；没有即抛，用例当场失败。 */
export function baseOf(world: World, id: string) {
  const base = world.store.getBase(id);
  if (base === undefined) {
    throw new Error(`no knowledge base ${id}`);
  }
  return base;
}

/**
 * 一份入库原件：假 RAGFlow 旧数据集里一份文档，本地一行上传来源的文档。`size` 缺省为原件的字节数；给别的值即「下载字节数与
 * 本地 `size` 不符」。
 */
export function seedDocument(
  world: World,
  kbId: string,
  name: string,
  content: string,
  size = Buffer.byteLength(content),
): KbDocument {
  const ragflowDocumentId = world.fake.addDocument(baseOf(world, kbId).datasetId, {
    name,
    content,
  });
  return world.store.addDocument({ kbId, ragflowDocumentId, name, size, source: "upload" });
}

/** 一行本地文档，旧数据集里没有它的原件：下载得 §9.1 的 not-found。 */
export function seedMissingDocument(world: World, kbId: string, name: string): KbDocument {
  const fields = { kbId, ragflowDocumentId: ABSENT, name, size: 5, source: "upload" as const };
  return world.store.addDocument(fields);
}

/** 一份文档在重建里的三个请求：从旧数据集下载，上传到新数据集，触发它的解析。 */
export function transferOf(oldDataset: string, newDataset: string, document: KbDocument) {
  return [
    `GET /api/v1/datasets/${oldDataset}/documents/${document.ragflowDocumentId}`,
    `POST /api/v1/datasets/${newDataset}/documents`,
    `POST /api/v1/datasets/${newDataset}/documents/parse`,
  ];
}

/** 普通库重建一次的出站序列：建新数据集 → 逐份转移 → 删旧数据集。 */
export function plainRebuildOf(
  oldDataset: string,
  newDataset: string,
  documents: KbDocument[],
): string[] {
  return [
    POST_DATASETS,
    ...documents.flatMap((document) => transferOf(oldDataset, newDataset, document)),
    DELETE_DATASETS,
  ];
}

/** 全部 `kb.rebuild` 审计的 actor 与 detail，旧的在前。 */
export function rebuildAudits(world: World) {
  return auditsOf(world, "kb.rebuild").map(({ actorId, detail }) => ({ actorId, detail }));
}

/** 重建失败：状态与固定句子，`kb.rebuild` 的最后一条是 `{id, result:"failed"}`，actor 是发起者。 */
export function expectRebuildFailed(world: World, id: string): void {
  expect(baseOf(world, id)).toMatchObject({
    state: "rebuild_failed",
    stateMessage: REBUILD_FAILED,
  });
  expect(rebuildAudits(world).at(-1)).toEqual({
    actorId: ADMIN,
    detail: { id, result: "failed" },
  });
}

/** 重建完成：`ready`，三个 `rebuild_*` 列为 NULL，代数为 1。 */
export function expectRebuilt(world: World, id: string): void {
  expect(baseOf(world, id)).toMatchObject({
    state: "ready",
    stateMessage: null,
    rebuildDatasetId: null,
    rebuildCanvasId: null,
    rebuildTemplateGroupId: null,
    embeddingGeneration: 1,
  });
}
