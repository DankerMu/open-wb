/**
 * Issue #942 migration 039: the table `chat_turn_snapshots` and its `workspace_id` index
 * (workspace-snapshots spec「迁移 039 回合快照登记表」Scenarios「建表与约束」「级联」, and the 039 part of
 * chat-sessions「会话数据 schema」"Migrations 037 to 039 apply in order"; the 038-failure half of that
 * scenario lives in `core-db-workspace-temporary.test.ts`). Expected columns, keys and rows are
 * literals taken from the spec text and the shared fixture, never recomputed from the migration.
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
  MIGRATION_039,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tableExists,
  tableIndexKeys,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import {
  COLUMNS_035,
  countReceipts,
  expectFixture035,
  preservedState,
  RECEIPTS_035,
  receipts,
  S_A,
  S_C,
  seedPopulated035,
  seedThrough,
  sortedForeignKeys,
  W_MISSING,
  W_U1,
  W_U1_SPARE,
  W_U2,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const TABLE = "chat_turn_snapshots";
const RECEIPTS_036 = [...RECEIPTS_035, MIGRATION_036] as const;
const RECEIPTS_038 = [...RECEIPTS_036, MIGRATION_037, MIGRATION_038] as const;
const LEDGER_TAIL: Array<[number, string]> = [
  [11, MIGRATION_037],
  [12, MIGRATION_038],
  [13, MIGRATION_039],
];
// Every column that exists before 039 on the tables an upgrade must keep.
const COLUMNS_038 = {
  ...COLUMNS_035,
  workspaces: [...COLUMNS_035.workspaces, "temporary"],
  chat_sessions: [...COLUMNS_035.chat_sessions, "todo", "archived_at"],
};
// [name, type, notnull, dflt_value, pk], in the order the spec lists the columns.
const TABLE_INFO = [
  ["message_id", "INTEGER", 0, null, 1],
  ["workspace_id", "TEXT", 1, null, 0],
  ["outcome", "TEXT", 1, null, 0],
  ["skipped", "TEXT", 0, null, 0],
  ["todo", "TEXT", 0, null, 0],
  ["created_at", "INTEGER", 1, null, 0],
];
const FOREIGN_KEYS = [
  { from: "message_id", table: "chat_messages", to: "id", on_delete: "CASCADE" },
  { from: "workspace_id", table: "workspaces", to: "id", on_delete: "CASCADE" },
];
const CHECK_FAILED = /CHECK constraint failed/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
const NOT_NULL_FAILED = /NOT NULL constraint failed: chat_turn_snapshots\./;
const DUPLICATE_MESSAGE = /UNIQUE constraint failed: chat_turn_snapshots\.message_id/;
const TABLE_EXISTS = /table chat_turn_snapshots already exists/;
const MISSING_MESSAGE_ID = 999;
const SKIPPED = '{"count":1,"paths":[{"path":"node_modules","reason":"excluded"}]}';
const TODO = '{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"pending"}]}]}';
const INSERT = `INSERT INTO ${TABLE}(message_id, workspace_id, outcome, skipped, todo, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
// One row per legal outcome on the fixture's messages: 1 and 2 belong to S_A, 3 to S_B, 5 to S_C.
const LEGAL_ROWS = [
  { message_id: 1, workspace_id: W_U1, outcome: "ok", skipped: SKIPPED, todo: TODO, created_at: 0 },
  {
    message_id: 2,
    workspace_id: W_U1,
    outcome: "command",
    skipped: null,
    todo: null,
    created_at: 7,
  },
  {
    message_id: 3,
    workspace_id: W_U1_SPARE,
    outcome: "too_large",
    skipped: null,
    todo: "",
    created_at: 1_760_000_000_000,
  },
  {
    message_id: 5,
    workspace_id: W_U2,
    outcome: "failed",
    skipped: null,
    todo: null,
    created_at: 9,
  },
];
type Value = string | number | null;

function snapshotRows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT message_id, workspace_id, outcome, skipped, todo, created_at FROM ${TABLE} ORDER BY message_id`,
    )
    .all();
}

function insertLegalRows(db: DatabaseSync): void {
  const insert = db.prepare(INSERT);
  for (const row of LEGAL_ROWS) {
    insert.run(
      row.message_id,
      row.workspace_id,
      row.outcome,
      row.skipped,
      row.todo,
      row.created_at,
    );
  }
}

function allSequences(db: DatabaseSync) {
  return db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all();
}

/** 037, 038 and 039 sit at positions eleven to thirteen, once each, and the table is the spec's. */
function expect039Applied(db: DatabaseSync): void {
  expect(ledgerRows(db).slice(10, 13)).toEqual(LEDGER_TAIL);
  for (const [, filename] of LEDGER_TAIL) {
    expect(countReceipts(db, filename), filename).toBe(1);
  }
  expect(
    db
      .prepare(`PRAGMA table_info('${TABLE}')`)
      .all()
      .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]),
  ).toEqual(TABLE_INFO);
  expect(sortedForeignKeys(db, TABLE)).toEqual(FOREIGN_KEYS);
  expect(tableIndexKeys(db, TABLE)).toEqual([
    { unique: 0, isPartial: 0, columns: [["workspace_id", 0]] },
  ]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** A current-schema in-memory database holding the shared fixture and the four legal rows. */
function withLegalRows(action: (db: DatabaseSync) => void): void {
  withOpenDb(":memory:", (db) => {
    seedPopulated035(db);
    insertLegalRows(db);
    expect(snapshotRows(db)).toEqual(LEGAL_ROWS);
    action(db);
  });
}

describe("migration 039 turn snapshot table", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])("%s database ends 037,038,039 with the registration table and its index", (_label, path) => {
    withOpenDb(path(), (db) => {
      expect039Applied(db);
      expect(snapshotRows(db)).toEqual([]);
    });
  });

  it("populated 038 database gains 039 once; legal rows insert and every prior row, key, index and sequence stays", () => {
    const file = join(tempDir(), "populated-038.db");
    seedThrough(file, RECEIPTS_038, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_038]);
      expect(tableExists(db, TABLE)).toBe(false);
      expectFixture035(db);
      return {
        receipts: receipts(db),
        state: preservedState(db, COLUMNS_038),
        sequences: allSequences(db).filter((row) => row.name !== "schema_migrations"),
      };
    });
    expect(before.receipts).toHaveLength(12);

    const upgraded = withOpenDb(file, (db) => {
      expect039Applied(db);
      expect(receipts(db).slice(0, 12)).toEqual(before.receipts);
      expect(snapshotRows(db)).toEqual([]);
      insertLegalRows(db);
      expect(snapshotRows(db)).toEqual(LEGAL_ROWS);
      expect(preservedState(db, COLUMNS_038)).toEqual(before.state);
      expectFixture035(db);
      // The table has no AUTOINCREMENT: neither creating it nor writing rows adds a sequence.
      expect(allSequences(db)).toEqual([
        ...before.sequences,
        { name: "schema_migrations", seq: TRACKED_MIGRATION_FILENAMES.length },
      ]);
      return receipts(db);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db, COLUMNS_038)).toEqual(before.state);
      expectFixture035(db);
      expect(snapshotRows(db)).toEqual(LEGAL_ROWS);
    });
  });

  it("a database whose receipts end at 036 applies 037, 038 then 039 in one openDb run", () => {
    const file = join(tempDir(), "receipts-036.db");
    seedThrough(file, RECEIPTS_036, seedPopulated035);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_036]);
      return receipts(db);
    });
    expect(before).toHaveLength(10);

    withOpenDb(file, (db) => {
      expect039Applied(db);
      expect(receipts(db).slice(0, 10)).toEqual(before);
      expect(ledgerRows(db)).toHaveLength(TRACKED_MIGRATION_FILENAMES.length);
      expectFixture035(db);
    });
  });

  it("a pre-existing table of the same name fails 039 instead of being accepted", () => {
    const file = join(tempDir(), "conflict-table.db");
    // The planted table has both indexed columns, so only CREATE TABLE itself can object to it.
    const planted = `CREATE TABLE ${TABLE} (message_id INTEGER PRIMARY KEY, workspace_id TEXT)`;
    seedThrough(file, RECEIPTS_038, (db) => {
      seedPopulated035(db);
      db.exec(planted);
    });

    expectOpenDbFailure(file, TABLE_EXISTS);

    withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_038]);
      expect(
        db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ?").all(TABLE),
      ).toEqual([{ type: "table", name: TABLE, sql: planted }]);
      expectFixture035(db);
    });
  });
});

