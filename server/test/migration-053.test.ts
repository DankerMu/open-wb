/**
 * Issue 2026 migration 053 (s2c-kb-visibility design D1): `accounts.department`, `project_groups`,
 * `project_group_members` and `knowledge_bases.scope` / `scope_group_id` in one migration
 * (account-groups「迁移 053 部门与项目组」, knowledge-bases「迁移 053 知识库范围列」, dev-stub-auth
 * 「053 之后 Principal 不变」). 053 is located by its position in the tracked catalog, right after 052.
 * Every expected value is a literal from the spec, never read back from the migration. New cases for
 * these tables belong here: `auth-schema.test.ts` (737 lines), `kb-schema.test.ts` and the other
 * full-chain files only follow the new tail in place.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS,
  cookiePair,
  requestMe,
  setCookieHeader,
  withApp,
} from "./auth-lifecycle-helpers.js";
import {
  COMPLETE_CATALOG,
  DDL_053,
  expectCatalogSnapshot,
  expectOpenDbFailure,
  expectRepeatedOpenStable,
  fullCatalogSnapshot,
  ledgerRows,
  MIGRATION_052,
  MIGRATION_053,
  migrationReceiptExists,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tableExists,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import {
  columnNames,
  seedThrough,
  sortedForeignKeys,
  tableInfo,
} from "./core-db-session-fixture.js";
import {
  BASE_ROW,
  CHECK,
  COMPILE_ROW,
  FOREIGN_KEY,
  hex,
  insertRow,
  rowsWithout,
} from "./kb-store-helpers.js";

afterEach(removeTempDirs);

const POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_053);
const THROUGH_052 = TRACKED_MIGRATION_FILENAMES.slice(0, POS);
const SOURCE = new URL(`../src/core/db/migrations/${MIGRATION_053}`, import.meta.url);
const FORBIDDEN_SQL = /\b(IF NOT EXISTS|OR IGNORE|OR REPLACE|BEGIN|COMMIT|PRAGMA)\b/i;
const ACCOUNT_COLUMNS = ["id", "account", "role", "disabled", "password_hash"];
const SCOPE_COLUMNS = ["scope", "scope_group_id"];
const PRINCIPAL_JSON = '{"id":"u1","account":"zhangsan","role":"成员"}';
const SEEDED = {
  departments: [
    { id: "u1", department: "平台研发部" },
    { id: "u2", department: "数据部" },
    { id: "u3", department: "产品部" },
    { id: "u4", department: null },
  ],
  groups: [{ id: "g1", name: "内网落地专项", created_at: 0 }],
  members: [
    { group_id: "g1", account_id: "u1" },
    { group_id: "g1", account_id: "u2" },
  ],
};
const SECOND_BASE = {
  ...COMPILE_ROW,
  id: hex(2),
  owner_id: "u2",
  name: "数据手册",
  dataset_id: "ds-2",
};
const UPGRADED_SCOPES = [
  { id: hex(1), scope: "me", scope_group_id: null },
  { id: hex(2), scope: "me", scope_group_id: null },
];
const QUOTED_053 = DDL_053.map((table) => `'${table}'`).join(", ");

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

/** Departments, groups and members as the spec lists them. */
function seedState(db: DatabaseSync) {
  return {
    departments: all(db, "SELECT id, department FROM accounts ORDER BY id"),
    groups: all(db, "SELECT * FROM project_groups ORDER BY id"),
    members: all(db, "SELECT * FROM project_group_members ORDER BY group_id, account_id"),
  };
}

/** Whole account rows plus the group tables: what a rejected write must leave alone. */
function accountsAndGroups(db: DatabaseSync) {
  return { accounts: all(db, "SELECT * FROM accounts ORDER BY id"), ...seedState(db) };
}

function namedIndex(db: DatabaseSync, table: string, name: string) {
  const index = all(db, `PRAGMA index_list('${table}')`).find((row) => row.name === name);
  return {
    unique: index?.unique,
    partial: index?.partial,
    columns: all(db, `PRAGMA index_info('${name}')`).map((row) => row.name),
  };
}

