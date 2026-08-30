import { constants, type DatabaseSync } from "node:sqlite";

export interface MigrationToRun {
  filename: string;
  source: string;
}

/** 单迁移 = 单个 runner 所有的事务；迁移正文无权控制事务或 savepoint。 */
export function runMigration(db: DatabaseSync, migration: MigrationToRun): void {
  db.exec("BEGIN");

  try {
    runMigrationBody(db, migration.source);
    const receipt = db
      .prepare("INSERT INTO schema_migrations(filename) VALUES (?)")
      .run(migration.filename);
    if (receipt.changes !== 1 && receipt.changes !== 1n) {
      throw new Error("migration receipt insert must change exactly one row");
    }
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterMigrationFailure(db, error);
  }
}

function runMigrationBody(db: DatabaseSync, source: string): void {
  db.setAuthorizer(denyMigrationTransactionControl);

  let bodyError: unknown;
  let bodyFailed = false;
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    db.exec(source);
  } catch (error) {
    bodyError = error;
    bodyFailed = true;
  } finally {
    try {
      db.setAuthorizer(null);
    } catch (error) {
      cleanupError = error;
      cleanupFailed = true;
    }
  }

  if (bodyFailed && cleanupFailed) {
    throw aggregateFailure(bodyError, cleanupError, "migration authorizer cleanup failed");
  }
  if (bodyFailed) {
    throw bodyError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
}

function rollbackAfterMigrationFailure(db: DatabaseSync, originalError: unknown): never {
  if (db.isTransaction) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw aggregateFailure(originalError, rollbackError, "migration rollback failed");
    }
  }

  throw originalError;
}

function denyMigrationTransactionControl(actionCode: number): number {
  if (actionCode === constants.SQLITE_TRANSACTION || actionCode === constants.SQLITE_SAVEPOINT) {
    return constants.SQLITE_DENY;
  }
  return constants.SQLITE_OK;
}

function aggregateFailure(
  originalError: unknown,
  cleanupError: unknown,
  message: string,
): AggregateError {
  return new AggregateError([originalError, cleanupError], message, { cause: originalError });
}