describe("migration 039 constraints", () => {
  it.each([
    ["outcome 'done'", [6, W_U2, "done", null, null, 1], CHECK_FAILED],
    ["outcome NULL", [6, W_U2, null, null, null, 1], NOT_NULL_FAILED],
    [
      "a message_id without a message",
      [MISSING_MESSAGE_ID, W_U2, "ok", null, null, 1],
      FOREIGN_KEY_FAILED,
    ],
    ["a workspace_id without a workspace", [6, W_MISSING, "ok", null, null, 1], FOREIGN_KEY_FAILED],
    ["workspace_id NULL", [6, null, "ok", null, null, 1], NOT_NULL_FAILED],
    ["a second row for the same message_id", [1, W_U2, "failed", null, null, 1], DUPLICATE_MESSAGE],
    ["created_at -1", [6, W_U2, "ok", null, null, -1], CHECK_FAILED],
    ["created_at 1.5", [6, W_U2, "ok", null, null, 1.5], CHECK_FAILED],
    ["created_at 'x'", [6, W_U2, "ok", null, null, "x"], CHECK_FAILED],
    ["created_at NULL", [6, W_U2, "ok", null, null, null], NOT_NULL_FAILED],
  ] as Array<[string, Value[], RegExp]>)(
    "rejects %s and keeps the stored rows",
    (_name, values, failure) => {
      withLegalRows((db) => {
        expect(() => db.prepare(INSERT).run(...values)).toThrow(failure);
        expect(snapshotRows(db)).toEqual(LEGAL_ROWS);
      });
    },
  );

  it("rejects an update to an illegal outcome or created_at", () => {
    withLegalRows((db) => {
      const update = (column: string, value: Value) =>
        db.prepare(`UPDATE ${TABLE} SET ${column} = ? WHERE message_id = 1`).run(value);
      expect(() => update("outcome", "done")).toThrow(CHECK_FAILED);
      expect(() => update("created_at", -1)).toThrow(CHECK_FAILED);
      expect(() => update("workspace_id", W_MISSING)).toThrow(FOREIGN_KEY_FAILED);
      expect(snapshotRows(db)).toEqual(LEGAL_ROWS);
    });
  });
});