/** 053's receipt is the 27th, right after 052's; the four tables carry exactly the spec's columns. */
function expect053Shape(db: DatabaseSync): void {
  expect(ledgerRows(db).slice(POS - 1, POS + 1)).toEqual([
    [26, MIGRATION_052],
    [27, MIGRATION_053],
  ]);
  expectCatalogSnapshot(db, COMPLETE_CATALOG);
  const accounts = tableInfo(db, "accounts");
  expect(accounts).toHaveLength(6);
  expect(accounts.at(-1)).toEqual(["department", "TEXT", 0, null, 0]);
  expect(accounts.slice(0, 5).map(([name]) => name)).toEqual(ACCOUNT_COLUMNS);
  expect(tableInfo(db, "project_groups")).toEqual([
    ["id", "TEXT", 1, null, 1],
    ["name", "TEXT", 1, null, 0],
    ["created_at", "INTEGER", 1, null, 0],
  ]);
  expect(tableInfo(db, "project_group_members")).toEqual([
    ["group_id", "TEXT", 1, null, 1],
    ["account_id", "TEXT", 1, null, 2],
  ]);
  expect(sortedForeignKeys(db, "project_group_members")).toEqual([
    { from: "account_id", table: "accounts", to: "id", on_delete: "CASCADE" },
    { from: "group_id", table: "project_groups", to: "id", on_delete: "CASCADE" },
  ]);
  expect(namedIndex(db, "project_group_members", "project_group_members_account")).toEqual({
    unique: 0,
    partial: 0,
    columns: ["account_id"],
  });
  expect(tableInfo(db, "knowledge_bases").slice(-2)).toEqual([
    ["scope", "TEXT", 1, "'me'", 0],
    ["scope_group_id", "TEXT", 0, null, 0],
  ]);
  expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
}

/**
 * Everything 053 must leave alone: the five 010 account columns, both bases bar the two new columns,
 * every `sqlite_master` object outside the four tables, every other table row by row, and every
 * `sqlite_sequence` row but the ledger's (receipts are asserted on their own).
 */
