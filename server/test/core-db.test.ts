import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { compareMigrationFilenames, readMigrationAssets } from "../src/core/db/migration-assets.js";
import { runMigration } from "../src/core/db/migration-runner.js";

const MIGRATION_0010 = "0010_schema_migrations_update_guard.sql";
const MIGRATION_002 = "002_schema_migrations_history.sql";
const HISTORY_VIEW = "schema_migration_history";

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "core-db-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withDatabase<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function withOpenDb<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = openDb(path);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

/** 版本回执按 sequence（实际应用顺序）。 */
function ledgerRows(db: DatabaseSync): Array<[number, string]> {
  return db
    .prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence")
    .all()
    .map((row) => [Number(row.sequence), String(row.filename)]);
}

function ledgerFilenames(db: DatabaseSync): string[] {
  return ledgerRows(db).map(([, filename]) => filename);
}

/** 全部 schema 对象清单（名称/类型/定义），用于两次打开的一致性比较。 */
function schemaInventory(db: DatabaseSync): string {
  return JSON.stringify(
    db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
  );
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) !==
    undefined
  );
}

function migrationReceiptExists(db: DatabaseSync, filename: string): boolean {
  return (
    db.prepare("SELECT 1 FROM schema_migrations WHERE filename = ?").get(filename) !== undefined
  );
}

function createCanonicalLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE schema_migrations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function installValid0010Foundation(db: DatabaseSync): void {
  db.exec(`CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'UPDATE on schema_migrations is forbidden');
END;

CREATE TRIGGER schema_migrations_no_reinsert
BEFORE INSERT ON schema_migrations
WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE filename = NEW.filename)
  OR EXISTS (SELECT 1 FROM schema_migrations WHERE sequence = NEW.sequence)
BEGIN
  SELECT RAISE(ABORT, 'INSERT on schema_migrations reuses an existing receipt');
END;`);
}

function createWrongTriggerTarget(db: DatabaseSync): void {
  db.exec("CREATE TABLE wrong_trigger_target (value TEXT)");
}

function seedValid0010Prefix(path: string): void {
  withDatabase(path, (db) => {
    createCanonicalLedger(db);
    installValid0010Foundation(db);
    db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_0010);
  });
}

function expectOpenDbFailure(path: string, expectedError?: RegExp): void {
  let db: DatabaseSync | undefined;
  let capturedError: unknown;

  try {
    db = openDb(path);
  } catch (error) {
    capturedError = error;
  } finally {
    db?.close();
  }

  expect(capturedError).toBeDefined();
  if (expectedError !== undefined) {
    expect(capturedError).toMatchObject({ message: expect.stringMatching(expectedError) });
  }
}

function expectFailedOpenToPreserve(path: string, expectedEffect: string): void {
  expectOpenDbFailure(path);
  withDatabase(path, (db) => {
    expect(tableExists(db, "schema_migrations")).toBe(true);
    expect(tableExists(db, expectedEffect)).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_update'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_reinsert'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_delete'").get(),
    ).toBeUndefined();
  });
}

function fixtureMigration(filename: string, source: string): { filename: string; source: string } {
  return { filename, source };
}

function expectFailedMigrationPrefix(
  path: string,
  expectedError: RegExp,
  expectedReceipts: readonly string[],
  historyExists: boolean,
): void {
  expectOpenDbFailure(path, expectedError);
  withDatabase(path, (db) => {
    expect(ledgerFilenames(db)).toEqual(expectedReceipts);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migration_history'").get() !==
        undefined,
    ).toBe(historyExists);
  });
}

