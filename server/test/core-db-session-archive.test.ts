/**
 * Issue #919 migration 037: one nullable `chat_sessions.archived_at` column appended with ADD COLUMN,
 * guarded by a non-negative-integer CHECK. Expected columns, rows and sequence values are fixture
 * literals written before the upgrade (chat-sessions spec「会话数据 schema」Scenarios "Migration 037 on
 * fresh and populated databases" and "Migration 037 column constraint"), never recomputed from the
 * migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ledgerFilenames,
  ledgerRows,
  MIGRATION_036,
  MIGRATION_037,
  removeTempDirs,
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
  type FixtureTable,
  PRIOR_COLUMNS,
  preservedState,
  RECEIPTS_035,
  receipts,
  S_A,
  S_B,
  S_C,
  S_D,
  seedPopulated035,
  seedThrough,
  selectRows,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const RECEIPTS_036 = [...RECEIPTS_035, MIGRATION_036] as const;
const CHECK_FAILED = /CHECK constraint failed/;
const TODO_TEXT =
  '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"pending"}]}]}';
// Every column that exists before 037: the 035 columns plus the 036 `todo` tail on chat_sessions.
const COLUMNS_036 = {
  ...COLUMNS_035,
  chat_sessions: [...COLUMNS_035.chat_sessions, "todo"],
};
// 036 values of the populated fixture: the pinned, bound root S_A and u2's S_C hold a task list.
const SESSION_TODO = [
  { id: S_A, todo: TODO_TEXT },
  { id: S_B, todo: null },
  { id: S_C, todo: "" },
  { id: S_D, todo: null },
];
const ALL_ARCHIVED_NULL = [S_A, S_B, S_C, S_D].map((id) => ({ id, archived_at: null }));

/** The populated 035 fixture with stored `todo` values (two owners, one fork child). */
function seedPopulated036(db: DatabaseSync): void {
  seedPopulated035(db);
  const todo = db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?");
  todo.run(TODO_TEXT, S_A);
  todo.run("", S_C);
}

function expectFixture036(db: DatabaseSync): void {
  expectFixture035(db);
  expect(db.prepare("SELECT id, todo FROM chat_sessions ORDER BY id").all()).toEqual(SESSION_TODO);
}

function archivedRows(db: DatabaseSync) {
  return db.prepare("SELECT id, archived_at FROM chat_sessions ORDER BY id").all();
}

/** 036 and 037 sit at positions ten and eleven; later migrations may follow them. */
function expect037Applied(db: DatabaseSync): void {
  expect(ledgerRows(db).slice(9, 11)).toEqual([
    [10, MIGRATION_036],
    [11, MIGRATION_037],
  ]);
  expect(countReceipts(db, MIGRATION_036)).toBe(1);
  expect(countReceipts(db, MIGRATION_037)).toBe(1);
  expectChatSchema(db);
  expect(
    db
      .prepare(
        "SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('chat_sessions') WHERE name = 'archived_at'",
      )
      .all(),
  ).toEqual([{ name: "archived_at", type: "INTEGER", not_null: 0, dflt_value: null, pk: 0 }]);
  expect(columnNames(db, "chat_sessions").slice(0, 13)).toEqual(COLUMNS_036.chat_sessions);
}

