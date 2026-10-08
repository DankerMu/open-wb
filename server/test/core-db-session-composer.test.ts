/**
 * Issue #993 migration 040: three nullable, default-free columns appended to `chat_sessions` with
 * ADD COLUMN — `approval_mode` and `reasoning_effort` behind a CHECK, `model_id` free text
 * (session-composer-settings spec「迁移 040 会话输入框设置列」Scenarios「新库与存量库」「列约束」
 * 「中途失败原子回滚」). 040 is located by its position in the tracked catalog, so later migrations
 * may follow it. Expected columns, legal values and rows are literals from the spec text and the
 * shared fixture, never recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_039,
  MIGRATION_040,
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
  expectChatSchema,
  expectFixture035,
  preservedState,
  receipts,
  S_A,
  S_B,
  S_C,
  S_D,
  seedPopulated035,
  seedThrough,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

// 040 follows whatever receipt precedes it in the catalog; its ordinal is derived, not written down.
const POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_040);
const RECEIPTS_BEFORE = TRACKED_MIGRATION_FILENAMES.slice(0, POS);
const NEW_COLUMNS = ["approval_mode", "model_id", "reasoning_effort"];
// Every column that exists before 040 on the tables an upgrade must keep.
const COLUMNS_039 = {
  ...COLUMNS_035,
  workspaces: [...COLUMNS_035.workspaces, "temporary"],
  chat_sessions: [...COLUMNS_035.chat_sessions, "todo", "archived_at"],
};
const SESSION_COLUMNS_BEFORE = COLUMNS_039.chat_sessions.length;
const APPROVAL_MODES = ["always-ask", "write", "yolo"];
const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_IDS = ["deepseek-v4.1-flash", "auto", "Vendor/模型 🚀 v2", "High"];
const CHECK_FAILED = /CHECK constraint failed/;
const DUPLICATE_REASONING_EFFORT = /duplicate column name: reasoning_effort/;
const SELECT_COMPOSER =
  "SELECT id, approval_mode, model_id, reasoning_effort FROM chat_sessions ORDER BY id";
const ALL_UNSET = [S_A, S_B, S_C, S_D].map((id) => ({
  id,
  approval_mode: null,
  model_id: null,
  reasoning_effort: null,
}));
type Value = string | null;

function composerRows(db: DatabaseSync) {
  return db.prepare(SELECT_COMPOSER).all();
}

function sessionsSql(db: DatabaseSync) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_sessions'").get();
}

/** 040's receipt sits right after 039's, once; the three columns are the table's next three. */
function expect040Applied(db: DatabaseSync): void {
  expect(POS).toBeGreaterThan(0);
  const ledger = ledgerRows(db);
  expect(ledger[POS - 1]).toEqual([POS, MIGRATION_039]);
  expect(ledger[POS]).toEqual([POS + 1, MIGRATION_040]);
  expect(countReceipts(db, MIGRATION_040)).toBe(1);
  expectChatSchema(db);
  const names = columnNames(db, "chat_sessions");
  expect(names.slice(0, SESSION_COLUMNS_BEFORE)).toEqual(COLUMNS_039.chat_sessions);
  expect(names.slice(SESSION_COLUMNS_BEFORE, SESSION_COLUMNS_BEFORE + 3)).toEqual(NEW_COLUMNS);
  const info = db.prepare(
    "SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('chat_sessions') WHERE name = ?",
  );
  for (const name of NEW_COLUMNS) {
    expect(info.all(name), name).toEqual([
      { name, type: "TEXT", not_null: 0, dflt_value: null, pk: 0 },
    ]);
  }
}

/** A current-schema in-memory database with one session of the seeded account u1. */
function withSession(action: (db: DatabaseSync) => void): void {
  withOpenDb(":memory:", (db) => {
    db.prepare(
      "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at) VALUES (?, 'u1', 'idle', 1, 1)",
    ).run(S_A);
    action(db);
  });
}

describe("migration 040 session composer columns", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])(
    "%s database has 040 right after 039 and three nullable default-free columns",
    (_label, path) => {
      withOpenDb(path(), (db) => {
        expect040Applied(db);
        expect(composerRows(db)).toEqual([]);
      });
    },
  );

  it("populated database ending at the previous receipt gains 040 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-before-040.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(ledgerFilenames(db)[POS - 1]).toBe(MIGRATION_039);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_039.chat_sessions);
      expectFixture035(db);
      return { receipts: receipts(db), state: preservedState(db, COLUMNS_039) };
    });
    expect(before.receipts).toHaveLength(POS);

    const upgraded = withOpenDb(file, (db) => {
      expect040Applied(db);
      expect(receipts(db).slice(0, POS)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_039)).toEqual(before.state);
      expectFixture035(db);
      expect(composerRows(db)).toEqual(ALL_UNSET);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      return receipts(db);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db, COLUMNS_039)).toEqual(before.state);
      expectFixture035(db);
      expect(composerRows(db)).toEqual(ALL_UNSET);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});

