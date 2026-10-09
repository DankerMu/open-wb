/**
 * Shared chat-schema migration fixture for the 035 / 036 / 037 ADD COLUMN tests: a populated 034 database
 * across owners u1/u2 written as literals, plus catalog readers for the state an upgrade must keep.
 */
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { trackedMigrationAssets } from "../src/core/db/migration-assets.js";
import { validatedAppliedFilenames } from "../src/core/db/migration-ledger.js";
import { runMigration } from "../src/core/db/migration-runner.js";
import {
  createCanonicalLedger,
  ledgerFilenames,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_031,
  MIGRATION_032,
  MIGRATION_033,
  MIGRATION_034,
  MIGRATION_035,
  MIGRATION_0010,
  tableIndexKeys,
  withDatabase,
} from "./core-db-helpers.js";

export const RECEIPTS_033 = [
  MIGRATION_0010,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_031,
  MIGRATION_032,
  MIGRATION_033,
] as const;
export const RECEIPTS_034 = [...RECEIPTS_033, MIGRATION_034] as const;
export const RECEIPTS_035 = [...RECEIPTS_034, MIGRATION_035] as const;
export const S_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const S_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const S_C = "cccccccccccccccccccccccccccccccc";
export const S_D = "dddddddddddddddddddddddddddddddd";
export const W_U1 = "11111111111111111111111111111111";
export const W_U1_SPARE = "12121212121212121212121212121212";
export const W_U2 = "22222222222222222222222222222222";
export const W_MISSING = "99999999999999999999999999999999";

// [name, type, notnull, dflt_value, pk] of the current schema: 032/033/034 columns, the 035 tail,
// then the 036 `todo`, 037 `archived_at` and 040 composer-setting tails on chat_sessions and the
// 042 `attachments` tail on chat_messages.
type ColumnInfo = [string, string, number, string | null, number];
const CHAT_TABLE_INFO = {
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
    ["todo", "TEXT", 0, null, 0],
    ["archived_at", "INTEGER", 0, null, 0],
    ["approval_mode", "TEXT", 0, null, 0],
    ["model_id", "TEXT", 0, null, 0],
    ["reasoning_effort", "TEXT", 0, null, 0],
  ],
  chat_messages: [
    ["id", "INTEGER", 0, null, 1],
    ["session_id", "TEXT", 1, null, 0],
    ["role", "TEXT", 1, null, 0],
    ["content", "TEXT", 1, "''", 0],
    ["status", "TEXT", 1, null, 0],
    ["created_at", "INTEGER", 1, null, 0],
    ["thinking", "TEXT", 0, null, 0],
    ["attachments", "TEXT", 0, null, 0],
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
const SESSION_FOREIGN_KEYS = [
  { from: "owner_id", table: "accounts", to: "id", on_delete: "CASCADE" },
  { from: "parent_session_id", table: "chat_sessions", to: "id", on_delete: "SET NULL" },
  { from: "workspace_id", table: "workspaces", to: "id", on_delete: "SET NULL" },
];

/** Drops the trailing columns later migrations appended (035: 3/1/1; on sessions 036 and 037 one more each, 040 three; on messages 042 one more). */
function namesBefore035(info: ColumnInfo[], newColumns: number): string[] {
  return info.slice(0, info.length - newColumns).map(([name]) => name);
}

// Columns that exist before 035, per table the upgrade must leave byte-identical.
export const PRIOR_COLUMNS = {
  accounts: ["id", "account", "role", "disabled", "password_hash"],
  workspaces: ["id", "owner_id", "name", "dir", "created_at"],
  chat_sessions: namesBefore035(CHAT_TABLE_INFO.chat_sessions, 8),
  chat_messages: namesBefore035(CHAT_TABLE_INFO.chat_messages, 2),
  chat_steps: namesBefore035(CHAT_TABLE_INFO.chat_steps, 1),
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
export type PriorTable = keyof typeof PRIOR_COLUMNS;

// Populated 034 fixture across owners u1/u2: S_B is a fork child of S_A; message 7 and step 5 are
// deleted before the upgrade so the kept high-water marks sit above max(id).
export const WORKSPACES = [
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
export const CHAT_SEQUENCES = [
  { name: "chat_approvals", seq: 3 },
  { name: "chat_messages", seq: 7 },
  { name: "chat_steps", seq: 5 },
];

function asRows(table: PriorTable, rows: ReadonlyArray<readonly unknown[]>) {
  const columns = PRIOR_COLUMNS[table];
  return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])));
}

