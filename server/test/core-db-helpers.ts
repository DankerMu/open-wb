import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { openDb } from "../src/core/db/index.js";

export const MIGRATION_0010 = "0010_schema_migrations_update_guard.sql";
export const MIGRATION_002 = "002_schema_migrations_history.sql";
export const HISTORY_VIEW = "schema_migration_history";
export type SqlLineEnding = "\n" | "\r\n" | "\r";

export interface CatalogSnapshot {
  receipts: ReadonlyArray<readonly [number, string]>;
  sequenceRows: ReadonlyArray<readonly [string, unknown, string]>;
  triggerNames: readonly string[];
  historyExists: boolean;
}

export interface CatalogStateCase {
  name: string;
  seed: (db: DatabaseSync) => void;
  before: CatalogSnapshot;
  after?: CatalogSnapshot;
  failure?: RegExp;
}

export const EMPTY_CATALOG: CatalogSnapshot = {
  receipts: [],
  sequenceRows: [],
  triggerNames: [],
  historyExists: false,
};
export const PREFIX_CATALOG: CatalogSnapshot = {
  receipts: [[1, MIGRATION_0010]],
  sequenceRows: [["schema_migrations", 1, "integer"]],
  triggerNames: ["schema_migrations_no_reinsert", "schema_migrations_no_update"],
  historyExists: false,
};
export const COMPLETE_CATALOG: CatalogSnapshot = {
  receipts: [
    [1, MIGRATION_0010],
    [2, MIGRATION_002],
  ],
  sequenceRows: [["schema_migrations", 2, "integer"]],
  triggerNames: [
    "schema_migrations_no_delete",
    "schema_migrations_no_reinsert",
    "schema_migrations_no_update",
  ],
  historyExists: true,
};
export const COMPLETE_CATALOG_WITH_UNRELATED_TRIGGER: CatalogSnapshot = {
  ...COMPLETE_CATALOG,
  triggerNames: [
    "schema_migrations_no_delete",
    "schema_migrations_no_reinsert",
    "schema_migrations_no_update",
    "unrelated_table_trigger",
  ],
};

const tmpDirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "core-db-test-"));
  tmpDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function withDatabase<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

export function withBigIntDatabase<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readBigInts: true });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

export function withOpenDb<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = openDb(path);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

/** 版本回执按 sequence（实际应用顺序）。 */
export function ledgerRows(db: DatabaseSync): Array<[number, string]> {
  return db
    .prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence")
    .all()
    .map((row) => [Number(row.sequence), String(row.filename)]);
}

export function ledgerFilenames(db: DatabaseSync): string[] {
  return ledgerRows(db).map(([, filename]) => filename);
}

function ledgerSequenceRows(db: DatabaseSync): Array<[string, unknown, string]> {
  return db
    .prepare(
      "SELECT name, seq, typeof(seq) AS seq_type FROM sqlite_sequence WHERE name COLLATE NOCASE = ? ORDER BY rowid",
    )
    .all("schema_migrations")
    .map((row) => {
      const sequence = row as { name: unknown; seq: unknown; seq_type: unknown };
      return [String(sequence.name), sequence.seq, String(sequence.seq_type)];
    });
}

function catalogSnapshot(db: DatabaseSync): CatalogSnapshot {
  return {
    receipts: ledgerRows(db),
    sequenceRows: ledgerSequenceRows(db),
    triggerNames: db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((row) => String(row.name)),
    historyExists:
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(HISTORY_VIEW) !== undefined,
  };
}

export function expectCatalogSnapshot(db: DatabaseSync, expected: CatalogSnapshot): void {
  expect(catalogSnapshot(db)).toEqual(expected);
}

/** 全部 schema 对象清单（名称/类型/定义），用于两次打开的一致性比较。 */
export function schemaInventory(db: DatabaseSync): string {
  return JSON.stringify(
    db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
  );
}

export function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) !==
    undefined
  );
}

export function migrationReceiptExists(db: DatabaseSync, filename: string): boolean {
  return (
    db.prepare("SELECT 1 FROM schema_migrations WHERE filename = ?").get(filename) !== undefined
  );
}

export function createCanonicalLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE schema_migrations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function installValid0010Foundation(db: DatabaseSync, lineEnding: SqlLineEnding = "\n"): void {
  db.exec(
    withSqlLineEnding(
      `CREATE TRIGGER schema_migrations_no_update
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
END;`,
      lineEnding,
    ),
  );
}

