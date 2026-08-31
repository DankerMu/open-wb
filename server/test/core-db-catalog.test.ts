import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CatalogStateCase,
  COMPLETE_CATALOG,
  COMPLETE_CATALOG_WITH_UNRELATED_TRIGGER,
  createCanonicalLedger,
  createValid0010Prefix,
  createValidCompletePrefix,
  EMPTY_CATALOG,
  expectCatalogSnapshot,
  expectFailedOpenToPreserveFullCatalog,
  expectNoBootstrapLedger,
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  fullCatalogSnapshot,
  ledgerFilenames,
  MIGRATION_0010,
  PREFIX_CATALOG,
  removeTempDirs,
  type SqlLineEnding,
  tableExists,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";

afterEach(removeTempDirs);

function seedReservedObject(db: DatabaseSync, kind: string, name: string): void {
  db.exec("CREATE TABLE reserved_object_target (value TEXT)");

  if (kind === "表" || kind === "大小写变体") {
    db.exec(`CREATE TABLE ${name} (value TEXT)`);
  } else if (kind === "视图") {
    db.exec(`CREATE VIEW ${name} AS SELECT value FROM reserved_object_target`);
  } else if (kind === "索引") {
    db.exec(`CREATE INDEX ${name} ON reserved_object_target(value)`);
  } else {
    db.exec(`CREATE TRIGGER ${name} AFTER INSERT ON reserved_object_target BEGIN SELECT 1; END`);
  }
}

