import type { DatabaseSync } from "node:sqlite";
import { rollbackAfterTransactionFailure } from "./migration-runner.js";

const LEDGER_NAME = "schema_migrations";

const LEDGER_SCHEMA = `CREATE TABLE schema_migrations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
const CANONICAL_LEDGER_DEFINITION = compactLedgerDefinition(LEDGER_SCHEMA);

const UPDATE_GUARD_NAME = "schema_migrations_no_update";
const INSERT_GUARD_NAME = "schema_migrations_no_reinsert";
const DELETE_GUARD_NAME = "schema_migrations_no_delete";
const HISTORY_VIEW_NAME = "schema_migration_history";

const UPDATE_GUARD_SQL = `CREATE TRIGGER ${UPDATE_GUARD_NAME}
BEFORE UPDATE ON ${LEDGER_NAME}
BEGIN
  SELECT RAISE(ABORT, 'UPDATE on schema_migrations is forbidden');
END`;

const INSERT_GUARD_SQL = `CREATE TRIGGER ${INSERT_GUARD_NAME}
BEFORE INSERT ON ${LEDGER_NAME}
WHEN EXISTS (SELECT 1 FROM ${LEDGER_NAME} WHERE filename = NEW.filename)
  OR EXISTS (SELECT 1 FROM ${LEDGER_NAME} WHERE sequence = NEW.sequence)
BEGIN
  SELECT RAISE(ABORT, 'INSERT on schema_migrations reuses an existing receipt');
END`;

const DELETE_GUARD_SQL = `CREATE TRIGGER ${DELETE_GUARD_NAME}
BEFORE DELETE ON ${LEDGER_NAME}
BEGIN
  SELECT RAISE(ABORT, 'DELETE on schema_migrations is forbidden');
