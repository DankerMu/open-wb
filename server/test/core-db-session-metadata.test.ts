/**
 * Issue #510 migration 035: five nullable session-metadata columns appended with ADD COLUMN.
 * Expected columns, rows and sequence values are fixture literals written before the upgrade
 * (spec「Migration 035 …」Scenarios), never recomputed from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { trackedMigrationAssets } from "../src/core/db/migration-assets.js";
import { validatedAppliedFilenames } from "../src/core/db/migration-ledger.js";
import { runMigration } from "../src/core/db/migration-runner.js";
import {
  createCanonicalLedger,
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  fullCatalogSnapshot,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_031,
  MIGRATION_032,
  MIGRATION_033,
  MIGRATION_034,
  MIGRATION_035,
  MIGRATION_0010,
  migrationReceiptExists,
  removeTempDirs,
  tableIndexKeys,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";

afterEach(removeTempDirs);

const RECEIPTS_033 = [
  MIGRATION_0010,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_031,
  MIGRATION_032,
  MIGRATION_033,
] as const;
const RECEIPTS_034 = [...RECEIPTS_033, MIGRATION_034] as const;
// Sequence = position in the discovered order: 034 must be the eighth receipt and 035 the ninth.
const LEDGER_035 = [...RECEIPTS_034, MIGRATION_035].map((filename, index): [number, string] => [
  index + 1,
  filename,
]);
const CHECK_FAILED = /CHECK constraint failed/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
const DUPLICATE_SCENE = /duplicate column name: scene/;
const S_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const S_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const S_C = "cccccccccccccccccccccccccccccccc";
const S_D = "dddddddddddddddddddddddddddddddd";
const W_U1 = "11111111111111111111111111111111";
const W_U1_SPARE = "12121212121212121212121212121212";
const W_U2 = "22222222222222222222222222222222";
const W_MISSING = "99999999999999999999999999999999";

// [name, type, notnull, dflt_value, pk] after 035: 032/033/034 columns, then the 035 tail.
type ColumnInfo = [string, string, number, string | null, number];
const TABLE_INFO_035 = {
  chat_sessions: [
    ["id", "TEXT", 1, null, 1],
    ["owner_id", "TEXT", 1, null, 0],
    ["title", "TEXT", 0, null, 0],
    ["status", "TEXT", 1, null, 0],
    ["omp_session_file", "TEXT", 0, null, 0],
    ["stream_epoch", "INTEGER", 1, "0", 0],
    ["created_at", "INTEGER", 1, null, 0],
    ["updated_at", "INTEGER", 1, null, 0],
    ["parent_session_id", "TEXT", 0, null, 0],
    ["workspace_id", "TEXT", 0, null, 0],
    ["scene", "TEXT", 0, null, 0],
    ["pinned_at", "INTEGER", 0, null, 0],
  ],
  chat_messages: [
    ["id", "INTEGER", 0, null, 1],
    ["session_id", "TEXT", 1, null, 0],
    ["role", "TEXT", 1, null, 0],
    ["content", "TEXT", 1, "''", 0],
    ["status", "TEXT", 1, null, 0],
    ["created_at", "INTEGER", 1, null, 0],
    ["thinking", "TEXT", 0, null, 0],
  ],
  chat_steps: [
    ["id", "INTEGER", 0, null, 1],
    ["message_id", "INTEGER", 1, null, 0],
    ["ordinal", "INTEGER", 1, null, 0],
    ["name", "TEXT", 1, null, 0],
    ["detail", "TEXT", 1, "''", 0],
    ["status", "TEXT", 1, null, 0],
    ["started_at", "INTEGER", 1, null, 0],
    ["ended_at", "INTEGER", 0, null, 0],
    ["output", "TEXT", 0, null, 0],
    ["changes", "TEXT", 0, null, 0],
  ],
} satisfies Record<string, ColumnInfo[]>;
const SESSION_FOREIGN_KEYS_035 = [
  { from: "owner_id", table: "accounts", to: "id", on_delete: "CASCADE" },
  { from: "parent_session_id", table: "chat_sessions", to: "id", on_delete: "SET NULL" },
  { from: "workspace_id", table: "workspaces", to: "id", on_delete: "SET NULL" },
];

function namesBefore035(info: ColumnInfo[], newColumns: number): string[] {
  return info.slice(0, info.length - newColumns).map(([name]) => name);
}

// Columns that exist before 035, per table the upgrade must leave byte-identical.
const PRIOR_COLUMNS = {
  accounts: ["id", "account", "role", "disabled", "password_hash"],
  workspaces: ["id", "owner_id", "name", "dir", "created_at"],
  chat_sessions: namesBefore035(TABLE_INFO_035.chat_sessions, 3),
  chat_messages: namesBefore035(TABLE_INFO_035.chat_messages, 1),
  chat_steps: namesBefore035(TABLE_INFO_035.chat_steps, 1),
  chat_approvals: [
    "id",
    "message_id",
    "request_id",
    "tool",
    "title",
    "requested_at",
    "expires_at",
    "decision",
    "decided_at",
  ],
} satisfies Record<string, readonly string[]>;
type PriorTable = keyof typeof PRIOR_COLUMNS;

// Populated 034 fixture across owners u1/u2: S_B is a fork child of S_A; message 7 and step 5 are
// deleted before the upgrade so the kept high-water marks sit above max(id).
const WORKSPACES = [
  [W_U1, "u1", "alpha", "alpha", 40],
  [W_U1_SPARE, "u1", "gamma 空间", "gamma", 41],
  [W_U2, "u2", "beta", "beta", 42],
] as const;
const SESSIONS = [
  [S_A, "u1", "root 会话 🚀", "done", "/data/a.jsonl", 3, 100, 200, null],
  [S_B, "u1", "fork", "idle", null, 0, 110, 210, S_A],
  [S_C, "u2", null, "failed", null, 1, 120, 220, null],
  [S_D, "u2", "tab\tand 'quote'", "stopped", "d.jsonl", 2, 130, 230, null],
] as const;
const MESSAGES = [
  [1, S_A, "user", "hello", "done", 1],
  [2, S_A, "assistant", "hi there ✓", "done", 2],
  [3, S_B, "user", "fork copy", "done", 3],
  [4, S_B, "assistant", "", "stopped", 4],
  [5, S_C, "user", "question", "done", 5],
  [6, S_D, "assistant", "streaming…", "running", 6],
  [7, S_D, "user", "deleted-top", "done", 7],
] as const;
const STEPS = [
  [1, 2, 0, "bash", '{"cmd":"ls"}', "done", 10, 11, "a\nb"],
  [2, 2, 1, "read", '{"path":"README.md"}', "failed", 12, 13, "ENOENT"],
  [3, 4, 0, "edit", '{"p":1}', "stopped", 14, 15, null],
  [4, 6, 0, "grep", "", "running", 16, null, null],
  [5, 6, 1, "tmp", "", "done", 17, 18, "x"],
] as const;
const APPROVALS = [
  [1, 2, "r-a", "bash", "run ls", 70, 60070, "allow", 80],
  [2, 4, "r-b", "edit", "write a.md", 71, 60071, null, null],
  [3, 6, "r-c", "bash", "rm -rf", 72, 60072, "deny", 90],
] as const;
const DELETED_MESSAGE_ID = 7;
const DELETED_STEP_ID = 5;
const CHAT_SEQUENCES = [
  { name: "chat_approvals", seq: 3 },
  { name: "chat_messages", seq: 7 },
  { name: "chat_steps", seq: 5 },
];

function asRows(table: PriorTable, rows: ReadonlyArray<readonly unknown[]>) {
  const columns = PRIOR_COLUMNS[table];
  return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])));
}

const EXPECTED_ROWS = {
  workspaces: asRows("workspaces", WORKSPACES),
  chat_sessions: asRows("chat_sessions", SESSIONS),
  chat_messages: asRows(
    "chat_messages",
    MESSAGES.filter(([id]) => id !== DELETED_MESSAGE_ID),
  ),
  chat_steps: asRows(
    "chat_steps",
    STEPS.filter(([id]) => id !== DELETED_STEP_ID),
  ),
  chat_approvals: asRows("chat_approvals", APPROVALS),
};
type FixtureTable = keyof typeof EXPECTED_ROWS;

function insertRows(db: DatabaseSync, table: PriorTable, rows: ReadonlyArray<readonly unknown[]>) {
  const columns = PRIOR_COLUMNS[table];
  const statement = db.prepare(
    `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) {
    statement.run(...(row as Array<string | number | null>));
  }
}

function seedPopulated034(db: DatabaseSync): void {
  insertRows(db, "workspaces", WORKSPACES);
  insertRows(db, "chat_sessions", SESSIONS);
  insertRows(db, "chat_messages", MESSAGES);
  insertRows(db, "chat_steps", STEPS);
  insertRows(db, "chat_approvals", APPROVALS);
  db.prepare("DELETE FROM chat_steps WHERE id = ?").run(DELETED_STEP_ID);
  db.prepare("DELETE FROM chat_messages WHERE id = ?").run(DELETED_MESSAGE_ID);
}

/** Runs the tracked migrations through `receipts` only (no 035), then applies the fixture seed. */
function seedThrough(
  path: string,
  receipts: readonly string[],
  seed: (db: DatabaseSync) => void,
): void {
  const assets = trackedMigrationAssets().filter((asset) => receipts.includes(asset.filename));
  expect(assets.map((asset) => asset.filename)).toEqual([...receipts]);
  withDatabase(path, (db) => {
    createCanonicalLedger(db);
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of assets) {
      runMigration(db, migration, () => {
        validatedAppliedFilenames(db, receipts);
      });
    }
    seed(db);
  });
}

