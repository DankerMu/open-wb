/**
 * Issue #1439 migration 044: one nullable, default-free, unconstrained, unindexed column
 * `thinking_ms INTEGER` appended to `chat_messages` with a single ADD COLUMN, no backfill
 * (thinking-fold spec「迁移 044 思考时长列」Scenarios「新库与存量库」「中途失败可重试」). 044 is located
 * by its position in the tracked catalog, right after 043. Expected columns and rows are literals from
 * the spec text and the shared fixture, never recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_043,
  MIGRATION_044,
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

const POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_044);
const RECEIPTS_BEFORE = TRACKED_MIGRATION_FILENAMES.slice(0, POS);
// Every column that exists before 044 on the tables an upgrade must keep: 035's, then 036–043's tails.
const COLUMNS_043 = {
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
  chat_messages: [
    ...COLUMNS_035.chat_messages,
    "attachments",
    "error_reason",
    "error_status",
    "error_detail",
  ],
} satisfies Record<PriorTable, readonly string[]>;
const NEW_INFO = [{ name: "thinking_ms", type: "INTEGER", not_null: 0, dflt_value: null, pk: 0 }];
const DUPLICATE_THINKING_MS = /duplicate column name: thinking_ms/;
// The six messages the populated fixture keeps (two of them carry `thinking`); all read NULL here.
const NO_DURATIONS = EXPECTED_ROWS.chat_messages.map(({ id }) => ({ id, thinking_ms: null }));
// 042/043 values written before the upgrade, so the kept-state check covers non-NULL tails too.
const ATTACHMENTS = '[{"path":"uploads/a.pdf","size":3}]';
const NO_TAIL = { attachments: null, error_reason: null, error_status: null, error_detail: null };
const TAILS_043 = EXPECTED_ROWS.chat_messages.map(({ id }) => {
  if (id === 1) return { id, ...NO_TAIL, attachments: ATTACHMENTS };
  if (id === 4) {
    return {
      id,
      ...NO_TAIL,
      error_reason: "upstream_error",
      error_status: 503,
      error_detail: "原文",
    };
  }
  return { id, ...NO_TAIL };
});

type Kept = { receipts: unknown[]; state: unknown; sql: unknown; indexes: unknown };

function durationRows(db: DatabaseSync) {
  return db.prepare("SELECT id, thinking_ms FROM chat_messages ORDER BY id").all();
}

function tailRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, attachments, error_reason, error_status, error_detail FROM chat_messages ORDER BY id",
    )
    .all();
}

function messagesSql(db: DatabaseSync) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_messages'").get();
}

function messageIndexes(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_messages' ORDER BY name",
    )
    .all();
}

/** 044's receipt sits right after 043's, once; `thinking_ms` is the last column of chat_messages. */
function expect044Applied(db: DatabaseSync): void {
  expect(POS).toBeGreaterThan(0);
  const ledger = ledgerRows(db);
  expect(ledger[POS - 1]).toEqual([POS, MIGRATION_043]);
  expect(ledger[POS]).toEqual([POS + 1, MIGRATION_044]);
  expect(countReceipts(db, MIGRATION_044)).toBe(1);
  const info = db.prepare(
    "SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('chat_messages') WHERE name = 'thinking_ms'",
  );
  expect(info.all()).toEqual(NEW_INFO);
  const names = columnNames(db, "chat_messages");
  const before = COLUMNS_043.chat_messages.length;
  expect(names.slice(0, before)).toEqual(COLUMNS_043.chat_messages);
  expect(names.slice(before)).toEqual(["thinking_ms"]);
  expectChatSchema(db);
}

/** The populated 035 fixture plus 042/043 values on messages 1 and 4. */
function seedPopulated043(db: DatabaseSync): void {
  seedPopulated035(db);
  db.prepare("UPDATE chat_messages SET attachments = ? WHERE id = 1").run(ATTACHMENTS);
  db.prepare(
    "UPDATE chat_messages SET error_reason = 'upstream_error', error_status = 503, error_detail = '原文' WHERE id = 4",
  ).run();
}

/** The populated fixture plus a pre-existing `thinking_ms` column: 044's only statement collides. */
function seedPlantedThinkingMs(db: DatabaseSync): void {
  seedPopulated043(db);
  db.exec("ALTER TABLE chat_messages ADD COLUMN thinking_ms TEXT");
  db.prepare("UPDATE chat_messages SET thinking_ms = 'planted' WHERE id = 2").run();
}

