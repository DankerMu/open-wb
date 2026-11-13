/**
 * Issue 1970 migration 052: `chat_messages.knowledge_bases`, a nullable, default-free, unchecked, unindexed
 * last column (message-attachments spec「迁移 052 知识库引用列」Scenarios「新库与存量库」「中途失败原子回滚」).
 * 052 is located by its position in the tracked catalog, right after 051. The column tuple, receipts,
 * sequence values and message rows are literals from the spec and the shared fixture, never read back
 * from the migration.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETE_CATALOG,
  expectCatalogSnapshot,
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_051,
  MIGRATION_052,
  migrationReceiptExists,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tableIndexKeys,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import {
  CHAT_SEQUENCES,
  COLUMNS_035,
  chatSequences,
  columnNames,
  countReceipts,
  expectFixture035,
  type PriorTable,
  preservedState,
  receipts,
  seedPopulated035,
  seedThrough,
  sortedForeignKeys,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_052);
const THROUGH_051 = TRACKED_MIGRATION_FILENAMES.slice(0, POS);
// [name, type, notnull, dflt_value, pk]: nullable, no default, not part of the key.
const KB_INFO = ["knowledge_bases", "TEXT", 0, null, 0];
const DUPLICATE_COLUMN = /duplicate column name: knowledge_bases/;
const ATTACHMENTS = '[{"path":"uploads/报告.pdf","size":2048}]';
// Every column the kept tables carry once 051 has run: 035's, then the 036–051 tails.
const COLUMNS_051 = {
  ...COLUMNS_035,
  workspaces: [...COLUMNS_035.workspaces, "temporary"],
  chat_sessions: [
    ...COLUMNS_035.chat_sessions,
    "todo",
    "archived_at",
    "approval_mode",
    "model_id",
    "reasoning_effort",
    "expert_id",
    "disabled_skills",
    "disabled_connectors",
  ],
  chat_messages: [
    ...COLUMNS_035.chat_messages,
    "attachments",
    "error_reason",
    "error_status",
    "error_detail",
    "thinking_ms",
  ],
  chat_steps: [...COLUMNS_035.chat_steps, "body_offset"],
  chat_approvals: [...COLUMNS_035.chat_approvals, "step_id"],
} satisfies Record<PriorTable, readonly string[]>;
const TAIL_COLUMNS = "id, role, attachments, error_reason, error_status, error_detail, thinking_ms";
const NO_TAIL = {
  attachments: null,
  error_reason: null,
  error_status: null,
  error_detail: null,
  thinking_ms: null,
};
// The six messages the fixture keeps (users 1/3/5, assistants 2/4/6) with the 042–044 tails `seed051` writes.
const MESSAGE_TAILS = [
  { id: 1, role: "user", ...NO_TAIL, attachments: ATTACHMENTS },
  { id: 2, role: "assistant", ...NO_TAIL, thinking_ms: 2400 },
  { id: 3, role: "user", ...NO_TAIL },
  {
    id: 4,
    role: "assistant",
    ...NO_TAIL,
    error_reason: "upstream_error",
    error_status: 502,
    error_detail: "上游 502",
  },
  { id: 5, role: "user", ...NO_TAIL },
  { id: 6, role: "assistant", ...NO_TAIL },
];
const NO_REFERENCES = [1, 2, 3, 4, 5, 6].map((id) => ({ id, knowledge_bases: null }));
const PLANTED_REFERENCES = NO_REFERENCES.map((row) =>
  row.id === 3 ? { ...row, knowledge_bases: "planted" } : row,
);

/** The populated fixture stopped at 051, with an attachment on user message 1 and assistant tails. */
function seed051(db: DatabaseSync): void {
  seedPopulated035(db);
  db.prepare("UPDATE chat_messages SET attachments = ? WHERE id = 1").run(ATTACHMENTS);
  db.prepare("UPDATE chat_messages SET thinking_ms = 2400 WHERE id = 2").run();
  db.prepare(
    "UPDATE chat_messages SET error_reason = 'upstream_error', error_status = 502, error_detail = '上游 502' WHERE id = 4",
  ).run();
}

function messageTails(db: DatabaseSync) {
  return db.prepare(`SELECT ${TAIL_COLUMNS} FROM chat_messages ORDER BY id`).all();
}

function references(db: DatabaseSync) {
  return db.prepare("SELECT id, knowledge_bases FROM chat_messages ORDER BY id").all();
}

function messagesInfo(db: DatabaseSync) {
  return db
    .prepare("PRAGMA table_info(chat_messages)")
    .all()
    .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
}

function migrationSequence(db: DatabaseSync) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'schema_migrations'").get();
}

/**
 * Everything 052 must leave alone: the first `POS` receipts, every prior row (SQL literals), column, key,
 * index and chat sequence, every `sqlite_master` object but the `chat_messages` row, and every other
 * `sqlite_sequence` row (only `schema_migrations` advances).
 */
function kept(db: DatabaseSync) {
  return {
    receipts: receipts(db).slice(0, POS),
    state: preservedState(db, COLUMNS_051),
    schema: db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name <> 'chat_messages' ORDER BY type, name",
      )
      .all(),
    sequences: db
      .prepare(
        "SELECT name, seq FROM sqlite_sequence WHERE name <> 'schema_migrations' ORDER BY name",
      )
      .all(),
  };
}
type Kept = ReturnType<typeof kept>;