export const EXPECTED_ROWS = {
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
export type FixtureTable = keyof typeof EXPECTED_ROWS;

export function insertRows(
  db: DatabaseSync,
  table: PriorTable,
  rows: ReadonlyArray<readonly unknown[]>,
) {
  const columns = PRIOR_COLUMNS[table];
  const statement = db.prepare(
    `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) {
    statement.run(...(row as Array<string | number | null>));
  }
}

export function seedPopulated034(db: DatabaseSync): void {
  insertRows(db, "workspaces", WORKSPACES);
  insertRows(db, "chat_sessions", SESSIONS);
  insertRows(db, "chat_messages", MESSAGES);
  insertRows(db, "chat_steps", STEPS);
  insertRows(db, "chat_approvals", APPROVALS);
  db.prepare("DELETE FROM chat_steps WHERE id = ?").run(DELETED_STEP_ID);
  db.prepare("DELETE FROM chat_messages WHERE id = ?").run(DELETED_MESSAGE_ID);
}

/** Runs the tracked migrations through `receipts` only, then applies the fixture seed. */
export function seedThrough(
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

export function selectRows(db: DatabaseSync, table: string, columns: readonly string[]) {
  return db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`).all();
}

function tableInfo(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
}

export function columnNames(db: DatabaseSync, table: string): string[] {
  return tableInfo(db, table).map(([name]) => String(name));
}

export function sortedForeignKeys(db: DatabaseSync, table: string) {
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

export function receipts(db: DatabaseSync) {
  return db
    .prepare("SELECT sequence, filename, applied_at FROM schema_migrations ORDER BY sequence")
    .all();
}

export function chatSequences(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name, seq FROM sqlite_sequence WHERE name LIKE 'chat\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all();
}

/**
 * Everything an ADD COLUMN upgrade must not touch, for the given pre-upgrade columns (default: those
 * before 035): SQL-literal row values, prior column shape, keys, indexes, sequences. The indexes are
 * those of every table but `chat_turn_snapshots` and `account_composer_prefs`, which 039 and 041
 * create whole (their own tests cover them).
 */
export function preservedState(
  db: DatabaseSync,
  prior: Record<PriorTable, readonly string[]> = PRIOR_COLUMNS,
) {
  const perTable = (read: (table: string, columns: readonly string[]) => unknown) =>
    Object.fromEntries(
      Object.entries(prior).map(([table, columns]) => [table, read(table, columns)]),
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
    foreignKeys: perTable((table, columns) =>
      sortedForeignKeys(db, table).filter((key) => columns.includes(key.from)),
    ),
    indexes: perTable((table) => tableIndexKeys(db, table)),
    indexSql: db
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name NOT IN ('chat_turn_snapshots','account_composer_prefs') ORDER BY name",
      )
      .all(),
    sequences: chatSequences(db),
  };
}

export function expectFixtureRows(db: DatabaseSync): void {
  for (const table of Object.keys(EXPECTED_ROWS) as FixtureTable[]) {
    expect(selectRows(db, table, PRIOR_COLUMNS[table]), table).toEqual(EXPECTED_ROWS[table]);
  }
}

export function countReceipts(db: DatabaseSync, filename: string): number {
  return ledgerFilenames(db).filter((name) => name === filename).length;
}

/** The 035 metadata columns of every session, message and step. */
export function metadataRows(db: DatabaseSync) {
  return {
    sessions: db
      .prepare("SELECT id, workspace_id, scene, pinned_at FROM chat_sessions ORDER BY id")
      .all(),
    messages: db.prepare("SELECT id, thinking FROM chat_messages ORDER BY id").all(),
    steps: db.prepare("SELECT id, changes FROM chat_steps ORDER BY id").all(),
  };
}

/** The current chat schema: exact column info, session foreign keys and a clean foreign-key check. */
export function expectChatSchema(db: DatabaseSync): void {
  for (const [table, info] of Object.entries(CHAT_TABLE_INFO)) {
    expect(tableInfo(db, table), table).toEqual(info);
  }
  expect(sortedForeignKeys(db, "chat_sessions")).toEqual(SESSION_FOREIGN_KEYS);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

// The populated 035 fixture (shared by the 036 and 037 upgrade tests).
const THINKING = "先想 🧠\n再答";
const CHANGES = '{"files":[{"path":"a.md","added":1,"removed":0,"kind":"edit"}]}';

// Every column that exists before 036: the 034 columns plus the 035 tail.
export const COLUMNS_035 = {
  ...PRIOR_COLUMNS,
  chat_sessions: [...PRIOR_COLUMNS.chat_sessions, "workspace_id", "scene", "pinned_at"],
  chat_messages: [...PRIOR_COLUMNS.chat_messages, "thinking"],
  chat_steps: [...PRIOR_COLUMNS.chat_steps, "changes"],
};
// 035 values of the populated fixture: S_A is bound, has a scene and is pinned; S_B is its fork child.
const SESSION_META = [
  { id: S_A, workspace_id: W_U1, scene: "code", pinned_at: 150 },
  { id: S_B, workspace_id: null, scene: null, pinned_at: null },
  { id: S_C, workspace_id: W_U2, scene: "office", pinned_at: null },
  { id: S_D, workspace_id: null, scene: null, pinned_at: null },
];
const MESSAGE_THINKING = [
  { id: 1, thinking: null },
  { id: 2, thinking: THINKING },
  { id: 3, thinking: null },
  { id: 4, thinking: null },
  { id: 5, thinking: null },
  { id: 6, thinking: "" },
];
const STEP_CHANGES = [
  { id: 1, changes: CHANGES },
  { id: 2, changes: null },
  { id: 3, changes: null },
  { id: 4, changes: null },
];

/** The populated 034 fixture with its 035 columns filled in (two owners, one fork child). */
export function seedPopulated035(db: DatabaseSync): void {
  seedPopulated034(db);
  const meta = db.prepare(
    "UPDATE chat_sessions SET workspace_id = ?, scene = ?, pinned_at = ? WHERE id = ?",
  );
  meta.run(W_U1, "code", 150, S_A);
  meta.run(W_U2, "office", null, S_C);
  const thinking = db.prepare("UPDATE chat_messages SET thinking = ? WHERE id = ?");
  thinking.run(THINKING, 2);
  thinking.run("", 6);
  db.prepare("UPDATE chat_steps SET changes = ? WHERE id = 1").run(CHANGES);
}

export function expectFixture035(db: DatabaseSync): void {
  expectFixtureRows(db);
  expect(metadataRows(db)).toEqual({
    sessions: SESSION_META,
    messages: MESSAGE_THINKING,
    steps: STEP_CHANGES,
  });
  expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
}
