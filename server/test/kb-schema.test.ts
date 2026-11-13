/**
 * Issue #1836（任务 7.2）：knowledge-bases「迁移 050 知识库 schema」的表形状，经 `openDb` 的真实迁移测。
 * 「约束」场景的九例在 `kb-store.test.ts`；这里是 spec 列出的其余约束，逐列一个非法取值与它的合法对照。
 * 直接写 SQL：表约束是 store 之外的最后一道兜底，要证明它自己拒绝。期望值是 spec 与 design 里的字面量。
 * Issue #1911（s2b 任务 1.2）：「迁移 051 检索参数与重排模型」的「列与约束」场景与 050 库升级不改其它表；
 * 完整迁移链的表形状断言是 051 之后的形状。
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  COMPLETE_CATALOG,
  expectCatalogSnapshot,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_049,
  MIGRATION_050,
  MIGRATION_051,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  uniqueIndexKeys,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import { seedPopulated034, seedThrough, sortedForeignKeys } from "./core-db-session-fixture.js";
import {
  BASE_ROW,
  CHECK,
  COMPILE_ROW,
  FOREIGN_KEY,
  hex,
  insertRow,
  type Row,
  rows,
  T0,
  UPLOAD_ROW,
  useKbDatabases,
  WORKSPACE_ROW,
} from "./kb-store-helpers.js";

const NEW_TABLES = ["kb_settings", "knowledge_bases", "kb_documents"];
type SchemaRow = Record<string, unknown>;

const fresh = useKbDatabases();

function tableInfo(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
}

/** 除新表及其自动索引之外的全部 schema 对象。 */
function existingSchema(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all()
    .filter((row) => !NEW_TABLES.includes(String(row.tbl_name)));
}

/** 完整链在 050 / 051 之后还有 052（#1970）：只给 chat_messages 的表定义在 `thinking_ms` 后添一列。 */
function with052(schema: SchemaRow[]): SchemaRow[] {
  return schema.map((row) =>
    row.name === "chat_messages"
      ? {
          ...row,
          sql: String(row.sql).replace(
            " thinking_ms INTEGER,",
            " thinking_ms INTEGER, knowledge_bases TEXT NULL,",
          ),
        }
      : row,
  );
}

