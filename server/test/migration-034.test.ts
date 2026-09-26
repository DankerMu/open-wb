/**
 * Issue #449 migration 034: chat tables rebuilt for `stopped`, `parent_session_id` and `chat_approvals`.
 * Expected rows, sequence values and schema shapes are fixture literals written before the upgrade
 * (spec「迁移 034 回合控制 schema」), never recomputed from the migration.
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
  MIGRATION_0010,
  migrationReceiptExists,
  removeTempDirs,
  tableExists,
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
const CHECK_FAILED = /CHECK constraint failed/;
const UNIQUE_APPROVAL =
  /UNIQUE constraint failed: chat_approvals\.message_id, chat_approvals\.request_id/;
const UNIQUE_ORDINAL = /UNIQUE constraint failed: chat_steps\.message_id, chat_steps\.ordinal/;
const S_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const S_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const S_C = "cccccccccccccccccccccccccccccccc";
const S_D = "dddddddddddddddddddddddddddddddd";
const S_E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const SESSION_COLUMNS = [
  "id",
  "owner_id",
  "title",
  "status",
  "omp_session_file",
  "stream_epoch",
  "created_at",
  "updated_at",
] as const;
const MESSAGE_COLUMNS = ["id", "session_id", "role", "content", "status", "created_at"] as const;
const STEP_COLUMNS = [
  "id",
  "message_id",
  "ordinal",
  "name",
  "detail",
  "status",
  "started_at",
  "ended_at",
  "output",
] as const;

// [name, type, notnull, dflt_value, pk] in declaration order (032 + 033 + 034).
const TABLE_INFO: Record<string, Array<[string, string, number, string | null, number]>> = {
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
  ],
  chat_messages: [
    ["id", "INTEGER", 0, null, 1],
    ["session_id", "TEXT", 1, null, 0],
    ["role", "TEXT", 1, null, 0],
    ["content", "TEXT", 1, "''", 0],
    ["status", "TEXT", 1, null, 0],
    ["created_at", "INTEGER", 1, null, 0],
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
  ],
  chat_approvals: [
    ["id", "INTEGER", 0, null, 1],
    ["message_id", "INTEGER", 1, null, 0],
    ["request_id", "TEXT", 1, null, 0],
    ["tool", "TEXT", 1, null, 0],
    ["title", "TEXT", 1, null, 0],
    ["requested_at", "INTEGER", 1, null, 0],
    ["expires_at", "INTEGER", 1, null, 0],
    ["decision", "TEXT", 0, null, 0],
    ["decided_at", "INTEGER", 0, null, 0],
  ],
};

const FOREIGN_KEYS: Record<string, Array<Record<string, string>>> = {
  chat_sessions: [
    { from: "owner_id", table: "accounts", to: "id", on_delete: "CASCADE" },
    { from: "parent_session_id", table: "chat_sessions", to: "id", on_delete: "SET NULL" },
  ],
  chat_messages: [{ from: "session_id", table: "chat_sessions", to: "id", on_delete: "CASCADE" }],
  chat_steps: [{ from: "message_id", table: "chat_messages", to: "id", on_delete: "CASCADE" }],
  chat_approvals: [{ from: "message_id", table: "chat_messages", to: "id", on_delete: "CASCADE" }],
};

const INDEXES: Record<string, Array<{ unique: number; columns: Array<[string, number]> }>> = {
  chat_sessions: [
    {
      unique: 0,
      columns: [
        ["owner_id", 0],
        ["updated_at", 1],
      ],
    },
    { unique: 1, columns: [["id", 0]] },
  ],
  chat_messages: [
    {
      unique: 0,
      columns: [
        ["session_id", 0],
        ["created_at", 0],
        ["id", 0],
      ],
    },
  ],
  chat_steps: [
    {
      unique: 1,
      columns: [
        ["message_id", 0],
        ["ordinal", 0],
      ],
    },
  ],
  chat_approvals: [
    { unique: 0, columns: [["message_id", 0]] },
    {
      unique: 1,
      columns: [
        ["message_id", 0],
        ["request_id", 0],
      ],
    },
  ],
};

// Populated 033 fixture: two owners; message ids 3 (middle) and 8 (top) and step ids 3 (middle)
// and 5 (top) are deleted before the upgrade, so the kept high-water marks are 8 and 5.
const SESSIONS = [
  [S_A, "u1", "first 会话 🚀", "done", "/data/a.jsonl", 3, 100, 200],
  [S_B, "u1", null, "failed", null, 0, 110, 210],
  [S_C, "u2", "second\nline", "idle", null, 1, 120, 220],
  [S_D, "u2", "running", "running", "d.jsonl", 2, 130, 230],
] as const;
const MESSAGES = [
  [1, S_A, "user", "hello", "done", 1],
  [2, S_A, "assistant", "hi there ✓", "done", 2],
  [3, S_A, "user", "deleted-middle", "done", 3],
  [4, S_B, "user", "question", "done", 4],
  [5, S_B, "assistant", "", "failed", 5],
  [6, S_C, "user", "tab\tand 'quote'", "done", 6],
  [7, S_D, "assistant", "streaming…", "running", 7],
  [8, S_D, "user", "deleted-top", "done", 8],
] as const;
const STEPS = [
  [1, 2, 0, "bash", '{"cmd":"ls"}', "done", 10, 11, "a\nb"],
  [2, 2, 1, "read", '{"path":"README.md"}', "failed", 12, 13, "ENOENT"],
  [3, 5, 0, "grep", "", "done", 14, 15, null],
  [4, 7, 0, "edit", '{"p":1}', "running", 16, null, null],
  [5, 7, 1, "tmp", "", "done", 17, 18, "x"],
] as const;
const DELETED_MESSAGE_IDS = [3, 8];
const DELETED_STEP_IDS = [3, 5];
const KEPT_MESSAGE_IDS = [1, 2, 4, 5, 6, 7];
const KEPT_STEP_IDS = [1, 2, 4];

function asRow(columns: readonly string[], values: readonly unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

const EXPECTED_SESSIONS = SESSIONS.map((row) => asRow(SESSION_COLUMNS, row));
const EXPECTED_MESSAGES = MESSAGES.filter(([id]) => KEPT_MESSAGE_IDS.includes(id)).map((row) =>
  asRow(MESSAGE_COLUMNS, row),
);
const EXPECTED_STEPS = STEPS.filter(([id]) => KEPT_STEP_IDS.includes(id)).map((row) =>
  asRow(STEP_COLUMNS, row),
);

function seed033Database(path: string, seed: (db: DatabaseSync) => void): void {
  const assets = trackedMigrationAssets().filter((asset) => asset.filename !== MIGRATION_034);
  const filenames = assets.map((asset) => asset.filename);
  expect(filenames).toEqual([...RECEIPTS_033]);
  withDatabase(path, (db) => {
    createCanonicalLedger(db);
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of assets) {
      runMigration(db, migration, () => {
        validatedAppliedFilenames(db, filenames);
      });
    }
    seed(db);
  });
}

function insertSession(db: DatabaseSync, row: readonly unknown[]): void {
  db.prepare(
    `INSERT INTO chat_sessions(${SESSION_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...(row as Array<string | number | null>));
}

function insertMessage(db: DatabaseSync, sessionId: string, status: string, content = ""): number {
  const result = db
    .prepare(
      "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', ?, ?, 50)",
    )
    .run(sessionId, content, status);
  return Number(result.lastInsertRowid);
}

function insertStep(db: DatabaseSync, messageId: number, ordinal: number, status: string): number {
  const result = db
    .prepare(
      "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at) VALUES (?, ?, 'step', '', ?, 60)",
    )
    .run(messageId, ordinal, status);
  return Number(result.lastInsertRowid);
}

function insertApproval(
  db: DatabaseSync,
  messageId: number,
  requestId: string,
  decision: string | null,
): void {
  db.prepare(
    "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at) VALUES (?, ?, 'bash', 'run ls', 70, 60070, ?, ?)",
  ).run(messageId, requestId, decision, decision === null ? null : 80);
}

function seedPopulated(db: DatabaseSync): void {
  for (const session of SESSIONS) {
    insertSession(db, session);
  }
  const message = db.prepare(
    `INSERT INTO chat_messages(${MESSAGE_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of MESSAGES) {
    message.run(...row);
  }
  const step = db.prepare(
    `INSERT INTO chat_steps(${STEP_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of STEPS) {
    step.run(...row);
  }
  for (const id of DELETED_STEP_IDS) {
    db.prepare("DELETE FROM chat_steps WHERE id = ?").run(id);
  }
  for (const id of DELETED_MESSAGE_IDS) {
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
  }
}

function rows(db: DatabaseSync, table: string, columns: readonly string[]) {
  return db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`).all();
}

/** Storage class + exact bytes of every pre-034 column, for byte-identity across the rebuild. */
function byteSnapshot(db: DatabaseSync) {
  const encode = (table: string, columns: readonly string[]) =>
    db
      .prepare(
        `SELECT ${columns.map((c) => `typeof(${c}) || ':' || hex(${c}) AS ${c}`).join(", ")} FROM ${table} ORDER BY id`,
      )
      .all();
  return {
    sessions: encode("chat_sessions", SESSION_COLUMNS),
    messages: encode("chat_messages", MESSAGE_COLUMNS),
    steps: encode("chat_steps", STEP_COLUMNS),
  };
}