describe("core/db migration assets", () => {
  it("按 Unicode scalar code-point 而非 UTF-16 代码单元排序文件名", () => {
    const privateUse = "migration-.sql";
    const supplementary = "migration-\u{10000}.sql";

    expect([supplementary, privateUse].sort(compareMigrationFilenames)).toEqual([
      privateUse,
      supplementary,
    ]);
    expect(
      ["002_schema_migrations_history.sql", "0010_schema_migrations_update_guard.sql"].sort(
        compareMigrationFilenames,
      ),
    ).toEqual([MIGRATION_0010, MIGRATION_002]);
    expect(["migration-b.sql", "migration-a.sql"].sort(compareMigrationFilenames)).toEqual([
      "migration-a.sql",
      "migration-b.sql",
    ]);
    expect(compareMigrationFilenames("migration", "migration.sql")).toBeLessThan(0);
    expect(compareMigrationFilenames("migration.sql", "migration")).toBeGreaterThan(0);
  });

  it("特殊直属文件名读取自身字节，不会重定向到同目录、父目录或嵌套哨兵", () => {
    const parentDirectory = tempDir();
    const directory = join(parentDirectory, "assets");
    const nestedDirectory = join(directory, "nested");
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(parentDirectory, "parent-sentinel.sql"), "SELECT 'parent sentinel';");
    writeFileSync(join(directory, "sentinel.txt"), "SELECT 'sibling sentinel';");
    writeFileSync(join(nestedDirectory, "sentinel.sql"), "SELECT 'nested sentinel';");
    writeFileSync(join(directory, "#-own.sql"), "SELECT 'hash own';");
    writeFileSync(join(directory, "?-own.sql"), "SELECT 'question own';");
    writeFileSync(join(directory, "%-own.sql"), "SELECT 'percent own';");
    writeFileSync(join(directory, "雪-own.sql"), "SELECT 'unicode own';");
    writeFileSync(join(directory, "sentinel.txt#.sql"), "SELECT 'hash suffix own';");
    writeFileSync(join(directory, "sentinel.txt?.sql"), "SELECT 'question suffix own';");
    writeFileSync(join(directory, "sentinel%2Etxt#.sql"), "SELECT 'percent suffix own';");

    const expectedSources = new Map([
      ["#-own.sql", "SELECT 'hash own';"],
      ["?-own.sql", "SELECT 'question own';"],
      ["%-own.sql", "SELECT 'percent own';"],
      ["雪-own.sql", "SELECT 'unicode own';"],
      ["sentinel.txt#.sql", "SELECT 'hash suffix own';"],
      ["sentinel.txt?.sql", "SELECT 'question suffix own';"],
      ["sentinel%2Etxt#.sql", "SELECT 'percent suffix own';"],
    ]);
    if (process.platform !== "win32") {
      writeFileSync(join(directory, "\\-own.sql"), "SELECT 'backslash own';");
      expectedSources.set("\\-own.sql", "SELECT 'backslash own';");
    }

    const assets = readMigrationAssets(directory);
    expect(new Map(assets.map((asset) => [asset.filename, asset.source]))).toEqual(expectedSources);
    expect(assets.map((asset) => asset.filename)).not.toContain("nested/sentinel.sql");
    expect(assets.map((asset) => asset.source)).not.toContain("SELECT 'parent sentinel';");
    expect(assets.map((asset) => asset.source)).not.toContain("SELECT 'sibling sentinel';");
    expect(assets.map((asset) => asset.source)).not.toContain("SELECT 'nested sentinel';");
  });

  it("忽略符号链接直属项，不会沿链接读取目录外字节", () => {
    const directory = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "outside.sql"), "SELECT 'outside';");
    symlinkSync(join(outside, "outside.sql"), join(directory, "linked.sql"));

    expect(readMigrationAssets(directory)).toEqual([]);
  });
});

