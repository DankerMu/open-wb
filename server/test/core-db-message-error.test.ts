/**
 * Issue #909 migration 043: three nullable, default-free, unconstrained columns `error_reason`,
 * `error_status`, `error_detail` appended to `chat_messages` with ADD COLUMN (upstream-failure spec
 * 「迁移 043 消息错误列」Scenarios「新库与存量库」「中途失败可重试」). 043 is located by its position in
 * the tracked catalog, right after 042. Expected columns and rows are literals from the spec text and
 * the shared fixture, never recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_042,
  MIGRATION_043,
  migrationReceiptExists,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import {
  COLUMNS_035,
  columnNames,
  countReceipts,
  EXPECTED_ROWS,
  expectChatSchema,
  expectFixture035,
  type PriorTable,
  preservedState,
  receipts,
  S_A,
  seedPopulated035,
  seedThrough,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_043);
const RECEIPTS_BEFORE = TRACKED_MIGRATION_FILENAMES.slice(0, POS);
const NEW_COLUMNS = ["error_reason", "error_status", "error_detail"];
// Every column that exists before 043 on the tables an upgrade must keep: 035's, then 036–042's tails.
const COLUMNS_042 = {
  ...COLUMNS_035,
  workspaces: [...COLUMNS_035.workspaces, "temporary"],
  chat_sessions: [
    ...COLUMNS_035.chat_sessions,
    "todo",
    "archived_at",
    "approval_mode",
    "model_id",
    "reasoning_effort",
  ],
  chat_messages: [...COLUMNS_035.chat_messages, "attachments"],
} satisfies Record<PriorTable, readonly string[]>;
const NEW_INFO = [
  { name: "error_reason", type: "TEXT", not_null: 0, dflt_value: null, pk: 0 },
  { name: "error_status", type: "INTEGER", not_null: 0, dflt_value: null, pk: 0 },
  { name: "error_detail", type: "TEXT", not_null: 0, dflt_value: null, pk: 0 },
];
const DUPLICATE_ERROR_DETAIL = /duplicate column name: error_detail/;
// The six messages the populated fixture keeps; every one reads NULL in the three new columns.
const NO_ERRORS = EXPECTED_ROWS.chat_messages.map(({ id }) => ({
  id,
  error_reason: null,
  error_status: null,
  error_detail: null,
}));

type Kept = { receipts: unknown[]; state: unknown; sql: unknown };

function errorRows(db: DatabaseSync) {
  return db
    .prepare("SELECT id, error_reason, error_status, error_detail FROM chat_messages ORDER BY id")
    .all();
}

function messagesSql(db: DatabaseSync) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_messages'").get();
}

/** 043's receipt sits right after 042's, once; the three columns follow `attachments`, in order. */
function expect043Applied(db: DatabaseSync): void {
  expect(POS).toBeGreaterThan(0);
  const ledger = ledgerRows(db);
  expect(ledger[POS - 1]).toEqual([POS, MIGRATION_042]);
  expect(ledger[POS]).toEqual([POS + 1, MIGRATION_043]);
  expect(countReceipts(db, MIGRATION_043)).toBe(1);
  const info = db.prepare(
    "SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('chat_messages') WHERE name = ?",
  );
  expect(NEW_COLUMNS.flatMap((name) => info.all(name))).toEqual(NEW_INFO);
  const names = columnNames(db, "chat_messages");
  const before = COLUMNS_042.chat_messages.length;
  expect(names.slice(0, before)).toEqual(COLUMNS_042.chat_messages);
  expect(names.slice(before)).toEqual(NEW_COLUMNS);
  expectChatSchema(db);
}

/** The populated fixture plus a pre-existing `error_detail` column: 043's third statement collides. */
function seedPlantedErrorDetail(db: DatabaseSync): void {
  seedPopulated035(db);
  db.exec("ALTER TABLE chat_messages ADD COLUMN error_detail TEXT");
  db.prepare("UPDATE chat_messages SET error_detail = 'planted' WHERE id = 5").run();
}

