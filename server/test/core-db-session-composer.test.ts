/**
 * Issue #993 migration 040: three nullable, default-free columns appended to `chat_sessions` with
 * ADD COLUMN — `approval_mode` and `reasoning_effort` behind a CHECK, `model_id` free text
 * (session-composer-settings spec「迁移 040 会话输入框设置列」Scenarios「新库与存量库」「列约束」
 * 「中途失败原子回滚」). 040 is located by its position in the tracked catalog, so later migrations
 * may follow it. Expected columns, legal values and rows are literals from the spec text and the
 * shared fixture, never recomputed from the migration.
 *
 * Issue #994 migration 041: the table `account_composer_prefs`, one row per account, created whole
 * in the runner's transaction and deleted with its account (spec「迁移 041 账号最近选择表」Scenarios
 * 「建表与约束」「随账号级联」). Located the same way, right after 040.
 *
 * Issue #995 migration 042: one nullable, default-free, unconstrained column `attachments` appended
 * to `chat_messages` (message-attachments spec「迁移 042 消息附件列」Scenarios「新库与存量库」
 * 「中途失败原子回滚」), right after 041; plus the proof that 040, 041 and 042 are applied in order,
 * each in its own transaction.
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
  MIGRATION_041,
  MIGRATION_042,
  migrationReceiptExists,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tableExists,
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
  S_B,
  S_C,
  S_D,
  seedPopulated035,
  seedThrough,
  sortedForeignKeys,
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

// 041 follows 040 the same way; `POS` above stays 040's.
const POS_041 = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_041);
const RECEIPTS_BEFORE_041 = TRACKED_MIGRATION_FILENAMES.slice(0, POS_041);
// Every column that exists before 041 on the tables an upgrade must keep: 039's plus the 040 tail.
const COLUMNS_040 = {
  ...COLUMNS_039,
  chat_sessions: [...COLUMNS_039.chat_sessions, ...NEW_COLUMNS],
};
const PREFS = "account_composer_prefs";
const PREFS_TABLE_INFO = [
  { name: "account_id", type: "TEXT", not_null: 1, dflt_value: null, pk: 1 },
  { name: "approval_mode", type: "TEXT", not_null: 0, dflt_value: null, pk: 0 },
  { name: "model_id", type: "TEXT", not_null: 0, dflt_value: null, pk: 0 },
  { name: "reasoning_effort", type: "TEXT", not_null: 0, dflt_value: null, pk: 0 },
  { name: "updated_at", type: "INTEGER", not_null: 1, dflt_value: null, pk: 0 },
];
const PREFS_FOREIGN_KEYS = [
  { from: "account_id", table: "accounts", to: "id", on_delete: "CASCADE" },
];
const PLANTED_PREFS = "CREATE TABLE account_composer_prefs (account_id TEXT PRIMARY KEY)";
const PREFS_EXISTS = /table account_composer_prefs already exists/;
const NOT_NULL_FAILED = /NOT NULL constraint failed/;
const UNIQUE_FAILED = /UNIQUE constraint failed/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
type PrefsRow = {
  account_id: string | null;
  approval_mode: Value;
  model_id: Value;
  reasoning_effort: Value;
  updated_at: number | null;
};
const prefs = (
  account_id: string,
  approval_mode: Value,
  model_id: Value,
  reasoning_effort: Value,
  updated_at: number,
): PrefsRow => ({ account_id, approval_mode, model_id, reasoning_effort, updated_at });
// u1, u2 and u3 are accounts seeded by 010. u1 never chose anything; u2 chose all three.
const U1_PREFS = prefs("u1", null, null, null, 0);
const U2_PREFS = prefs("u2", "yolo", "Vendor/模型 🚀 v2", "max", 1760000000000);
// A legal row for a third account: each rejected case changes exactly one of its values.
const U3_PREFS = prefs("u3", "write", "deepseek-v4.1-flash", "high", 5);

function prefsRows(db: DatabaseSync) {
  return db.prepare(`SELECT * FROM ${PREFS} ORDER BY account_id`).all();
}

function insertPrefs(db: DatabaseSync, row: PrefsRow): void {
  db.prepare(
    `INSERT INTO ${PREFS}(account_id, approval_mode, model_id, reasoning_effort, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(row.account_id, row.approval_mode, row.model_id, row.reasoning_effort, row.updated_at);
}

/** A current-schema in-memory database holding the rows of u1 and u2. */
function withPrefs(action: (db: DatabaseSync) => void): void {
  withOpenDb(":memory:", (db) => {
    insertPrefs(db, U1_PREFS);
    insertPrefs(db, U2_PREFS);
    expect(prefsRows(db)).toEqual([U1_PREFS, U2_PREFS]);
    action(db);
  });
}