function chatSequences(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name, seq, typeof(seq) AS seq_type FROM sqlite_sequence WHERE name IN ('chat_messages', 'chat_steps', 'chat_approvals') ORDER BY name",
    )
    .all();
}

function receipts(db: DatabaseSync) {
  return db
    .prepare("SELECT sequence, filename, applied_at FROM schema_migrations ORDER BY sequence")
    .all();
}

function tableInfo(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
}

function foreignKeys(db: DatabaseSync, table: string) {
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

function indexes(db: DatabaseSync, table: string) {
  return tableIndexKeys(db, table)
    .map((index) => {
      expect(index.isPartial).toBe(0);
      return { unique: index.unique, columns: index.columns };
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expect034Receipts(db: DatabaseSync): void {
  expect(ledgerFilenames(db)).toEqual([...RECEIPTS_034]);
  expect(ledgerRows(db).at(-1)).toEqual([8, MIGRATION_034]);
}

function expect034Schema(db: DatabaseSync): void {
  for (const table of Object.keys(TABLE_INFO)) {
    expect(tableInfo(db, table), table).toEqual(TABLE_INFO[table]);
    expect(foreignKeys(db, table), table).toEqual(FOREIGN_KEYS[table]);
    expect(indexes(db, table), table).toEqual(INDEXES[table]);
  }
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE instr(name, '_next') > 0 OR instr(sql, '_next') > 0",
      )
      .all(),
  ).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_temp_master").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function expectNoMigrationLeftovers(db: DatabaseSync): void {
  expect(migrationReceiptExists(db, MIGRATION_034)).toBe(false);
  expect(ledgerFilenames(db)).toEqual([...RECEIPTS_033]);
  expect(tableExists(db, "chat_sessions_next")).toBe(false);
  expect(tableExists(db, "chat_steps_next")).toBe(false);
}

describe("migration 034 chat turn-control schema", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])(
    "%s database gets eight receipts, the rebuilt tables, chat_approvals and no sequence rows",
    (_label, path) => {
      withOpenDb(path(), (db) => {
        expect034Receipts(db);
        expect(ledgerFilenames(db).filter((name) => name === MIGRATION_034)).toHaveLength(1);
        expect034Schema(db);
        expect(chatSequences(db)).toEqual([]);
      });
    },
  );

  it("stopped is accepted on all three tables while unknown status and decision values are rejected", () => {
    withOpenDb(":memory:", (db) => {
      expect034Receipts(db);
      insertSession(db, [S_A, "u1", null, "stopped", null, 0, 1, 1]);
      const messageId = insertMessage(db, S_A, "stopped");
      insertStep(db, messageId, 0, "stopped");
      expect(db.prepare("SELECT status FROM chat_sessions").get()).toEqual({ status: "stopped" });
      expect(db.prepare("SELECT status FROM chat_messages").get()).toEqual({ status: "stopped" });
      expect(db.prepare("SELECT status FROM chat_steps").get()).toEqual({ status: "stopped" });

      expect(() => insertSession(db, [S_B, "u1", null, "cancelled", null, 0, 1, 1])).toThrow(
        CHECK_FAILED,
      );
      expect(() => insertMessage(db, S_A, "cancelled")).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, messageId, 1, "cancelled")).toThrow(CHECK_FAILED);
      expect(() => insertSession(db, [S_B, "u1", null, "Stopped", null, 0, 1, 1])).toThrow(
        CHECK_FAILED,
      );

      insertApproval(db, messageId, "r-null", null);
      insertApproval(db, messageId, "r-allow", "allow");
      insertApproval(db, messageId, "r-deny", "deny");
      insertApproval(db, messageId, "r-timeout", "timeout");
      expect(() => insertApproval(db, messageId, "r-bad", "maybe")).toThrow(CHECK_FAILED);
      expect(() => insertApproval(db, messageId, "r-allow", "deny")).toThrow(UNIQUE_APPROVAL);
      expect(
        db.prepare("SELECT request_id, decision FROM chat_approvals ORDER BY id").all(),
      ).toEqual([
        { request_id: "r-null", decision: null },
        { request_id: "r-allow", decision: "allow" },
        { request_id: "r-deny", decision: "deny" },
        { request_id: "r-timeout", decision: "timeout" },
      ]);
      const otherMessage = insertMessage(db, S_A, "done");
      insertApproval(db, otherMessage, "r-allow", null);

      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(messageId);
      expect(
        db.prepare("SELECT message_id, request_id FROM chat_approvals ORDER BY id").all(),
      ).toEqual([{ message_id: otherMessage, request_id: "r-allow" }]);
      db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(S_A);
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_approvals").get()).toEqual({ n: 0 });
    });
  });

  it("populated 033 database upgrades once with byte-identical rows and kept sequence marks", () => {
    const file = join(tempDir(), "populated.db");
    seed033Database(file, seedPopulated);
    const before = withDatabase(file, (db) => ({
      receipts: receipts(db),
      bytes: byteSnapshot(db),
      sequences: chatSequences(db),
    }));
    expect(before.receipts.map((row) => row.filename)).toEqual([...RECEIPTS_033]);
    expect(before.sequences).toEqual([
      { name: "chat_messages", seq: 8, seq_type: "integer" },
      { name: "chat_steps", seq: 5, seq_type: "integer" },
    ]);

    const upgraded = withOpenDb(file, (db) => {
      expect034Receipts(db);
      expect(ledgerFilenames(db).filter((name) => name === MIGRATION_034)).toHaveLength(1);
      expect(receipts(db).slice(0, 7)).toEqual(before.receipts);
      expect(byteSnapshot(db)).toEqual(before.bytes);
      expect(rows(db, "chat_sessions", SESSION_COLUMNS)).toEqual(EXPECTED_SESSIONS);
      expect(rows(db, "chat_messages", MESSAGE_COLUMNS)).toEqual(EXPECTED_MESSAGES);
      expect(rows(db, "chat_steps", STEP_COLUMNS)).toEqual(EXPECTED_STEPS);
      expect(
        db.prepare("SELECT id, parent_session_id FROM chat_sessions ORDER BY id").all(),
      ).toEqual(SESSIONS.map(([id]) => ({ id, parent_session_id: null })));
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_approvals").get()).toEqual({ n: 0 });
      expect(chatSequences(db)).toEqual(before.sequences);
      expect034Schema(db);
      expect(() => insertStep(db, 2, 1, "done")).toThrow(UNIQUE_ORDINAL);
      return { receipts: receipts(db), bytes: byteSnapshot(db) };
    });

    expectRepeatedOpenStable(file, (db) => {
      expect(receipts(db)).toEqual(upgraded.receipts);
      expect(byteSnapshot(db)).toEqual(upgraded.bytes);
      expect(chatSequences(db)).toEqual(before.sequences);
    });
  });

  it("sequence high-water marks above max(id) survive, so new ids exceed every id ever issued", () => {
    const file = join(tempDir(), "high-water.db");
    seed033Database(file, seedPopulated);
    withDatabase(file, (db) => {
      expect(db.prepare("SELECT max(id) AS id FROM chat_messages").get()).toEqual({ id: 7 });
      expect(db.prepare("SELECT max(id) AS id FROM chat_steps").get()).toEqual({ id: 4 });
    });
    withOpenDb(file, (db) => {
      expect034Receipts(db);
      expect(chatSequences(db)).toEqual([
        { name: "chat_messages", seq: 8, seq_type: "integer" },
        { name: "chat_steps", seq: 5, seq_type: "integer" },
      ]);
      const messageId = insertMessage(db, S_A, "done");
      expect(messageId).toBe(9);
      expect(insertStep(db, messageId, 0, "done")).toBe(6);
    });
  });

  it.each([
    [
      "messages keep rows",
      (db: DatabaseSync) => {
        insertMessage(db, S_A, "done");
        insertMessage(db, S_A, "done");
      },
      [1, 2],
    ],
    [
      "messages all deleted",
      (db: DatabaseSync) => {
        insertMessage(db, S_A, "done");
        insertMessage(db, S_A, "done");
        db.exec("DELETE FROM chat_messages");
      },
      [],
    ],
  ])(
    "mixed sequence state (%s, steps never inserted) writes no NULL or phantom sequence row",
    (_label, seed, keptIds) => {
      const file = join(tempDir(), "mixed.db");
      seed033Database(file, (db) => {
        insertSession(db, [S_A, "u1", null, "done", null, 0, 1, 1]);
        seed(db);
      });
      withDatabase(file, (db) => {
        expect(chatSequences(db)).toEqual([{ name: "chat_messages", seq: 2, seq_type: "integer" }]);
      });
      withOpenDb(file, (db) => {
        expect034Receipts(db);
        expect(db.prepare("SELECT id FROM chat_messages ORDER BY id").all()).toEqual(
          keptIds.map((id) => ({ id })),
        );
        expect(chatSequences(db)).toEqual([{ name: "chat_messages", seq: 2, seq_type: "integer" }]);
        const messageId = insertMessage(db, S_A, "done");
        expect(messageId).toBe(3);
        expect(insertStep(db, messageId, 0, "done")).toBe(1);
        expect(insertStep(db, messageId, 1, "done")).toBe(2);
        expect(chatSequences(db)).toEqual([
          { name: "chat_messages", seq: 3, seq_type: "integer" },
          { name: "chat_steps", seq: 2, seq_type: "integer" },
        ]);
      });
    },
  );

  it("after the upgrade account and session deletes cascade and parent deletes null out forks", () => {
    const file = join(tempDir(), "cascade.db");
    seed033Database(file, seedPopulated);
    withOpenDb(file, (db) => {
      expect034Receipts(db);
      insertApproval(db, 2, "r-a", null);
      insertApproval(db, 7, "r-d", "allow");
      insertSession(db, [S_E, "u1", "fork", "idle", null, 0, 300, 300]);
      db.prepare("UPDATE chat_sessions SET parent_session_id = ? WHERE id = ?").run(S_B, S_E);

      db.prepare("DELETE FROM accounts WHERE id = ?").run("u2");
      expect(db.prepare("SELECT id FROM chat_sessions ORDER BY id").all()).toEqual([
        { id: S_A },
        { id: S_B },
        { id: S_E },
      ]);
      expect(db.prepare("SELECT id FROM chat_messages ORDER BY id").all()).toEqual(
        [1, 2, 4, 5].map((id) => ({ id })),
      );
      expect(db.prepare("SELECT id FROM chat_steps ORDER BY id").all()).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect(db.prepare("SELECT request_id FROM chat_approvals").all()).toEqual([
        { request_id: "r-a" },
      ]);

      db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(S_B);
      expect(
        db.prepare("SELECT id, parent_session_id, title FROM chat_sessions ORDER BY id").all(),
      ).toEqual([
        { id: S_A, parent_session_id: null, title: "first 会话 🚀" },
        { id: S_E, parent_session_id: null, title: "fork" },
      ]);
      expect(db.prepare("SELECT id FROM chat_messages ORDER BY id").all()).toEqual([
        { id: 1 },
        { id: 2 },
      ]);

      db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(S_A);
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_steps").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM chat_approvals").get()).toEqual({ n: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it.each([
    ["chat_messages_next", /table chat_messages_next already exists/],
    ["chat_approvals", /table chat_approvals already exists/],
  ])(
    "a pre-existing %s aborts 034 atomically and a retry after removing it applies once",
    (conflict, error) => {
      const file = join(tempDir(), `conflict-${conflict}.db`);
      seed033Database(file, (db) => {
        seedPopulated(db);
        db.exec(`CREATE TABLE ${conflict} (marker TEXT); INSERT INTO ${conflict} VALUES ('kept')`);
      });
      const before = withDatabase(file, (db) => ({
        catalog: fullCatalogSnapshot(db),
        receipts: receipts(db),
        bytes: byteSnapshot(db),
      }));

      expectOpenDbFailure(file, error);

      withDatabase(file, (db) => {
        expect(fullCatalogSnapshot(db)).toEqual(before.catalog);
        expect(receipts(db)).toEqual(before.receipts);
        expect(byteSnapshot(db)).toEqual(before.bytes);
        expect(rows(db, "chat_messages", MESSAGE_COLUMNS)).toEqual(EXPECTED_MESSAGES);
        expectNoMigrationLeftovers(db);
        expect(
          tableExists(db, conflict === "chat_approvals" ? "chat_messages_next" : "chat_approvals"),
        ).toBe(false);
        expect(db.prepare(`SELECT marker FROM ${conflict}`).all()).toEqual([{ marker: "kept" }]);
        expect(chatSequences(db)).toEqual([
          { name: "chat_messages", seq: 8, seq_type: "integer" },
          { name: "chat_steps", seq: 5, seq_type: "integer" },
        ]);
        db.exec(`DROP TABLE ${conflict}`);
      });

      withOpenDb(file, (db) => {
        expect034Receipts(db);
        expect(ledgerFilenames(db).filter((name) => name === MIGRATION_034)).toHaveLength(1);
        expect(receipts(db).slice(0, 7)).toEqual(before.receipts);
        expect(byteSnapshot(db)).toEqual(before.bytes);
        expect034Schema(db);
      });
    },
  );
});
