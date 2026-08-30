/**
 * core/db — SQLite 元数据存储接缝（ADR-0004 落地，system.md §3.1/§5）。
 *
 * 对外唯一出口 openDb(path)：调用方只传 SQLite 路径，拿到真实 node:sqlite
 * DatabaseSync 句柄并负责关闭；迁移机制全部藏在接缝后（WAL、migrations/*.sql
 * 按字典序执行、版本表幂等）。
 *
 * 不变量：每个已跟踪迁移按 code-point 字典序至多执行一次，且 SQL 效果与版本
 * 回执同事务提交或一起回滚。
 *
 * 迁移资产约定：
 * - migrations/ 相对本模块解析（new URL + import.meta.url），与进程 cwd 无关。
 * - 发现规则：只取直属普通 .sql 文件；非 SQL 直属文件与子目录（含嵌套 .sql）忽略。
 * - sentinel_ignored.txt 与 nested/sentinel_nested.sql 是验证数据（非生产迁移源）：
 *   若被误执行会创建 forbidden_sentinel_* 表，测试经 openDb 证明二者被忽略。
 */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/** 版本表：filename 是迁移身份，sequence 记录实际应用顺序。 */
const LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS schema_migrations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

/**
 * 打开 SQLite 并完成迁移。失败时关闭句柄后重抛（openDb 无法返回它），
 * 已提交的先前迁移保持提交。
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // WAL 先于任何迁移；:memory: 不支持 WAL，SQLite 保持 memory 模式。
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(LEDGER_SCHEMA);
    const applied = new Set(ledgerFilenames(db));
    for (const filename of discoverMigrations()) {
      if (!applied.has(filename)) {
        applyMigration(db, filename);
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 发现直属 .sql 文件并按 JS/code-point 字典序排序（非数值/自然/locale 序）。 */
function discoverMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function ledgerFilenames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT filename FROM schema_migrations")
    .all()
    .map((row) => (row as { filename: string }).filename);
}

/** 单迁移 = 单事务：SQL 效果与 filename 回执一起提交，任一失败一起回滚。 */
function applyMigration(db: DatabaseSync, filename: string): void {
  const sql = readFileSync(new URL(`./migrations/${filename}`, import.meta.url), "utf8");
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(filename);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