function kept(db: DatabaseSync) {
  const others = all(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN (${QUOTED_053}, 'schema_migrations', 'sqlite_sequence') ORDER BY name`,
  ).map((row) => String(row.name));
  return {
    accounts: all(db, `SELECT ${ACCOUNT_COLUMNS.join(", ")} FROM accounts ORDER BY id`),
    bases: rowsWithout(db, "knowledge_bases", SCOPE_COLUMNS),
    schema: all(
      db,
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN (${QUOTED_053}) ORDER BY type, name`,
    ),
    rows: Object.fromEntries(
      others.map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY rowid`)]),
    ),
    sequences: all(
      db,
      "SELECT name, seq FROM sqlite_sequence WHERE name <> 'schema_migrations' ORDER BY name",
    ),
  };
}
type Kept = ReturnType<typeof kept>;

/** A file database stopped at 052 holding two bases (u1's plain one, u2's compiled one). */
function seed052(file: string, plant: (db: DatabaseSync) => void = () => {}): Kept {
  seedThrough(file, THROUGH_052, (db) => {
    insertRow(db, "knowledge_bases", BASE_ROW);
    insertRow(db, "knowledge_bases", SECOND_BASE);
    plant(db);
  });
  return withDatabase(file, (db) => {
    expect(ledgerRows(db)).toHaveLength(26);
    expect(migrationReceiptExists(db, MIGRATION_053)).toBe(false);
    const before = kept(db);
    expect(before.bases).toHaveLength(2);
    return before;
  });
}

/** `openDb` applies 053 once onto the kept data, the seeds land as on a new database, reopening is stable. */
function expectUpgradedTo053(file: string, before: Kept): void {
  const verify = (db: DatabaseSync) => {
    expect053Shape(db);
    expect(kept(db)).toEqual(before);
    expect(all(db, "SELECT id, scope, scope_group_id FROM knowledge_bases ORDER BY id")).toEqual(
      UPGRADED_SCOPES,
    );
    expect(seedState(db)).toEqual(SEEDED);
  };
  withOpenDb(file, verify);
  expectRepeatedOpenStable(file, verify);
}

describe("migration 053: 目录与源码", () => {
  it("the trusted catalog holds 053 once, right after 052, as the 27th receipt", () => {
    expect(POS).toBe(26);
    expect(TRACKED_MIGRATION_FILENAMES[25]).toBe(MIGRATION_052);
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_053)).toHaveLength(1);
    expect(COMPLETE_CATALOG.receipts[26]).toEqual([27, MIGRATION_053]);
    expect(COMPLETE_CATALOG.sequenceRows).toEqual([["schema_migrations", 27, "integer"]]);
  });

  it("the source leaves transactions to the runner and lets a same-name conflict fail", () => {
    expect(readFileSync(SOURCE, "utf8")).not.toMatch(FORBIDDEN_SQL);
  });

  it.each([
    ["in-memory", () => ":memory:"],
    ["new file", () => join(tempDir(), "fresh-053.db")],
  ])("%s database has 053 right after 052 with the spec's columns, keys and index", (_l, path) => {
    const file = path();
    withOpenDb(file, (db) => {
      expect053Shape(db);
      expect(seedState(db)).toEqual(SEEDED);
    });
    if (file !== ":memory:") expectRepeatedOpenStable(file, expect053Shape);
  });
});

describe("迁移 053 部门与项目组", () => {
  it("种子与约束：五次非法写入各自失败、表不变；64 个字符按字符计长可写", () => {
    withOpenDb(":memory:", (db) => {
      expect(seedState(db)).toEqual(SEEDED);
      const before = accountsAndGroups(db);
      const setDepartment = (value: string) => () =>
        db.prepare("UPDATE accounts SET department = ? WHERE id = 'u1'").run(value);
      const writes: Array<[() => unknown, RegExp]> = [
        [setDepartment(""), CHECK],
        [setDepartment("部".repeat(65)), CHECK],
        [setDepartment("a\u0007b"), CHECK],
        [
          () => db.exec("INSERT INTO project_groups VALUES ('g2','内网落地专项',0)"),
          /UNIQUE constraint failed: project_groups\.name/,
        ],
        [() => db.exec("INSERT INTO project_group_members VALUES ('g1','nope')"), FOREIGN_KEY],
      ];
      for (const [write, error] of writes) {
        expect(write).toThrow(error);
        expect(accountsAndGroups(db)).toEqual(before);
      }
      setDepartment("部".repeat(64))();
      expect(all(db, "SELECT department FROM accounts WHERE id = 'u1'")).toEqual([
        { department: "部".repeat(64) },
      ]);
    });
  });

  it.each<[string, string]>([
    ["空 id", "('', 'x', 0)"],
    ["含 C0 的 id", "('g\u0001', 'x', 0)"],
    ["空名称", "('g2', '', 0)"],
    ["65 个字符的名称", `('g2', '${"组".repeat(65)}', 0)`],
    ["含 DEL 的名称", "('g2', 'a\u007fb', 0)"],
    ["负的 created_at", "('g2', 'x', -1)"],
    ["小数 created_at", "('g2', 'x', 1.5)"],
  ])("project_groups 拒绝 %s", (_name, values) => {
    withOpenDb(":memory:", (db) => {
      expect(() => db.exec(`INSERT INTO project_groups VALUES ${values}`)).toThrow(CHECK);
      expect(seedState(db)).toEqual(SEEDED);
    });
  });

  it("级联（组侧）：删组带走它的成员行，账号不变", () => {
    withOpenDb(":memory:", (db) => {
      const accounts = all(db, "SELECT * FROM accounts ORDER BY id");
      db.exec("DELETE FROM project_groups WHERE id = 'g1'");
      expect(all(db, "SELECT * FROM project_group_members")).toEqual([]);
      expect(all(db, "SELECT * FROM accounts ORDER BY id")).toEqual(accounts);
    });
  });

  it("级联（账号侧）：删账号带走它的成员行", () => {
    withOpenDb(":memory:", (db) => {
      db.exec("DELETE FROM accounts WHERE id = 'u2'");
      expect(all(db, "SELECT * FROM project_group_members")).toEqual([
        { group_id: "g1", account_id: "u1" },
      ]);
    });
  });
});

describe("迁移 053 知识库范围列", () => {
  it("列与约束：四次非法范围与删被引用的组都失败、行不变；group + g1 成功", () => {
    withOpenDb(":memory:", (db) => {
      insertRow(db, "knowledge_bases", BASE_ROW);
      const scopes = () => all(db, "SELECT scope, scope_group_id FROM knowledge_bases");
      const setScope = db.prepare("UPDATE knowledge_bases SET scope = ?, scope_group_id = ?");
      const rejected: Array<[string, string | null, RegExp]> = [
        ["group", null, CHECK],
        ["all", "g1", CHECK],
        ["group", "g9", FOREIGN_KEY],
        ["team", null, CHECK],
      ];
      for (const [scope, group, error] of rejected) {
        expect(() => setScope.run(scope, group)).toThrow(error);
        expect(scopes()).toEqual([{ scope: "me", scope_group_id: null }]);
      }
      setScope.run("group", "g1");
      const grouped = { ...SEEDED, bases: [{ scope: "group", scope_group_id: "g1" }] };
      expect({ ...seedState(db), bases: scopes() }).toEqual(grouped);
      expect(() => db.exec("DELETE FROM project_groups WHERE id = 'g1'")).toThrow(FOREIGN_KEY);
      expect({ ...seedState(db), bases: scopes() }).toEqual(grouped);
    });
  });

  it("升级保留既有的库：052 库的两个库读作 me，其余列、其余表与 schema 都不变", () => {
    const file = join(tempDir(), "populated-052.db");
    const before = seed052(file);
    expect(before.accounts).toHaveLength(4);
    expectUpgradedTo053(file, before);
  });

  it("中途失败原子回滚：第 ⑥ 句冲突时 ①–⑤ 一并回滚、无回执；去掉冲突后重试恰应用一次", () => {
    const file = join(tempDir(), "conflict-scope-group-id.db");
    const plant = (db: DatabaseSync) =>
      db.exec("ALTER TABLE knowledge_bases ADD COLUMN scope_group_id TEXT");
    const before = seed052(file, plant);
    const exact = (db: DatabaseSync) => ({
      catalog: fullCatalogSnapshot(db),
      bases: all(db, "SELECT * FROM knowledge_bases ORDER BY id"),
    });
    const planted = withDatabase(file, exact);

    expectOpenDbFailure(file, /duplicate column name: scope_group_id/);

    withDatabase(file, (db) => {
      expect(exact(db)).toEqual(planted);
      expect(migrationReceiptExists(db, MIGRATION_053)).toBe(false);
      expect(columnNames(db, "accounts")).toEqual(ACCOUNT_COLUMNS);
      expect(tableExists(db, "project_groups")).toBe(false);
      expect(tableExists(db, "project_group_members")).toBe(false);
      expect(columnNames(db, "knowledge_bases")).not.toContain("scope");
      expect(kept(db)).toEqual(before);
      db.exec("ALTER TABLE knowledge_bases DROP COLUMN scope_group_id");
    });

    expectUpgradedTo053(file, before);
  });
});

describe("053 之后 Principal 不变", () => {
  it("登录与 GET /api/auth/me 逐字节只有 id、account、role；部门在库里但不外泄", async () => {
    await withApp({}, async ({ app, db }) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: JSON.stringify(CREDENTIALS),
        headers: { "content-type": "application/json" },
      });
      expect(login.statusCode).toBe(200);
      expect(login.payload).toBe(PRINCIPAL_JSON);
      const header = setCookieHeader(login);
      expect(header).toBeDefined();
      const me = await requestMe(app, cookiePair(String(header)));
      expect(me.statusCode).toBe(200);
      expect(me.payload).toBe(PRINCIPAL_JSON);
      expect(Object.keys(JSON.parse(me.payload))).toEqual(["id", "account", "role"]);
      expect(all(db, "SELECT department FROM accounts WHERE id = 'u1'")).toEqual([
        { department: "平台研发部" },
      ]);
    });
  });
});
