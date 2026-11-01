/**
 * `kb-store.test.ts` 与 `kb-schema.test.ts` 共用：`:memory:` 经真实迁移的库，与一组合法的原始行。
 * 每个用例只改一个字段，所以被拒的原因只可能是这个字段。
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { createKbStore } from "../src/kb/store.js";
import { removeTempDirs } from "./core-db-helpers.js";

export type Row = Record<string, SQLInputValue>;

export const T0 = 1_760_000_000_000;
export const CHECK = /CHECK constraint failed/;
export const FOREIGN_KEY = /FOREIGN KEY constraint failed/;
export const hex = (n: number) => n.toString(16).padStart(32, "0");

export const BASE_ROW: Row = {
  id: hex(1),
  owner_id: "u1",
  name: "产品文档",
  template: "naive",
  raptor: 0,
  graph: 0,
  dataset_id: "ds-1",
  embedding_generation: 0,
  state: "ready",
  created_at: T0,
  updated_at: T0,
};
export const COMPILE_ROW: Row = {
  ...BASE_ROW,
  raptor: 1,
  canvas_id: "canvas-1",
  template_group_id: "group-1",
};
export const UPLOAD_ROW: Row = {
  id: "doc-1",
  kb_id: hex(1),
  ragflow_document_id: "rf-1",
  name: "a.txt",
  size: 3,
  source: "upload",
  created_at: T0,
};
export const WORKSPACE_ROW: Row = {
  ...UPLOAD_ROW,
  source: "workspace",
  workspace_id: "w1",
  source_path: "docs/a.txt",
  source_mtime_ms: T0,
};
export const MODEL_ROW: Row = {
  id: "m1",
  name: "m1",
  reasoning: 0,
  vision: 0,
  max_tokens: 4096,
  created_at: T0,
  updated_at: T0,
};

/** 在所在文件登记假时钟与收尾，返回开库函数：每个用例一个新库。 */
export function useKbDatabases() {
  const opened: DatabaseSync[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const db of opened.splice(0)) db.close();
    removeTempDirs();
  });
  return () => {
    const db = openDb(":memory:");
    opened.push(db);
    return { db, store: createKbStore(db) };
  };
}

export function insertRow(db: DatabaseSync, table: string, row: Row): void {
  const columns = Object.keys(row);
  const slots = columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${slots})`).run(
    ...Object.values(row),
  );
}

export const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table}`).all();