function selectRows(db: DatabaseSync, table: string, columns: readonly string[]) {
  return db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`).all();
}

function tableInfo(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return tableInfo(db, table).map(([name]) => String(name));
}

function sortedForeignKeys(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA foreign_key_list('${table}')`)
    .all()
    .map((row) => ({
      from: String(row.from),
      table: String(row.table),
      to: String(row.to),
      on_delete: String(row.on_delete),
    }))
    .sort((left, right) => left.from.localeCompare(right.from));
}

function receipts(db: DatabaseSync) {
  return db
    .prepare("SELECT sequence, filename, applied_at FROM schema_migrations ORDER BY sequence")
    .all();
}

function chatSequences(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name, seq FROM sqlite_sequence WHERE name LIKE 'chat\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all();
}

/** Everything 035 must not touch: SQL-literal row values, prior column shape, keys, indexes, sequences. */
function preservedState(db: DatabaseSync) {
  const perTable = (read: (table: string, columns: readonly string[]) => unknown) =>
    Object.fromEntries(
      Object.entries(PRIOR_COLUMNS).map(([table, columns]) => [table, read(table, columns)]),
    );
  return {
    rows: perTable((table, columns) =>
      db
        .prepare(
          `SELECT ${columns.map((column) => `quote(${column}) AS ${column}`).join(", ")} FROM ${table} ORDER BY id`,
        )
        .all(),
    ),
    columns: perTable((table, columns) => tableInfo(db, table).slice(0, columns.length)),
    foreignKeys: perTable((table) =>
      table === "chat_sessions"
        ? sortedForeignKeys(db, table).filter((key) => key.from !== "workspace_id")
        : sortedForeignKeys(db, table),
    ),
    indexes: perTable((table) => tableIndexKeys(db, table)),
    indexSql: db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all(),
    sequences: chatSequences(db),
  };
}