/** 052's receipt is the 26th, once, right after 051's; `knowledge_bases` is the bare last column. */
function expect052Applied(db: DatabaseSync): void {
  expect(TRACKED_MIGRATION_FILENAMES[POS - 1]).toBe(MIGRATION_051);
  expect(ledgerRows(db).slice(POS - 1, POS + 1)).toEqual([
    [25, MIGRATION_051],
    [26, MIGRATION_052],
  ]);
  expect(countReceipts(db, MIGRATION_052)).toBe(1);
  expectCatalogSnapshot(db, COMPLETE_CATALOG);
  expect(migrationSequence(db)).toEqual({ seq: 26 });
  expect(messagesInfo(db).at(-1)).toEqual(KB_INFO);
  expect(columnNames(db, "chat_messages")).toEqual([
    ...COLUMNS_051.chat_messages,
    "knowledge_bases",
  ]);
  // No CHECK (invisible to table_info): the stored definition is the bare column after `thinking_ms`.
  expect(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_messages'").get()?.sql,
  ).toContain(" thinking_ms INTEGER, knowledge_bases TEXT NULL,\n");
  expect(sortedForeignKeys(db, "chat_messages").map((key) => key.from)).not.toContain(
    "knowledge_bases",
  );
  const indexed = tableIndexKeys(db, "chat_messages").flatMap((index) =>
    index.columns.map(([column]) => column),
  );
  expect(indexed).not.toContain("knowledge_bases");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

/** `openDb` applies 052 once onto the kept data, every message reads NULL, and reopening changes nothing. */
function expectUpgradedTo052(file: string, before: Kept): void {
  const verify = (db: DatabaseSync) => {
    expect052Applied(db);
    expect(kept(db)).toEqual(before);
    expectFixture035(db);
    expect(messageTails(db)).toEqual(MESSAGE_TAILS);
    expect(references(db)).toEqual(NO_REFERENCES);
    expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
  };
  withOpenDb(file, verify);
  expectRepeatedOpenStable(file, verify);
}

/** A file database stopped at 051 holding the populated fixture, as read before `openDb` touches it. */
function readAt051(db: DatabaseSync): Kept {
  expect(ledgerFilenames(db)).toEqual([...THROUGH_051]);
  expect(migrationSequence(db)).toEqual({ seq: 25 });
  expect(migrationReceiptExists(db, MIGRATION_052)).toBe(false);
  expectFixture035(db);
  expect(messageTails(db)).toEqual(MESSAGE_TAILS);
  return kept(db);
}

describe("migration 052 knowledge-base references: 新库与存量库", () => {
  it("the trusted catalog holds 052 once, right after 051, as the 26th receipt", () => {
    expect(POS).toBe(25);
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_052)).toHaveLength(1);
    expect(TRACKED_MIGRATION_FILENAMES[POS - 1]).toBe(MIGRATION_051);
    expect(COMPLETE_CATALOG.receipts[POS]).toEqual([26, MIGRATION_052]);
    expect(COMPLETE_CATALOG.sequenceRows).toEqual([["schema_migrations", 26, "integer"]]);
  });

  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-052.db")],
  ])("%s database has 052 right after 051 and a bare knowledge_bases column", (_l, path) => {
    const file = path();
    withOpenDb(file, (db) => {
      expect052Applied(db);
      expect(references(db)).toEqual([]);
    });
    if (file !== ":memory:") expectRepeatedOpenStable(file, expect052Applied);
  });

  it("populated database ending at 051 gains 052 once, every message keeps its row and reads NULL, nothing else moves", () => {
    const file = join(tempDir(), "populated-before-052.db");
    seedThrough(file, THROUGH_051, seed051);
    const before = withDatabase(file, (db) => {
      expect(columnNames(db, "chat_messages")).toEqual(COLUMNS_051.chat_messages);
      return readAt051(db);
    });
    expect(before.receipts).toHaveLength(25);

    expectUpgradedTo052(file, before);
  });
});

describe("migration 052: 中途失败原子回滚", () => {
  it("a pre-existing knowledge_bases column fails 052 leaving no receipt and the data untouched; a retry applies it once", () => {
    const file = join(tempDir(), "conflict-knowledge-bases.db");
    seedThrough(file, THROUGH_051, (db) => {
      seed051(db);
      db.exec("ALTER TABLE chat_messages ADD COLUMN knowledge_bases TEXT");
      db.prepare("UPDATE chat_messages SET knowledge_bases = 'planted' WHERE id = 3").run();
    });
    // Full receipts (with applied_at), whole message rows (planted column included) and the table definition.
    const exact = (db: DatabaseSync) => ({
      receipts: receipts(db),
      messages: db.prepare("SELECT * FROM chat_messages ORDER BY id").all(),
      sql: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_messages'").get(),
    });
    const planted = withDatabase(file, (db) => {
      expect(references(db)).toEqual(PLANTED_REFERENCES);
      return { exact: exact(db), kept: readAt051(db) };
    });

    expectOpenDbFailure(file, DUPLICATE_COLUMN);

    withDatabase(file, (db) => {
      expect(exact(db)).toEqual(planted.exact);
      expect(readAt051(db)).toEqual(planted.kept);
      expect(references(db)).toEqual(PLANTED_REFERENCES);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("ALTER TABLE chat_messages DROP COLUMN knowledge_bases");
      expect(columnNames(db, "chat_messages")).toEqual(COLUMNS_051.chat_messages);
    });

    expectUpgradedTo052(file, planted.kept);
  });
});
