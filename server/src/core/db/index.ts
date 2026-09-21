/**
 * core/db — SQLite 元数据存储接缝（ADR-0004 落地，system.md §3.1/§5）。
 *
 * 对外出口 openDb(path) 与 createSqliteTextDecoder(db)：调用方只传 SQLite
 * 路径，拿到真实 node:sqlite DatabaseSync 句柄并负责关闭；迁移机制全部藏在
 * 接缝后（WAL、固定 migrations/ 资产、规范账本与 runner 所有的原子事务）。
 * 自由文本读取按当前连接 PRAGMA encoding 使用有界、无状态 TextDecoder
 *（按 encoding 标签复用，不按 DatabaseSync 对象身份缓存）。
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
    // 外键按连接启用，不随文件持久化；每个成功返回的句柄都必须实际打开 enforcement。
    db.exec("PRAGMA foreign_keys = ON");

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

type SqliteTextEncoding = "UTF-8" | "UTF-16le" | "UTF-16be";

const SQLITE_TEXT_DECODERS: Record<SqliteTextEncoding, TextDecoder | undefined> = {
  "UTF-8": undefined,
  "UTF-16le": undefined,
  "UTF-16be": undefined,
};

/**
 * Resolve the current connection encoding once and return a shared non-streaming
 * decoder. Failed encoding reads propagate; unknown encodings are not guessed.
 */
export function createSqliteTextDecoder(db: DatabaseSync): TextDecoder {
  const row = db.prepare("PRAGMA encoding").get() as { encoding?: unknown } | undefined;
  if (row === undefined || typeof row.encoding !== "string") {
    throw new Error("SQLite PRAGMA encoding is unavailable");
  }
  const encoding = row.encoding;
  if (encoding !== "UTF-8" && encoding !== "UTF-16le" && encoding !== "UTF-16be") {
    throw new Error(`unsupported SQLite text encoding: ${encoding}`);
  }
  const existing = SQLITE_TEXT_DECODERS[encoding];
  if (existing !== undefined) {
    return existing;
  }
  const decoder = new TextDecoder(encoding, { ignoreBOM: true });
  SQLITE_TEXT_DECODERS[encoding] = decoder;
  return decoder;
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