/** What a 043 upgrade or failure must leave alone, read before `openDb` touches the file. */
function keptBefore043(file: string): Kept {
  return withDatabase(file, (db) => {
    expectFixture035(db);
    return { receipts: receipts(db), state: preservedState(db, COLUMNS_042), sql: messagesSql(db) };
  });
}

function expectKept(db: DatabaseSync, before: Kept): void {
  expect(receipts(db).slice(0, before.receipts.length)).toEqual(before.receipts);
  expect(preservedState(db, COLUMNS_042)).toEqual(before.state);
  expectFixture035(db);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** `openDb` applies 043 once onto the kept data, every message reads NULL, and reopening changes nothing. */
function expectUpgradedTo043(file: string, before: Kept): void {
  const upgraded = withOpenDb(file, (db) => {
    expect043Applied(db);
    expectKept(db, before);
    expect(errorRows(db)).toEqual(NO_ERRORS);
    return receipts(db);
  });
  expectRepeatedOpenStable(file, (db) => {
    expect(receipts(db)).toEqual(upgraded);
    expect(countReceipts(db, MIGRATION_043)).toBe(1);
    expectKept(db, before);
    expect(errorRows(db)).toEqual(NO_ERRORS);
  });
}

describe("migration 043 message error columns: 新库与存量库", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-043.db")],
  ])("%s database has 043 right after 042 and three nullable default-free columns", (_l, path) => {
    withOpenDb(path(), (db) => {
      expect043Applied(db);
      expect(errorRows(db)).toEqual([]);
    });
  });

  it("populated database ending at 042 gains 043 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-before-043.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPopulated035);
    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(ledgerFilenames(db)[POS - 1]).toBe(MIGRATION_042);
      expect(columnNames(db, "chat_messages")).toEqual(COLUMNS_042.chat_messages);
    });
    expect(NO_ERRORS).toHaveLength(6);
    const before = keptBefore043(file);
    expect(before.receipts).toHaveLength(POS);

    expectUpgradedTo043(file, before);
  });

  // No CHECK and no default: the columns hold whatever the application writes, NULL when omitted.
  it("the three columns are NULL when omitted and store any value verbatim", () => {
    withOpenDb(":memory:", (db) => {
      db.prepare(
        "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at) VALUES (?, 'u1', 'idle', 1, 1)",
      ).run(S_A);
      db.prepare(
        "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', '', 'failed', 1)",
      ).run(S_A);
      expect(errorRows(db)).toEqual([
        { id: 1, error_reason: null, error_status: null, error_detail: null },
      ]);
      db.prepare(
        "UPDATE chat_messages SET error_reason = 'not a reason', error_status = 700, error_detail = '' WHERE id = 1",
      ).run();
      expect(errorRows(db)).toEqual([
        { id: 1, error_reason: "not a reason", error_status: 700, error_detail: "" },
      ]);
    });
  });
});

describe("migration 043: 中途失败可重试", () => {
  it("a pre-existing error_detail column fails 043 leaving no receipt and neither of its first two columns, and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-error-detail.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPlantedErrorDetail);
    const before = keptBefore043(file);
    expect(before.receipts).toHaveLength(POS);

    expectOpenDbFailure(file, DUPLICATE_ERROR_DETAIL);

    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(migrationReceiptExists(db, MIGRATION_043)).toBe(false);
      expect(receipts(db)).toEqual(before.receipts);
      // The two columns 043 added before its third statement failed were rolled back with it.
      expect(columnNames(db, "chat_messages")).toEqual([
        ...COLUMNS_042.chat_messages,
        "error_detail",
      ]);
      expect(messagesSql(db)).toEqual(before.sql);
      expect(db.prepare("SELECT id, error_detail FROM chat_messages ORDER BY id").all()).toEqual(
        NO_ERRORS.map(({ id }) => ({ id, error_detail: id === 5 ? "planted" : null })),
      );
      expectKept(db, before);
      db.exec("ALTER TABLE chat_messages DROP COLUMN error_detail");
    });

    expectUpgradedTo043(file, before);
  });
});