describe("migration 040 column constraints", () => {
  const read = (db: DatabaseSync, column: string) =>
    db.prepare(`SELECT ${column} AS v, typeof(${column}) AS t FROM chat_sessions WHERE id = ?`);

  it.each([
    ["approval_mode", APPROVAL_MODES],
    ["reasoning_effort", REASONING_EFFORTS],
    ["model_id", MODEL_IDS],
  ] as Array<[string, string[]]>)(
    "%s is NULL when omitted and accepts every legal value and NULL on update and insert",
    (column, legal) => {
      withSession((db) => {
        const stored = read(db, column);
        const update = db.prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`);
        expect(stored.get(S_A)).toEqual({ v: null, t: "null" });
        for (const value of legal) {
          expect(update.run(value, S_A).changes, value).toBe(1);
          expect(stored.get(S_A), value).toEqual({ v: value, t: "text" });
        }
        expect(update.run(null, S_A).changes).toBe(1);
        expect(stored.get(S_A)).toEqual({ v: null, t: "null" });

        const insert = db.prepare(
          `INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at, ${column}) VALUES (?, 'u1', 'idle', 1, 1, ?)`,
        );
        const values: Value[] = [...legal, null];
        values.forEach((value, index) => {
          const id = `${index + 1}`.padStart(32, "0");
          insert.run(id, value);
          expect(stored.get(id)?.v, String(value)).toBe(value);
        });
        // Only the written column moved: the other two stay NULL on every row.
        for (const other of NEW_COLUMNS.filter((name) => name !== column)) {
          expect(
            db.prepare(`SELECT COUNT(*) AS n FROM chat_sessions WHERE ${other} IS NOT NULL`).get(),
            other,
          ).toEqual({ n: 0 });
        }
      });
    },
  );

  it.each([
    ["approval_mode", "Write"],
    ["approval_mode", "auto"],
    ["approval_mode", ""],
    ["reasoning_effort", "auto"],
    ["reasoning_effort", "ultra"],
    ["reasoning_effort", "High"],
    ["reasoning_effort", ""],
  ])("rejects %s '%s' on insert and update and keeps the stored row", (column, value) => {
    withSession((db) => {
      const legal = column === "approval_mode" ? "write" : "high";
      db.prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`).run(legal, S_A);
      const kept = composerRows(db);
      expect(kept).toEqual([{ ...ALL_UNSET[0], [column]: legal }]);
      expect(() =>
        db
          .prepare(
            `INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at, ${column}) VALUES (?, 'u1', 'idle', 1, 1, ?)`,
          )
          .run(S_B, value),
      ).toThrow(CHECK_FAILED);
      expect(() =>
        db.prepare(`UPDATE chat_sessions SET ${column} = ? WHERE id = ?`).run(value, S_A),
      ).toThrow(CHECK_FAILED);
      expect(composerRows(db)).toEqual(kept);
    });
  });
});

describe("migration 040 atomic rollback", () => {
  it("a conflicting reasoning_effort fails 040 at its last statement leaving no 040 column or receipt, and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-reasoning-effort.db");
    // The planted column is unconstrained and holds a value 040's CHECK would refuse.
    const planted = [S_A, S_B, S_C, S_D].map((id) => ({
      id,
      reasoning_effort: id === S_C ? "auto" : null,
    }));
    seedThrough(file, RECEIPTS_BEFORE, (db) => {
      seedPopulated035(db);
      db.exec("ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT");
      db.prepare("UPDATE chat_sessions SET reasoning_effort = 'auto' WHERE id = ?").run(S_C);
    });
    const plantedColumns = [...COLUMNS_039.chat_sessions, "reasoning_effort"];
    const before = withDatabase(file, (db) => {
      expect(columnNames(db, "chat_sessions")).toEqual(plantedColumns);
      return {
        receipts: receipts(db),
        state: preservedState(db, COLUMNS_039),
        sql: sessionsSql(db),
      };
    });
    expect(before.receipts).toHaveLength(POS);

    expectOpenDbFailure(file, DUPLICATE_REASONING_EFFORT);

    withDatabase(file, (db) => {
      // approval_mode and model_id were added before the failing statement; neither survived.
      expect(columnNames(db, "chat_sessions")).toEqual(plantedColumns);
      expect(sessionsSql(db)).toEqual(before.sql);
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE]);
      expect(migrationReceiptExists(db, MIGRATION_040)).toBe(false);
      expect(receipts(db)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_039)).toEqual(before.state);
      expectFixture035(db);
      expect(
        db.prepare("SELECT id, reasoning_effort FROM chat_sessions ORDER BY id").all(),
      ).toEqual(planted);
      db.exec("ALTER TABLE chat_sessions DROP COLUMN reasoning_effort");
    });

    const retried = withOpenDb(file, (db) => {
      expect040Applied(db);
      expect(receipts(db).slice(0, POS)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_039)).toEqual(before.state);
      expectFixture035(db);
      expect(composerRows(db)).toEqual(ALL_UNSET);
      return receipts(db);
    });
    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(retried);
      expect(countReceipts(db, MIGRATION_040)).toBe(1);
      expect(composerRows(db)).toEqual(ALL_UNSET);
    });
  });
});
