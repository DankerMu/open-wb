import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { trackedMigrationAssets } from "../src/core/db/migration-assets.js";
import { validatedAppliedFilenames } from "../src/core/db/migration-ledger.js";
import { runMigration } from "../src/core/db/migration-runner.js";
import {
  COMPLETE_CATALOG,
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
  MIGRATION_0010,
  migrationReceiptExists,
  removeTempDirs,
  schemaInventory,
  TRACKED_MIGRATION_FILENAMES,
  tableExists,
  tableIndexKeys,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";

afterEach(removeTempDirs);

const CHECK_FAILED = /CHECK constraint failed/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
const UNIQUE_ORDINAL = /UNIQUE constraint failed: chat_steps\./;
const TABLE_EXISTS = /table chat_steps already exists/;
const HEX32_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEX32_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEX32_C = "cccccccccccccccccccccccccccccccc";
const HEX32_D = "dddddddddddddddddddddddddddddddd";
const HEX32_F = "ffffffffffffffffffffffffffffffff";
const SESSION_ID_NUL = `${HEX32_A}\0`;
const AUTH_SESSION_ID = "a".repeat(64);
const WORKSPACE_ID = "0123456789abcdef0123456789abcdef";
const HISTORICAL_FILENAMES = [
  MIGRATION_0010,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_031,
] as const;
const INSERT_SESSION =
  "INSERT INTO chat_sessions(id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const INSERT_MESSAGE =
  "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?)";
const INSERT_STEP =
  "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

function notNull(column: string): RegExp {
  return new RegExp(`NOT NULL constraint failed: ${column.replaceAll(".", "\\.")}`);
}

function insertSession(
  db: DatabaseSync,
  id: string | null,
  ownerId: string | null,
  title: string | null,
  status: string | null,
  ompSessionFile: string | null,
  streamEpoch: number | string | null,
  createdAt: number | string | null,
  updatedAt: number | string | null,
) {
  return db
    .prepare(INSERT_SESSION)
    .run(id, ownerId, title, status, ompSessionFile, streamEpoch, createdAt, updatedAt);
}

function insertMessage(
  db: DatabaseSync,
  sessionId: string | null,
  role: string | null,
  content: string | null,
  status: string | null,
  createdAt: number | string | null,
) {
  return db.prepare(INSERT_MESSAGE).run(sessionId, role, content, status, createdAt);
}

function insertStep(
  db: DatabaseSync,
  messageId: number | string | null,
  ordinal: number | string | null,
  name: string | null,
  detail: string | null,
  status: string | null,
  startedAt: number | string | null,
  endedAt: number | string | null,
) {
  return db.prepare(INSERT_STEP).run(messageId, ordinal, name, detail, status, startedAt, endedAt);
}

function sessionRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, owner_id, title, status, omp_session_file, stream_epoch, created_at, updated_at FROM chat_sessions ORDER BY id",
    )
    .all();
}

function messageRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, session_id, role, content, status, created_at FROM chat_messages ORDER BY id",
    )
    .all();
}

function stepRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, message_id, ordinal, name, detail, status, started_at, ended_at FROM chat_steps ORDER BY id",
    )
    .all();
}