describe("core/db catalog protocol", () => {
  it.each<CatalogStateCase>([
    {
      name: "空规范账本",
      seed: createCanonicalLedger,
      before: EMPTY_CATALOG,
      after: COMPLETE_CATALOG,
    },
    {
      name: "规范 0010 前缀",
      seed: createValid0010Prefix,
      before: PREFIX_CATALOG,
      after: COMPLETE_CATALOG,
    },
    {
      name: "完整规范前缀",
      seed: createValidCompletePrefix,
      before: COMPLETE_CATALOG,
      after: COMPLETE_CATALOG,
    },
    {
      name: "小写额外账本触发器",
      seed: (db) => {
        createCanonicalLedger(db);
        db.exec(
          "CREATE TRIGGER lowercase_ledger_trigger BEFORE INSERT ON schema_migrations BEGIN SELECT 1; END",
        );
      },
      before: { ...EMPTY_CATALOG, triggerNames: ["lowercase_ledger_trigger"] },
      failure: /schema_migrations triggers do not match the receipt prefix/,
    },
    {
      name: "大写目标的额外账本触发器",
      seed: (db) => {
        createCanonicalLedger(db);
        db.exec(
          "CREATE TRIGGER uppercase_ledger_trigger BEFORE INSERT ON SCHEMA_MIGRATIONS BEGIN SELECT 1; END",
        );
      },
      before: { ...EMPTY_CATALOG, triggerNames: ["uppercase_ledger_trigger"] },
      failure: /schema_migrations triggers do not match the receipt prefix/,
    },
    {
      name: "正文提及账本的无关表触发器",
      seed: (db) => {
        createCanonicalLedger(db);
        db.exec(`CREATE TABLE unrelated_trigger_target (value TEXT);
CREATE TRIGGER unrelated_table_trigger AFTER INSERT ON unrelated_trigger_target
BEGIN
  SELECT (SELECT COUNT(*) FROM schema_migrations);
END`);
      },
      before: { ...EMPTY_CATALOG, triggerNames: ["unrelated_table_trigger"] },
      after: COMPLETE_CATALOG_WITH_UNRELATED_TRIGGER,
    },
    {
      name: "空账本的已污染计数器",
      seed: (db) => {
        createCanonicalLedger(db);
        db.exec("INSERT OR IGNORE INTO schema_migrations(filename) VALUES (NULL)");
      },
      before: {
        ...EMPTY_CATALOG,
        sequenceRows: [["schema_migrations", 1, "integer"]],
      },
      failure: /sqlite_sequence state is not canonical for an empty ledger/,
    },
    {
      name: "0010 前缀的超前计数器",
      seed: (db) => {
        createValid0010Prefix(db);
        db.exec("UPDATE sqlite_sequence SET seq = 2 WHERE name = 'schema_migrations'");
      },
      before: { ...PREFIX_CATALOG, sequenceRows: [["schema_migrations", 2, "integer"]] },
      failure: /sqlite_sequence state does not match ledger receipts/,
    },
    {
      name: "0010 前缀缺失计数器",
      seed: (db) => {
        createValid0010Prefix(db);
        db.exec("DELETE FROM sqlite_sequence WHERE name = 'schema_migrations'");
      },
      before: { ...PREFIX_CATALOG, sequenceRows: [] },
      failure: /sqlite_sequence state does not match ledger receipts/,
    },
    {
      name: "0010 前缀只有大小写变体的计数器行",
      seed: (db) => {
        createValid0010Prefix(db);
        db.exec("UPDATE sqlite_sequence SET name = 'SCHEMA_MIGRATIONS'");
      },
      before: { ...PREFIX_CATALOG, sequenceRows: [["SCHEMA_MIGRATIONS", 1, "integer"]] },
      failure: /sqlite_sequence state does not match ledger receipts/,
    },
    {
      name: "0010 前缀有大小写变体的重复计数器行",
      seed: (db) => {
        createValid0010Prefix(db);
        db.exec("INSERT INTO sqlite_sequence(name, seq) VALUES ('SCHEMA_MIGRATIONS', 1)");
      },
      before: {
        ...PREFIX_CATALOG,
        sequenceRows: [
          ["schema_migrations", 1, "integer"],
          ["SCHEMA_MIGRATIONS", 1, "integer"],
        ],
      },
      failure: /sqlite_sequence state does not match ledger receipts/,
    },
    {
      name: "0010 前缀有数值相等但非整数的计数器",
      seed: (db) => {
        createValid0010Prefix(db);
        db.exec("UPDATE sqlite_sequence SET seq = 1.0 WHERE name = 'schema_migrations'");
      },
      before: { ...PREFIX_CATALOG, sequenceRows: [["schema_migrations", 1, "real"]] },
      failure: /sqlite_sequence state does not match ledger receipts/,
    },
    {
      name: "0010 前缀有负计数器",
      seed: (db) => {
        createValid0010Prefix(db);
        db.exec("UPDATE sqlite_sequence SET seq = -1 WHERE name = 'schema_migrations'");
      },
      before: { ...PREFIX_CATALOG, sequenceRows: [["schema_migrations", -1, "integer"]] },
      failure: /sqlite_sequence state does not match ledger receipts/,
    },
  ])("$name 在新迁移效果前满足完整 SQLite 目录状态约束", (state) => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      state.seed(db);
      expectCatalogSnapshot(db, state.before);
    });

    if (state.failure === undefined) {
      withOpenDb(file, (db) => {
        expectCatalogSnapshot(db, state.after ?? state.before);
      });
      return;
    }

    expectOpenDbFailure(file, state.failure);
    withDatabase(file, (db) => {
      expectCatalogSnapshot(db, state.before);
    });
  });

  it.each([
    ["表", "schema_migrations_no_update"],
    ["视图", "schema_migrations_no_reinsert"],
    ["索引", "schema_migration_history"],
    ["触发器", "schema_migration_history"],
    ["大小写变体", "SCHEMA_MIGRATIONS_NO_DELETE"],
  ])("无账本且有保留%s时在 DDL 前失败并完整保留目录", (kind, name) => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => seedReservedObject(db, kind, name));

    expectFailedOpenToPreserveFullCatalog(
      file,
      /migration ledger reserved catalog exists before bootstrap/,
    );
    withDatabase(file, expectNoBootstrapLedger);
  });

  it("无关对象允许首次和重复打开，且目录稳定", () => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      db.exec(`CREATE TABLE unrelated_table (value TEXT);
CREATE TRIGGER unrelated_trigger AFTER INSERT ON unrelated_table BEGIN SELECT 1; END`);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(tableExists(db, "unrelated_table")).toBe(true);
      expect(
        db.prepare("SELECT type FROM sqlite_master WHERE name = 'unrelated_trigger'").get()?.type,
      ).toBe("trigger");
    });
  });

  it.each([
    "pragma_table_xinfo",
    "pragma_table_list",
    "pragma_foreign_key_list",
    "pragma_index_list",
    "pragma_index_xinfo",
  ])("%s 表不能遮蔽首次或重复打开的固定 PRAGMA 读取", (shadowName) => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => db.exec(`CREATE TABLE ${shadowName} (value TEXT)`));

    expectRepeatedOpenStable(file, (db) => {
      expect(tableExists(db, shadowName)).toBe(true);
    });
  });

  it.each([
    ["精确名称", "INSERT INTO sqlite_sequence(name, seq) VALUES ('schema_migrations', 7)"],
    ["大小写变体", "INSERT INTO sqlite_sequence(name, seq) VALUES ('SCHEMA_MIGRATIONS', 7)"],
    [
      "大小写变体重复行",
      "INSERT INTO sqlite_sequence(name, seq) VALUES ('schema_migrations', 7); INSERT INTO sqlite_sequence(name, seq) VALUES ('SCHEMA_MIGRATIONS', 8)",
    ],
    ["非整数", "INSERT INTO sqlite_sequence(name, seq) VALUES ('schema_migrations', 1.5)"],
    ["非数值", "INSERT INTO sqlite_sequence(name, seq) VALUES ('schema_migrations', 'poison')"],
    ["负数", "INSERT INTO sqlite_sequence(name, seq) VALUES ('schema_migrations', -1)"],
    ["超前值", "INSERT INTO sqlite_sequence(name, seq) VALUES ('schema_migrations', 99)"],
  ])("无账本且有%s隐藏计数器时完整保留失败前快照", (_name, poison) => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      db.exec("CREATE TABLE another_autoincrement (id INTEGER PRIMARY KEY AUTOINCREMENT)");
      db.exec(poison);
    });

    expectFailedOpenToPreserveFullCatalog(
      file,
      /sqlite_sequence state exists before ledger bootstrap/,
    );
  });

  it("真正空白数据库在 bootstrap 后可重复验证", () => {
    const file = join(tempDir(), "app.db");

    const first = withOpenDb(file, (db) => ({
      catalog: fullCatalogSnapshot(db),
      receipts: ledgerFilenames(db),
    }));
    withOpenDb(file, (db) => {
      expect(ledgerFilenames(db)).toEqual(first.receipts);
      expect(fullCatalogSnapshot(db)).toEqual(first.catalog);
      expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, "002_schema_migrations_history.sql"]);
    });
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["lone CR", "\r"],
  ] as const)("%s 规范基座在空账本、0010 前缀与完整目录中均可稳定重开", (_name, lineEnding) => {
    const cases: ReadonlyArray<
      readonly [string, (db: DatabaseSync, ending: SqlLineEnding) => void]
    > = [
      ["空账本", (db) => createCanonicalLedger(db)],
      ["0010 前缀", createValid0010Prefix],
      ["完整目录", createValidCompletePrefix],
    ];

    for (const [stateName, seed] of cases) {
      const file = join(tempDir(), `${stateName}.db`);
      withDatabase(file, (db) => seed(db, lineEnding));

      expectRepeatedOpenStable(file, (db) => {
        expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, "002_schema_migrations_history.sql"]);
      });
    }
  });

  it.each([
    [
      "触发器主体",
      "schema_migrations_no_update",
      "SELECT RAISE(ABORT, 'UPDATE on schema_migrations is forbidden');",
      "SELECT 1;",
    ],
    [
      "触发器消息",
      "schema_migrations_no_update",
      "UPDATE on schema_migrations is forbidden",
      "UPDATE on schema_migrations changed",
    ],
    ["视图排序 token", "schema_migration_history", "ORDER BY sequence", "ORDER BY filename"],
  ])("规范基座的非 EOL %s 漂移仍被拒绝并保留完整目录", (_name, objectName, expected, drifted) => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      createValidCompletePrefix(db, "\r\n");
      const object = db
        .prepare("SELECT type, sql FROM sqlite_master WHERE name = ?")
        .get(objectName) as { type: string; sql: string };
      const alteredDefinition = object.sql.replace(expected, drifted);
      expect(alteredDefinition).not.toBe(object.sql);
      db.exec(`DROP ${object.type} ${objectName}`);
      db.exec(alteredDefinition);
    });

    expectFailedOpenToPreserveFullCatalog(file, /migration ledger reserved catalog does not match/);
  });
});
