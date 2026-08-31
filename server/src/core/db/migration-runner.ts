import { constants, type DatabaseSync } from "node:sqlite";

export interface MigrationToRun {
  filename: string;
  source: string;
}

export type MigrationPostflight = () => void;

/** 单迁移 = 单个 runner 所有的事务；迁移正文无权控制事务或 savepoint。 */
export function runMigration(
  db: DatabaseSync,
  migration: MigrationToRun,
  postflight: MigrationPostflight,
): void {
  db.exec("BEGIN");

  try {
    const expectedSequence = expectedNextReceiptSequence(db);
    runMigrationBody(db, migration.source);
    const receipt = db
      .prepare("INSERT INTO schema_migrations(filename) VALUES (?)")
      .run(migration.filename);
    if (receipt.changes !== 1 && receipt.changes !== 1n) {
      throw new Error("migration receipt insert must change exactly one row");
    }
    validatePersistedReceipt(db, migration.filename, expectedSequence);
    postflight();
    db.exec("COMMIT");
  } catch (error) {
    rollbackAfterTransactionFailure(db, error, "migration rollback failed");
  }
}

function expectedNextReceiptSequence(db: DatabaseSync): number | bigint {
  const row = db.prepare("SELECT COUNT(*) + 1 AS sequence FROM schema_migrations").get() as
    | { sequence: unknown }
    | undefined;

  if (row === undefined || (typeof row.sequence !== "number" && typeof row.sequence !== "bigint")) {
    throw new Error("migration ledger next receipt sequence is invalid");
  }

  return row.sequence;
}

function validatePersistedReceipt(
  db: DatabaseSync,
  filename: string,
  expectedSequence: number | bigint,
): void {
  const receipts = db
    .prepare("SELECT sequence FROM schema_migrations WHERE filename = ?")
    .all(filename) as Array<{ sequence: unknown }>;

  if (receipts.length !== 1 || receipts[0]?.sequence !== expectedSequence) {
    throw new Error("migration receipt does not match the expected sequence");
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

/** 当前事务失败时回滚；保留原始错误并在回滚失败时聚合报告。 */
export function rollbackAfterTransactionFailure(
  db: DatabaseSync,
  originalError: unknown,
  rollbackMessage: string,
): never {
  if (db.isTransaction) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw aggregateFailure(originalError, rollbackError, rollbackMessage);
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
