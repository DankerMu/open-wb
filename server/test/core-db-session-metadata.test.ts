/**
 * Issue #510 migration 035: five nullable session-metadata columns appended with ADD COLUMN.
 * Expected columns, rows and sequence values are fixture literals written before the upgrade
 * (spec「Migration 035 …」Scenarios), never recomputed from the migration.
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
  MIGRATION_033,
  MIGRATION_034,
  MIGRATION_035,
  migrationReceiptExists,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import {
  CHAT_SEQUENCES,
  chatSequences,
  columnNames,
  countReceipts,
  EXPECTED_ROWS,
  expectChatSchema,
  expectFixtureRows,
  type FixtureTable,
  insertRows,
  metadataRows,
  PRIOR_COLUMNS,
  preservedState,
  RECEIPTS_033,
  RECEIPTS_034,
  receipts,
  S_A,
  S_B,
  S_C,
  S_D,
  seedPopulated034,
  seedThrough,
  selectRows,
  sortedForeignKeys,
  W_MISSING,
  W_U1,
  W_U1_SPARE,
  W_U2,
  WORKSPACES,
} from "./core-db-session-fixture.js";

afterEach(removeTempDirs);

const CHECK_FAILED = /CHECK constraint failed/;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
const DUPLICATE_SCENE = /duplicate column name: scene/;
// Sequence = position in the discovered order: 034 is the eighth receipt and 035 the ninth; openDb
// then goes on to every later tracked migration (036 …), which the 035 assertions leave alone.
const LEDGER = TRACKED_MIGRATION_FILENAMES.map((filename, index): [number, string] => [
  index + 1,
  filename,
]);
const RECEIPTS_033_TO_035: Array<[number, string]> = [
  [7, MIGRATION_033],
  [8, MIGRATION_034],
  [9, MIGRATION_035],
];

function expectAllMetadataNull(db: DatabaseSync): void {
  const expected = (table: FixtureTable, extra: Record<string, null>) =>
    EXPECTED_ROWS[table].map((row) => ({ id: row.id, ...extra }));
  expect(metadataRows(db)).toEqual({
    sessions: expected("chat_sessions", { workspace_id: null, scene: null, pinned_at: null }),
    messages: expected("chat_messages", { thinking: null }),
    steps: expected("chat_steps", { changes: null }),
  });
}

describe("migration 035 session metadata schema", () => {
  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh.db")],
  ])(
    "%s database ends 033,034,035 with five nullable default-free tail columns",
    (_label, path) => {
      withOpenDb(path(), (db) => {
        expect(ledgerRows(db)).toEqual(LEDGER);
        expect(ledgerRows(db).slice(6, 9)).toEqual(RECEIPTS_033_TO_035);
        expectChatSchema(db);
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
      expect(ledgerRows(db)).toEqual(LEDGER);
      expect(countReceipts(db, MIGRATION_035)).toBe(1);
      expect(receipts(db).slice(0, 8)).toEqual(before.receipts);
      expect(preservedState(db)).toEqual(before.state);
      expectFixtureRows(db);
      expectAllMetadataNull(db);
      expect(chatSequences(db)).toEqual(CHAT_SEQUENCES);
      expectChatSchema(db);
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
      expect(ledgerRows(db)).toEqual(LEDGER);
      expect(ledgerRows(db).slice(6, 9)).toEqual(RECEIPTS_033_TO_035);
      expect(countReceipts(db, MIGRATION_034)).toBe(1);
      expect(countReceipts(db, MIGRATION_035)).toBe(1);
      expect(receipts(db).slice(0, 7)).toEqual(before);
      expectChatSchema(db);
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
      expect(ledgerRows(db)).toEqual(LEDGER);
      expect(countReceipts(db, MIGRATION_035)).toBe(1);
      expect(receipts(db).slice(0, 8)).toEqual(before.receipts);
      expectChatSchema(db);
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
