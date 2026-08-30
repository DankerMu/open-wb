import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";

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

/** 版本回执按 sequence（实际应用顺序）。 */
function ledgerFilenames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT filename FROM schema_migrations ORDER BY sequence")
    .all()
    .map((row) => String(row.filename));
}

/** 全部 schema 对象清单（名称/类型/定义），用于两次打开的一致性比较。 */
function schemaInventory(db: DatabaseSync): string {
  return JSON.stringify(
    db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
  );
}

describe("core/db openDb", () => {
  it(":memory: 迁移按字典序应用并装好账本守卫", () => {
    const db = openDb(":memory:");

    // 历史视图按 sequence（实际应用顺序）报告：0010 先于 002（字典序），
    // 与数值/自然序（002 先于 0010）可观察地不同。
    const history = db
      .prepare("SELECT filename FROM schema_migration_history")
      .all()
      .map((row) => String(row.filename));
    expect(history).toEqual([MIGRATION_0010, MIGRATION_002]);

    // 回执的 sequence 与字典序应用顺序一致。
    expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, MIGRATION_002]);
    const sequences = db
      .prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence")
      .all()
      .map((row) => [Number(row.sequence), String(row.filename)]);
    expect(sequences).toEqual([
      [1, MIGRATION_0010],
      [2, MIGRATION_002],
    ]);

    // 两个守卫触发器与历史视图都真实存在（UPDATE/DELETE 被拒是其生效证明）。
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => String(row.name));
    expect(triggers).toContain("schema_migrations_no_update");
    expect(triggers).toContain("schema_migrations_no_delete");
    const viewType = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(HISTORY_VIEW);
    expect(viewType?.type).toBe("view");

    // 账本不可更新/不可删除。
    expect(() => db.exec("UPDATE schema_migrations SET filename = filename")).toThrow(
      /UPDATE on schema_migrations is forbidden/,
    );
    expect(() => db.exec("DELETE FROM schema_migrations")).toThrow(
      /DELETE on schema_migrations is forbidden/,
    );

    db.close();
  });

  it("临时文件库以 WAL 模式打开", () => {
    const db = openDb(join(tempDir(), "app.db"));
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    db.close();
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

    const first = openDb(file);
    const receiptsFirst = ledgerFilenames(first);
    const inventoryFirst = schemaInventory(first);
    first.close();

    const second = openDb(file);
    expect(ledgerFilenames(second)).toEqual(receiptsFirst);
    expect(schemaInventory(second)).toEqual(inventoryFirst);
    second.close();
  });

  it("002 迁移失败时回滚 DELETE 触发器与回执，0010 保持已提交", () => {
    const file = join(tempDir(), "app.db");
    const seeded = new DatabaseSync(file);
    seeded.exec(
      `CREATE TABLE schema_migration_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    seeded.close();

    // 002 在创建 DELETE 触发器后因同名表已存在而失败（CREATE VIEW 无 IF NOT EXISTS），
    // openDb 关闭句柄后重抛——句柄未泄漏，否则下面原生重开会被锁。
    expect(() => openDb(file)).toThrow(/table schema_migration_history already exists/);

    const raw = new DatabaseSync(file);
    // 0010 回执已提交；002 回执不存在。
    expect(ledgerFilenames(raw)).toEqual([MIGRATION_0010]);
    // DELETE 触发器随事务回滚；UPDATE 触发器（0010）保留。
    const triggers = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => String(row.name));
    expect(triggers).toContain("schema_migrations_no_update");
    expect(triggers).not.toContain("schema_migrations_no_delete");
    // 预置的冲突对象仍是 table，未被破坏。
    const conflict = raw
      .prepare("SELECT type, sql FROM sqlite_master WHERE name = ?")
      .get(HISTORY_VIEW);
    expect(conflict?.type).toBe("table");
    expect(String(conflict?.sql)).toContain("CREATE TABLE schema_migration_history");
    raw.close();
  });

  it("忽略非 SQL 直属文件与嵌套 .sql 文件", () => {
    const db = openDb(join(tempDir(), "app.db"));

    expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, MIGRATION_002]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    expect(tables).not.toContain("forbidden_sentinel_non_sql");
    expect(tables).not.toContain("forbidden_sentinel_nested");

    db.close();
  });
});
