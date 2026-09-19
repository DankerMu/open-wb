import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  ledgerFilenames,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_031,
  MIGRATION_0010,
  migrationReceiptExists,
  removeTempDirs,
  schemaInventory,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  uniqueIndexKeys,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";

afterEach(removeTempDirs);

const CHECK_FAILED = /CHECK constraint failed/;
const NOT_NULL_ID = /NOT NULL constraint failed: workspaces\.id/;
const NOT_NULL_OWNER = /NOT NULL constraint failed: workspaces\.owner_id/;
const NOT_NULL_NAME = /NOT NULL constraint failed: workspaces\.name/;
const NOT_NULL_DIR = /NOT NULL constraint failed: workspaces\.dir/;
const NOT_NULL_CREATED_AT = /NOT NULL constraint failed: workspaces\.created_at/;
const UNIQUE_FAILED = /UNIQUE constraint failed: workspaces\./;
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;
const TABLE_EXISTS = /table workspaces already exists/;

const HEX32_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEX32_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEX32_C = "cccccccccccccccccccccccccccccccc";
const HEX32_D = "dddddddddddddddddddddddddddddddd";
const HEX32_E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HEX32_F = "ffffffffffffffffffffffffffffffff";
const HEX32_1 = "11111111111111111111111111111111";
const HEX32_2 = "22222222222222222222222222222222";
const HEX32_3 = "33333333333333333333333333333333";
const HEX32_4 = "44444444444444444444444444444444";
const HEX32_0 = "00000000000000000000000000000000";

const DISPLAY_NAME = "智能 客服/重构";
const CANONICAL_DIR = "智能-客服-重构";
const CJK_START = "\u4e00";
const CJK_END = "\u9fa5";
const NAME_64 = "n".repeat(64);
const NAME_64_CJK = CJK_START.repeat(64);
const DIR_64_ASCII = "d".repeat(64);
const DIR_64_CJK = CJK_START.repeat(64);

const INSERT_SQL =
  "INSERT INTO workspaces(id, owner_id, name, dir, created_at) VALUES (?, ?, ?, ?, ?)";

function insertWorkspace(
  db: DatabaseSync,
  id: string | null,
  ownerId: string | null,
  name: string | null,
  dir: string | null,
  createdAt: number | null,
) {
  return db.prepare(INSERT_SQL).run(id, ownerId, name, dir, createdAt);
}

function workspaceRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT id, owner_id, name, dir, created_at FROM workspaces ORDER BY id, owner_id, name, dir",
    )
    .all();
}

const KEPT_WORKSPACE_ID = HEX32_0;
const KEPT_OWNER_ID = "u1";
const COMPATIBLE_PREEXISTING_WORKSPACES_SQL = `CREATE TABLE workspaces (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (owner_id, name),
  UNIQUE (owner_id, dir)
);
INSERT INTO workspaces(id, owner_id, name, dir, created_at)
VALUES ('${KEPT_WORKSPACE_ID}', '${KEPT_OWNER_ID}', 'kept-name', 'kept-dir', 7);`;