describe("core/db migration runner", () => {
  it.each([
    ["ROLLBACK", "CREATE TABLE rollback_escape (value TEXT); ROLLBACK;", "rollback_escape"],
    [
      "COMMIT",
      "CREATE TABLE commit_escape (value TEXT); COMMIT; CREATE TABLE missing (value TEXT, value TEXT);",
      "commit_escape",
    ],
    [
      "SAVEPOINT",
      "CREATE TABLE savepoint_escape (value TEXT); SAVEPOINT x; RELEASE x;",
      "savepoint_escape",
    ],
    ["RELEASE", "CREATE TABLE release_escape (value TEXT); RELEASE x;", "release_escape"],
  ])("拒绝迁移正文中的 %s，且不留下效果或回执", (_name, source, effectTable) => {
    withDatabase(":memory:", (db) => {
      createCanonicalLedger(db);
      const migration = fixtureMigration("control.sql", source);

      expect(() => runMigration(db, migration)).toThrow(/not authorized/);
      expect(tableExists(db, effectTable)).toBe(false);
      expect(migrationReceiptExists(db, migration.filename)).toBe(false);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("正常迁移将效果与回执一起提交", () => {
    withDatabase(":memory:", (db) => {
      createCanonicalLedger(db);
      const migration = fixtureMigration(
        "normal.sql",
        "CREATE TABLE normal_migration_effect (value TEXT);",
      );

      runMigration(db, migration);

      expect(tableExists(db, "normal_migration_effect")).toBe(true);
      expect(ledgerFilenames(db)).toEqual([migration.filename]);
      expect(db.isTransaction).toBe(false);
    });
  });
});

describe("core/db openDb", () => {
  it(":memory: 迁移按字典序应用并装好账本守卫", () => {
    withOpenDb(":memory:", (db) => {
      // 历史视图按 sequence（实际应用顺序）报告：0010 先于 002（字典序），
      // 与数值/自然序（002 先于 0010）可观察地不同。
      const history = db
        .prepare("SELECT filename FROM schema_migration_history")
        .all()
        .map((row) => String(row.filename));
      expect(history).toEqual([MIGRATION_0010, MIGRATION_002]);

      // 回执的 sequence 与字典序应用顺序一致。
      expect(ledgerRows(db)).toEqual([
        [1, MIGRATION_0010],
        [2, MIGRATION_002],
      ]);

      // 两个守卫触发器与历史视图都真实存在（UPDATE/DELETE/REPLACE 被拒是其生效证明）。
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all()
        .map((row) => String(row.name));
      expect(triggers).toContain("schema_migrations_no_update");
      expect(triggers).toContain("schema_migrations_no_reinsert");
      expect(triggers).toContain("schema_migrations_no_delete");
      const viewType = db
        .prepare("SELECT type FROM sqlite_master WHERE name = ?")
        .get(HISTORY_VIEW);
      expect(viewType?.type).toBe("view");

      expect(() => db.exec("UPDATE schema_migrations SET filename = filename")).toThrow(
        /UPDATE on schema_migrations is forbidden/,
      );
      expect(() => db.exec("DELETE FROM schema_migrations")).toThrow(
        /DELETE on schema_migrations is forbidden/,
      );

      const beforeReplace = ledgerRows(db);
      expect(() => {
        db.prepare("INSERT OR REPLACE INTO schema_migrations(filename) VALUES (?)").run(
          MIGRATION_0010,
        );
      }).toThrow(/reuses an existing receipt/);
      expect(ledgerRows(db)).toEqual(beforeReplace);

      expect(() => {
        db.prepare(
          "INSERT OR REPLACE INTO schema_migrations(sequence, filename) VALUES (?, ?)",
        ).run(1, "replacement.sql");
      }).toThrow(/reuses an existing receipt/);
      expect(ledgerRows(db)).toEqual(beforeReplace);
    });
  });

  it("临时文件库以 WAL 模式打开", () => {
    withOpenDb(join(tempDir(), "app.db"), (db) => {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    });
  });

  it("仓库外 cwd 打开时加载已跟踪迁移历史", () => {
    const originalCwd = process.cwd();
    const outsideRepo = tempDir();
    let db: DatabaseSync | undefined;

    try {
      process.chdir(outsideRepo);
      db = openDb(join(outsideRepo, "app.db"));
      const history = db
        .prepare("SELECT filename FROM schema_migration_history")
        .all()
        .map((row) => String(row.filename));
      expect(history).toEqual([MIGRATION_0010, MIGRATION_002]);
    } finally {
      try {
        db?.close();
      } finally {
        process.chdir(originalCwd);
      }
    }
  });

  it("同一路径重开不重复迁移且 schema 清单一致", () => {
    const file = join(tempDir(), "app.db");
    const firstResult = withOpenDb(file, (first) => ({
      receipts: ledgerFilenames(first),
      inventory: schemaInventory(first),
    }));

    withOpenDb(file, (second) => {
      expect(ledgerFilenames(second)).toEqual(firstResult.receipts);
      expect(schemaInventory(second)).toEqual(firstResult.inventory);
    });
  });

  it("合法 0010 前缀及其守卫继续安装 002", () => {
    const file = join(tempDir(), "app.db");
    seedValid0010Prefix(file);

    withOpenDb(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, MIGRATION_002]);
      expect(
        db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(HISTORY_VIEW)?.type,
      ).toBe("view");
    });
  });

  it("filename-only 损坏账本在任何已跟踪效果前失败", () => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      db.exec("CREATE TABLE schema_migrations (filename TEXT NOT NULL UNIQUE)");
    });

    expectFailedOpenToPreserve(file, "schema_migration_history");
    withDatabase(file, (db) => {
      expect(tableExists(db, "schema_migration_history")).toBe(false);
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_update'").get(),
      ).toBeUndefined();
    });
  });

  it("仅有 002 回执的规范账本在 0010 效果前失败", () => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      createCanonicalLedger(db);
      db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_002);
    });

    expectFailedOpenToPreserve(file, "schema_migration_history");
    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([MIGRATION_002]);
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_update'").get(),
      ).toBeUndefined();
    });
  });

  it.each([
    [
      "重复 filename",
      (db: DatabaseSync) => {
        db.exec(`CREATE TABLE schema_migrations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_0010);
        db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_0010);
      },
    ],
    [
      "未知 filename",
      (db: DatabaseSync) => {
        createCanonicalLedger(db);
        db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run("unknown.sql");
      },
    ],
    [
      "sequence 缺口",
      (db: DatabaseSync) => {
        createCanonicalLedger(db);
        db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_0010);
        db.prepare("INSERT INTO schema_migrations(sequence, filename) VALUES (?, ?)").run(
          3,
          MIGRATION_002,
        );
      },
    ],
    [
      "重排 filename",
      (db: DatabaseSync) => {
        createCanonicalLedger(db);
        db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_002);
        db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_0010);
      },
    ],
  ])("%s 的回执状态在新迁移效果前失败", (_name, seed) => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, seed);

    expectFailedOpenToPreserve(file, "schema_migration_history");
  });

  it("错误同名 UPDATE 触发器阻止 0010 回执", () => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      createCanonicalLedger(db);
      createWrongTriggerTarget(db);
      db.exec(
        "CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON wrong_trigger_target BEGIN SELECT 1; END;",
      );
    });

    expectFailedMigrationPrefix(
      file,
      /trigger schema_migrations_no_update already exists/,
      [],
      false,
    );
    withDatabase(file, (db) => {
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_reinsert'")
          .get(),
      ).toBeUndefined();
    });
  });

  it("错误同名 UPDATE 触发器使已确认的 0010 前缀失败", () => {
    const file = join(tempDir(), "app.db");
    seedValid0010Prefix(file);
    withDatabase(file, (db) => {
      db.exec("DROP TRIGGER schema_migrations_no_update");
      createWrongTriggerTarget(db);
      db.exec(
        "CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON wrong_trigger_target BEGIN SELECT 1; END;",
      );
    });

    expectFailedMigrationPrefix(
      file,
      /foundation object is missing or incompatible/,
      [MIGRATION_0010],
      false,
    );
  });

  it("错误同名 DELETE 触发器阻止 002 回执", () => {
    const file = join(tempDir(), "app.db");
    seedValid0010Prefix(file);
    withDatabase(file, (db) => {
      createWrongTriggerTarget(db);
      db.exec(
        "CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON wrong_trigger_target BEGIN SELECT 1; END;",
      );
    });

    expectFailedMigrationPrefix(
      file,
      /trigger schema_migrations_no_delete already exists/,
      [MIGRATION_0010],
      false,
    );
  });

  it("带有错误同名 DELETE 触发器的完整回执状态失败", () => {
    const file = join(tempDir(), "app.db");
    seedValid0010Prefix(file);
    withOpenDb(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, MIGRATION_002]);
    });
    withDatabase(file, (db) => {
      db.exec("DROP TRIGGER schema_migrations_no_delete");
      createWrongTriggerTarget(db);
      db.exec(
        "CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON wrong_trigger_target BEGIN SELECT 1; END;",
      );
    });

    expectFailedMigrationPrefix(
      file,
      /foundation object is missing or incompatible/,
      [MIGRATION_0010, MIGRATION_002],
      true,
    );
  });

  it("002 迁移失败时回滚 DELETE 触发器与回执，0010 保持已提交", () => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (seeded) => {
      seeded.exec(
        `CREATE TABLE schema_migration_history (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      );
    });

    // 002 在创建 DELETE 触发器后因同名表已存在而失败；openDb 关闭句柄后重抛。
    expectOpenDbFailure(file, /table schema_migration_history already exists/);

    withDatabase(file, (raw) => {
      // 0010 回执已提交；002 回执不存在。
      expect(ledgerFilenames(raw)).toEqual([MIGRATION_0010]);
      // DELETE 触发器随事务回滚；0010 两个守卫保留。
      const triggers = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all()
        .map((row) => String(row.name));
      expect(triggers).toContain("schema_migrations_no_update");
      expect(triggers).toContain("schema_migrations_no_reinsert");
      expect(triggers).not.toContain("schema_migrations_no_delete");
      const conflict = raw
        .prepare("SELECT type, sql FROM sqlite_master WHERE name = ?")
        .get(HISTORY_VIEW);
      expect(conflict?.type).toBe("table");
      expect(String(conflict?.sql)).toContain("CREATE TABLE schema_migration_history");
    });
  });

  it("回调抛错时数据库辅助器关闭自身连接并保留原始错误", () => {
    const originalClose = DatabaseSync.prototype.close;
    const closedDbs: DatabaseSync[] = [];
    DatabaseSync.prototype.close = function closeWithObservation(this: DatabaseSync): void {
      closedDbs.push(this);
      originalClose.call(this);
    };

    try {
      const databaseError = new Error("withDatabase callback failure");
      let database: DatabaseSync | undefined;
      let databaseThrown: unknown;
      try {
        withDatabase(":memory:", (db) => {
          database = db;
          throw databaseError;
        });
      } catch (error) {
        databaseThrown = error;
      }
      expect(databaseThrown).toBe(databaseError);
      expect(closedDbs).toHaveLength(1);
      expect(closedDbs[0]).toBe(database);

      const openDbError = new Error("withOpenDb callback failure");
      let openedDatabase: DatabaseSync | undefined;
      let openDbThrown: unknown;
      try {
        withOpenDb(":memory:", (db) => {
          openedDatabase = db;
          throw openDbError;
        });
      } catch (error) {
        openDbThrown = error;
      }
      expect(openDbThrown).toBe(openDbError);
      expect(closedDbs).toHaveLength(2);
      expect(closedDbs[1]).toBe(openedDatabase);
    } finally {
      DatabaseSync.prototype.close = originalClose;
    }
  });

  it("失败打开实际调用内部 DatabaseSync.close", () => {
    const file = join(tempDir(), "app.db");
    withDatabase(file, (db) => {
      db.exec("CREATE TABLE schema_migration_history (value TEXT)");
    });

    const originalClose = DatabaseSync.prototype.close;
    let closeCalls = 0;
    DatabaseSync.prototype.close = function closeWithObservation(this: DatabaseSync): void {
      closeCalls += 1;
      originalClose.call(this);
    };

    try {
      expectOpenDbFailure(file, /table schema_migration_history already exists/);
      expect(closeCalls).toBe(1);
    } finally {
      DatabaseSync.prototype.close = originalClose;
    }
  });

  it("忽略非 SQL 直属文件与嵌套 .sql 文件", () => {
    withOpenDb(join(tempDir(), "app.db"), (db) => {
      expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, MIGRATION_002]);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      expect(tables).not.toContain("forbidden_sentinel_non_sql");
      expect(tables).not.toContain("forbidden_sentinel_nested");
    });
  });
});