/** 041's receipt sits right after 040's, once; the table is the five columns and one key of the spec. */
function expect041Applied(db: DatabaseSync): void {
  expect(POS_041).toBeGreaterThan(0);
  const ledger = ledgerRows(db);
  expect(ledger[POS_041 - 1]).toEqual([POS_041, MIGRATION_040]);
  expect(ledger[POS_041]).toEqual([POS_041 + 1, MIGRATION_041]);
  expect(countReceipts(db, MIGRATION_041)).toBe(1);
  expect(
    db
      .prepare(
        `SELECT name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_info('${PREFS}')`,
      )
      .all(),
  ).toEqual(PREFS_TABLE_INFO);
  expect(sortedForeignKeys(db, PREFS)).toEqual(PREFS_FOREIGN_KEYS);
  // An ordinary rowid table whose only index is the one its TEXT primary key brings.
  expect(db.prepare(`SELECT wr, strict FROM pragma_table_list('${PREFS}')`).all()).toEqual([
    { wr: 0, strict: 0 },
  ]);
  expect(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(PREFS),
  ).toEqual([{ name: "sqlite_autoindex_account_composer_prefs_1", sql: null }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("migration 041 account composer prefs table", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-041.db")],
  ])("%s database has 041 right after 040 and an empty five-column table", (_label, path) => {
    withOpenDb(path(), (db) => {
      expect041Applied(db);
      expect040Applied(db);
      expect(prefsRows(db)).toEqual([]);
    });
  });

  it("populated database ending at 040 gains 041 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-before-041.db");
    seedThrough(file, RECEIPTS_BEFORE_041, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE_041]);
      expect(tableExists(db, PREFS)).toBe(false);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_040.chat_sessions);
      expectFixture035(db);
      return { receipts: receipts(db), state: preservedState(db, COLUMNS_040) };
    });
    expect(before.receipts).toHaveLength(POS_041);

    const upgraded = withOpenDb(file, (db) => {
      expect041Applied(db);
      expect(receipts(db).slice(0, POS_041)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_040)).toEqual(before.state);
      expectFixture035(db);
      expect(composerRows(db)).toEqual(ALL_UNSET);
      expect(prefsRows(db)).toEqual([]);
      return receipts(db);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db, COLUMNS_040)).toEqual(before.state);
      expectFixture035(db);
      expect(prefsRows(db)).toEqual([]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("a pre-existing table of the same name fails 041 leaving it and the receipts as they were, and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-prefs-table.db");
    const prefsSql = (db: DatabaseSync) =>
      db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").all(PREFS);
    seedThrough(file, RECEIPTS_BEFORE_041, (db) => {
      seedPopulated035(db);
      db.exec(PLANTED_PREFS);
    });
    const before = withDatabase(file, (db) => ({
      receipts: receipts(db),
      state: preservedState(db, COLUMNS_040),
    }));
    expect(before.receipts).toHaveLength(POS_041);

    expectOpenDbFailure(file, PREFS_EXISTS);

    withDatabase(file, (db) => {
      expect(prefsSql(db)).toEqual([{ type: "table", sql: PLANTED_PREFS }]);
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE_041]);
      expect(migrationReceiptExists(db, MIGRATION_041)).toBe(false);
      expect(receipts(db)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_040)).toEqual(before.state);
      expectFixture035(db);
      db.exec(`DROP TABLE ${PREFS}`);
    });

    const retried = withOpenDb(file, (db) => {
      expect041Applied(db);
      expect(receipts(db).slice(0, POS_041)).toEqual(before.receipts);
      expectFixture035(db);
      expect(prefsRows(db)).toEqual([]);
      return receipts(db);
    });
    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(retried);
      expect(countReceipts(db, MIGRATION_041)).toBe(1);
    });
  });
});

