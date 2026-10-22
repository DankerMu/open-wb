/**
 * Issue 1469 migration 045: `chat_steps.body_offset` and `chat_approvals.step_id` (nullable, default-free,
 * unconstrained, unindexed last columns) plus the new table `chat_thinking_segments` with its message
 * cascade, non-negative CHECK and `message_id` index (chat-sessions spec「迁移 045 分段位置与确认关联」
 * Scenarios「新库与存量库」「约束与级联」「中途失败可重试」). 045 is located by its position in the tracked
 * catalog, right after 044. Expected columns, keys and rows are literals from the spec text and the shared
 * fixture, never recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETE_CATALOG,
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_044,
  MIGRATION_045,
  migrationReceiptExists,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tableExists,
  tableIndexKeys,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import {
  CHAT_SEQUENCES,
  COLUMNS_035,
  chatSequences,
  columnNames,
  countReceipts,
  expectFixture035,
  type PriorTable,
  preservedState,
  receipts,
  seedPopulated035,
  seedThrough,
  sortedForeignKeys,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const TABLE = "chat_thinking_segments";
const POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_045);
const RECEIPTS_BEFORE = TRACKED_MIGRATION_FILENAMES.slice(0, POS);
// Every column that exists before 045 on the tables an upgrade must keep: 035's, then 036–044's tails.
const COLUMNS_044 = {
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
    "thinking_ms",
  ],
} satisfies Record<PriorTable, readonly string[]>;
const INFO_QUERY =
  'SELECT name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_info(?) WHERE name = ?';
const NEW_COLUMNS = [
  ["chat_steps", "body_offset"],
  ["chat_approvals", "step_id"],
] as const;
const NULLABLE_INTEGER = { type: "INTEGER", not_null: 0, dflt_value: null, pk: 0 };
// [name, type, notnull, dflt_value, pk] in the order the spec lists the columns.
const SEGMENT_INFO = [
  ["id", "INTEGER", 0, null, 1],
  ["message_id", "INTEGER", 1, null, 0],
  ["body_offset", "INTEGER", 1, null, 0],
  ["thinking_offset", "INTEGER", 1, null, 0],
  ["steps_before", "INTEGER", 1, null, 0],
  ["thinking_length", "INTEGER", 0, null, 0],
  ["thinking_ms", "INTEGER", 0, null, 0],
];
const SEGMENT_FOREIGN_KEYS = [
  { from: "message_id", table: "chat_messages", to: "id", on_delete: "CASCADE" },
];
const SEGMENT_INDEXES = [{ name: "chat_thinking_segments_message" }];
// The shared fixture keeps steps 1–4 and approvals 1–3; every one reads NULL in the new columns.
const NO_OFFSETS = [1, 2, 3, 4].map((id) => ({ id, body_offset: null }));
const NO_STEP_IDS = [1, 2, 3].map((id) => ({ id, step_id: null }));
// One row per table that meets every pre-045 constraint and carries -1 in the new column. `message_id` -1
// matches no message: the probe defers the foreign key and rolls back before it would be checked.
const NEGATIVE_PROBES = [
  [
    "chat_steps",
    "body_offset",
    "INSERT INTO chat_steps(message_id, ordinal, name, status, started_at, body_offset) VALUES (-1, 0, 'probe', 'done', 0, -1)",
  ],
  [
    "chat_approvals",
    "step_id",
    "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, step_id) VALUES (-1, 'probe', 'probe', 'probe', 0, 0, -1)",
  ],
] as const;
const CHECK_FAILED = /CHECK constraint failed/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
const TABLE_EXISTS = /table chat_thinking_segments already exists/;
const COLUMNS =
  "message_id, body_offset, thinking_offset, steps_before, thinking_length, thinking_ms";
const INSERT = `INSERT INTO ${TABLE}(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`;
// Two segments on assistant message 2 (S_A) and one on assistant message 6 (S_D), zero and NULL included.
const LEGAL_ROWS = [
  {
    id: 1,
    message_id: 2,
    body_offset: 0,
    thinking_offset: 0,
    steps_before: 0,
    thinking_length: 0,
    thinking_ms: 0,
  },
  {
    id: 2,
    message_id: 2,
    body_offset: 5,
    thinking_offset: 3,
    steps_before: 2,
    thinking_length: 4,
    thinking_ms: 1200,
  },
  {
    id: 3,
    message_id: 6,
    body_offset: 0,
    thinking_offset: 0,
    steps_before: 0,
    thinking_length: null,
    thinking_ms: null,
  },
];
type Value = string | number | null;
type Kept = { receipts: unknown[]; state: unknown };

function offsetRows(db: DatabaseSync) {
  return db.prepare("SELECT id, body_offset FROM chat_steps ORDER BY id").all();
}

function stepIdRows(db: DatabaseSync) {
  return db.prepare("SELECT id, step_id FROM chat_approvals ORDER BY id").all();
}

function segmentRows(db: DatabaseSync) {
  return db.prepare(`SELECT id, ${COLUMNS} FROM ${TABLE} ORDER BY id`).all();
}

/** Neither new column carries a CHECK (invisible to `table_info`): a -1 write is stored, then rolled back. */
function expectNegativeAccepted(db: DatabaseSync): void {
  for (const [table, column, insert] of NEGATIVE_PROBES) {
    db.exec("BEGIN");
    try {
      db.exec("PRAGMA defer_foreign_keys = ON");
      const { lastInsertRowid } = db.prepare(insert).run();
      expect(
        db.prepare(`SELECT ${column} FROM ${table} WHERE id = ?`).get(lastInsertRowid),
        column,
      ).toEqual({ [column]: -1 });
    } finally {
      db.exec("ROLLBACK");
    }
  }
}