function installValid002Foundation(db: DatabaseSync, lineEnding: SqlLineEnding = "\n"): void {
  db.exec(
    withSqlLineEnding(
      `CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'DELETE on schema_migrations is forbidden');
END;

CREATE VIEW schema_migration_history AS
SELECT sequence, filename, applied_at
FROM schema_migrations
ORDER BY sequence;`,
      lineEnding,
    ),
  );
}

export function createValid0010Prefix(db: DatabaseSync, lineEnding: SqlLineEnding = "\n"): void {
  createCanonicalLedger(db);
  installValid0010Foundation(db, lineEnding);
  db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_0010);
}

export function createValidCompletePrefix(
  db: DatabaseSync,
  lineEnding: SqlLineEnding = "\n",
): void {
  createValid0010Prefix(db, lineEnding);
  installValid002Foundation(db, lineEnding);
  db.prepare("INSERT INTO schema_migrations(filename) VALUES (?)").run(MIGRATION_002);
}

function withSqlLineEnding(source: string, lineEnding: SqlLineEnding): string {
  return source.replaceAll("\n", lineEnding);
}

export function seedValid0010Prefix(path: string): void {
  withDatabase(path, createValid0010Prefix);
}

export function expectOpenDbFailure(path: string, expectedError?: RegExp): void {
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

export function expectNoMigrationFoundationObjects(db: DatabaseSync): void {
  expect(tableExists(db, HISTORY_VIEW)).toBe(false);
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_update'").get(),
  ).toBeUndefined();
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_reinsert'").get(),
  ).toBeUndefined();
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations_no_delete'").get(),
  ).toBeUndefined();
}

export function expectFailedOpenToPreserve(path: string): void {
  expectOpenDbFailure(path);
  withDatabase(path, (db) => {
    expect(tableExists(db, "schema_migrations")).toBe(true);
    expectNoMigrationFoundationObjects(db);
  });
}

export function fixtureMigration(
  filename: string,
  source: string,
): { filename: string; source: string } {
  return { filename, source };
}

export interface FullCatalogSnapshot {
  masterObjects: ReadonlyArray<readonly [unknown, string, string, string, unknown, string | null]>;
  sequenceRows: ReadonlyArray<readonly [unknown, string, unknown, string]>;
}

/** sqlite_master 定义及全部 sqlite_sequence 行，用于失败前后的完整持久目录快照。 */
export function fullCatalogSnapshot(db: DatabaseSync): FullCatalogSnapshot {
  const masterObjects = db
    .prepare("SELECT rowid, type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY rowid")
    .all()
    .map((row) => {
      const object = row as {
        rowid: unknown;
        type: unknown;
        name: unknown;
        tbl_name: unknown;
        rootpage: unknown;
        sql: unknown;
      };
      return [
        object.rowid,
        String(object.type),
        String(object.name),
        String(object.tbl_name),
        object.rootpage,
        object.sql === null ? null : String(object.sql),
      ] as const;
    });
  const sqliteSequenceExists =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
      .get() !== undefined;
  const sequenceRows = sqliteSequenceExists
    ? db
        .prepare(
          "SELECT rowid, name, seq, typeof(seq) AS seq_type FROM sqlite_sequence ORDER BY rowid",
        )
        .all()
        .map((row) => {
          const sequence = row as {
            rowid: unknown;
            name: unknown;
            seq: unknown;
            seq_type: unknown;
          };
          return [
            sequence.rowid,
            String(sequence.name),
            sequence.seq,
            String(sequence.seq_type),
          ] as const;
        })
    : [];

  return { masterObjects, sequenceRows };
}

export function expectFailedOpenToPreserveFullCatalog(path: string, expectedError: RegExp): void {
  const before = withDatabase(path, fullCatalogSnapshot);

  expectOpenDbFailure(path, expectedError);

  withDatabase(path, (db) => {
    expect(fullCatalogSnapshot(db)).toEqual(before);
  });
}

export function expectNoBootstrapLedger(db: DatabaseSync): void {
  expect(tableExists(db, "schema_migrations")).toBe(false);
  expect(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_autoindex_schema_migrations_1'")
      .get(),
  ).toBeUndefined();
}

export function expectRepeatedOpenStable(path: string, verify: (db: DatabaseSync) => void): void {
  const first = withOpenDb(path, (db) => ({
    inventory: schemaInventory(db),
    receipts: ledgerFilenames(db),
  }));

  withOpenDb(path, (db) => {
    expect(ledgerFilenames(db)).toEqual(first.receipts);
    expect(schemaInventory(db)).toEqual(first.inventory);
    verify(db);
  });
}
