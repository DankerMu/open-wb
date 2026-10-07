/**
 * Issue #863 migration 036: one nullable `chat_sessions.todo` column appended with ADD COLUMN.
 * Expected columns, rows and sequence values are fixture literals written before the upgrade
 * (chat-sessions spec「迁移 036 任务清单列」Scenarios), never recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  fullCatalogSnapshot,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_034,
  MIGRATION_035,
  MIGRATION_036,
  migrationReceiptExists,
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
  expectFixtureRows,
  type FixtureTable,
  PRIOR_COLUMNS,
  preservedState,
  RECEIPTS_034,
  RECEIPTS_035,
  receipts,
  S_A,
  S_B,
  S_C,
  S_D,
  seedPopulated034,
  seedPopulated035,
  seedThrough,
  selectRows,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const LEDGER_TAIL: Array<[number, string]> = [
  [8, MIGRATION_034],
  [9, MIGRATION_035],
  [10, MIGRATION_036],
];
const DUPLICATE_TODO = /duplicate column name: todo/;
const TODO_TEXT =
  '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"pending"}]}]}';
const ALL_TODO_NULL = [S_A, S_B, S_C, S_D].map((id) => ({ id, todo: null }));

function todoRows(db: DatabaseSync) {
  return db.prepare("SELECT id, todo FROM chat_sessions ORDER BY id").all();
}

function expect036Applied(db: DatabaseSync): void {
  expect(ledgerRows(db).slice(7, 10)).toEqual(LEDGER_TAIL);
  expect(ledgerRows(db)).toHaveLength(12);
  expect(countReceipts(db, MIGRATION_035)).toBe(1);
  expect(countReceipts(db, MIGRATION_036)).toBe(1);
  expectChatSchema(db);
  expect(columnNames(db, "chat_sessions").slice(-2)).toEqual(["todo", "archived_at"]);
}

describe("migration 036 session todo column", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])(
    "%s database ends 034,035,036 with todo as a nullable default-free column ahead of 037",
    (_label, path) => {
      withOpenDb(path(), (db) => {
        expect036Applied(db);
        expect(todoRows(db)).toEqual([]);
      });
    },
  );

  it("populated 035 database gains 036 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-035.db");
    seedThrough(file, RECEIPTS_035, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_035]);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_035.chat_sessions);
      expectFixture035(db);
      return { receipts: receipts(db), state: preservedState(db, COLUMNS_035) };
    });

    const upgraded = withOpenDb(file, (db) => {
      expect036Applied(db);
      expect(receipts(db).slice(0, 9)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_035)).toEqual(before.state);
      expectFixture035(db);
      expect(todoRows(db)).toEqual(ALL_TODO_NULL);
      return receipts(db);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db, COLUMNS_035)).toEqual(before.state);
      expect(todoRows(db)).toEqual(ALL_TODO_NULL);
    });
  });

  it("todo stores the task-list text then NULL verbatim, touching no other column; account delete still cascades", () => {
    const file = join(tempDir(), "todo-values.db");
    seedThrough(file, RECEIPTS_035, seedPopulated035);
    withOpenDb(file, (db) => {
      const kept = preservedState(db, COLUMNS_035);
      const write = db.prepare("UPDATE chat_sessions SET todo = ? WHERE id = ?");

      expect(write.run(TODO_TEXT, S_A).changes).toBe(1);
      expect(todoRows(db)).toEqual([{ id: S_A, todo: TODO_TEXT }, ...ALL_TODO_NULL.slice(1)]);
      expect(
        db.prepare("SELECT typeof(todo) AS t FROM chat_sessions WHERE id = ?").get(S_A),
      ).toEqual({ t: "text" });
      expect(preservedState(db, COLUMNS_035)).toEqual(kept);

      expect(write.run(null, S_A).changes).toBe(1);
      expect(todoRows(db)).toEqual(ALL_TODO_NULL);
      expect(preservedState(db, COLUMNS_035)).toEqual(kept);

      write.run(TODO_TEXT, S_A);
      write.run(TODO_TEXT, S_C);
      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      const u2Rows = (table: FixtureTable, ids: unknown[]) =>
        EXPECTED_ROWS[table].filter((row) => ids.includes(row.id));
      expect(todoRows(db)).toEqual([
        { id: S_C, todo: TODO_TEXT },
        { id: S_D, todo: null },
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

  it("a database whose receipts end at 034 applies 035 then 036 in one openDb run", () => {
    const file = join(tempDir(), "receipts-034.db");
    seedThrough(file, RECEIPTS_034, seedPopulated034);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_034]);
      expect(columnNames(db, "chat_sessions")).toEqual(PRIOR_COLUMNS.chat_sessions);
      return { receipts: receipts(db), state: preservedState(db) };
    });

    withOpenDb(file, (db) => {
      expect036Applied(db);
      expect(receipts(db).slice(0, 8)).toEqual(before.receipts);
      expect(preservedState(db)).toEqual(before.state);
      expectFixtureRows(db);
      expect(todoRows(db)).toEqual(ALL_TODO_NULL);
    });
  });

  it("a conflicting chat_sessions.todo aborts 036 atomically and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-todo.db");
    seedThrough(file, RECEIPTS_035, (db) => {
      seedPopulated035(db);
      db.exec("ALTER TABLE chat_sessions ADD COLUMN todo INTEGER");
      db.prepare("UPDATE chat_sessions SET todo = 7 WHERE id = ?").run(S_B);
    });
    const before = withDatabase(file, (db) => ({
      catalog: fullCatalogSnapshot(db),
      receipts: receipts(db),
      state: preservedState(db, COLUMNS_035),
    }));

    expectOpenDbFailure(file, DUPLICATE_TODO);

    withDatabase(file, (db) => {
      expect(fullCatalogSnapshot(db)).toEqual(before.catalog);
      expect(receipts(db)).toEqual(before.receipts);
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_035]);
      expect(migrationReceiptExists(db, MIGRATION_036)).toBe(false);
      expect(preservedState(db, COLUMNS_035)).toEqual(before.state);
      expectFixture035(db);
      expect(db.prepare("SELECT id, todo FROM chat_sessions WHERE todo IS NOT NULL").all()).toEqual(
        [{ id: S_B, todo: 7 }],
      );
      db.exec("ALTER TABLE chat_sessions DROP COLUMN todo");
    });

    withOpenDb(file, (db) => {
      expect036Applied(db);
      expect(receipts(db).slice(0, 9)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_035)).toEqual(before.state);
      expectFixture035(db);
      expect(todoRows(db)).toEqual(ALL_TODO_NULL);
    });
  });
});