describe("migration 041 constraints", () => {
  it("stores an all-NULL row with updated_at 0 and an all-set row, and takes every legal value", () => {
    withPrefs((db) => {
      expect(
        db.prepare(`SELECT typeof(updated_at) AS t FROM ${PREFS} ORDER BY account_id`).all(),
      ).toEqual([{ t: "integer" }, { t: "integer" }]);
      for (const [column, legal] of [
        ["approval_mode", APPROVAL_MODES],
        ["reasoning_effort", REASONING_EFFORTS],
        ["model_id", MODEL_IDS],
      ] as Array<[keyof PrefsRow, string[]]>) {
        const update = db.prepare(`UPDATE ${PREFS} SET ${column} = ? WHERE account_id = 'u1'`);
        for (const value of [...legal, null]) {
          expect(update.run(value).changes, `${column} ${value}`).toBe(1);
          expect(prefsRows(db)).toEqual([{ ...U1_PREFS, [column]: value }, U2_PREFS]);
        }
      }
      // The key is not AUTOINCREMENT: writing rows adds nothing to sqlite_sequence.
      expect(db.prepare("SELECT name FROM sqlite_sequence WHERE name = ?").all(PREFS)).toEqual([]);
    });
  });

  it.each([
    ["account_id", "u1", UNIQUE_FAILED],
    ["approval_mode", "Write", CHECK_FAILED],
    ["approval_mode", "auto", CHECK_FAILED],
    ["approval_mode", "", CHECK_FAILED],
    ["reasoning_effort", "auto", CHECK_FAILED],
    ["reasoning_effort", "ultra", CHECK_FAILED],
    ["reasoning_effort", "High", CHECK_FAILED],
    ["reasoning_effort", "", CHECK_FAILED],
    ["updated_at", -1, CHECK_FAILED],
    ["updated_at", 1.5, CHECK_FAILED],
    ["updated_at", null, NOT_NULL_FAILED],
    ["account_id", null, NOT_NULL_FAILED],
    ["account_id", "nobody", FOREIGN_KEY_FAILED],
  ] as Array<[keyof PrefsRow, string | number | null, RegExp]>)(
    "rejects %s %j on insert and update and keeps the stored rows",
    (column, value, failure) => {
      withPrefs((db) => {
        // Insert: u3's otherwise legal row. Update: the same single value written onto u2's row.
        expect(() => insertPrefs(db, { ...U3_PREFS, [column]: value })).toThrow(failure);
        expect(() =>
          db.prepare(`UPDATE ${PREFS} SET ${column} = ? WHERE account_id = 'u2'`).run(value),
        ).toThrow(failure);
        expect(prefsRows(db)).toEqual([U1_PREFS, U2_PREFS]);
        // The base row itself is legal, so each refusal above is due to the one changed value.
        insertPrefs(db, U3_PREFS);
        expect(prefsRows(db)).toEqual([U1_PREFS, U2_PREFS, U3_PREFS]);
      });
    },
  );
});