describe("migration 039 cascade", () => {
  const messageIds = (db: DatabaseSync) => snapshotRows(db).map((row) => row.message_id);
  const count = (db: DatabaseSync, table: string) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;

  it("deleting a message removes its row only", () => {
    withLegalRows((db) => {
      expect(db.prepare("DELETE FROM chat_messages WHERE id = 1").run().changes).toBe(1);
      expect(snapshotRows(db)).toEqual(LEGAL_ROWS.slice(1));
    });
  });

  it("deleting a session removes the rows of its messages and no other session's", () => {
    withLegalRows((db) => {
      expect(db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(S_A).changes).toBe(1);
      expect(snapshotRows(db)).toEqual(LEGAL_ROWS.slice(2));
    });
  });

  it("deleting a workspace removes its rows while the messages and other workspaces' rows stay", () => {
    withLegalRows((db) => {
      const messages = count(db, "chat_messages");
      expect(db.prepare("DELETE FROM workspaces WHERE id = ?").run(W_U1).changes).toBe(1);
      expect(messageIds(db)).toEqual([3, 5]);
      expect(db.prepare("DELETE FROM workspaces WHERE id = ?").run(W_U2).changes).toBe(1);
      expect(snapshotRows(db)).toEqual([LEGAL_ROWS[2]]);
      // The session's own workspace key is SET NULL, so no message goes with the workspace.
      expect(count(db, "chat_messages")).toBe(messages);
      expect(
        db.prepare("SELECT workspace_id FROM chat_sessions WHERE id IN (?, ?)").all(S_A, S_C),
      ).toEqual([{ workspace_id: null }, { workspace_id: null }]);
    });
  });
});