function insertLegalRows(db: DatabaseSync): void {
  const insert = db.prepare(INSERT);
  for (const row of LEGAL_ROWS) {
    const { id: _id, ...values } = row;
    insert.run(...(Object.values(values) as Value[]));
  }
}

/** 045's receipt sits right after 044's, once; the two columns are last and unchecked; the table is the spec's. */
function expect045Applied(db: DatabaseSync): void {
  expect(POS).toBeGreaterThan(0);
  const ledger = ledgerRows(db);
  expect(ledger[POS - 1]).toEqual([POS, MIGRATION_044]);
  expect(ledger[POS]).toEqual([POS + 1, MIGRATION_045]);
  expect(ledger).toEqual([...COMPLETE_CATALOG.receipts]);
  expect(countReceipts(db, MIGRATION_045)).toBe(1);
  for (const [table, column] of NEW_COLUMNS) {
    expect(db.prepare(INFO_QUERY).all(table, column), column).toEqual([
      { name: column, ...NULLABLE_INTEGER },
    ]);
    expect(columnNames(db, table), table).toEqual([...COLUMNS_044[table], column]);
    expect(
      sortedForeignKeys(db, table).map((key) => key.from),
      table,
    ).not.toContain(column);
    const indexed = tableIndexKeys(db, table).flatMap((index) => index.columns.map(([c]) => c));
    expect(indexed, table).not.toContain(column);
  }
  expectNegativeAccepted(db);
  expect(
    db
      .prepare(`PRAGMA table_info('${TABLE}')`)
      .all()
      .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]),
  ).toEqual(SEGMENT_INFO);
  expect(sortedForeignKeys(db, TABLE)).toEqual(SEGMENT_FOREIGN_KEYS);
  expect(tableIndexKeys(db, TABLE)).toEqual([
    { unique: 0, isPartial: 0, columns: [["message_id", 0]] },
  ]);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(TABLE),
  ).toEqual(SEGMENT_INDEXES);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** The populated 035 fixture plus 042/043/044 values, so the kept-state check covers non-NULL tails. */
function seedPopulated044(db: DatabaseSync): void {
  seedPopulated035(db);
  db.prepare("UPDATE chat_messages SET attachments = '[]', thinking_ms = 1500 WHERE id = 2").run();
  db.prepare(
    "UPDATE chat_messages SET error_reason = 'upstream_error', error_status = 503, error_detail = '原文' WHERE id = 4",
  ).run();
}

/** What a 045 upgrade or failure must leave alone, read before `openDb` touches the file. */
function keptBefore045(file: string): Kept {
  return withDatabase(file, (db) => {
    expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
    expectFixture035(db);
    return { receipts: receipts(db), state: preservedState(db, COLUMNS_044) };
  });
}