describe("migration 050 schema", () => {
  it("is tracked once, right after 049, with its receipt at position 24", () => {
    const pos = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_050);
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_050)).toHaveLength(1);
    expect(TRACKED_MIGRATION_FILENAMES[pos - 1]).toBe(MIGRATION_049);
    expect(COMPLETE_CATALOG.receipts[pos]).toEqual([24, MIGRATION_050]);
    const { db } = fresh();
    expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
  });

  it("builds exactly the spec's columns on the three tables (051 appends to kb_settings and knowledge_bases)", () => {
    const { db } = fresh();
    expect(tableInfo(db, "kb_settings")).toEqual([
      ["id", "TEXT", 1, null, 1],
      ["embedding_name", "TEXT", 0, null, 0],
      ["embedding_base_url", "TEXT", 0, null, 0],
      ["embedding_api_key", "TEXT", 0, null, 0],
      ["embedding_generation", "INTEGER", 1, "0", 0],
      ["embedding_probe_status", "TEXT", 1, "'never'", 0],
      ["embedding_probe_at", "INTEGER", 0, null, 0],
      ["embedding_probe_message", "TEXT", 0, null, 0],
      ["chat_model_id", "TEXT", 0, null, 0],
      ["rebuild_actor_id", "TEXT", 0, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
      ["rerank_name", "TEXT", 0, null, 0],
      ["rerank_base_url", "TEXT", 0, null, 0],
      ["rerank_api_key", "TEXT", 0, null, 0],
      ["rerank_probe_status", "TEXT", 1, "'never'", 0],
      ["rerank_probe_at", "INTEGER", 0, null, 0],
      ["rerank_probe_message", "TEXT", 0, null, 0],
    ]);
    expect(tableInfo(db, "knowledge_bases")).toEqual([
      ["id", "TEXT", 1, null, 1],
      ["owner_id", "TEXT", 1, null, 0],
      ["name", "TEXT", 1, null, 0],
      ["template", "TEXT", 1, null, 0],
      ["raptor", "INTEGER", 1, null, 0],
      ["graph", "INTEGER", 1, null, 0],
      ["dataset_id", "TEXT", 1, null, 0],
      ["rebuild_dataset_id", "TEXT", 0, null, 0],
      ["canvas_id", "TEXT", 0, null, 0],
      ["template_group_id", "TEXT", 0, null, 0],
      ["rebuild_canvas_id", "TEXT", 0, null, 0],
      ["rebuild_template_group_id", "TEXT", 0, null, 0],
      ["embedding_generation", "INTEGER", 1, null, 0],
      ["state", "TEXT", 1, null, 0],
      ["state_message", "TEXT", 0, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
      ["retrieval_threshold", "REAL", 1, "0.2", 0],
      ["retrieval_vector_weight", "REAL", 1, "0.7", 0],
    ]);
    expect(tableInfo(db, "kb_documents")).toEqual([
      ["id", "TEXT", 1, null, 1],
      ["kb_id", "TEXT", 1, null, 0],
      ["ragflow_document_id", "TEXT", 1, null, 0],
      ["name", "TEXT", 1, null, 0],
      ["size", "INTEGER", 1, null, 0],
      ["source", "TEXT", 1, null, 0],
      ["workspace_id", "TEXT", 0, null, 0],
      ["source_path", "TEXT", 0, null, 0],
      ["source_mtime_ms", "INTEGER", 0, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
    ]);
  });

  it("inserts the one kb_settings row and nothing else", () => {
    const { db } = fresh();
    expect(rows(db, "kb_settings")).toEqual([
      {
        id: "kb",
        embedding_name: null,
        embedding_base_url: null,
        embedding_api_key: null,
        embedding_generation: 0,
        embedding_probe_status: "never",
        embedding_probe_at: null,
        embedding_probe_message: null,
        chat_model_id: null,
        rebuild_actor_id: null,
        updated_at: 0,
        rerank_name: null,
        rerank_base_url: null,
        rerank_api_key: null,
        rerank_probe_status: "never",
        rerank_probe_at: null,
        rerank_probe_message: null,
      },
    ]);
    expect(rows(db, "knowledge_bases")).toEqual([]);
    expect(rows(db, "kb_documents")).toEqual([]);
  });

  it("declares the foreign keys and unique keys of design D6; workspace_id has no foreign key", () => {
    const { db } = fresh();
    const keys = (table: string) =>
      sortedForeignKeys(db, table).map((key) => [key.from, key.table, key.to, key.on_delete]);
    expect(keys("kb_settings")).toEqual([
      ["chat_model_id", "models", "id", "SET NULL"],
      ["rebuild_actor_id", "accounts", "id", "NO ACTION"],
    ]);
    expect(keys("knowledge_bases")).toEqual([["owner_id", "accounts", "id", "RESTRICT"]]);
    expect(keys("kb_documents")).toEqual([["kb_id", "knowledge_bases", "id", "CASCADE"]]);
    expect(uniqueIndexKeys(db, "kb_settings")).toEqual([["id"]]);
    expect(uniqueIndexKeys(db, "knowledge_bases")).toEqual([["id"], ["owner_id", "name"]]);
    expect(uniqueIndexKeys(db, "kb_documents")).toEqual([
      ["id"],
      ["kb_id", "workspace_id", "source_path"],
    ]);
  });

  it("a populated database ending at 049 upgrades without touching any existing table", () => {
    const file = join(tempDir(), "populated-049.db");
    const through049 = TRACKED_MIGRATION_FILENAMES.slice(
      0,
      TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_050),
    );
    seedThrough(file, through049, seedPopulated034);
    const before = withDatabase(file, (db) => ({
      schema: existingSchema(db),
      accounts: rows(db, "accounts"),
      workspaces: rows(db, "workspaces"),
    }));
    withOpenDb(file, (db) => {
      expect(existingSchema(db)).toEqual(with052(before.schema));
      expect(rows(db, "accounts")).toEqual(before.accounts);
      expect(rows(db, "workspaces")).toEqual(before.workspaces);
      expect(rows(db, "kb_settings")).toHaveLength(1);
      expect(rows(db, "knowledge_bases")).toEqual([]);
      expect(rows(db, "kb_documents")).toEqual([]);
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
    });
  });
});

