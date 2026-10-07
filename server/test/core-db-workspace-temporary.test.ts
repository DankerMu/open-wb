/**
 * Issue #920 migration 038: one `workspaces.temporary` flag appended with ADD COLUMN (NOT NULL,
 * DEFAULT 0, 0/1 CHECK). Expected columns, rows and receipts are fixture literals written before the
 * upgrade (temporary-workspaces spec「迁移 038 临时标记」Scenarios「新库与存量库」「取值约束」, and the
 * 037 → 038 part of chat-sessions「会话数据 schema」"Migrations 037 to 039 apply in order"), never
 * recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_036,
  MIGRATION_037,
  MIGRATION_038,
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
  expectFixture035,
  PRIOR_COLUMNS,
  preservedState,
  RECEIPTS_035,
  receipts,
  seedPopulated035,
  seedThrough,
  W_MISSING,
  W_U1,
  W_U1_SPARE,
  W_U2,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const RECEIPTS_036 = [...RECEIPTS_035, MIGRATION_036] as const;
const RECEIPTS_037 = [...RECEIPTS_036, MIGRATION_037] as const;
const LEDGER_TAIL: Array<[number, string]> = [
  [10, MIGRATION_036],
  [11, MIGRATION_037],
  [12, MIGRATION_038],
];
const CHECK_FAILED = /CHECK constraint failed/;
const NOT_NULL_TEMPORARY = /NOT NULL constraint failed: workspaces\.temporary/;
const DUPLICATE_TEMPORARY = /duplicate column name: temporary/;
// Columns that exist before 038: the 035 columns plus the 036 `todo` (and, once applied, the 037
// `archived_at`) tails on chat_sessions; `workspaces` is the five 031 columns throughout.
const COLUMNS_036 = { ...COLUMNS_035, chat_sessions: [...COLUMNS_035.chat_sessions, "todo"] };
const COLUMNS_037 = {
  ...COLUMNS_036,
  chat_sessions: [...COLUMNS_036.chat_sessions, "archived_at"],
};
const WORKSPACE_COLUMNS_038 = [...PRIOR_COLUMNS.workspaces, "temporary"];
// The fixture's three workspaces (two of u1, one of u2), all permanent after the upgrade.
const ALL_PERMANENT = [
  { id: W_U1, owner_id: "u1", temporary: 0, t: "integer" },
  { id: W_U1_SPARE, owner_id: "u1", temporary: 0, t: "integer" },
  { id: W_U2, owner_id: "u2", temporary: 0, t: "integer" },
];

function temporaryRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, owner_id, temporary, typeof(temporary) AS t FROM workspaces ORDER BY owner_id, id",
    )
    .all();
}

/** 036, 037 and 038 sit at positions ten to twelve; later migrations may follow them. */
function expect038Applied(db: DatabaseSync): void {
  expect(ledgerRows(db).slice(9, 12)).toEqual(LEDGER_TAIL);
  for (const [, filename] of LEDGER_TAIL) {
    expect(countReceipts(db, filename), filename).toBe(1);
  }
  expect(columnNames(db, "workspaces")).toEqual(WORKSPACE_COLUMNS_038);
  expect(
    db
      .prepare(
        "SELECT name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('workspaces') WHERE name = 'temporary'",
      )
      .all(),
  ).toEqual([{ name: "temporary", type: "INTEGER", not_null: 1, dflt_value: "0", pk: 0 }]);
  expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_037.chat_sessions);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("migration 038 workspace temporary flag", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])("%s database ends 036,037,038 with a NOT NULL default-0 temporary", (_label, path) => {
    withOpenDb(path(), (db) => {
      expect038Applied(db);
      expect(temporaryRows(db)).toEqual([]);
    });
  });

  it("populated 037 database gains 038 once; every workspace reads 0 and every prior value, key, index and sequence stays", () => {
    const file = join(tempDir(), "populated-037.db");
    seedThrough(file, RECEIPTS_037, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_037]);
      expect(columnNames(db, "workspaces")).toEqual(PRIOR_COLUMNS.workspaces);
      expectFixture035(db);
      return { receipts: receipts(db), state: preservedState(db, COLUMNS_037) };
    });
    expect(before.receipts).toHaveLength(11);

    const upgraded = withOpenDb(file, (db) => {
      expect038Applied(db);
      expect(receipts(db).slice(0, 11)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_037)).toEqual(before.state);
      expectFixture035(db);
      expect(temporaryRows(db)).toEqual(ALL_PERMANENT);
      return receipts(db);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db, COLUMNS_037)).toEqual(before.state);
      expectFixture035(db);
      expect(temporaryRows(db)).toEqual(ALL_PERMANENT);
    });
  });

  it("a database whose receipts end at 036 applies 037 then 038 in one openDb run", () => {
    const file = join(tempDir(), "receipts-036.db");
    seedThrough(file, RECEIPTS_036, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_036]);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_036.chat_sessions);
      expect(columnNames(db, "workspaces")).toEqual(PRIOR_COLUMNS.workspaces);
      return { receipts: receipts(db), state: preservedState(db, COLUMNS_036) };
    });
    expect(before.receipts).toHaveLength(10);

    withOpenDb(file, (db) => {
      expect038Applied(db);
      expect(receipts(db).slice(0, 10)).toEqual(before.receipts);
      expect(preservedState(db, COLUMNS_036)).toEqual(before.state);
      expectFixture035(db);
      expect(temporaryRows(db)).toEqual(ALL_PERMANENT);
    });
  });

  it("a conflicting workspaces.temporary fails 038 after 037 is kept, and a retry applies 038 once", () => {
    const file = join(tempDir(), "conflict-temporary.db");
    seedThrough(file, RECEIPTS_036, (db) => {
      seedPopulated035(db);
      db.exec("ALTER TABLE workspaces ADD COLUMN temporary INTEGER");
      db.prepare("UPDATE workspaces SET temporary = 7 WHERE id = ?").run(W_U2);
    });
    const before = withDatabase(file, (db) => ({
      receipts: receipts(db),
      state: preservedState(db, COLUMNS_036),
      workspacesSql: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'workspaces'").get(),
    }));
    expect(before.receipts).toHaveLength(10);

    expectOpenDbFailure(file, DUPLICATE_TEMPORARY);

    const afterFailure = withDatabase(file, (db) => {
      // 037 committed in its own transaction: its receipt and column are there, 038 left nothing.
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_037]);
      expect(receipts(db).slice(0, 10)).toEqual(before.receipts);
      expect(countReceipts(db, MIGRATION_037)).toBe(1);
      expect(migrationReceiptExists(db, MIGRATION_038)).toBe(false);
      expect(columnNames(db, "chat_sessions")).toEqual(COLUMNS_037.chat_sessions);
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'workspaces'").get()).toEqual(
        before.workspacesSql,
      );
      expect(preservedState(db, COLUMNS_036)).toEqual(before.state);
      expectFixture035(db);
      // The test-owned column is still the unconstrained one, with its planted value.
      expect(temporaryRows(db)).toEqual([
        { id: W_U1, owner_id: "u1", temporary: null, t: "null" },
        { id: W_U1_SPARE, owner_id: "u1", temporary: null, t: "null" },
        { id: W_U2, owner_id: "u2", temporary: 7, t: "integer" },
      ]);
      const kept = receipts(db);
      db.exec("ALTER TABLE workspaces DROP COLUMN temporary");
      return kept;
    });
    expect(afterFailure).toHaveLength(11);

    const retried = withOpenDb(file, (db) => {
      expect038Applied(db);
      expect(receipts(db).slice(0, 11)).toEqual(afterFailure);
      expect(preservedState(db, COLUMNS_036)).toEqual(before.state);
      expectFixture035(db);
      expect(temporaryRows(db)).toEqual(ALL_PERMANENT);
      return receipts(db);
    });
    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(retried);
      expect(temporaryRows(db)).toEqual(ALL_PERMANENT);
    });
  });
});