function metadataRows(db: DatabaseSync) {
  return {
    sessions: db
      .prepare("SELECT id, workspace_id, scene, pinned_at FROM chat_sessions ORDER BY id")
      .all(),
    messages: db.prepare("SELECT id, thinking FROM chat_messages ORDER BY id").all(),
    steps: db.prepare("SELECT id, changes FROM chat_steps ORDER BY id").all(),
  };
}

function expectAllMetadataNull(db: DatabaseSync): void {
  const expected = (table: FixtureTable, extra: Record<string, null>) =>
    EXPECTED_ROWS[table].map((row) => ({ id: row.id, ...extra }));
  expect(metadataRows(db)).toEqual({
    sessions: expected("chat_sessions", { workspace_id: null, scene: null, pinned_at: null }),
    messages: expected("chat_messages", { thinking: null }),
    steps: expected("chat_steps", { changes: null }),
  });
}

function expect035Schema(db: DatabaseSync): void {
  for (const [table, info] of Object.entries(TABLE_INFO_035)) {
    expect(tableInfo(db, table), table).toEqual(info);
  }
  expect(sortedForeignKeys(db, "chat_sessions")).toEqual(SESSION_FOREIGN_KEYS_035);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function expectFixtureRows(db: DatabaseSync): void {
  for (const table of Object.keys(EXPECTED_ROWS) as FixtureTable[]) {
    expect(selectRows(db, table, PRIOR_COLUMNS[table]), table).toEqual(EXPECTED_ROWS[table]);
  }
}

function countReceipts(db: DatabaseSync, filename: string): number {
  return ledgerFilenames(db).filter((name) => name === filename).length;
}

describe("migration 035 session metadata schema", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])(
    "%s database ends 033,034,035 with five nullable default-free tail columns",
    (_label, path) => {
      withOpenDb(path(), (db) => {
        expect(ledgerRows(db)).toEqual(LEDGER_035);
        expect(ledgerFilenames(db).slice(-3)).toEqual([
          MIGRATION_033,
          MIGRATION_034,
          MIGRATION_035,
        ]);
        expect035Schema(db);
      });
    },
  );

  it("populated 034 database gains 035 once and keeps every prior value, key, index and sequence", () => {
    const file = join(tempDir(), "populated-034.db");
    seedThrough(file, RECEIPTS_034, seedPopulated034);
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_034]);
      expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
      expectFixtureRows(db);
      expect(columnNames(db, "chat_sessions")).not.toContain("workspace_id");
      return { receipts: receipts(db), state: preservedState(db) };
    });

    const upgraded = withOpenDb(file, (db) => {
      expect(ledgerRows(db)).toEqual(LEDGER_035);
      expect(countReceipts(db, MIGRATION_035)).toBe(1);
      expect(receipts(db).slice(0, 8)).toEqual(before.receipts);
      expect(preservedState(db)).toEqual(before.state);
      expectFixtureRows(db);
      expectAllMetadataNull(db);
      expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
      expect035Schema(db);
      for (const table of ["chat_messages", "chat_steps", "chat_approvals"]) {
        expect(sortedForeignKeys(db, table), table).toEqual(before.state.foreignKeys[table]);
      }
      expect(() =>
        insertRows(db, "chat_steps", [[9, 2, 1, "dup", "", "done", 1, 1, null]]),
      ).toThrow(/UNIQUE constraint failed: chat_steps\.message_id, chat_steps\.ordinal/);
      expect(() =>
        insertRows(db, "chat_approvals", [[9, 2, "r-a", "bash", "again", 1, 2, null, null]]),
      ).toThrow(/UNIQUE constraint failed: chat_approvals\.message_id, chat_approvals\.request_id/);
      return receipts(db);
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded);
      expect(preservedState(db)).toEqual(before.state);
      expectAllMetadataNull(db);
    });
  });

  it("a database whose receipts end at 033 applies 034 then 035 in one openDb run", () => {
    const file = join(tempDir(), "receipts-033.db");
    seedThrough(file, RECEIPTS_033, (db) => {
      db.prepare(
        "INSERT INTO chat_sessions(id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at) VALUES (?, 'u1', 'legacy', 'done', NULL, 0, 1, 2)",
      ).run(S_A);
      db.prepare(
        "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', 'ok', 'done', 3)",
      ).run(S_A);
      db.prepare(
        "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at, output) VALUES (1, 0, 'bash', '{}', 'done', 4, 5, 'out')",
      ).run();
    });
    const before = withDatabase(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_033]);
      expect(columnNames(db, "chat_sessions")).not.toContain("parent_session_id");
      return receipts(db);
    });

    withOpenDb(file, (db) => {
      expect(ledgerRows(db)).toEqual(LEDGER_035);
      expect(ledgerRows(db).slice(7)).toEqual([
        [8, MIGRATION_034],
        [9, MIGRATION_035],
      ]);
      expect(countReceipts(db, MIGRATION_034)).toBe(1);
      expect(countReceipts(db, MIGRATION_035)).toBe(1);
      expect(receipts(db).slice(0, 7)).toEqual(before);
      expect035Schema(db);
      expect(
        db
          .prepare(
            "SELECT id, title, parent_session_id, workspace_id, scene, pinned_at FROM chat_sessions",
          )
          .all(),
      ).toEqual([
        {
          id: S_A,
          title: "legacy",
          parent_session_id: null,
          workspace_id: null,
          scene: null,
          pinned_at: null,
        },
      ]);
      expect(db.prepare("SELECT id, content, thinking FROM chat_messages").all()).toEqual([
        { id: 1, content: "ok", thinking: null },
      ]);
      expect(db.prepare("SELECT id, output, changes FROM chat_steps").all()).toEqual([
        { id: 1, output: "out", changes: null },
      ]);
    });
  });

  it("a conflicting chat_sessions.scene aborts 035 atomically and a retry applies it once", () => {
    const file = join(tempDir(), "conflict-scene.db");
    seedThrough(file, RECEIPTS_034, (db) => {
      seedPopulated034(db);
      db.exec("ALTER TABLE chat_sessions ADD COLUMN scene TEXT");
      db.prepare("UPDATE chat_sessions SET scene = 'conflict-marker' WHERE id = ?").run(S_A);
    });
    const before = withDatabase(file, (db) => ({
      catalog: fullCatalogSnapshot(db),
      receipts: receipts(db),
      state: preservedState(db),
    }));

    expectOpenDbFailure(file, DUPLICATE_SCENE);

    withDatabase(file, (db) => {
      expect(fullCatalogSnapshot(db)).toEqual(before.catalog);
      expect(receipts(db)).toEqual(before.receipts);
      expect(ledgerFilenames(db)).toEqual([...RECEIPTS_034]);
      expect(migrationReceiptExists(db, MIGRATION_035)).toBe(false);
      expect(preservedState(db)).toEqual(before.state);
      expect(columnNames(db, "chat_sessions")).toEqual([...PRIOR_COLUMNS.chat_sessions, "scene"]);
      expect(columnNames(db, "chat_messages")).toEqual(PRIOR_COLUMNS.chat_messages);
      expect(columnNames(db, "chat_steps")).toEqual(PRIOR_COLUMNS.chat_steps);
      expect(
        db.prepare("SELECT id, scene FROM chat_sessions WHERE scene IS NOT NULL").all(),
      ).toEqual([{ id: S_A, scene: "conflict-marker" }]);
      expectFixtureRows(db);
      db.exec("ALTER TABLE chat_sessions DROP COLUMN scene");
    });

    withOpenDb(file, (db) => {
      expect(ledgerRows(db)).toEqual(LEDGER_035);
      expect(countReceipts(db, MIGRATION_035)).toBe(1);
      expect(receipts(db).slice(0, 8)).toEqual(before.receipts);
      expect035Schema(db);
      expectFixtureRows(db);
      expectAllMetadataNull(db);
      expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
    });
  });
});