describe("migration 041 cascade", () => {
  it("deleting an account removes its row and leaves the other account's row as it was", () => {
    withPrefs((db) => {
      expect(db.prepare("PRAGMA foreign_keys").all()).toEqual([{ foreign_keys: 1 }]);
      expect(db.prepare("DELETE FROM accounts WHERE id = 'u1'").run().changes).toBe(1);
      expect(prefsRows(db)).toEqual([U2_PREFS]);
      expect(db.prepare("SELECT id FROM accounts WHERE id IN ('u1', 'u2')").all()).toEqual([
        { id: "u2" },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});

// 042 follows 041 the same way; `POS` and `POS_041` above stay 040's and 041's.
const POS_042 = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_042);
const RECEIPTS_BEFORE_042 = TRACKED_MIGRATION_FILENAMES.slice(0, POS_042);
const ATTACHMENTS_INFO = {
  name: "attachments",
  type: "TEXT",
  not_null: 0,
  dflt_value: null,
  pk: 0,
};
const ATTACHMENTS_JSON = '[{"path":"uploads/a.txt","size":3}]';
const DUPLICATE_ATTACHMENTS = /duplicate column name: attachments/;
// The six messages the populated fixture keeps, none with attachments.
const NO_ATTACHMENTS = EXPECTED_ROWS.chat_messages.map(({ id }) => ({ id, attachments: null }));
// The planted column is unconstrained and holds a value on message 5.
const PLANTED_ATTACHMENTS = NO_ATTACHMENTS.map((row) =>
  row.id === 5 ? { ...row, attachments: "planted" } : row,
);
type Columns = Record<PriorTable, readonly string[]>;
type Kept = { receipts: unknown[]; state: unknown; sql?: unknown };

function attachmentRows(db: DatabaseSync) {
  return db.prepare("SELECT id, attachments FROM chat_messages ORDER BY id").all();
}

function messagesSql(db: DatabaseSync) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_messages'").get();
}

/** 042's receipt sits right after 041's, once; `attachments` is the eighth column of chat_messages. */
function expect042Applied(db: DatabaseSync): void {
  expect(POS_042).toBeGreaterThan(0);
  const ledger = ledgerRows(db);
  expect(ledger[POS_042 - 1]).toEqual([POS_042, MIGRATION_041]);
  expect(ledger[POS_042]).toEqual([POS_042 + 1, MIGRATION_042]);
  expect(countReceipts(db, MIGRATION_042)).toBe(1);
  expect(
    db
      .prepare(
        "SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('chat_messages') WHERE name = 'attachments'",
      )
      .all(),
  ).toEqual([ATTACHMENTS_INFO]);
  const names = columnNames(db, "chat_messages");
  expect(names.slice(0, 7)).toEqual(COLUMNS_035.chat_messages);
  expect(names.slice(7, 8)).toEqual(["attachments"]);
  expectChatSchema(db);
}

/** The populated fixture plus a pre-existing `attachments` column: 042's only statement collides. */
function seedPlantedAttachments(db: DatabaseSync): void {
  seedPopulated035(db);
  db.exec("ALTER TABLE chat_messages ADD COLUMN attachments TEXT");
  db.prepare("UPDATE chat_messages SET attachments = 'planted' WHERE id = 5").run();
}

/** What a 042 upgrade or failure must leave alone, read before `openDb` touches the file. */
function keptBefore042(file: string, prior: Columns): Kept {
  return withDatabase(file, (db) => {
    expectFixture035(db);
    return { receipts: receipts(db), state: preservedState(db, prior), sql: messagesSql(db) };
  });
}

/** The receipts and every prior row, key, index and sequence are those read before. */
function expectKept(db: DatabaseSync, before: Kept, prior: Columns): void {
  expect(receipts(db).slice(0, before.receipts.length)).toEqual(before.receipts);
  expect(preservedState(db, prior)).toEqual(before.state);
  expectFixture035(db);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** `openDb` applies 042 once onto the kept data, every message reads NULL, and reopening changes nothing. */
function expectUpgradedTo042(file: string, before: Kept, prior: Columns): void {
  const upgraded = withOpenDb(file, (db) => {
    expect042Applied(db);
    expectKept(db, before, prior);
    expect(attachmentRows(db)).toEqual(NO_ATTACHMENTS);
    return receipts(db);
  });
  expectRepeatedOpenStable(file, (db) => {
    expect(receipts(db)).toEqual(upgraded);
    for (const migration of [MIGRATION_040, MIGRATION_041, MIGRATION_042]) {
      expect(countReceipts(db, migration), migration).toBe(1);
    }
    expectKept(db, before, prior);
    expect(attachmentRows(db)).toEqual(NO_ATTACHMENTS);
  });
}

describe("migration 042 message attachments column", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-042.db")],
  ])(
    "%s database has 040, 041, 042 in order and a nullable default-free attachments column",
    (_label, path) => {
      withOpenDb(path(), (db) => {
        expect042Applied(db);
        expect041Applied(db);
        expect040Applied(db);
        expect(ledgerRows(db).slice(POS, POS + 3)).toEqual([
          [POS + 1, MIGRATION_040],
          [POS + 2, MIGRATION_041],
          [POS + 3, MIGRATION_042],
        ]);
        expect(attachmentRows(db)).toEqual([]);
      });
    },
  );

  it("populated database ending at 041 gains 042 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-before-042.db");
    seedThrough(file, RECEIPTS_BEFORE_042, seedPopulated035);
    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE_042]);
      expect(ledgerFilenames(db)[POS_042 - 1]).toBe(MIGRATION_041);
      expect(columnNames(db, "chat_messages")).toEqual(COLUMNS_035.chat_messages);
    });
    expect(NO_ATTACHMENTS).toHaveLength(6);
    const before = keptBefore042(file, COLUMNS_040);
    expect(before.receipts).toHaveLength(POS_042);

    expectUpgradedTo042(file, before, COLUMNS_040);
  });

  // 042 carries no CHECK: whatever text the application writes is stored and read back verbatim.
  it.each([
    [null, "null"],
    [ATTACHMENTS_JSON, "text"],
    ["not json", "text"],
    ["", "text"],
  ])(
    "attachments is NULL when omitted and stores %j verbatim on insert and update",
    (value, type) => {
      withSession((db) => {
        const stored = db.prepare(
          "SELECT attachments AS v, typeof(attachments) AS t FROM chat_messages ORDER BY id",
        );
        db.prepare(
          "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', '', 'done', 1)",
        ).run(S_A);
        expect(stored.all()).toEqual([{ v: null, t: "null" }]);
        db.prepare(
          "INSERT INTO chat_messages(session_id, role, content, status, created_at, attachments) VALUES (?, 'user', 'hello', 'done', 2, ?)",
        ).run(S_A, value);
        expect(stored.all()).toEqual([
          { v: null, t: "null" },
          { v: value, t: type },
        ]);
        expect(
          db.prepare("UPDATE chat_messages SET attachments = ? WHERE id = 1").run(value).changes,
        ).toBe(1);
        expect(stored.all()).toEqual([
          { v: value, t: type },
          { v: value, t: type },
        ]);
      });
    },
  );
});