function expectKept(db: DatabaseSync, before: Kept): void {
  expect(receipts(db).slice(0, before.receipts.length)).toEqual(before.receipts);
  expect(preservedState(db, COLUMNS_044)).toEqual(before.state);
  expectFixture035(db);
  expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** `openDb` applies 045 once onto the kept data, the new columns read NULL, and reopening changes nothing. */
function expectUpgradedTo045(file: string, before: Kept): void {
  const verify = (db: DatabaseSync) => {
    expect045Applied(db);
    expectKept(db, before);
    expect(offsetRows(db)).toEqual(NO_OFFSETS);
    expect(stepIdRows(db)).toEqual(NO_STEP_IDS);
    expect(segmentRows(db)).toEqual([]);
  };
  const upgraded = withOpenDb(file, (db) => {
    verify(db);
    return receipts(db);
  });
  expectRepeatedOpenStable(file, (db) => {
    expect(receipts(db)).toEqual(upgraded);
    verify(db);
  });
}

describe("migration 045 interleaved segments: 新库与存量库", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-045.db")],
  ])("%s database has 045 right after 044, both columns and the segment table", (_l, path) => {
    const file = path();
    withOpenDb(file, (db) => {
      expect045Applied(db);
      expect(segmentRows(db)).toEqual([]);
    });
    if (file !== ":memory:") expectRepeatedOpenStable(file, expect045Applied);
  });

  it("the trusted catalog holds 045 once, right after 044, with its receipt at the 045 position", () => {
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_045)).toHaveLength(1);
    expect(TRACKED_MIGRATION_FILENAMES[POS - 1]).toBe(MIGRATION_044);
    expect(COMPLETE_CATALOG.receipts[POS]).toEqual([POS + 1, MIGRATION_045]);
    expect(COMPLETE_CATALOG.sequenceRows).toEqual([
      ["schema_migrations", TRACKED_MIGRATION_FILENAMES.length, "integer"],
    ]);
  });

  it("populated database ending at 044 gains 045 once, reads NULL, keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-before-045.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPopulated044);
    withDatabase(file, (db) => {
      expect(columnNames(db, "chat_steps")).toEqual(COLUMNS_044.chat_steps);
      expect(columnNames(db, "chat_approvals")).toEqual(COLUMNS_044.chat_approvals);
      expect(tableExists(db, TABLE)).toBe(false);
    });
    const before = keptBefore045(file);
    expect(before.receipts).toHaveLength(POS);

    expectUpgradedTo045(file, before);
  });
});

describe("migration 045: 约束与级联", () => {
  function withLegalRows(action: (db: DatabaseSync) => void): void {
    withOpenDb(":memory:", (db) => {
      seedPopulated035(db);
      insertLegalRows(db);
      expect(segmentRows(db)).toEqual(LEGAL_ROWS);
      // AUTOINCREMENT: the first insert adds the table's own sequence row, the shared ones stay.
      expect(chatSequences(db)).toEqual([...CHAT_SEQUENCES, { name: TABLE, seq: 3 }]);
      action(db);
    });
  }

  it.each([
    ["body_offset -1", [2, -1, 0, 0, null, null], CHECK_FAILED],
    ["thinking_ms -5", [2, 0, 0, 0, null, -5], CHECK_FAILED],
    ["thinking_offset -1", [2, 0, -1, 0, null, null], CHECK_FAILED],
    ["steps_before -1", [2, 0, 0, -1, null, null], CHECK_FAILED],
    ["thinking_length -1", [2, 0, 0, 0, -1, null], CHECK_FAILED],
    ["a message_id without a message", [999, 0, 0, 0, null, null], FOREIGN_KEY_FAILED],
  ] as Array<[string, Value[], RegExp]>)(
    "rejects %s and keeps the stored rows",
    (_n, values, failure) => {
      withLegalRows((db) => {
        expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        expect(() => db.prepare(INSERT).run(...values)).toThrow(failure);
        expect(segmentRows(db)).toEqual(LEGAL_ROWS);
      });
    },
  );

  it("deleting an assistant message with two segment rows removes them and leaves no orphan", () => {
    withLegalRows((db) => {
      expect(db.prepare("DELETE FROM chat_messages WHERE id = 2").run().changes).toBe(1);
      expect(segmentRows(db)).toEqual([LEGAL_ROWS[2]]);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${TABLE} AS s LEFT JOIN chat_messages AS m ON m.id = s.message_id WHERE m.id IS NULL`,
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});

describe("migration 045: 中途失败可重试", () => {
  it("a pre-existing chat_thinking_segments fails 045 leaving no receipt, no new column and the data untouched; a retry applies it once", () => {
    const file = join(tempDir(), "conflict-segments.db");
    const planted = `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, message_id INTEGER)`;
    seedThrough(file, RECEIPTS_BEFORE, (db) => {
      seedPopulated044(db);
      db.exec(planted);
    });
    const before = keptBefore045(file);

    expectOpenDbFailure(file, TABLE_EXISTS);

    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(migrationReceiptExists(db, MIGRATION_045)).toBe(false);
      expect(columnNames(db, "chat_steps")).toEqual(COLUMNS_044.chat_steps);
      expect(columnNames(db, "chat_approvals")).toEqual(COLUMNS_044.chat_approvals);
      expect(
        db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ?").all(TABLE),
      ).toEqual([{ type: "table", name: TABLE, sql: planted }]);
      expectKept(db, before);
      db.exec(`DROP TABLE ${TABLE}`);
    });

    expectUpgradedTo045(file, before);
  });
});