describe("migration 035 column constraints", () => {
  const INSERT_META =
    "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at, workspace_id, scene, pinned_at) VALUES (?, 'u1', 'idle', 1, 1, ?, ?, ?)";
  const UPDATE_META =
    "UPDATE chat_sessions SET workspace_id = ?, scene = ?, pinned_at = ? WHERE id = ?";
  type Meta = [string | null, string | null, number | string | null];

  function withWorkspaceDb(action: (db: DatabaseSync) => void): void {
    withOpenDb(":memory:", (db) => {
      insertRows(db, "workspaces", WORKSPACES);
      action(db);
    });
  }

  it("scene, pinned_at and workspace_id accept every valid value including NULL", () => {
    const now = Date.now();
    withWorkspaceDb((db) => {
      const accepted: Array<[string, ...Meta]> = [
        [S_A, W_U1, "office", 0],
        [S_B, null, "code", now],
        [S_C, W_U1_SPARE, "design", null],
        [S_D, null, null, null],
      ];
      for (const [id, ...meta] of accepted) {
        db.prepare(INSERT_META).run(id, ...meta);
      }
      expect(metadataRows(db).sessions).toEqual(
        accepted.map(([id, workspace_id, scene, pinned_at]) => ({
          id,
          workspace_id,
          scene,
          pinned_at,
        })),
      );
      expect(
        db.prepare("SELECT typeof(pinned_at) AS t FROM chat_sessions ORDER BY id").all(),
      ).toEqual([{ t: "integer" }, { t: "integer" }, { t: "null" }, { t: "null" }]);
    });
  });

  it.each([
    ["scene chat", [null, "chat", null], CHECK_FAILED],
    ["scene Office", [null, "Office", null], CHECK_FAILED],
    ["scene empty", [null, "", null], CHECK_FAILED],
    ["pinned_at -1", [null, null, -1], CHECK_FAILED],
    ["pinned_at 1.5", [null, null, 1.5], CHECK_FAILED],
    ["pinned_at 'x'", [null, null, "x"], CHECK_FAILED],
    ["missing workspace", [W_MISSING, null, null], FOREIGN_KEY_FAILED],
  ] as Array<[string, Meta, RegExp]>)("rejects %s on insert and update", (_name, meta, error) => {
    withWorkspaceDb((db) => {
      db.prepare(INSERT_META).run(S_A, W_U2, "code", 5);
      const kept = metadataRows(db).sessions;
      expect(kept).toEqual([{ id: S_A, workspace_id: W_U2, scene: "code", pinned_at: 5 }]);
      expect(() => db.prepare(INSERT_META).run(S_B, ...meta)).toThrow(error);
      expect(() => db.prepare(UPDATE_META).run(...meta, S_A)).toThrow(error);
      expect(metadataRows(db).sessions).toEqual(kept);
    });
  });

  it("thinking and changes store arbitrary text verbatim and default to NULL when omitted", () => {
    const texts = ["", "深度思考 🧠\n第二行", '{"files":[{"path":"a.md","kind":"edit"}]}', "it's"];
    withWorkspaceDb((db) => {
      db.prepare(INSERT_META).run(S_A, null, null, null);
      const message = db.prepare(
        "INSERT INTO chat_messages(session_id, role, content, status, created_at, thinking) VALUES (?, 'assistant', '', 'done', 1, ?)",
      );
      const step = db.prepare(
        "INSERT INTO chat_steps(message_id, ordinal, name, status, started_at, changes) VALUES (1, ?, 'edit', 'done', 1, ?)",
      );
      texts.forEach((text, index) => {
        message.run(S_A, text);
        step.run(index, text);
      });
      db.prepare(
        "INSERT INTO chat_messages(session_id, role, status, created_at) VALUES (?, 'user', 'done', 2)",
      ).run(S_A);
      db.prepare(
        "INSERT INTO chat_steps(message_id, ordinal, name, status, started_at) VALUES (1, 9, 'x', 'done', 1)",
      ).run();
      const { messages, steps } = metadataRows(db);
      expect(messages).toEqual([
        ...texts.map((thinking, index) => ({ id: index + 1, thinking })),
        { id: 5, thinking: null },
      ]);
      expect(steps).toEqual([
        ...texts.map((changes, index) => ({ id: index + 1, changes })),
        { id: 5, changes: null },
      ]);
    });
  });

  it("deleting a workspace nulls session workspace_id; deleting an account still cascades", () => {
    const file = join(tempDir(), "cascade-035.db");
    seedThrough(file, RECEIPTS_034, seedPopulated034);
    withOpenDb(file, (db) => {
      const bind = db.prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?");
      bind.run(W_U1, S_A);
      bind.run(W_U1, S_B);
      bind.run(W_U2, S_C);

      db.prepare("DELETE FROM workspaces WHERE id = ?").run(W_U1);
      expect(metadataRows(db).sessions.map((row) => [row.id, row.workspace_id])).toEqual([
        [S_A, null],
        [S_B, null],
        [S_C, W_U2],
        [S_D, null],
      ]);
      expect(selectRows(db, "chat_sessions", PRIOR_COLUMNS.chat_sessions)).toEqual(
        EXPECTED_ROWS.chat_sessions,
      );
      expect(selectRows(db, "chat_messages", ["id"])).toEqual(
        [1, 2, 3, 4, 5, 6].map((id) => ({ id })),
      );

      bind.run(W_U1_SPARE, S_A);
      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      expect(
        db.prepare("SELECT id FROM accounts WHERE id IN ('u1', 'u2') ORDER BY id").all(),
      ).toEqual([{ id: "u2" }]);
      const u2Rows = (table: FixtureTable, ids: unknown[]) =>
        EXPECTED_ROWS[table].filter((row) => ids.includes(row.id));
      expect(selectRows(db, "workspaces", PRIOR_COLUMNS.workspaces)).toEqual(
        u2Rows("workspaces", [W_U2]),
      );
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
      expect(metadataRows(db).sessions).toEqual([
        { id: S_C, workspace_id: W_U2, scene: null, pinned_at: null },
        { id: S_D, workspace_id: null, scene: null, pinned_at: null },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});