function sessionOf(
  id: string,
  ownerId: string,
  title: string | null,
  status: string,
  omp: string | null,
  epoch: number,
  createdAt: number,
  updatedAt: number,
) {
  return {
    id,
    owner_id: ownerId,
    title,
    status,
    omp_session_file: omp,
    stream_epoch: epoch,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function messageOf(
  id: number,
  sessionId: string,
  role: string,
  content: string,
  status: string,
  createdAt: number,
) {
  return { id, session_id: sessionId, role, content, status, created_at: createdAt };
}

function stepOf(
  id: number,
  messageId: number,
  ordinal: number,
  name: string,
  detail: string,
  status: string,
  startedAt: number,
  endedAt: number | null,
) {
  return {
    id,
    message_id: messageId,
    ordinal,
    name,
    detail,
    status,
    started_at: startedAt,
    ended_at: endedAt,
  };
}

function columnInfo(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_xinfo('${table}')`)
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk, row.hidden]);
}

function expectCascadeFk(db: DatabaseSync, table: string, parent: string, from: string): void {
  expect(db.prepare(`PRAGMA foreign_key_list('${table}')`).all()).toEqual([
    expect.objectContaining({ table: parent, from, to: "id", on_delete: "CASCADE" }),
  ]);
}

function expectRequiredIndex(
  db: DatabaseSync,
  table: string,
  columns: Array<[string, number]>,
  unique: number,
): void {
  expect(
    tableIndexKeys(db, table).some(
      (index) =>
        index.unique === unique &&
        index.isPartial === 0 &&
        JSON.stringify(index.columns) === JSON.stringify(columns),
    ),
  ).toBe(true);
}

function seedPre032Database(path: string): void {
  const assets = trackedMigrationAssets().filter(
    (asset) => asset.filename !== MIGRATION_032 && asset.filename !== MIGRATION_033,
  );
  const filenames = assets.map((asset) => asset.filename);
  expect(filenames).toEqual([...HISTORICAL_FILENAMES]);
  withDatabase(path, (db) => {
    createCanonicalLedger(db);
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of assets) {
      runMigration(db, migration, () => {
        validatedAppliedFilenames(db, filenames);
      });
    }
    db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
      AUTH_SESSION_ID,
      "u1",
      1_700_000_000_000,
    );
    db.prepare(
      "INSERT INTO audit_events(ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(11, "u1", "workspace.create", "kept-audit", "{}", WORKSPACE_ID);
    db.prepare(
      "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(WORKSPACE_ID, "u2", "kept-space", "kept-dir", 21);
    db.prepare("UPDATE accounts SET disabled = 1 WHERE id = ?").run("u3");
  });
}

function receiptSnapshot(db: DatabaseSync) {
  return db
    .prepare("SELECT sequence, filename, applied_at FROM schema_migrations ORDER BY sequence")
    .all();
}

function businessSnapshot(db: DatabaseSync) {
  return {
    accounts: db
      .prepare("SELECT id, account, role, disabled, password_hash FROM accounts ORDER BY id")
      .all(),
    sessions: db.prepare("SELECT id, user_id, expires_at FROM auth_sessions ORDER BY id").all(),
    events: db
      .prepare(
        "SELECT id, ts, actor_id, kind, title, detail, workspace_id FROM audit_events ORDER BY id",
      )
      .all(),
    workspaces: db
      .prepare("SELECT id, owner_id, name, dir, created_at FROM workspaces ORDER BY id")
      .all(),
  };
}

function pre032State(db: DatabaseSync) {
  return {
    receipts: receiptSnapshot(db),
    business: businessSnapshot(db),
    catalog: fullCatalogSnapshot(db),
    inventory: schemaInventory(db),
    filenames: ledgerFilenames(db),
  };
}

describe("core/db chat schema", () => {
  it("openDb exposes three chat tables, defaults, keys, and both required indexes", () => {
    withOpenDb(":memory:", (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(ledgerRows(db)).toEqual([...COMPLETE_CATALOG.receipts]);
      expect(migrationReceiptExists(db, MIGRATION_032)).toBe(true);
      expect(migrationReceiptExists(db, MIGRATION_033)).toBe(true);
      expect(columnInfo(db, "chat_sessions")).toEqual([
        ["id", "TEXT", 1, null, 1, 0],
        ["owner_id", "TEXT", 1, null, 0, 0],
        ["title", "TEXT", 0, null, 0, 0],
        ["status", "TEXT", 1, null, 0, 0],
        ["omp_session_file", "TEXT", 0, null, 0, 0],
        ["stream_epoch", "INTEGER", 1, "0", 0, 0],
        ["created_at", "INTEGER", 1, null, 0, 0],
        ["updated_at", "INTEGER", 1, null, 0, 0],
      ]);
      expect(columnInfo(db, "chat_messages")).toEqual([
        ["id", "INTEGER", 0, null, 1, 0],
        ["session_id", "TEXT", 1, null, 0, 0],
        ["role", "TEXT", 1, null, 0, 0],
        ["content", "TEXT", 1, "''", 0, 0],
        ["status", "TEXT", 1, null, 0, 0],
        ["created_at", "INTEGER", 1, null, 0, 0],
      ]);
      expect(columnInfo(db, "chat_steps")).toEqual([
        ["id", "INTEGER", 0, null, 1, 0],
        ["message_id", "INTEGER", 1, null, 0, 0],
        ["ordinal", "INTEGER", 1, null, 0, 0],
        ["name", "TEXT", 1, null, 0, 0],
        ["detail", "TEXT", 1, "''", 0, 0],
        ["status", "TEXT", 1, null, 0, 0],
        ["started_at", "INTEGER", 1, null, 0, 0],
        ["ended_at", "INTEGER", 0, null, 0, 0],
        ["output", "TEXT", 0, null, 0, 0],
      ]);
      expectCascadeFk(db, "chat_sessions", "accounts", "owner_id");
      expectCascadeFk(db, "chat_messages", "chat_sessions", "session_id");
      expectCascadeFk(db, "chat_steps", "chat_messages", "message_id");
      expectRequiredIndex(
        db,
        "chat_sessions",
        [
          ["owner_id", 0],
          ["updated_at", 1],
        ],
        0,
      );
      expectRequiredIndex(
        db,
        "chat_messages",
        [
          ["session_id", 0],
          ["created_at", 0],
          ["id", 0],
        ],
        0,
      );
      expectRequiredIndex(
        db,
        "chat_steps",
        [
          ["message_id", 0],
          ["ordinal", 0],
        ],
        1,
      );
    });
  });

  it("valid enum, zero, nullable, and omitted-default writes succeed before negative cases", () => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_A, "u1", null, "idle", null, 0, 0, 0);
      insertSession(db, HEX32_B, "u1", "", "running", "", 1, 1, 1);
      insertSession(db, HEX32_C, "u2", "done-title", "done", "resume.jsonl", "2", 2, 2);
      db.prepare(
        "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(HEX32_D, "u2", "failed", 3, 3);
      const userId = Number(
        insertMessage(db, HEX32_A, "user", "hello", "done", -5).lastInsertRowid,
      );
      const assistantId = Number(
        insertMessage(db, HEX32_A, "assistant", "", "running", 0).lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO chat_messages(session_id, role, status, created_at) VALUES (?, ?, ?, ?)",
      ).run(HEX32_B, "assistant", "failed", 4);
      insertStep(db, userId, 0, "", "", "running", 9, null);
      insertStep(db, userId, "1", "bash", "done-detail", "done", 8, 7);
      db.prepare(
        "INSERT INTO chat_steps(message_id, ordinal, name, status, started_at) VALUES (?, ?, ?, ?, ?)",
      ).run(assistantId, 0, "search", "failed", -3);
      expect(sessionRows(db)).toEqual([
        sessionOf(HEX32_A, "u1", null, "idle", null, 0, 0, 0),
        sessionOf(HEX32_B, "u1", "", "running", "", 1, 1, 1),
        sessionOf(HEX32_C, "u2", "done-title", "done", "resume.jsonl", 2, 2, 2),
        sessionOf(HEX32_D, "u2", null, "failed", null, 0, 3, 3),
      ]);
      expect(messageRows(db)).toEqual([
        messageOf(1, HEX32_A, "user", "hello", "done", -5),
        messageOf(2, HEX32_A, "assistant", "", "running", 0),
        messageOf(3, HEX32_B, "assistant", "", "failed", 4),
      ]);
      expect(stepRows(db)).toEqual([
        stepOf(1, 1, 0, "", "", "running", 9, null),
        stepOf(2, 1, 1, "bash", "done-detail", "done", 8, 7),
        stepOf(3, 2, 0, "search", "", "failed", -3, null),
      ]);
    });
  });

  it("generated message and step ids are not reused after deleting the highest id", () => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_A, "u1", null, "idle", null, 0, 1, 1);
      expect(Number(insertMessage(db, HEX32_A, "user", "a", "done", 1).lastInsertRowid)).toBe(1);
      expect(Number(insertMessage(db, HEX32_A, "assistant", "b", "done", 2).lastInsertRowid)).toBe(
        2,
      );
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(2);
      expect(Number(insertMessage(db, HEX32_A, "user", "c", "done", 3).lastInsertRowid)).toBe(3);
      expect(Number(insertStep(db, 1, 0, "one", "", "done", 1, 1).lastInsertRowid)).toBe(1);
      expect(Number(insertStep(db, 1, 1, "two", "", "done", 2, 2).lastInsertRowid)).toBe(2);
      db.prepare("DELETE FROM chat_steps WHERE id = ?").run(2);
      expect(Number(insertStep(db, 1, 2, "three", "", "done", 3, 3).lastInsertRowid)).toBe(3);
      expect(
        db
          .prepare(
            "SELECT name, seq FROM sqlite_sequence WHERE name IN ('chat_messages', 'chat_steps') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "chat_messages", seq: 3 },
        { name: "chat_steps", seq: 3 },
      ]);
      expect(messageRows(db).map((row) => row.id)).toEqual([1, 3]);
      expect(stepRows(db).map((row) => row.id)).toEqual([1, 3]);
    });
  });

  it.each([
    ["null session id", [null, "u1", null, "idle", null, 0, 1, 1], notNull("chat_sessions.id")],
    ["empty session id", ["", "u1", null, "idle", null, 0, 1, 1], CHECK_FAILED],
    ["id length 31", ["a".repeat(31), "u1", null, "idle", null, 0, 1, 1], CHECK_FAILED],
    ["id length 33", [`${HEX32_A}0`, "u1", null, "idle", null, 0, 1, 1], CHECK_FAILED],
    [
      "uppercase hex id",
      ["Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "u1", null, "idle", null, 0, 1, 1],
      CHECK_FAILED,
    ],
    [
      "interior nonhex id",
      ["aaaaaaaaaaaaaaaagaaaaaaaaaaaaaaa", "u1", null, "idle", null, 0, 1, 1],
      CHECK_FAILED,
    ],
    ["embedded NUL id", [SESSION_ID_NUL, "u1", null, "idle", null, 0, 1, 1], CHECK_FAILED],
    ["null owner", [HEX32_A, null, null, "idle", null, 0, 1, 1], notNull("chat_sessions.owner_id")],
    ["null status", [HEX32_A, "u1", null, null, null, 0, 1, 1], notNull("chat_sessions.status")],
    ["unknown status", [HEX32_A, "u1", null, "pending", null, 0, 1, 1], CHECK_FAILED],
    [
      "null stream_epoch",
      [HEX32_A, "u1", null, "idle", null, null, 1, 1],
      notNull("chat_sessions.stream_epoch"),
    ],
    ["negative stream_epoch", [HEX32_A, "u1", null, "idle", null, -1, 1, 1], CHECK_FAILED],
    ["fractional stream_epoch", [HEX32_A, "u1", null, "idle", null, 1.5, 1, 1], CHECK_FAILED],
    ["text stream_epoch", [HEX32_A, "u1", null, "idle", null, "epoch", 1, 1], CHECK_FAILED],
    [
      "null created_at",
      [HEX32_A, "u1", null, "idle", null, 0, null, 1],
      notNull("chat_sessions.created_at"),
    ],
    ["negative created_at", [HEX32_A, "u1", null, "idle", null, 0, -1, 1], CHECK_FAILED],
    ["fractional created_at", [HEX32_A, "u1", null, "idle", null, 0, 1.5, 1], CHECK_FAILED],
    [
      "null updated_at",
      [HEX32_A, "u1", null, "idle", null, 0, 1, null],
      notNull("chat_sessions.updated_at"),
    ],
    ["negative updated_at", [HEX32_A, "u1", null, "idle", null, 0, 1, -1], CHECK_FAILED],
    ["fractional updated_at", [HEX32_A, "u1", null, "idle", null, 0, 1, 0.5], CHECK_FAILED],
  ] as const)("rejects session write %s after a valid row remains", (_name, args, error) => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_F, "u1", null, "idle", null, 0, 1, 1);
      expect(() =>
        insertSession(db, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]),
      ).toThrow(error);
      expect(sessionRows(db).map((row) => row.id)).toEqual([HEX32_F]);
    });
  });

  it("rejects required message/step nulls and invalid role, status, and ordinal domains", () => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_A, "u1", null, "idle", null, 0, 1, 1);
      const keptId = Number(insertMessage(db, HEX32_A, "user", "kept", "done", 1).lastInsertRowid);
      insertStep(db, keptId, 0, "kept", "", "done", 1, 1);
      expect(() => insertMessage(db, null, "user", "x", "done", 1)).toThrow(
        notNull("chat_messages.session_id"),
      );
      expect(() => insertMessage(db, HEX32_A, null, "x", "done", 1)).toThrow(
        notNull("chat_messages.role"),
      );
      expect(() => insertMessage(db, HEX32_A, "system", "x", "done", 1)).toThrow(CHECK_FAILED);
      expect(() => insertMessage(db, HEX32_A, "user", null, "done", 1)).toThrow(
        notNull("chat_messages.content"),
      );
      expect(() => insertMessage(db, HEX32_A, "user", "x", null, 1)).toThrow(
        notNull("chat_messages.status"),
      );
      expect(() => insertMessage(db, HEX32_A, "user", "x", "pending", 1)).toThrow(CHECK_FAILED);
      expect(() => insertMessage(db, HEX32_A, "user", "x", "done", null)).toThrow(
        notNull("chat_messages.created_at"),
      );
      expect(() => insertMessage(db, HEX32_A, "user", "x", "done", 1.25)).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, null, 1, "n", "", "done", 1, 1)).toThrow(
        notNull("chat_steps.message_id"),
      );
      expect(() => insertStep(db, keptId, null, "n", "", "done", 1, 1)).toThrow(
        notNull("chat_steps.ordinal"),
      );
      expect(() => insertStep(db, keptId, -1, "n", "", "done", 1, 1)).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, keptId, 1.5, "n", "", "done", 1, 1)).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, keptId, "ordinal", "n", "", "done", 1, 1)).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, keptId, 1, null, "", "done", 1, 1)).toThrow(
        notNull("chat_steps.name"),
      );
      expect(() => insertStep(db, keptId, 1, "n", null, "done", 1, 1)).toThrow(
        notNull("chat_steps.detail"),
      );
      expect(() => insertStep(db, keptId, 1, "n", "", null, 1, 1)).toThrow(
        notNull("chat_steps.status"),
      );
      expect(() => insertStep(db, keptId, 1, "n", "", "pending", 1, 1)).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, keptId, 1, "n", "", "done", null, 1)).toThrow(
        notNull("chat_steps.started_at"),
      );
      expect(() => insertStep(db, keptId, 1, "n", "", "done", 1.5, 1)).toThrow(CHECK_FAILED);
      expect(() => insertStep(db, keptId, 1, "n", "", "done", 1, 1.5)).toThrow(CHECK_FAILED);
      expect(messageRows(db)).toEqual([messageOf(keptId, HEX32_A, "user", "kept", "done", 1)]);
      expect(stepRows(db)).toEqual([stepOf(1, keptId, 0, "kept", "", "done", 1, 1)]);
    });
  });

  it("rejects missing foreign keys at account, session, and message levels", () => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_A, "u1", null, "idle", null, 0, 1, 1);
      const messageId = Number(
        insertMessage(db, HEX32_A, "user", "kept", "done", 1).lastInsertRowid,
      );
      expect(() => insertSession(db, HEX32_B, "missing", null, "idle", null, 0, 1, 1)).toThrow(
        FOREIGN_KEY_FAILED,
      );
      expect(() => insertMessage(db, HEX32_B, "user", "x", "done", 1)).toThrow(FOREIGN_KEY_FAILED);
      expect(() => insertStep(db, messageId + 99, 0, "n", "", "done", 1, 1)).toThrow(
        FOREIGN_KEY_FAILED,
      );
      expect(sessionRows(db).map((row) => row.id)).toEqual([HEX32_A]);
      expect(messageRows(db).map((row) => row.id)).toEqual([messageId]);
      expect(stepRows(db)).toEqual([]);
    });
  });

  it("duplicate ordinal fails within one message and equal ordinal succeeds on a sibling message", () => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_A, "u1", null, "idle", null, 0, 1, 1);
      const first = Number(insertMessage(db, HEX32_A, "user", "one", "done", 1).lastInsertRowid);
      const second = Number(
        insertMessage(db, HEX32_A, "assistant", "two", "done", 2).lastInsertRowid,
      );
      insertStep(db, first, 0, "a", "", "done", 1, 1);
      expect(() => insertStep(db, first, 0, "dup", "", "done", 2, 2)).toThrow(UNIQUE_ORDINAL);
      insertStep(db, second, 0, "b", "", "done", 3, 3);
      expect(stepRows(db)).toEqual([
        stepOf(1, first, 0, "a", "", "done", 1, 1),
        stepOf(2, second, 0, "b", "", "done", 3, 3),
      ]);
    });
  });

  it("message, session, and account deletes cascade only their chat descendants", () => {
    withOpenDb(":memory:", (db) => {
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
      insertSession(db, HEX32_A, "u1", "keep-sibling", "idle", null, 0, 1, 1);
      insertSession(db, HEX32_B, "u1", "delete-me", "idle", null, 0, 2, 2);
      insertSession(db, HEX32_C, "u2", "other-owner", "idle", null, 0, 3, 3);
      const keptMessage = Number(
        insertMessage(db, HEX32_A, "user", "keep", "done", 1).lastInsertRowid,
      );
      const deletedMessage = Number(
        insertMessage(db, HEX32_A, "assistant", "drop", "done", 2).lastInsertRowid,
      );
      const otherSessionMessage = Number(
        insertMessage(db, HEX32_B, "user", "session-drop", "done", 3).lastInsertRowid,
      );
      const otherOwnerMessage = Number(
        insertMessage(db, HEX32_C, "user", "owner-keep", "done", 4).lastInsertRowid,
      );
      insertStep(db, keptMessage, 0, "keep", "", "done", 1, 1);
      insertStep(db, deletedMessage, 0, "drop-message", "", "done", 2, 2);
      insertStep(db, otherSessionMessage, 0, "drop-session", "", "done", 3, 3);
      insertStep(db, otherOwnerMessage, 0, "keep-owner", "", "done", 4, 4);
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(deletedMessage);
      expect(messageRows(db).map((row) => row.id)).toEqual([
        keptMessage,
        otherSessionMessage,
        otherOwnerMessage,
      ]);
      expect(stepRows(db).map((row) => row.name)).toEqual(["keep", "drop-session", "keep-owner"]);
      db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(HEX32_B);
      expect(sessionRows(db).map((row) => row.id)).toEqual([HEX32_A, HEX32_C]);
      expect(messageRows(db).map((row) => row.id)).toEqual([keptMessage, otherOwnerMessage]);
      expect(stepRows(db).map((row) => row.name)).toEqual(["keep", "keep-owner"]);
      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      expect(db.prepare("SELECT id FROM accounts WHERE id = 'u1'").get()).toBeUndefined();
      expect(db.prepare("SELECT id FROM accounts WHERE id = 'u2'").get()).toEqual({ id: "u2" });
      expect(sessionRows(db)).toEqual([
        sessionOf(HEX32_C, "u2", "other-owner", "idle", null, 0, 3, 3),
      ]);
      expect(messageRows(db)).toEqual([
        messageOf(otherOwnerMessage, HEX32_C, "user", "owner-keep", "done", 4),
      ]);
      expect(stepRows(db)).toEqual([
        stepOf(4, otherOwnerMessage, 0, "keep-owner", "", "done", 4, 4),
      ]);
    });
  });

  it("audit RESTRICT blocks account delete and leaves chat descendants unchanged", () => {
    withOpenDb(":memory:", (db) => {
      insertSession(db, HEX32_A, "u1", "owned", "idle", null, 0, 1, 1);
      const messageId = Number(
        insertMessage(db, HEX32_A, "user", "hello", "done", 1).lastInsertRowid,
      );
      insertStep(db, messageId, 0, "step", "", "done", 1, 1);
      db.prepare(
        "INSERT INTO audit_events(ts, actor_id, kind, title, detail) VALUES (?, ?, ?, ?, ?)",
      ).run(1, "u1", "sandbox.reject", "denied", "{}");
      const sessions = sessionRows(db);
      const messages = messageRows(db);
      const steps = stepRows(db);
      const account = db.prepare("SELECT id, account FROM accounts WHERE id = 'u1'").get();
      const events = db.prepare("SELECT id, actor_id FROM audit_events ORDER BY id").all();
      expect(() => db.prepare("DELETE FROM accounts WHERE id = ?").run("u1")).toThrow(
        FOREIGN_KEY_FAILED,
      );
      expect(db.prepare("SELECT id, account FROM accounts WHERE id = 'u1'").get()).toEqual(account);
      expect(sessionRows(db)).toEqual(sessions);
      expect(messageRows(db)).toEqual(messages);
      expect(stepRows(db)).toEqual(steps);
      expect(db.prepare("SELECT id, actor_id FROM audit_events ORDER BY id").all()).toEqual(events);
    });
  });

  it("old five-migration database upgrades once, preserves business data, and reopens stably", () => {
    const file = join(tempDir(), "chat-upgrade.db");
    seedPre032Database(file);
    const before = withDatabase(file, pre032State);
    expect(before.filenames).toEqual([...HISTORICAL_FILENAMES]);
    expect(before.receipts).toHaveLength(5);
    expect(before.business.events).toEqual([
      {
        id: 1,
        ts: 11,
        actor_id: "u1",
        kind: "workspace.create",
        title: "kept-audit",
        detail: "{}",
        workspace_id: WORKSPACE_ID,
      },
    ]);
    expect(before.business.workspaces).toEqual([
      { id: WORKSPACE_ID, owner_id: "u2", name: "kept-space", dir: "kept-dir", created_at: 21 },
    ]);
    expect(
      before.business.accounts.find((row) => {
        return typeof row === "object" && row !== null && "id" in row && row.id === "u3";
      }),
    ).toEqual(expect.objectContaining({ id: "u3", disabled: 1 }));
    const upgraded = withOpenDb(file, (db) => ({
      filenames: ledgerFilenames(db),
      receipts: receiptSnapshot(db),
      business: businessSnapshot(db),
      inventory: schemaInventory(db),
    }));
    expect(upgraded.filenames).toEqual([...TRACKED_MIGRATION_FILENAMES]);
    expect(upgraded.receipts.slice(0, 5)).toEqual(before.receipts);
    expect(upgraded.receipts[5]).toEqual(
      expect.objectContaining({ sequence: 6, filename: MIGRATION_032 }),
    );
    expect(upgraded.receipts[6]).toEqual(
      expect.objectContaining({ sequence: 7, filename: MIGRATION_033 }),
    );
    expect(upgraded.business).toEqual(before.business);
    expectRepeatedOpenStable(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(receiptSnapshot(db)).toEqual(upgraded.receipts);
      expect(businessSnapshot(db)).toEqual(before.business);
      expect(schemaInventory(db)).toEqual(upgraded.inventory);
      expect(tableExists(db, "chat_sessions")).toBe(true);
      expect(tableExists(db, "chat_messages")).toBe(true);
      expect(tableExists(db, "chat_steps")).toBe(true);
    });
  });

  it("later chat_steps conflict rolls back earlier 032 DDL and recovers after the object is removed", () => {
    const file = join(tempDir(), "chat-conflict.db");
    seedPre032Database(file);
    withDatabase(file, (db) => {
      db.exec(
        "CREATE TABLE chat_steps (id INTEGER, marker TEXT); INSERT INTO chat_steps(id, marker) VALUES (7, 'kept-conflict');",
      );
    });
    const before = withDatabase(file, (db) => ({
      ...pre032State(db),
      conflict: db.prepare("SELECT id, marker FROM chat_steps ORDER BY id").all(),
      conflictSql: db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_steps'")
        .get(),
    }));
    expect(before.filenames).toEqual([...HISTORICAL_FILENAMES]);
    expectOpenDbFailure(file, TABLE_EXISTS);
    withDatabase(file, (db) => {
      expect(pre032State(db)).toEqual({
        receipts: before.receipts,
        business: before.business,
        catalog: before.catalog,
        inventory: before.inventory,
        filenames: before.filenames,
      });
      expect(db.prepare("SELECT id, marker FROM chat_steps ORDER BY id").all()).toEqual(
        before.conflict,
      );
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_steps'")
          .get(),
      ).toEqual(before.conflictSql);
      expect(tableExists(db, "chat_sessions")).toBe(false);
      expect(tableExists(db, "chat_messages")).toBe(false);
      expect(migrationReceiptExists(db, MIGRATION_032)).toBe(false);
      expect(before.conflict).toEqual([{ id: 7, marker: "kept-conflict" }]);
    });
    withDatabase(file, (db) => {
      db.exec("DROP TABLE chat_steps");
    });
    withOpenDb(file, (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(receiptSnapshot(db).slice(0, 5)).toEqual(before.receipts);
      expect(businessSnapshot(db)).toEqual(before.business);
      expect(tableExists(db, "chat_sessions")).toBe(true);
      expect(tableExists(db, "chat_messages")).toBe(true);
      expect(tableExists(db, "chat_steps")).toBe(true);
      expect(sessionRows(db)).toEqual([]);
      insertSession(db, HEX32_A, "u2", null, "idle", null, 0, 1, 1);
      expect(sessionRows(db).map((row) => row.id)).toEqual([HEX32_A]);
    });
  });
});