/** What a 044 upgrade or failure must leave alone, read before `openDb` touches the file. */
function keptBefore044(file: string): Kept {
  return withDatabase(file, (db) => {
    expectFixture035(db);
    expect(tailRows(db)).toEqual(TAILS_043);
    return {
      receipts: receipts(db),
      state: preservedState(db, COLUMNS_043),
      sql: messagesSql(db),
      indexes: messageIndexes(db),
    };
  });
}

function expectKept(db: DatabaseSync, before: Kept): void {
  expect(receipts(db).slice(0, before.receipts.length)).toEqual(before.receipts);
  expect(preservedState(db, COLUMNS_043)).toEqual(before.state);
  expect(messageIndexes(db)).toEqual(before.indexes);
  expectFixture035(db);
  expect(tailRows(db)).toEqual(TAILS_043);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** `openDb` applies 044 once onto the kept data, every message reads NULL, and reopening changes nothing. */
function expectUpgradedTo044(file: string, before: Kept): void {
  const upgraded = withOpenDb(file, (db) => {
    expect044Applied(db);
    expectKept(db, before);
    expect(durationRows(db)).toEqual(NO_DURATIONS);
    return receipts(db);
  });
  expectRepeatedOpenStable(file, (db) => {
    expect(receipts(db)).toEqual(upgraded);
    expect(countReceipts(db, MIGRATION_044)).toBe(1);
    expectKept(db, before);
    expect(durationRows(db)).toEqual(NO_DURATIONS);
  });
}

describe("migration 044 thinking_ms column: 新库与存量库", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-044.db")],
  ])("%s database has 044 right after 043 and a nullable default-free last column", (_l, path) => {
    withOpenDb(path(), (db) => {
      expect044Applied(db);
      expect(durationRows(db)).toEqual([]);
    });
  });

  it("populated database ending at 043 gains 044 once, reads NULL and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-before-044.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPopulated043);
    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(ledgerFilenames(db)[POS - 1]).toBe(MIGRATION_043);
      expect(columnNames(db, "chat_messages")).toEqual(COLUMNS_043.chat_messages);
    });
    expect(NO_DURATIONS).toHaveLength(6);
    const before = keptBefore044(file);
    expect(before.receipts).toHaveLength(POS);

    expectUpgradedTo044(file, before);
  });

  // No CHECK and no default: the column holds whatever the application writes, NULL when omitted.
  it("thinking_ms is NULL when omitted and stores any integer verbatim", () => {
    withOpenDb(":memory:", (db) => {
      db.prepare(
        "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at) VALUES (?, 'u1', 'idle', 1, 1)",
      ).run(S_A);
      db.prepare(
        "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', '', 'done', 1)",
      ).run(S_A);
      expect(durationRows(db)).toEqual([{ id: 1, thinking_ms: null }]);
      db.prepare("UPDATE chat_messages SET thinking_ms = -1 WHERE id = 1").run();
      expect(durationRows(db)).toEqual([{ id: 1, thinking_ms: -1 }]);
    });
  });
});

describe("migration 044: 中途失败可重试", () => {
  it("a pre-existing thinking_ms column fails 044 leaving no receipt and the data untouched, and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-thinking-ms.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPlantedThinkingMs);
    const before = keptBefore044(file);
    expect(before.receipts).toHaveLength(POS);

    expectOpenDbFailure(file, DUPLICATE_THINKING_MS);

    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(migrationReceiptExists(db, MIGRATION_044)).toBe(false);
      expect(receipts(db)).toEqual(before.receipts);
      expect(columnNames(db, "chat_messages")).toEqual([
        ...COLUMNS_043.chat_messages,
        "thinking_ms",
      ]);
      expect(messagesSql(db)).toEqual(before.sql);
      expect(durationRows(db)).toEqual(
        NO_DURATIONS.map(({ id }) => ({ id, thinking_ms: id === 2 ? "planted" : null })),
      );
      expectKept(db, before);
      db.exec("ALTER TABLE chat_messages DROP COLUMN thinking_ms");
    });

    expectUpgradedTo044(file, before);
  });
});