describe("migration 042 atomic rollback", () => {
  it("a pre-existing attachments column fails 042 leaving it, the receipts and the data as they were, and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-attachments.db");
    seedThrough(file, RECEIPTS_BEFORE_042, seedPlantedAttachments);
    const before = keptBefore042(file, COLUMNS_040);
    expect(before.receipts).toHaveLength(POS_042);

    expectOpenDbFailure(file, DUPLICATE_ATTACHMENTS);

    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE_042]);
      expect(migrationReceiptExists(db, MIGRATION_042)).toBe(false);
      expect(receipts(db)).toEqual(before.receipts);
      expect(messagesSql(db)).toEqual(before.sql);
      expect(attachmentRows(db)).toEqual(PLANTED_ATTACHMENTS);
      expectKept(db, before, COLUMNS_040);
      db.exec("ALTER TABLE chat_messages DROP COLUMN attachments");
    });

    expectUpgradedTo042(file, before, COLUMNS_040);
  });

  it("a database ending at 039 commits 040 and 041 on their own when 042 fails in the same openDb run, and a retry applies 042 once", () => {
    const file = join(tempDir(), "conflict-attachments-from-039.db");
    seedThrough(file, RECEIPTS_BEFORE, seedPlantedAttachments);
    const before = keptBefore042(file, COLUMNS_039);
    expect(before.receipts).toHaveLength(POS);
    withDatabase(file, (db) => {
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_039.chat_sessions);
      expect(tableExists(db, PREFS)).toBe(false);
    });

    expectOpenDbFailure(file, DUPLICATE_ATTACHMENTS);

    withDatabase(file, (db) => {
      // One transaction per file: 040's columns and 041's table stayed, only 042 was rolled back.
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_BEFORE_042]);
      expect(migrationReceiptExists(db, MIGRATION_042)).toBe(false);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_040.chat_sessions);
      expect(composerRows(db)).toEqual(ALL_UNSET);
      expect(tableExists(db, PREFS)).toBe(true);
      expect(prefsRows(db)).toEqual([]);
      expect(messagesSql(db)).toEqual(before.sql);
      expect(attachmentRows(db)).toEqual(PLANTED_ATTACHMENTS);
      expectKept(db, before, COLUMNS_039);
      db.exec("ALTER TABLE chat_messages DROP COLUMN attachments");
    });

    expectUpgradedTo042(file, before, COLUMNS_039);
    withOpenDb(file, (db) => {
      expect041Applied(db);
      expect040Applied(db);
    });
  });
});
