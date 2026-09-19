import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectOpenDbFailure,
  fullCatalogSnapshot,
  ledgerFilenames,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_030,
  MIGRATION_0010,
  migrationReceiptExists,
  removeTempDirs,
  schemaInventory,
  tableExists,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";

afterEach(removeTempDirs);

describe("core/db audit_events schema", () => {
  const APPEND_ONLY = /audit_events is append-only/;
  const CHECK_FAILED = /CHECK constraint failed/;
  const INSERT_SQL =
    "INSERT INTO audit_events(ts, actor_id, kind, title, detail, workspace_id) VALUES (?, ?, ?, ?, ?, ?)";

  function insertEvent(
    db: DatabaseSync,
    ts: number | null = 0,
    kind: string | null = "sandbox.reject",
    title: string | null = "denied",
    detail: string | null = "{}",
    workspaceId: string | null = null,
    actorId: string | null = "u1",
  ) {
    return db.prepare(INSERT_SQL).run(ts, actorId, kind, title, detail, workspaceId);
  }

  function eventRows(db: DatabaseSync) {
    return db
      .prepare(
        "SELECT id, ts, actor_id, kind, title, detail, workspace_id FROM audit_events ORDER BY id",
      )
      .all();
  }

  type AuditObjectName =
    | "audit_events"
    | "audit_events_actor_id"
    | "audit_events_no_update"
    | "audit_events_no_delete";

  function auditConflictSeed(collidingName: AuditObjectName): string {
    if (collidingName === "audit_events") {
      return `CREATE TABLE audit_events (
  id TEXT, ts TEXT, actor_id TEXT, kind TEXT, title TEXT, detail TEXT, workspace_id TEXT
); INSERT INTO audit_events VALUES ('kept','0','u1','x.y','t','{}',NULL);`;
    }
    const sentinel =
      "CREATE TABLE sentinel_audit_conflict (value TEXT); INSERT INTO sentinel_audit_conflict(value) VALUES ('kept');";
    if (collidingName === "audit_events_actor_id") {
      return `${sentinel} CREATE INDEX audit_events_actor_id ON sentinel_audit_conflict(value);`;
    }
    return `${sentinel} CREATE TRIGGER ${collidingName} BEFORE INSERT ON sentinel_audit_conflict
BEGIN SELECT 1; END;`;
  }

  function auditConflictState(db: DatabaseSync, collidingName: AuditObjectName) {
    return {
      objects: db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (?, 'sentinel_audit_conflict') ORDER BY name",
        )
        .all(collidingName),
      named: db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('audit_events','audit_events_actor_id','audit_events_no_update','audit_events_no_delete') ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      events: tableExists(db, "audit_events")
        ? db.prepare("SELECT * FROM audit_events ORDER BY rowid").all()
        : null,
      sentinel: tableExists(db, "sentinel_audit_conflict")
        ? db.prepare("SELECT * FROM sentinel_audit_conflict ORDER BY rowid").all()
        : null,
    };
  }

  function expectPreservedAuditConflict(
    file: string,
    error: RegExp,
    collidingName: AuditObjectName,
  ): void {
    const before = withDatabase(file, (db) => auditConflictState(db, collidingName));
    expectOpenDbFailure(file, error);
    withDatabase(file, (db) => {
      expect(auditConflictState(db, collidingName)).toEqual(before);
      expect(before.named).toEqual([collidingName]);
      expect(ledgerFilenames(db)).toEqual([MIGRATION_0010, MIGRATION_002, MIGRATION_010]);
      expect(migrationReceiptExists(db, MIGRATION_030)).toBe(false);
      expect(tableExists(db, "accounts")).toBe(true);
    });
  }

  it("openDb exposes exact columns, actor/id-desc index, and two append-only triggers", () => {
    withOpenDb(":memory:", (db) => {
      expect(
        db
          .prepare("PRAGMA table_xinfo('audit_events')")
          .all()
          .map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk, row.hidden]),
      ).toEqual([
        ["id", "INTEGER", 0, null, 1, 0],
        ["ts", "INTEGER", 1, null, 0, 0],
        ["actor_id", "TEXT", 1, null, 0, 0],
        ["kind", "TEXT", 1, null, 0, 0],
        ["title", "TEXT", 1, null, 0, 0],
        ["detail", "TEXT", 1, "'{}'", 0, 0],
        ["workspace_id", "TEXT", 0, null, 0, 0],
      ]);
      expect(db.prepare("PRAGMA foreign_key_list('audit_events')").all()).toEqual([
        expect.objectContaining({
          table: "accounts",
          from: "actor_id",
          to: "id",
          on_delete: "RESTRICT",
        }),
      ]);
      expect(db.prepare("PRAGMA index_list('audit_events')").all()).toEqual([
        expect.objectContaining({
          name: "audit_events_actor_id",
          unique: 0,
          origin: "c",
          partial: 0,
        }),
      ]);
      expect(
        db
          .prepare("PRAGMA index_xinfo('audit_events_actor_id')")
          .all()
          .filter((row) => row.key === 1)
          .map((row) => [row.name, row.desc]),
      ).toEqual([
        ["actor_id", 0],
        ["id", 1],
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["audit_events_no_delete", "audit_events_no_update"]);
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events_no_update'").get()
          ?.sql,
      ).toMatch(
        /BEFORE UPDATE ON audit_events[\s\S]*RAISE\(ABORT, 'audit_events is append-only'\)/,
      );
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events_no_delete'").get()
          ?.sql,
      ).toMatch(
        /BEFORE DELETE ON audit_events[\s\S]*RAISE\(ABORT, 'audit_events is append-only'\)/,
      );
      expect(ledgerFilenames(db)).toEqual([
        MIGRATION_0010,
        MIGRATION_002,
        MIGRATION_010,
        MIGRATION_030,
      ]);
    });
  });

  it("legal inserts generate AUTOINCREMENT ids, default detail to {}, and leave workspace_id NULL", () => {
    withOpenDb(":memory:", (db) => {
      expect(
        db
          .prepare("INSERT INTO audit_events(ts, actor_id, kind, title) VALUES (?, ?, ?, ?)")
          .run(0, "u1", "sandbox.reject", "denied").lastInsertRowid,
      ).toBe(1);
      expect(
        db
          .prepare("INSERT INTO audit_events(ts, actor_id, kind, title) VALUES (?, ?, ?, ?)")
          .run(1, "u1", "workspace.create", "created").lastInsertRowid,
      ).toBe(2);
      expect(eventRows(db)).toEqual([
        {
          id: 1,
          ts: 0,
          actor_id: "u1",
          kind: "sandbox.reject",
          title: "denied",
          detail: "{}",
          workspace_id: null,
        },
        {
          id: 2,
          ts: 1,
          actor_id: "u1",
          kind: "workspace.create",
          title: "created",
          detail: "{}",
          workspace_id: null,
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT name, seq, typeof(seq) AS seq_type FROM sqlite_sequence WHERE name = 'audit_events'",
          )
          .all(),
      ).toEqual([{ name: "audit_events", seq: 2, seq_type: "integer" }]);
      insertEvent(db, 0, "dir.create", "mkdir", "[]", "ws1");
      expect(
        db.prepare("SELECT kind, detail, workspace_id FROM audit_events WHERE id = 3").get(),
      ).toEqual({
        kind: "dir.create",
        detail: "[]",
        workspace_id: "ws1",
      });
    });
  });

  it("accepts an empty title because the contract is NOT NULL, not nonempty", () => {
    withOpenDb(":memory:", (db) => {
      insertEvent(db, 0, "sandbox.reject", "");
      expect(db.prepare("SELECT title FROM audit_events WHERE id = 1").get()).toEqual({
        title: "",
      });
    });
  });

  it("UPDATE and DELETE fail with the append-only error and leave the row unchanged", () => {
    withOpenDb(":memory:", (db) => {
      insertEvent(db);
      const original = eventRows(db);
      expect(() => db.exec("UPDATE audit_events SET title = 'mutated'")).toThrow(APPEND_ONLY);
      expect(eventRows(db)).toEqual(original);
      expect(() => db.exec("DELETE FROM audit_events")).toThrow(APPEND_ONLY);
      expect(eventRows(db)).toEqual(original);
    });
  });

  it("deleting a referenced account is denied and leaves account and event unchanged", () => {
    withOpenDb(":memory:", (db) => {
      insertEvent(db);
      const originalEvent = eventRows(db);
      const originalAccount = db.prepare("SELECT id, account FROM accounts WHERE id = 'u1'").get();
      expect(() => db.prepare("DELETE FROM accounts WHERE id = ?").run("u1")).toThrow(
        /FOREIGN KEY constraint failed/,
      );
      expect(eventRows(db)).toEqual(originalEvent);
      expect(db.prepare("SELECT id, account FROM accounts WHERE id = 'u1'").get()).toEqual(
        originalAccount,
      );
    });
  });

  it.each([
    ["uppercase", "Sandbox.reject"],
    ["single segment", "sandbox"],
    ["trailing empty segment", "sandbox."],
    ["leading empty segment", ".reject"],
    ["empty interior segment", "sandbox..reject"],
    ["digit-leading segment", "sandbox.9x"],
    ["underscore-leading segment", "sandbox._x"],
    ["whitespace", "sandbox reject"],
    ["hyphen", "sandbox-reject"],
    ["NUL", "sandbox.reject\u0000x"],
    ["internal uppercase", "sandbox.reJect"],
    ["digit-leading first segment", "9sandbox.reject"],
  ])("rejects invalid kind %s", (_name, kind) => {
    withOpenDb(":memory:", (db) => {
      expect(() => insertEvent(db, 0, kind)).toThrow(CHECK_FAILED);
      expect(eventRows(db)).toEqual([]);
    });
  });

  it("rejects malformed JSON, negative and fractional timestamps, and required nulls", () => {
    withOpenDb(":memory:", (db) => {
      expect(() => insertEvent(db, 0, "sandbox.reject", "denied", "{")).toThrow(CHECK_FAILED);
      expect(() => insertEvent(db, -1)).toThrow(CHECK_FAILED);
      expect(() => insertEvent(db, 1.5)).toThrow(CHECK_FAILED);
      expect(() => insertEvent(db, null)).toThrow(/NOT NULL constraint failed: audit_events.ts/);
      expect(() => insertEvent(db, 0, "sandbox.reject", null)).toThrow(
        /NOT NULL constraint failed: audit_events.title/,
      );
      expect(() => insertEvent(db, 0, "sandbox.reject", "denied", "{}", null, null)).toThrow(
        /NOT NULL constraint failed: audit_events.actor_id/,
      );
      expect(() => insertEvent(db, 0, null)).toThrow(
        /NOT NULL constraint failed: audit_events.kind/,
      );
      expect(() => insertEvent(db, 0, "sandbox.reject", "denied", null)).toThrow(
        /NOT NULL constraint failed: audit_events.detail/,
      );
      expect(eventRows(db)).toEqual([]);
    });
  });

  it("real temp-file reopen retains the audit row, schema, and 030 receipt", () => {
    const file = join(tempDir(), "audit-reopen.db");
    const first = withOpenDb(file, (db) => {
      insertEvent(db, 42);
      return {
        rows: eventRows(db),
        catalog: fullCatalogSnapshot(db),
        inventory: schemaInventory(db),
        receipts: ledgerFilenames(db),
      };
    });
    expect(first.receipts).toEqual([MIGRATION_0010, MIGRATION_002, MIGRATION_010, MIGRATION_030]);
    withOpenDb(file, (db) => {
      expect(eventRows(db)).toEqual(first.rows);
      expect(fullCatalogSnapshot(db)).toEqual(first.catalog);
      expect(schemaInventory(db)).toEqual(first.inventory);
      expect(ledgerFilenames(db)).toEqual(first.receipts);
      expect(migrationReceiptExists(db, MIGRATION_030)).toBe(true);
    });
  });

  it.each([
    ["table", "audit_events", /table audit_events already exists/],
    ["index", "audit_events_actor_id", /index audit_events_actor_id already exists/],
    ["update trigger", "audit_events_no_update", /trigger audit_events_no_update already exists/],
    ["delete trigger", "audit_events_no_delete", /trigger audit_events_no_delete already exists/],
  ] as const)(
    "late %s conflict rolls back 030 objects and omits its receipt",
    (_name, collidingName, error) => {
      const file = join(tempDir(), `late-audit-${collidingName}-conflict.db`);
      withDatabase(file, (db) => {
        db.exec(auditConflictSeed(collidingName));
      });
      expectPreservedAuditConflict(file, error, collidingName);
    },
  );
});