describe("core/db workspaces schema", () => {
  it("openDb exposes five columns, id PK NOT NULL, CASCADE owner FK, and both unique indexes", () => {
    withOpenDb(":memory:", (db) => {
      expect(
        db
          .prepare("PRAGMA table_xinfo('workspaces')")
          .all()
          .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk, row.hidden]),
      ).toEqual([
        ["id", "TEXT", 1, null, 1, 0],
        ["owner_id", "TEXT", 1, null, 0, 0],
        ["name", "TEXT", 1, null, 0, 0],
        ["dir", "TEXT", 1, null, 0, 0],
        ["created_at", "INTEGER", 1, null, 0, 0],
      ]);
      expect(db.prepare("PRAGMA foreign_key_list('workspaces')").all()).toEqual([
        expect.objectContaining({
          table: "accounts",
          from: "owner_id",
          to: "id",
          on_delete: "CASCADE",
        }),
      ]);
      expect(uniqueIndexKeys(db, "workspaces")).toEqual([
        ["id"],
        ["owner_id", "dir"],
        ["owner_id", "name"],
      ]);
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(migrationReceiptExists(db, MIGRATION_031)).toBe(true);
    });
  });

  it("same-owner name conflict is independent of dir, same-owner dir conflict is independent of name, and cross-owner same name+dir is allowed", () => {
    withOpenDb(":memory:", (db) => {
      insertWorkspace(db, HEX32_A, "u1", "alpha", "dir-a", 1);
      expect(() => insertWorkspace(db, HEX32_B, "u1", "alpha", "dir-b", 2)).toThrow(UNIQUE_FAILED);
      expect(() => insertWorkspace(db, HEX32_C, "u1", "beta", "dir-a", 3)).toThrow(UNIQUE_FAILED);
      insertWorkspace(db, HEX32_D, "u2", "alpha", "dir-a", 4);
      expect(() => insertWorkspace(db, HEX32_A, "u2", "gamma", "dir-c", 5)).toThrow(UNIQUE_FAILED);
      expect(workspaceRows(db)).toEqual([
        { id: HEX32_A, owner_id: "u1", name: "alpha", dir: "dir-a", created_at: 1 },
        { id: HEX32_D, owner_id: "u2", name: "alpha", dir: "dir-a", created_at: 4 },
      ]);
    });
  });

  it("account delete cascades only that owner's workspaces when audit_events is empty", () => {
    withOpenDb(":memory:", (db) => {
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
      insertWorkspace(db, HEX32_A, "u1", "one", "one", 1);
      insertWorkspace(db, HEX32_B, "u1", "two", "two", 2);
      insertWorkspace(db, HEX32_C, "u2", "one", "one", 3);
      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      expect(workspaceRows(db)).toEqual([
        { id: HEX32_C, owner_id: "u2", name: "one", dir: "one", created_at: 3 },
      ]);
      expect(db.prepare("SELECT id FROM accounts WHERE id = 'u1'").get()).toBeUndefined();
      expect(db.prepare("SELECT id FROM accounts WHERE id = 'u2'").get()).toEqual({ id: "u2" });
    });
  });

  it("accepts canonical ASCII/CJK names and dirs at 1 and 64 characters, display Unicode, and signed created_at", () => {
    withOpenDb(":memory:", (db) => {
      insertWorkspace(db, HEX32_A, "u1", "a", "A", 0);
      insertWorkspace(db, HEX32_B, "u1", NAME_64, DIR_64_ASCII, -1);
      insertWorkspace(db, HEX32_C, "u1", DISPLAY_NAME, CANONICAL_DIR, 42);
      insertWorkspace(db, HEX32_D, "u1", CJK_START, CJK_START, 1);
      insertWorkspace(db, HEX32_E, "u1", CJK_END, CJK_END, 2);
      insertWorkspace(db, HEX32_F, "u1", "slash/name space", "z_9-", 3);
      insertWorkspace(db, HEX32_1, "u1", NAME_64_CJK, "cjk-name", 4);
      insertWorkspace(db, HEX32_2, "u1", "cjk-dir", DIR_64_CJK, 5);
      expect(
        db
          .prepare(
            "SELECT id, name, dir, typeof(created_at) AS created_type, created_at FROM workspaces ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: HEX32_1,
          name: NAME_64_CJK,
          dir: "cjk-name",
          created_type: "integer",
          created_at: 4,
        },
        { id: HEX32_2, name: "cjk-dir", dir: DIR_64_CJK, created_type: "integer", created_at: 5 },
        { id: HEX32_A, name: "a", dir: "A", created_type: "integer", created_at: 0 },
        { id: HEX32_B, name: NAME_64, dir: DIR_64_ASCII, created_type: "integer", created_at: -1 },
        {
          id: HEX32_C,
          name: DISPLAY_NAME,
          dir: CANONICAL_DIR,
          created_type: "integer",
          created_at: 42,
        },
        { id: HEX32_D, name: CJK_START, dir: CJK_START, created_type: "integer", created_at: 1 },
        { id: HEX32_E, name: CJK_END, dir: CJK_END, created_type: "integer", created_at: 2 },
        {
          id: HEX32_F,
          name: "slash/name space",
          dir: "z_9-",
          created_type: "integer",
          created_at: 3,
        },
      ]);
    });
  });

  it.each([
    ["null id", [null, "u1", "n", "d", 1], NOT_NULL_ID],
    ["empty id", ["", "u1", "n", "d", 1], CHECK_FAILED],
    ["id length 31", ["a".repeat(31), "u1", "n", "d", 1], CHECK_FAILED],
    ["id length 33", [`${HEX32_A}0`, "u1", "n", "d", 1], CHECK_FAILED],
    ["interior nonhex", ["aaaaaaaaaaaaaaaagaaaaaaaaaaaaaaa", "u1", "n", "d", 1], CHECK_FAILED],
    ["uppercase hex", ["Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "u1", "n", "d", 1], CHECK_FAILED],
    ["interior uppercase", ["aaaaaaaaaaaaaaaAaaaaaaaaaaaaaaaa", "u1", "n", "d", 1], CHECK_FAILED],
    ["NUL tail after valid 32 hex", [`${HEX32_A}\0`, "u1", "n", "d", 1], CHECK_FAILED],
    ["unknown owner", [HEX32_A, "missing", "n", "d", 1], FOREIGN_KEY_FAILED],
    ["null owner", [HEX32_A, null, "n", "d", 1], NOT_NULL_OWNER],
    ["empty name", [HEX32_A, "u1", "", "d", 1], CHECK_FAILED],
    ["name length 65", [HEX32_A, "u1", "n".repeat(65), "d", 1], CHECK_FAILED],
    ["name NUL", [HEX32_A, "u1", "na\0me", "d", 1], CHECK_FAILED],
    ["name C0 0x01", [HEX32_A, "u1", "na\u0001me", "d", 1], CHECK_FAILED],
    ["name C0 0x1f", [HEX32_A, "u1", "na\u001fme", "d", 1], CHECK_FAILED],
    ["name DEL 0x7f", [HEX32_A, "u1", "na\u007fme", "d", 1], CHECK_FAILED],
    ["null name", [HEX32_A, "u1", null, "d", 1], NOT_NULL_NAME],
    ["empty dir", [HEX32_A, "u1", "n", "", 1], CHECK_FAILED],
    ["dir length 65", [HEX32_A, "u1", "n", "d".repeat(65), 1], CHECK_FAILED],
    ["dir dot", [HEX32_A, "u1", "n", ".", 1], CHECK_FAILED],
    ["dir dotdot", [HEX32_A, "u1", "n", "..", 1], CHECK_FAILED],
    ["dir slash", [HEX32_A, "u1", "n", "a/b", 1], CHECK_FAILED],
    ["dir backslash", [HEX32_A, "u1", "n", "a\\b", 1], CHECK_FAILED],
    ["dir NUL", [HEX32_A, "u1", "n", "ab\0c", 1], CHECK_FAILED],
    ["dir space", [HEX32_A, "u1", "n", "a b", 1], CHECK_FAILED],
    ["dir CJK below range", [HEX32_A, "u1", "n", "\u4dff", 1], CHECK_FAILED],
    ["dir CJK above range", [HEX32_A, "u1", "n", "\u9fa6", 1], CHECK_FAILED],
    ["null dir", [HEX32_A, "u1", "n", null, 1], NOT_NULL_DIR],
    ["null created_at", [HEX32_A, "u1", "n", "d", null], NOT_NULL_CREATED_AT],
    ["fractional created_at", [HEX32_A, "u1", "n", "d", 1.5], CHECK_FAILED],
  ] as const)("rejects %s without inserting a row", (_name, args, error) => {
    withOpenDb(":memory:", (db) => {
      expect(() =>
        insertWorkspace(
          db,
          args[0] as string | null,
          args[1] as string | null,
          args[2] as string | null,
          args[3] as string | null,
          args[4] as number | null,
        ),
      ).toThrow(error);
      expect(workspaceRows(db)).toEqual([]);
    });
  });

  it("rejects remaining interior C0 names independently of length", () => {
    withOpenDb(":memory:", (db) => {
      for (let code = 2; code <= 30; code += 1) {
        const name = `na${String.fromCharCode(code)}me`;
        expect(() => insertWorkspace(db, HEX32_A, "u1", name, "d", 1)).toThrow(CHECK_FAILED);
      }
      expect(workspaceRows(db)).toEqual([]);
    });
  });

  it("name C0/DEL neighbors and dir alphabet neighbors remain independently valid", () => {
    withOpenDb(":memory:", (db) => {
      insertWorkspace(db, HEX32_1, "u1", "na me", "ok", 1);
      insertWorkspace(db, HEX32_2, "u1", "na~me", "ok2", 1);
      insertWorkspace(db, HEX32_3, "u1", "na\u0080me", "ok3", 1);
      insertWorkspace(db, HEX32_4, "u1", "ok", "Az_9-", 1);
      insertWorkspace(db, HEX32_A, "u1", "ok2", `${CJK_START}${CJK_END}`, 1);
      expect(workspaceRows(db)).toEqual([
        { id: HEX32_1, owner_id: "u1", name: "na me", dir: "ok", created_at: 1 },
        { id: HEX32_2, owner_id: "u1", name: "na~me", dir: "ok2", created_at: 1 },
        { id: HEX32_3, owner_id: "u1", name: "na\u0080me", dir: "ok3", created_at: 1 },
        { id: HEX32_4, owner_id: "u1", name: "ok", dir: "Az_9-", created_at: 1 },
        { id: HEX32_A, owner_id: "u1", name: "ok2", dir: `${CJK_START}${CJK_END}`, created_at: 1 },
      ]);
    });
  });

  it("compatible preexisting workspaces table makes openDb fail and preserves four prior receipts without 031", () => {
    const file = join(tempDir(), "workspaces-conflict.db");
    withDatabase(file, (db) => {
      db.exec(COMPATIBLE_PREEXISTING_WORKSPACES_SQL);
    });
    const before = withDatabase(file, (db) => ({
      sql: db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
        .get(),
      rows: db.prepare("SELECT * FROM workspaces ORDER BY rowid").all(),
    }));
    expectOpenDbFailure(file, TABLE_EXISTS);
    withDatabase(file, (db) => {
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
          .get(),
      ).toEqual(before.sql);
      expect(db.prepare("SELECT * FROM workspaces ORDER BY rowid").all()).toEqual(before.rows);
      expect(before.rows).toEqual([
        {
          id: KEPT_WORKSPACE_ID,
          owner_id: KEPT_OWNER_ID,
          name: "kept-name",
          dir: "kept-dir",
          created_at: 7,
        },
      ]);
      expect(ledgerFilenames(db)).toEqual([
        MIGRATION_0010,
        MIGRATION_002,
        MIGRATION_010,
        MIGRATION_030,
      ]);
      expect(migrationReceiptExists(db, MIGRATION_031)).toBe(false);
    });
  });

  it("real temp-file reopen retains workspace rows, schema, and 031 receipt", () => {
    const file = join(tempDir(), "workspaces-reopen.db");
    const first = withOpenDb(file, (db) => {
      insertWorkspace(db, HEX32_A, "u1", DISPLAY_NAME, CANONICAL_DIR, -3);
      return {
        rows: workspaceRows(db),
        inventory: schemaInventory(db),
        receipts: ledgerFilenames(db),
      };
    });
    expect(first.receipts).toEqual([...TRACKED_MIGRATION_FILENAMES]);
    withOpenDb(file, (db) => {
      expect(workspaceRows(db)).toEqual(first.rows);
      expect(schemaInventory(db)).toEqual(first.inventory);
      expect(ledgerFilenames(db)).toEqual(first.receipts);
      expect(migrationReceiptExists(db, MIGRATION_031)).toBe(true);
    });
  });
});