END`;

const HISTORY_VIEW_SQL = `CREATE VIEW ${HISTORY_VIEW_NAME} AS
SELECT sequence, filename, applied_at
FROM ${LEDGER_NAME}
ORDER BY sequence`;

const RESERVED_INVENTORY_SQL = `SELECT type, name, tbl_name, sql
FROM main.sqlite_master
WHERE name COLLATE NOCASE IN (
  'schema_migrations',
  'schema_migrations_no_update',
  'schema_migrations_no_reinsert',
  'schema_migrations_no_delete',
  'schema_migration_history'
)`;
const LEDGER_COLUMNS_PRAGMA = "PRAGMA main.table_xinfo('schema_migrations')";
const TABLE_LIST_PRAGMA = "PRAGMA main.table_list";
const LEDGER_FOREIGN_KEYS_PRAGMA = "PRAGMA main.foreign_key_list('schema_migrations')";
const LEDGER_INDEX_LIST_PRAGMA = "PRAGMA main.index_list('schema_migrations')";
const LEDGER_INDEX_XINFO_PRAGMA = "PRAGMA main.index_xinfo('sqlite_autoindex_schema_migrations_1')";
const SQLITE_SEQUENCE_EXISTS_SQL =
  "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'";
const LEDGER_SEQUENCE_ROWS_SQL = `SELECT name, seq, typeof(seq) AS seq_type
FROM main.sqlite_sequence
WHERE name COLLATE NOCASE = 'schema_migrations'
ORDER BY rowid`;
const SQLITE_SEQUENCE_ROOTPAGE_SQL =
  "SELECT rootpage FROM main.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'";
const AUTOINCREMENT_EXPLAIN_SQL =
  "EXPLAIN INSERT INTO schema_migrations(filename) VALUES ('migration-ledger-probe')";

interface MasterObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface ExpectedReservedObject {
  type: string;
  name: string;
  tblName: string;
  sql: string;
}

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface IndexSummary {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColumn {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface TableProperties {
  schema: string;
  name: string;
  type: string;
  ncol: number;
  wr: number;
  strict: number;
}

interface Receipt {
  sequence: number;
  filename: string;
}

interface SequenceRow {
  name: unknown;
  seq: unknown;
  seq_type: unknown;
}

interface AppliedReceiptRow {
  sequence: unknown;
  filename: unknown;
}

/** 创建或验证账本，并在任何迁移效果前验证完整目录。 */
export function prepareMigrationLedger(
  db: DatabaseSync,
  filenames: readonly string[],
): Set<string> {
  const inventory = reservedObjectInventory(db);

  if (hasLedgerNamedObject(inventory)) {
    return validateMigrationCatalog(db, filenames, inventory);
  }

  validateNoLedgerBootstrapPreflight(db, inventory);
  return bootstrapMigrationLedger(db, filenames);
}

/** 已接收的回执必须是发现列表的连续、有序前缀，且完整目录必须与此前缀一致。 */
export function validatedAppliedFilenames(
  db: DatabaseSync,
  filenames: readonly string[],
): Set<string> {
  return validateMigrationCatalog(db, filenames);
}

function bootstrapMigrationLedger(db: DatabaseSync, filenames: readonly string[]): Set<string> {
  db.exec("BEGIN");

  try {
    db.exec(LEDGER_SCHEMA);
    const applied = validateMigrationCatalog(db, filenames);
    db.exec("COMMIT");
    return applied;
  } catch (error) {
    rollbackAfterTransactionFailure(db, error, "migration ledger bootstrap rollback failed");
  }
}

function validateNoLedgerBootstrapPreflight(
  db: DatabaseSync,
  inventory: readonly MasterObject[],
): void {
  if (inventory.length !== 0) {
    throw new Error("migration ledger reserved catalog exists before bootstrap");
  }

  if (sqliteSequenceExists(db) && ledgerSequenceRows(db).length !== 0) {
    throw new Error("schema_migrations sqlite_sequence state exists before ledger bootstrap");
  }
}

function validateMigrationCatalog(
  db: DatabaseSync,
  filenames: readonly string[],
  inventory = reservedObjectInventory(db),
): Set<string> {
  validateLedgerSchema(db, inventory);
  const receipts = ledgerReceipts(db);
  validateReceiptPrefix(receipts, filenames);
  validateReservedInventory(inventory, receipts);
  validateLedgerTriggerOwnership(db, receipts);
  validateLedgerSequenceState(db, receipts);
  return new Set(receipts.map((receipt) => receipt.filename));
}

function validateLedgerSchema(db: DatabaseSync, inventory: readonly MasterObject[]): void {
  const ledger = canonicalLedgerObject(inventory);
  if (!matchesCanonicalLedgerObject(ledger)) {
    throw new Error("schema_migrations must be the canonical migration ledger table");
  }

  const columns = (db.prepare(LEDGER_COLUMNS_PRAGMA).all() as unknown as TableColumn[]).sort(
    (left, right) => left.cid - right.cid,
  );
  const expectedColumns: ReadonlyArray<readonly [string, string, number, string | null, number]> = [
    ["sequence", "INTEGER", 0, null, 1],
    ["filename", "TEXT", 1, null, 0],
    ["applied_at", "TEXT", 1, "CURRENT_TIMESTAMP", 0],
  ];

  if (
    columns.length !== expectedColumns.length ||
    !columns.every((column, index) => matchesLedgerColumn(column, expectedColumns[index]))
  ) {
    throw new Error("schema_migrations columns do not match the canonical ledger");
  }

  if (
    !hasCanonicalTableProperties(db, ledger) ||
    !hasAutoincrementSequence(db) ||
    !hasOnlyCanonicalLedgerIndex(db) ||
    hasForeignKeys(db)
  ) {
    throw new Error("schema_migrations constraints do not match the canonical ledger");
  }
}

function canonicalLedgerObject(inventory: readonly MasterObject[]): MasterObject | undefined {
  const ledgerObjects = inventory.filter((object) =>
    sameSqliteIdentifier(object.name, LEDGER_NAME),
  );
  return ledgerObjects.length === 1 ? ledgerObjects[0] : undefined;
}

function matchesCanonicalLedgerObject(object: MasterObject | undefined): object is MasterObject {
  return (
    object?.type === "table" &&
    object.name === LEDGER_NAME &&
    object.tbl_name === LEDGER_NAME &&
    object.sql !== null &&
    compactLedgerDefinition(object.sql) === CANONICAL_LEDGER_DEFINITION
  );
}

function matchesLedgerColumn(
  column: TableColumn,
  expected: readonly [string, string, number, string | null, number] | undefined,
): boolean {
  if (expected === undefined) {
    return false;
  }

  const [name, type, notNull, defaultValue, primaryKey] = expected;
  return (
    column.hidden === 0 &&
    column.name === name &&
    column.type === type &&
    column.notnull === notNull &&
    column.dflt_value === defaultValue &&
    column.pk === primaryKey
  );
}

function hasCanonicalTableProperties(db: DatabaseSync, ledger: MasterObject): boolean {
  if (ledger.sql === null) {
    return false;
  }

  const tables = db.prepare(TABLE_LIST_PRAGMA).all() as unknown as TableProperties[];
  const matchingTables = tables.filter(
    (table) => table.schema === "main" && table.name === LEDGER_NAME && table.type === "table",
  );

  return (
    matchingTables.length === 1 &&
    matchingTables[0]?.ncol === 3 &&
    matchingTables[0].wr === 0 &&
    matchingTables[0].strict === 0 &&
    compactLedgerDefinition(ledger.sql) === CANONICAL_LEDGER_DEFINITION
  );
}

function compactLedgerDefinition(definition: string): string {
  return definition.replaceAll(/\s+/g, " ").trim();
}

function hasForeignKeys(db: DatabaseSync): boolean {
  return db.prepare(LEDGER_FOREIGN_KEYS_PRAGMA).all().length !== 0;
}

function hasAutoincrementSequence(db: DatabaseSync): boolean {
  const program = db.prepare(AUTOINCREMENT_EXPLAIN_SQL).all() as Array<{
    opcode: unknown;
    p2: unknown;
  }>;
  const sqliteSequence = db.prepare(SQLITE_SEQUENCE_ROOTPAGE_SQL).get() as
    | { rootpage: unknown }
    | undefined;

  return (
    isSqliteInteger(sqliteSequence?.rootpage) &&
    program.some(
      (instruction) =>
        instruction.opcode === "OpenWrite" && instruction.p2 === sqliteSequence.rootpage,
    )
  );
}

function isSqliteInteger(value: unknown): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint";
}

function hasOnlyCanonicalLedgerIndex(db: DatabaseSync): boolean {
  const indexes = (db.prepare(LEDGER_INDEX_LIST_PRAGMA).all() as unknown as IndexSummary[]).sort(
    (left, right) => left.seq - right.seq,
  );

  if (
    indexes.length !== 1 ||
    indexes[0]?.seq !== 0 ||
    indexes[0]?.unique !== 1 ||
    indexes[0]?.origin !== "u" ||
    indexes[0]?.partial !== 0 ||
    indexes[0]?.name !== "sqlite_autoindex_schema_migrations_1"
  ) {
    return false;
  }

  const columns = (db.prepare(LEDGER_INDEX_XINFO_PRAGMA).all() as unknown as IndexColumn[]).sort(
    (left, right) => left.seqno - right.seqno,
  );
  const keyColumns = columns.filter((column) => column.key === 1);

  return (
    keyColumns.length === 1 &&
    keyColumns[0]?.seqno === 0 &&
    keyColumns[0]?.cid === 1 &&
    keyColumns[0]?.name === "filename" &&
    keyColumns[0]?.desc === 0 &&
    keyColumns[0]?.coll === "BINARY"
  );
}

function ledgerReceipts(db: DatabaseSync): Receipt[] {
  const rows = db
    .prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence")
    .all() as unknown as AppliedReceiptRow[];
  const receipts: Receipt[] = [];
  let previousSequence: number | undefined;

  for (const row of rows) {
    if (
      typeof row.sequence !== "number" ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 1 ||
      typeof row.filename !== "string" ||
      (previousSequence !== undefined && row.sequence <= previousSequence)
    ) {
      throw new Error("schema_migrations receipt has an invalid value");
    }
    receipts.push({ sequence: row.sequence, filename: row.filename });
    previousSequence = row.sequence;
  }

  return receipts;
}

function validateReceiptPrefix(receipts: readonly Receipt[], filenames: readonly string[]): void {
  if (receipts.length > filenames.length) {
    throw new Error("migration ledger has more receipts than discovered migrations");
  }

  for (const [index, receipt] of receipts.entries()) {
    const expectedSequence = index + 1;
    const expectedFilename = filenames[index];
    if (
      receipt.sequence !== expectedSequence ||
      receipt.filename !== expectedFilename ||
      typeof expectedFilename !== "string"
    ) {
      throw new Error("migration ledger receipts are not a contiguous discovered prefix");
    }
  }
}

function validateReservedInventory(
  dbInventory: readonly MasterObject[],
  receipts: readonly Receipt[],
): void {
  const expected = expectedReservedObjects(receipts);
  if (!hasExactReservedInventory(dbInventory, expected)) {
    throw new Error("migration ledger reserved catalog does not match the receipt prefix");
  }
}

function expectedReservedObjects(receipts: readonly Receipt[]): ExpectedReservedObject[] {
  const expected: ExpectedReservedObject[] = [
    { type: "table", name: LEDGER_NAME, tblName: LEDGER_NAME, sql: LEDGER_SCHEMA },
  ];

  if (hasReceipt(receipts, "0010_schema_migrations_update_guard.sql")) {
    expected.push(
      {
        type: "trigger",
        name: UPDATE_GUARD_NAME,
        tblName: LEDGER_NAME,
        sql: UPDATE_GUARD_SQL,
      },
      {
        type: "trigger",
        name: INSERT_GUARD_NAME,
        tblName: LEDGER_NAME,
        sql: INSERT_GUARD_SQL,
      },
    );
  }
  if (hasReceipt(receipts, "002_schema_migrations_history.sql")) {
    expected.push(
      {
        type: "trigger",
        name: DELETE_GUARD_NAME,
        tblName: LEDGER_NAME,
        sql: DELETE_GUARD_SQL,
      },
      {
        type: "view",
        name: HISTORY_VIEW_NAME,
        tblName: HISTORY_VIEW_NAME,
        sql: HISTORY_VIEW_SQL,
      },
    );
  }

  return expected;
}

function hasReceipt(receipts: readonly Receipt[], filename: string): boolean {
  return receipts.some((receipt) => receipt.filename === filename);
}

function hasExactReservedInventory(
  actual: readonly MasterObject[],
  expected: readonly ExpectedReservedObject[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((expectedObject) => {
      const matches = actual.filter(
        (object) => object.type === expectedObject.type && object.name === expectedObject.name,
      );
      return matches.length === 1 && matchesReservedObject(matches[0], expectedObject);
    })
  );
}

function matchesReservedObject(
  object: MasterObject | undefined,
  expected: ExpectedReservedObject,
): boolean {
  if (object?.tbl_name !== expected.tblName || object.sql === null) {
    return false;
  }

  return matchesReservedDefinition(object.sql, expected);
}

function matchesReservedDefinition(actual: string, expected: ExpectedReservedObject): boolean {
  if (expected.name === LEDGER_NAME) {
    return compactLedgerDefinition(actual) === compactLedgerDefinition(expected.sql);
  }

  return expected.type === "trigger" || expected.type === "view"
    ? canonicalizeDefinitionLineEndings(actual) === canonicalizeDefinitionLineEndings(expected.sql)
    : actual === expected.sql;
}

/** 目录定义仅将 Git checkout 的 CRLF 或 lone-CR 表示统一为 LF。 */
function canonicalizeDefinitionLineEndings(definition: string): string {
  return definition.replaceAll(/\r\n?/g, "\n");
}

function reservedObjectInventory(db: DatabaseSync): MasterObject[] {
  return db.prepare(RESERVED_INVENTORY_SQL).all() as unknown as MasterObject[];
}

function hasLedgerNamedObject(inventory: readonly MasterObject[]): boolean {
  return inventory.some((object) => sameSqliteIdentifier(object.name, LEDGER_NAME));
}

function sameSqliteIdentifier(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right;
}

function validateLedgerTriggerOwnership(db: DatabaseSync, receipts: readonly Receipt[]): void {
  const expectedTriggerNames = expectedReservedObjects(receipts)
    .filter((object) => object.type === "trigger")
    .map((object) => object.name)
    .sort();
  const triggerNames = db
    .prepare(
      "SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND tbl_name COLLATE NOCASE = 'schema_migrations' ORDER BY name",
    )
    .all()
    .map((row) => {
      const name = (row as { name: unknown }).name;
      if (typeof name !== "string") {
        throw new Error("schema_migrations trigger has an invalid name");
      }
      return name;
    });

  if (
    triggerNames.length !== expectedTriggerNames.length ||
    !triggerNames.every((name, index) => name === expectedTriggerNames[index])
  ) {
    throw new Error("schema_migrations triggers do not match the receipt prefix");
  }
}

function validateLedgerSequenceState(db: DatabaseSync, receipts: readonly Receipt[]): void {
  const sequenceRows = ledgerSequenceRows(db);

  if (receipts.length === 0) {
    if (sequenceRows.length !== 0) {
      throw new Error(
        "schema_migrations sqlite_sequence state is not canonical for an empty ledger",
      );
    }
    return;
  }

  const expectedSequence = receipts.at(-1)?.sequence;
  const sequenceRow = sequenceRows[0];
  if (
    sequenceRows.length !== 1 ||
    sequenceRow?.name !== LEDGER_NAME ||
    sequenceRow.seq_type !== "integer" ||
    typeof sequenceRow.seq !== "number" ||
    !Number.isSafeInteger(sequenceRow.seq) ||
    sequenceRow.seq < 1 ||
    sequenceRow.seq !== expectedSequence
  ) {
    throw new Error("schema_migrations sqlite_sequence state does not match ledger receipts");
  }
}

function sqliteSequenceExists(db: DatabaseSync): boolean {
  return db.prepare(SQLITE_SEQUENCE_EXISTS_SQL).get() !== undefined;
}

function ledgerSequenceRows(db: DatabaseSync): SequenceRow[] {
  return db.prepare(LEDGER_SEQUENCE_ROWS_SQL).all() as unknown as SequenceRow[];
}
