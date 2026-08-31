/**
 * core/db — SQLite 元数据存储接缝（ADR-0004 落地，system.md §3.1/§5）。
 *
 * 对外唯一出口 openDb(path)：调用方只传 SQLite 路径，拿到真实 node:sqlite
 * DatabaseSync 句柄并负责关闭；迁移机制全部藏在接缝后（WAL、固定 migrations/
 * 资产、规范账本与 runner 所有的原子事务）。
 *
 * 不变量：每个已跟踪迁移按 Unicode scalar code-point 字典序至多执行一次，且 SQL
 * 效果与版本回执同事务提交或一起回滚。
 */

import { DatabaseSync } from "node:sqlite";
import { trackedMigrationAssets } from "./migration-assets.js";
import { prepareMigrationLedger, validatedAppliedFilenames } from "./migration-ledger.js";
import { runMigration } from "./migration-runner.js";

/**
 * 打开 SQLite 并完成迁移。失败时关闭内部创建的句柄后重抛；已提交的先前迁移保持提交。
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // WAL 先于任何迁移；:memory: 不支持 WAL，SQLite 保持 memory 模式。
    db.exec("PRAGMA journal_mode = WAL");

    const migrations = trackedMigrationAssets();
    const filenames = migrations.map((migration) => migration.filename);
    const applied = prepareMigrationLedger(db, filenames);
    const validateCatalog = (): void => {
      validatedAppliedFilenames(db, filenames);
    };

    for (const migration of migrations) {
      if (!applied.has(migration.filename)) {
        runMigration(db, migration, validateCatalog);
      }
    }

    validateCatalog();
    return db;
  } catch (error) {
    closeFailedOpen(db, error);
  }
}

function closeFailedOpen(db: DatabaseSync, originalError: unknown): never {
  try {
    db.close();
  } catch (closeError) {
    throw new AggregateError(
      [originalError, closeError],
      "failed to close database after open failure",
      {
        cause: originalError,
      },
    );
  }

  throw originalError;
}
