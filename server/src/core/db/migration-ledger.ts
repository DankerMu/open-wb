import type { DatabaseSync } from "node:sqlite";

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

interface MasterObject {
  type: string;
  tbl_name: string;
  sql: string | null;
}

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  not_null: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface IndexSummary {
  name: string;
  is_unique: number;
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

/** 若账本不存在则创建；已存在账本必须在读回执前通过严格语义验证。 */
export function prepareMigrationLedger(db: DatabaseSync): void {
  if (ledgerObject(db) === undefined) {
    db.exec(LEDGER_SCHEMA);
    return;
  }

  validateLedgerSchema(db);
}

/** 已接收的回执必须是发现列表的连续、有序前缀。 */
export function validatedAppliedFilenames(
  db: DatabaseSync,
  filenames: readonly string[],
): Set<string> {
  const receipts = ledgerReceipts(db);

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

  validatePromisedFoundationObjects(db, receipts);
  validateLedgerTriggerOwnership(db, receipts);
  validateLedgerSequenceState(db, receipts);
  return new Set(receipts.map((receipt) => receipt.filename));
}

function validateLedgerSchema(db: DatabaseSync): void {
  const object = ledgerObject(db);
  if (object?.type !== "table" || object.tbl_name !== LEDGER_NAME || object.sql === null) {
    throw new Error("schema_migrations must be the canonical migration ledger table");
  }

  const columns = db
    .prepare(
      'SELECT cid, name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
    )
    .all(LEDGER_NAME) as unknown as TableColumn[];
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
    !hasCanonicalTableProperties(db) ||
    !hasAutoincrementSequence(db) ||
    !hasOnlyFilenameUniqueConstraint(db) ||
    hasForeignKeys(db)
  ) {
    throw new Error("schema_migrations constraints do not match the canonical ledger");
  }
}

function ledgerObject(db: DatabaseSync): MasterObject | undefined {
  return db
    .prepare("SELECT type, tbl_name, sql FROM sqlite_master WHERE name = ?")
    .get(LEDGER_NAME) as unknown as MasterObject | undefined;
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
    column.not_null === notNull &&
    column.dflt_value === defaultValue &&
    column.pk === primaryKey
  );
}

function hasCanonicalTableProperties(db: DatabaseSync): boolean {
  const properties = db
    .prepare("SELECT ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(LEDGER_NAME) as unknown as TableProperties | undefined;
  const definition = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(LEDGER_NAME) as { sql: string | null } | undefined;

  return (
    properties?.ncol === 3 &&
    properties.wr === 0 &&
    properties.strict === 0 &&
    definition?.sql !== null &&
    definition !== undefined &&
    compactLedgerDefinition(definition.sql) === CANONICAL_LEDGER_DEFINITION
  );
}

function compactLedgerDefinition(definition: string): string {
  return definition.replaceAll(/\s+/g, " ").trim();
}

function hasForeignKeys(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM pragma_foreign_key_list(?)").get(LEDGER_NAME) !== undefined;
}

function hasAutoincrementSequence(db: DatabaseSync): boolean {
  const program = db
    .prepare("EXPLAIN INSERT INTO schema_migrations(filename) VALUES ('migration-ledger-probe')")
    .all() as Array<{ opcode: unknown; p2: unknown }>;
  const sqliteSequence = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
    .get() as { rootpage: unknown } | undefined;

  return (
    typeof sqliteSequence?.rootpage === "number" &&
    program.some(
      (instruction) =>
        instruction.opcode === "OpenWrite" && instruction.p2 === sqliteSequence.rootpage,
    )
  );
}

function hasOnlyFilenameUniqueConstraint(db: DatabaseSync): boolean {
  const indexes = db
    .prepare(
      'SELECT name, "unique" AS is_unique, origin, partial FROM pragma_index_list(?) ORDER BY seq',
    )
    .all(LEDGER_NAME) as unknown as IndexSummary[];
  const uniqueIndexes = indexes.filter((index) => index.is_unique === 1);

  if (
    uniqueIndexes.length !== 1 ||
    uniqueIndexes[0]?.origin !== "u" ||
    uniqueIndexes[0]?.partial !== 0 ||
    uniqueIndexes[0]?.name !== "sqlite_autoindex_schema_migrations_1"
  ) {
    return false;
  }

  const indexName = uniqueIndexes[0]?.name;
  if (indexName === undefined) {
    return false;
  }
  const columns = db
    .prepare("SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno")
    .all(indexName) as unknown as IndexColumn[];
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
  return db
    .prepare("SELECT sequence, filename FROM schema_migrations ORDER BY sequence")
    .all()
    .map((row) => {
      const receipt = row as { sequence: unknown; filename: unknown };
      if (typeof receipt.sequence !== "number" || typeof receipt.filename !== "string") {
        throw new Error("schema_migrations receipt has an invalid value");
      }
      return { sequence: receipt.sequence, filename: receipt.filename };
    });
}

function validatePromisedFoundationObjects(db: DatabaseSync, receipts: readonly Receipt[]): void {
  for (const receipt of receipts) {
    if (receipt.filename === "0010_schema_migrations_update_guard.sql") {
      validateObjectDefinition(db, "trigger", UPDATE_GUARD_NAME, LEDGER_NAME, UPDATE_GUARD_SQL);
      validateObjectDefinition(db, "trigger", INSERT_GUARD_NAME, LEDGER_NAME, INSERT_GUARD_SQL);
    }
    if (receipt.filename === "002_schema_migrations_history.sql") {
      validateObjectDefinition(db, "trigger", DELETE_GUARD_NAME, LEDGER_NAME, DELETE_GUARD_SQL);
      validateObjectDefinition(db, "view", HISTORY_VIEW_NAME, HISTORY_VIEW_NAME, HISTORY_VIEW_SQL);
    }
  }
}

function validateLedgerTriggerOwnership(db: DatabaseSync, receipts: readonly Receipt[]): void {
  const expectedTriggerNames = expectedLedgerTriggerNames(receipts);
  const triggerNames = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name COLLATE NOCASE = ? ORDER BY name",
    )
    .all(LEDGER_NAME)
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
  const sequenceRows = db
    .prepare(
      "SELECT name, seq, typeof(seq) AS seq_type FROM sqlite_sequence WHERE name COLLATE NOCASE = ?",
    )
    .all(LEDGER_NAME) as unknown as SequenceRow[];

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

function expectedLedgerTriggerNames(receipts: readonly Receipt[]): readonly string[] {
  const triggerNames: string[] = [];

  for (const receipt of receipts) {
    if (receipt.filename === "0010_schema_migrations_update_guard.sql") {
      triggerNames.push(INSERT_GUARD_NAME, UPDATE_GUARD_NAME);
    }
    if (receipt.filename === "002_schema_migrations_history.sql") {
      triggerNames.push(DELETE_GUARD_NAME);
    }
  }

  return triggerNames.sort();
}

function validateObjectDefinition(
  db: DatabaseSync,
  expectedType: string,
  name: string,
  expectedTable: string,
  expectedSql: string,
): void {
  const object = db
    .prepare("SELECT type, tbl_name, sql FROM sqlite_master WHERE name = ?")
    .get(name) as unknown as MasterObject | undefined;

  if (
    object?.type !== expectedType ||
    object.tbl_name !== expectedTable ||
    object.sql !== expectedSql
  ) {
    throw new Error(`migration ledger foundation object is missing or incompatible: ${name}`);
  }
}