describe("migration 038 value constraint", () => {
  const INSERT =
    "INSERT INTO workspaces(id, owner_id, name, dir, created_at, temporary) VALUES (?, 'u1', ?, ?, 1, ?)";
  const UPDATE = "UPDATE workspaces SET temporary = ? WHERE id = ?";

  it("temporary accepts 0 and 1 on insert and update, and is 0 when omitted", () => {
    withOpenDb(":memory:", (db) => {
      db.prepare(INSERT).run(W_U1, "zero", "zero", 0);
      db.prepare(INSERT).run(W_U1_SPARE, "one", "one", 1);
      db.prepare(
        "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, 'u1', 'omitted', 'omitted', 1)",
      ).run(W_U2);
      expect(temporaryRows(db)).toEqual([
        { id: W_U1, owner_id: "u1", temporary: 0, t: "integer" },
        { id: W_U1_SPARE, owner_id: "u1", temporary: 1, t: "integer" },
        { id: W_U2, owner_id: "u1", temporary: 0, t: "integer" },
      ]);

      const update = db.prepare(UPDATE);
      expect(update.run(1, W_U1).changes).toBe(1);
      expect(update.run(0, W_U1_SPARE).changes).toBe(1);
      expect(update.run(1, W_U2).changes).toBe(1);
      expect(temporaryRows(db)).toEqual([
        { id: W_U1, owner_id: "u1", temporary: 1, t: "integer" },
        { id: W_U1_SPARE, owner_id: "u1", temporary: 0, t: "integer" },
        { id: W_U2, owner_id: "u1", temporary: 1, t: "integer" },
      ]);
    });
  });

  it.each([
    ["2", 2, CHECK_FAILED],
    ["-1", -1, CHECK_FAILED],
    ["NULL", null, NOT_NULL_TEMPORARY],
    ["'x'", "x", CHECK_FAILED],
  ] as Array<[string, number | string | null, RegExp]>)(
    "rejects temporary %s on insert and update",
    (_name, value, failure) => {
      withOpenDb(":memory:", (db) => {
        db.prepare(INSERT).run(W_U1, "kept", "kept", 1);
        const kept = temporaryRows(db);
        expect(kept).toEqual([{ id: W_U1, owner_id: "u1", temporary: 1, t: "integer" }]);
        expect(() => db.prepare(INSERT).run(W_MISSING, "other", "other", value)).toThrow(failure);
        expect(() => db.prepare(UPDATE).run(value, W_U1)).toThrow(failure);
        expect(temporaryRows(db)).toEqual(kept);
      });
    },
  );
});