describe("migration 037 session archive column", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])("%s database ends 036,037 with a nullable default-free archived_at", (_label, path) => {
    withOpenDb(path(), (db) => {
      expect037Applied(db);
      expect(archivedRows(db)).toEqual([]);
    });
  });

  it("populated 036 database gains 037 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-036.db");
    seedThrough(file, RECEIPTS_036, seedPopulated036);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_036]);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_036.chat_sessions);
      expectFixture036(db);
      return { receipts: receipts(db), state: preservedState(db, COLUMNS_036) };
    });
    expect(before.receipts).toHaveLength(10);

    const upgraded = withOpenDb(file, (db) => {
      expect037Applied(db);
      expect(receipts(db).slice(0, 10)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_036)).toEqual(before.state);
      expectFixture036(db);
      expect(archivedRows(db)).toEqual(ALL_ARCHIVED_NULL);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      return receipts(db);
    });

    // Reopen twice: receipts and the full schema inventory stay put, nothing is re-applied.
    const inventory = (db: DatabaseSync) =>
      db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const first = withOpenDb(file, inventory);
    withOpenDb(file, (db) => {
      expect(inventory(db)).toEqual(first);
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db, COLUMNS_036)).toEqual(before.state);
      expectFixture036(db);
      expect(archivedRows(db)).toEqual(ALL_ARCHIVED_NULL);
    });
  });

  it("archiving touches no other column and account delete still cascades through archived sessions", () => {
    const file = join(tempDir(), "archive-cascade.db");
    seedThrough(file, RECEIPTS_036, seedPopulated036);
    withOpenDb(file, (db) => {
      const kept = preservedState(db, COLUMNS_036);
      const write = db.prepare("UPDATE chat_sessions SET archived_at = ? WHERE id = ?");

      expect(write.run(300, S_A).changes).toBe(1);
      expect(write.run(310, S_C).changes).toBe(1);
      expect(archivedRows(db)).toEqual([
        { id: S_A, archived_at: 300 },
        { id: S_B, archived_at: null },
        { id: S_C, archived_at: 310 },
        { id: S_D, archived_at: null },
      ]);
      expect(preservedState(db, COLUMNS_036)).toEqual(kept);

      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      const u2Rows = (table: FixtureTable, ids: unknown[]) =>
        EXPECTED_ROWS[table].filter((row) => ids.includes(row.id));
      expect(archivedRows(db)).toEqual([
        { id: S_C, archived_at: 310 },
        { id: S_D, archived_at: null },
      ]);
      expect(selectRows(db, "chat_sessions", PRIOR_COLUMNS.chat_sessions)).toEqual(
        u2Rows("chat_sessions", [S_C, S_D]),
      );
      expect(selectRows(db, "chat_messages", PRIOR_COLUMNS.chat_messages)).toEqual(
        u2Rows("chat_messages", [5, 6]),
      );
      expect(selectRows(db, "chat_steps", PRIOR_COLUMNS.chat_steps)).toEqual(
        u2Rows("chat_steps", [4]),
      );
      expect(selectRows(db, "chat_approvals", PRIOR_COLUMNS.chat_approvals)).toEqual(
        u2Rows("chat_approvals", [3]),
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});

describe("migration 037 column constraint", () => {
  const INSERT =
    "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at, archived_at) VALUES (?, 'u1', 'idle', 1, 1, ?)";
  const UPDATE = "UPDATE chat_sessions SET archived_at = ? WHERE id = ?";
  const typedRows = (db: DatabaseSync) =>
    db
      .prepare("SELECT id, archived_at, typeof(archived_at) AS t FROM chat_sessions ORDER BY id")
      .all();

  it("archived_at accepts 0, a current epoch-ms value and NULL, and is NULL when omitted", () => {
    const now = Date.now();
    withOpenDb(":memory:", (db) => {
      db.prepare(INSERT).run(S_A, 0);
      db.prepare(INSERT).run(S_B, now);
      db.prepare(INSERT).run(S_C, null);
      db.prepare(
        "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at) VALUES (?, 'u1', 'idle', 1, 1)",
      ).run(S_D);
      expect(typedRows(db)).toEqual([
        { id: S_A, archived_at: 0, t: "integer" },
        { id: S_B, archived_at: now, t: "integer" },
        { id: S_C, archived_at: null, t: "null" },
        { id: S_D, archived_at: null, t: "null" },
      ]);

      const update = db.prepare(UPDATE);
      expect(update.run(null, S_A).changes).toBe(1);
      expect(update.run(0, S_B).changes).toBe(1);
      expect(update.run(now, S_C).changes).toBe(1);
      expect(typedRows(db).slice(0, 3)).toEqual([
        { id: S_A, archived_at: null, t: "null" },
        { id: S_B, archived_at: 0, t: "integer" },
        { id: S_C, archived_at: now, t: "integer" },
      ]);
    });
  });

  it.each([
    ["-1", -1],
    ["1.5", 1.5],
    ["'x'", "x"],
  ] as Array<[string, number | string]>)(
    "rejects archived_at %s on insert and update",
    (_name, value) => {
      withOpenDb(":memory:", (db) => {
        db.prepare(INSERT).run(S_A, 5);
        const kept = typedRows(db);
        expect(kept).toEqual([{ id: S_A, archived_at: 5, t: "integer" }]);
        expect(() => db.prepare(INSERT).run(S_B, value)).toThrow(CHECK_FAILED);
        expect(() => db.prepare(UPDATE).run(value, S_A)).toThrow(CHECK_FAILED);
        expect(typedRows(db)).toEqual(kept);
      });
    },
  );
});