const RERANK_COLUMNS = [
  "rerank_name",
  "rerank_base_url",
  "rerank_api_key",
  "rerank_probe_status",
  "rerank_probe_at",
  "rerank_probe_message",
];
const RETRIEVAL_COLUMNS = ["retrieval_threshold", "retrieval_vector_weight"];
const ALTERED_TABLES = ["kb_settings", "knowledge_bases"];

/** 跑完 050 为止的迁移再预置数据：一个停在 050 的库。 */
function seed050(file: string, seed: (db: DatabaseSync) => void): void {
  const through050 = TRACKED_MIGRATION_FILENAMES.slice(
    0,
    TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_051),
  );
  expect(through050.at(-1)).toBe(MIGRATION_050);
  seedThrough(file, through050, seed);
}

/** 除 051 改动的两张表之外的全部 schema 对象（kb_documents 也在其内）。 */
function untouchedSchema(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all()
    .filter((row) => !ALTERED_TABLES.includes(String(row.tbl_name)));
}

/** 某表除给定列之外的整行，按 id 排序。 */
function rowsWithout(db: DatabaseSync, table: string, dropped: readonly string[]) {
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY id`)
    .all()
    .map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !dropped.includes(key))),
    );
}

describe("迁移 051 检索参数与重排模型", () => {
  it("列与约束：050 库上应用后取列缺省；两列越界与非数字文本被拒，两端 0 与 1 存成 real", () => {
    const file = join(tempDir(), "kb-050.db");
    seed050(file, (db) => insertRow(db, "knowledge_bases", BASE_ROW));
    withOpenDb(file, (db) => {
      expect(
        db
          .prepare(
            "SELECT retrieval_threshold, typeof(retrieval_threshold) AS threshold_type, retrieval_vector_weight, typeof(retrieval_vector_weight) AS weight_type FROM knowledge_bases",
          )
          .all(),
      ).toEqual([
        {
          retrieval_threshold: 0.2,
          threshold_type: "real",
          retrieval_vector_weight: 0.7,
          weight_type: "real",
        },
      ]);
      expect(db.prepare(`SELECT ${RERANK_COLUMNS.join(", ")} FROM kb_settings`).all()).toEqual([
        {
          rerank_name: null,
          rerank_base_url: null,
          rerank_api_key: null,
          rerank_probe_status: "never",
          rerank_probe_at: null,
          rerank_probe_message: null,
        },
      ]);
      const stored = () =>
        db
          .prepare(
            "SELECT retrieval_threshold, typeof(retrieval_threshold) AS threshold_type, retrieval_vector_weight, typeof(retrieval_vector_weight) AS weight_type FROM knowledge_bases",
          )
          .all();
      const current = { retrieval_threshold: 0.2, retrieval_vector_weight: 0.7 };
      for (const column of RETRIEVAL_COLUMNS) {
        for (const value of [1.5, -0.1, "abc"]) {
          expect(() => db.prepare(`UPDATE knowledge_bases SET ${column} = ?`).run(value)).toThrow(
            CHECK,
          );
        }
        // 两端用 SQL 整数字面量：node:sqlite 把 JS number 绑成 double，绑参走不到 REAL 亲和性把整数转成 real 的路径。
        for (const endpoint of [0, 1]) {
          db.exec(`UPDATE knowledge_bases SET ${column} = ${endpoint}`);
          Object.assign(current, { [column]: endpoint });
          expect(stored()).toEqual([{ ...current, threshold_type: "real", weight_type: "real" }]);
        }
      }
    });
  });

  it("重排探活状态只认 never、ok、failed", () => {
    const { db } = fresh();
    expect(() => db.exec("UPDATE kb_settings SET rerank_probe_status = 'unknown'")).toThrow(CHECK);
    for (const status of ["ok", "failed", "never"]) {
      db.prepare("UPDATE kb_settings SET rerank_probe_status = ?").run(status);
      expect(rows(db, "kb_settings")).toMatchObject([{ rerank_probe_status: status }]);
    }
  });

  it("050 库升级只给两张表加列：既有列值不变，其它表的 schema 不变，回执落在第 25 位", () => {
    const file = join(tempDir(), "populated-050.db");
    seed050(file, (db) => {
      insertRow(db, "knowledge_bases", {
        ...COMPILE_ROW,
        name: "旧库",
        rebuild_dataset_id: "ds-next",
        rebuild_canvas_id: "canvas-next",
        rebuild_template_group_id: "group-next",
        embedding_generation: 3,
        state: "rebuild_failed",
        state_message: "重建失败",
        updated_at: T0 + 5,
      });
      insertRow(db, "kb_documents", UPLOAD_ROW);
      db.prepare(
        "UPDATE kb_settings SET embedding_name = ?, embedding_base_url = ?, embedding_api_key = ?, embedding_generation = 3, embedding_probe_status = 'ok', embedding_probe_at = ?, updated_at = ? WHERE id = 'kb'",
      ).run("bge-m3", "http://embed/v1", "k-050", T0 + 1, T0 + 2);
    });
    const before = withDatabase(file, (db) => ({
      schema: untouchedSchema(db),
      settings: rows(db, "kb_settings"),
      bases: rows(db, "knowledge_bases"),
      documents: rows(db, "kb_documents"),
    }));
    expect(before.settings).toMatchObject([
      { embedding_name: "bge-m3", embedding_probe_status: "ok", embedding_generation: 3 },
    ]);
    expect(before.bases).toMatchObject([{ state: "rebuild_failed", embedding_generation: 3 }]);
    withOpenDb(file, (db) => {
      expect(untouchedSchema(db)).toEqual(with052(before.schema));
      expect(rowsWithout(db, "kb_settings", RERANK_COLUMNS)).toEqual(before.settings);
      expect(rowsWithout(db, "knowledge_bases", RETRIEVAL_COLUMNS)).toEqual(before.bases);
      expect(rows(db, "kb_documents")).toEqual(before.documents);
      expect(
        db.prepare(`SELECT ${RETRIEVAL_COLUMNS.join(", ")} FROM knowledge_bases`).all(),
      ).toEqual([{ retrieval_threshold: 0.2, retrieval_vector_weight: 0.7 }]);
      const pos051 = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_051);
      expect(ledgerRows(db)[pos051]).toEqual([25, MIGRATION_051]);
      expect(TRACKED_MIGRATION_FILENAMES[pos051 - 1]).toBe(MIGRATION_050);
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(COMPLETE_CATALOG.sequenceRows).toEqual([["schema_migrations", 26, "integer"]]);
      expectCatalogSnapshot(db, COMPLETE_CATALOG);
    });
  });
});

describe("迁移 050 的约束", () => {
  it.each<[string, string]>([
    ["只有名称", "embedding_name = 'n'"],
    ["只有地址", "embedding_base_url = 'http://x/v1'"],
    ["只有密钥", "embedding_api_key = 'k'"],
    ["缺名称", "embedding_base_url = 'http://x/v1', embedding_api_key = 'k'"],
    ["缺地址", "embedding_name = 'n', embedding_api_key = 'k'"],
    ["缺密钥", "embedding_name = 'n', embedding_base_url = 'http://x/v1'"],
    ["未知探活状态", "embedding_probe_status = 'unknown'"],
  ])("kb_settings 拒绝 %s", (_name, assignment) => {
    const { db } = fresh();
    expect(() => db.exec(`UPDATE kb_settings SET ${assignment}`)).toThrow(CHECK);
  });

  it("kb_settings 的两个引用只认真实的行：未知模型与未知账号被外键拒绝", () => {
    const { db } = fresh();
    expect(() => db.exec("UPDATE kb_settings SET chat_model_id = 'nope'")).toThrow(FOREIGN_KEY);
    expect(() => db.exec("UPDATE kb_settings SET rebuild_actor_id = 'nope'")).toThrow(FOREIGN_KEY);
  });

  it.each<[string, Row]>([
    ["大写 id", { ...BASE_ROW, id: "A".repeat(32) }],
    ["31 位 id", { ...BASE_ROW, id: "a".repeat(31) }],
    ["含 NUL 的 31 位 id", { ...BASE_ROW, id: `${"a".repeat(31)}\u0000` }],
    ["32 位之后接 NUL 的 id", { ...BASE_ROW, id: `${"a".repeat(32)}\u0000` }],
    ["非十六进制 id", { ...BASE_ROW, id: "g".repeat(32) }],
    ["空名称", { ...BASE_ROW, name: "" }],
    ["65 码点的名称", { ...BASE_ROW, name: "知".repeat(65) }],
    ["含 C0 的名称", { ...BASE_ROW, name: "a\u0001b" }],
    ["含 NUL 的名称", { ...BASE_ROW, name: "a\u0000b" }],
    ["NUL 后接超长内容的名称", { ...BASE_ROW, name: `\u0000${"知".repeat(65)}` }],
    ["字符后接 NUL 与超长内容的名称", { ...BASE_ROW, name: `a\u0000${"知".repeat(65)}` }],
    ["含 DEL 的名称", { ...BASE_ROW, name: "a\u007fb" }],
    ["十一种之外的模板", { ...BASE_ROW, template: "general" }],
    ["raptor 不是 0 或 1", { ...COMPILE_ROW, raptor: 2 }],
    ["graph 不是 0 或 1", { ...COMPILE_ROW, graph: 2 }],
    ["未知 state", { ...BASE_ROW, state: "failed" }],
    ["开编译而缺画布", { ...COMPILE_ROW, canvas_id: null }],
    ["开编译而缺模板组", { ...COMPILE_ROW, template_group_id: null }],
    ["开知识图谱而画布、模板组都缺", { ...BASE_ROW, graph: 1 }],
    ["两开关都关而画布非空", { ...BASE_ROW, canvas_id: "c" }],
    ["两开关都关而模板组非空", { ...BASE_ROW, template_group_id: "g" }],
    ["新一代数据集为空而画布非空", { ...BASE_ROW, rebuild_canvas_id: "c" }],
    ["新一代数据集为空而模板组非空", { ...BASE_ROW, rebuild_template_group_id: "g" }],
    [
      "普通库的新一代数据集为空而画布、模板组都在",
      { ...BASE_ROW, rebuild_canvas_id: "c", rebuild_template_group_id: "g" },
    ],
    ["开编译的库新一代只有数据集", { ...COMPILE_ROW, rebuild_dataset_id: "d" }],
    ["新一代缺画布", { ...COMPILE_ROW, rebuild_dataset_id: "d", rebuild_template_group_id: "g" }],
    ["新一代缺模板组", { ...COMPILE_ROW, rebuild_dataset_id: "d", rebuild_canvas_id: "c" }],
    [
      "两开关都关而新一代带画布与模板组",
      {
        ...BASE_ROW,
        rebuild_dataset_id: "d",
        rebuild_canvas_id: "c",
        rebuild_template_group_id: "g",
      },
    ],
  ])("knowledge_bases 拒绝 %s", (_name, row) => {
    const { db } = fresh();
    expect(() => insertRow(db, "knowledge_bases", row)).toThrow(CHECK);
    expect(rows(db, "knowledge_bases")).toEqual([]);
  });

  it("knowledge_bases 的 owner 引用 RESTRICT：未知账号被拒，账号有库时不能删", () => {
    const { db } = fresh();
    expect(() => insertRow(db, "knowledge_bases", { ...BASE_ROW, owner_id: "nope" })).toThrow(
      FOREIGN_KEY,
    );
    insertRow(db, "knowledge_bases", BASE_ROW);
    expect(() => db.prepare("DELETE FROM accounts WHERE id = 'u1'").run()).toThrow(FOREIGN_KEY);
  });

  it.each([
    "naive",
    "book",
    "email",
    "laws",
    "manual",
    "one",
    "paper",
    "picture",
    "presentation",
    "qa",
    "table",
  ])("knowledge_bases 接受模板 %s", (template) => {
    const { db } = fresh();
    insertRow(db, "knowledge_bases", { ...BASE_ROW, template });
    expect(rows(db, "knowledge_bases")).toMatchObject([{ id: hex(1), template }]);
  });

  it.each<[string, Row]>([
    ["64 码点的名称", { ...BASE_ROW, name: "知".repeat(64) }],
    ["开 RAPTOR", COMPILE_ROW],
    ["开知识图谱", { ...COMPILE_ROW, raptor: 0, graph: 1 }],
    ["两个开关都开", { ...COMPILE_ROW, graph: 1 }],
    ["普通库的新一代只有数据集", { ...BASE_ROW, rebuild_dataset_id: "d" }],
    [
      "开编译的库的新一代三列齐全",
      {
        ...COMPILE_ROW,
        rebuild_dataset_id: "d",
        rebuild_canvas_id: "c",
        rebuild_template_group_id: "g",
      },
    ],
  ])("knowledge_bases 接受 %s", (_name, row) => {
    const { db } = fresh();
    insertRow(db, "knowledge_bases", row);
    expect(rows(db, "knowledge_bases")).toHaveLength(1);
  });

  it.each<[string, Row]>([
    ["未知 source", { ...UPLOAD_ROW, source: "web" }],
    ["upload 带 workspace_id", { ...UPLOAD_ROW, workspace_id: "w1" }],
    ["upload 带 source_mtime_ms", { ...UPLOAD_ROW, source_mtime_ms: T0 }],
    ["upload 三列齐全", { ...WORKSPACE_ROW, source: "upload" }],
    ["workspace 缺 workspace_id", { ...WORKSPACE_ROW, workspace_id: null }],
    ["workspace 缺 source_path", { ...WORKSPACE_ROW, source_path: null }],
    ["workspace 缺 source_mtime_ms", { ...WORKSPACE_ROW, source_mtime_ms: null }],
  ])("kb_documents 拒绝 %s", (_name, row) => {
    const { db } = fresh();
    insertRow(db, "knowledge_bases", BASE_ROW);
    expect(() => insertRow(db, "kb_documents", row)).toThrow(CHECK);
    expect(rows(db, "kb_documents")).toEqual([]);
  });

  it("kb_documents 要有所属的知识库，且接受 upload 与 workspace 两种形状", () => {
    const { db } = fresh();
    expect(() => insertRow(db, "kb_documents", UPLOAD_ROW)).toThrow(FOREIGN_KEY);
    insertRow(db, "knowledge_bases", BASE_ROW);
    insertRow(db, "kb_documents", UPLOAD_ROW);
    insertRow(db, "kb_documents", { ...WORKSPACE_ROW, id: "doc-2" });
    expect(rows(db, "kb_documents")).toHaveLength(2);
  });
});
