import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { trackedMigrationAssets } from "../src/core/db/migration-assets.js";
import {
  createValidFoundationPrefix,
  expectCatalogSnapshot,
  expectOpenDbFailure,
  FOUNDATION_CATALOG,
  fullCatalogSnapshot,
  ledgerFilenames,
  ledgerRows,
  MIGRATION_002,
  MIGRATION_010,
  MIGRATION_0010,
  migrationReceiptExists,
  removeTempDirs,
  schemaInventory,
  seedValidFoundationPrefix,
  TRACKED_MIGRATION_FILENAMES,
  tableExists,
  tempDir,
  withDatabase,
} from "./core-db-helpers.js";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}
const AUTH_MIGRATION_SOURCE_PATH = fileURLToPath(
  new URL("../src/core/db/migrations/010_auth_schema_seed.sql", import.meta.url),
);
const HASH_ENCODING = /^scrypt\$16384\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
const VALID_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIFTH_ACCOUNT_HASH =
  "scrypt$16384$8$1$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXPECTED_ACCOUNT_COLUMNS = ["id", "account", "role", "disabled", "password_hash"] as const;
const EXPECTED_SESSION_COLUMNS = ["id", "user_id", "expires_at"] as const;
const CANONICAL_SEEDS = [
  { id: "u1", account: "zhangsan", role: "成员", disabled: 0 },
  { id: "u2", account: "zhaoliu", role: "成员", disabled: 0 },
  { id: "u3", account: "lisi", role: "管理员", disabled: 0 },
  { id: "u4", account: "wangwu", role: "成员", disabled: 1 },
] as const;

interface AccountSeedRow {
  id: string;
  account: string;
  role: string;
  disabled: number;
  password_hash: string;
}

interface ColumnInfo {
  cid: number;
  name: string;
  declaredType: string;
  notNull: number;
  defaultValue: string | null;
  primaryKey: number;
  hidden: number;
}

interface UniqueIndexInfo {
  name: string;
  unique: number;
  origin: string;
  isPartial: number;
}

interface UniqueIndexKey {
  seqno: number;
  cid: number;
  columnName: string | null;
  isKey: number;
}

interface SessionForeignKey {
  referencedTable: string;
  fromColumn: string;
  toColumn: string;
  onDelete: string;
}

interface EncodedScrypt {
  salt: Buffer;
  digest: Buffer;
}

afterEach(removeTempDirs);

async function withOpenDbAsync<T>(
  path: string,
  action: (db: DatabaseSync) => Promise<T>,
): Promise<T> {
  const db = openDb(path);
  try {
    return await action(db);
  } finally {
    db.close();
  }
}

describe("core/db auth schema and seed", () => {
  it("tracked 010 is a single lexical receipt after the foundation prefix", () => {
    const assets = trackedMigrationAssets();
    const filenames = assets.map((asset) => asset.filename);
    const authAssets = assets.filter((asset) => asset.filename === MIGRATION_010);

    expect(existsSync(AUTH_MIGRATION_SOURCE_PATH)).toBe(true);
    expect(filenames).toEqual([...TRACKED_MIGRATION_FILENAMES]);
    expect(authAssets).toHaveLength(1);
    const source = readFileSync(AUTH_MIGRATION_SOURCE_PATH, "utf8");
    expect(authAssets[0]?.source).toBe(source);
    expect(source).not.toMatch(/'demo'/);
    expect(source).not.toMatch(/"demo"/);
    expect(source).not.toMatch(/\bIF NOT EXISTS\b/i);
    expect(source).not.toMatch(/\bOR IGNORE\b/i);
    expect(source).not.toMatch(/\bINSERT OR REPLACE\b/i);
    expectAuthSchemaSeedStatementOrder(source);
  });

  it(":memory: open yields exact schema, four independently verifiable seeds, and foreign keys", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(ledgerRows(db)).toEqual([
        [1, MIGRATION_0010],
        [2, MIGRATION_002],
        [3, MIGRATION_010],
      ]);
      expect(foreignKeysEnabled(db)).toBe(true);
      expectAuthSchema(db);
      await expectCanonicalSeedState(db);
    });
  });

  it.each([
    ["empty account", ["u5", "", "成员", 0, FIFTH_ACCOUNT_HASH]],
    ["uppercase account", ["u5", "ZhangSan", "成员", 0, FIFTH_ACCOUNT_HASH]],
    ["trim-needed account", ["u5", " zhangsan", "成员", 0, FIFTH_ACCOUNT_HASH]],
    ["duplicate account", ["u5", "zhangsan", "成员", 0, FIFTH_ACCOUNT_HASH]],
    ["empty id", ["", "sunqi", "成员", 0, FIFTH_ACCOUNT_HASH]],
    ["invalid role", ["u5", "sunqi", "admin", 0, FIFTH_ACCOUNT_HASH]],
    ["disabled -1", ["u5", "sunqi", "成员", -1, FIFTH_ACCOUNT_HASH]],
    ["disabled 2", ["u5", "sunqi", "成员", 2, FIFTH_ACCOUNT_HASH]],
    ["disabled text", ["u5", "sunqi", "成员", "disabled", FIFTH_ACCOUNT_HASH]],
    ["disabled real", ["u5", "sunqi", "成员", 1.5, FIFTH_ACCOUNT_HASH]],
    ["disabled null", ["u5", "sunqi", "成员", null, FIFTH_ACCOUNT_HASH]],
    ["malformed hash", ["u5", "sunqi", "成员", 0, "not-a-scrypt-hash"]],
  ] as const)(
    "account mutation %s is rejected without changing canonical seed",
    async (_name, args) => {
      await withOpenDbAsync(":memory:", async (db) => {
        const before = canonicalAccountSnapshot(db);
        expect(() =>
          db
            .prepare(
              "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES (?, ?, ?, ?, ?)",
            )
            .run(...args),
        ).toThrow();
        expect(canonicalAccountSnapshot(db)).toEqual(before);
        expect(sessionCount(db)).toBe(0);
      });
    },
  );

  it("a legal fifth account can be inserted and deleted without changing canonical seed", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      const before = canonicalAccountSnapshot(db);
      db.prepare(
        "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("u5", "sunqi", "成员", 0, FIFTH_ACCOUNT_HASH);
      expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 5 });
      db.prepare("DELETE FROM accounts WHERE id = ?").run("u5");
      expect(canonicalAccountSnapshot(db)).toEqual(before);
    });
  });

  it("BLOB account id is rejected and remains non-TEXT rather than being stored", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      const before = canonicalAccountSnapshot(db);
      expect(() =>
        db
          .prepare(
            "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES (?, ?, ?, ?, ?)",
          )
          .run(Buffer.from("u7"), "sunqi", "成员", 0, FIFTH_ACCOUNT_HASH),
      ).toThrow();
      expect(canonicalAccountSnapshot(db)).toEqual(before);
      expect(accountStorageClasses(db)).toEqual(["text", "text", "text", "text"]);
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("BLOB account/role/hash siblings are rejected without changing canonical seed", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      const before = canonicalAccountSnapshot(db);
      const insert = db.prepare(
        "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES (?, ?, ?, ?, ?)",
      );
      expect(() => insert.run("u5", Buffer.from("sunqi"), "成员", 0, FIFTH_ACCOUNT_HASH)).toThrow();
      expect(() => insert.run("u5", "sunqi", Buffer.from("成员"), 0, FIFTH_ACCOUNT_HASH)).toThrow();
      expect(() => insert.run("u5", "sunqi", "成员", 0, Buffer.from(FIFTH_ACCOUNT_HASH))).toThrow();
      expect(canonicalAccountSnapshot(db)).toEqual(before);
      expect(accountStorageClasses(db)).toEqual(["text", "text", "text", "text"]);
    });
  });

  it.each([
    ["non-64-hex id", ["short", "u1", 1]],
    [
      "uppercase hex id",
      ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "u1", 1],
    ],
    ["unknown user", [VALID_SESSION_ID, "u9", 1]],
    ["negative expiry", [VALID_SESSION_ID, "u1", -1]],
    ["non-integer expiry", [VALID_SESSION_ID, "u1", 1.5]],
    ["text expiry", [VALID_SESSION_ID, "u1", "later"]],
    ["null expiry", [VALID_SESSION_ID, "u1", null]],
  ] as const)("auth session mutation %s is rejected", async (_name, args) => {
    await withOpenDbAsync(":memory:", async (db) => {
      expect(foreignKeysEnabled(db)).toBe(true);
      expect(() =>
        db
          .prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)")
          .run(...args),
      ).toThrow();
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("BLOB session id is rejected and remains non-TEXT rather than being stored", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      expect(foreignKeysEnabled(db)).toBe(true);
      expect(() =>
        db
          .prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)")
          .run(Buffer.from("a".repeat(64)), "u1", 1),
      ).toThrow();
      expect(sessionCount(db)).toBe(0);
      expect(sessionStorageClasses(db)).toEqual([]);
    });
  });

  it("BLOB session user_id is rejected as a foreign-key failure without writing a session", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      expect(foreignKeysEnabled(db)).toBe(true);
      expect(() =>
        db
          .prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)")
          .run(VALID_SESSION_ID, Buffer.from("u1"), 1),
      ).toThrow(/FOREIGN KEY constraint failed/);
      expect(sessionCount(db)).toBe(0);
    });
  });

  it("valid session inserts, unknown user is a foreign-key failure, and account delete cascades", async () => {
    await withOpenDbAsync(":memory:", async (db) => {
      expect(foreignKeysEnabled(db)).toBe(true);
      db.prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)").run(
        VALID_SESSION_ID,
        "u1",
        1,
      );
      expect(sessionCount(db)).toBe(1);
      expect(() =>
        db
          .prepare("INSERT INTO auth_sessions(id, user_id, expires_at) VALUES (?, ?, ?)")
          .run("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "missing", 1),
      ).toThrow(/FOREIGN KEY constraint failed/);
      db.prepare("DELETE FROM accounts WHERE id = ?").run("u1");
      expect(sessionCount(db)).toBe(0);
      expect(
        db.prepare("SELECT 1 FROM auth_sessions WHERE id = ?").get(VALID_SESSION_ID),
      ).toBeUndefined();
    });
  });

  it("legal foundation-only file upgrades atomically and reopens without hash or receipt drift", async () => {
    const file = join(tempDir(), "foundation-upgrade.db");
    seedValidFoundationPrefix(file);
    withDatabase(file, (db) => {
      expectCatalogSnapshot(db, FOUNDATION_CATALOG);
      expect(tableExists(db, "accounts")).toBe(false);
      expect(tableExists(db, "auth_sessions")).toBe(false);
    });

    const first = await withOpenDbAsync(file, async (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expectAuthSchema(db);
      await expectCanonicalSeedState(db);
      return {
        catalog: fullCatalogSnapshot(db),
        inventory: schemaInventory(db),
        seeds: canonicalAccountSnapshot(db),
        sessions: sessionCount(db),
        hashes: accountHashes(db),
      };
    });

    await withOpenDbAsync(file, async (db) => {
      expect(ledgerFilenames(db)).toEqual([...TRACKED_MIGRATION_FILENAMES]);
      expect(fullCatalogSnapshot(db)).toEqual(first.catalog);
      expect(schemaInventory(db)).toEqual(first.inventory);
      expect(canonicalAccountSnapshot(db)).toEqual(first.seeds);
      expect(sessionCount(db)).toBe(first.sessions);
      expect(accountHashes(db)).toEqual(first.hashes);
      await expectCanonicalSeedState(db);
    });
  });

  it("early pre-existing accounts conflict preserves the foundation snapshot and closes the handle", () => {
    const file = join(tempDir(), "early-accounts-conflict.db");
    withDatabase(file, (db) => {
      createValidFoundationPrefix(db);
      db.exec("CREATE TABLE accounts (id TEXT)");
    });
    expectConflictOpenPreservesFoundation(file, true, /table accounts already exists/);
  });

  it("late pre-existing auth_sessions conflict rolls back account DDL and seed after 010 starts", () => {
    const file = join(tempDir(), "late-sessions-conflict.db");
    withDatabase(file, (db) => {
      createValidFoundationPrefix(db);
      db.exec("CREATE TABLE auth_sessions (id TEXT)");
    });
    expectConflictOpenPreservesFoundation(file, false, /table auth_sessions already exists/);
  });
});

function expectConflictOpenPreservesFoundation(
  path: string,
  accountsAlreadyExist: boolean,
  expectedError: RegExp,
): void {
  const before = withDatabase(path, (db) => ({
    catalog: fullCatalogSnapshot(db),
    data: businessDataSnapshot(db),
  }));

  const originalClose = DatabaseSync.prototype.close;
  let closeCalls = 0;
  DatabaseSync.prototype.close = function closeWithObservation(this: DatabaseSync): void {
    closeCalls += 1;
    originalClose.call(this);
  };

  try {
    expectOpenDbFailure(path, expectedError);
    expect(closeCalls).toBe(1);
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }

  withDatabase(path, (db) => {
    expect(fullCatalogSnapshot(db)).toEqual(before.catalog);
    expect(businessDataSnapshot(db)).toEqual(before.data);
    expectCatalogSnapshot(db, FOUNDATION_CATALOG);
    expect(tableExists(db, "accounts")).toBe(accountsAlreadyExist);
    expect(tableExists(db, "auth_sessions")).toBe(!accountsAlreadyExist);
    expect(migrationReceiptExists(db, MIGRATION_010)).toBe(false);
    if (accountsAlreadyExist) {
      expect(db.prepare("SELECT COUNT(*) AS count FROM accounts").get()).toEqual({ count: 0 });
    } else {
      expect(tableExists(db, "accounts")).toBe(false);
    }
  });
}

function expectAuthSchema(db: DatabaseSync): void {
  expect(visibleColumnNames(db, "accounts")).toEqual([...EXPECTED_ACCOUNT_COLUMNS]);
  expect(visibleColumnNames(db, "auth_sessions")).toEqual([...EXPECTED_SESSION_COLUMNS]);
  expect(tableColumn(db, "accounts", "id")).toMatchObject({
    declaredType: "TEXT",
    notNull: 1,
    primaryKey: 1,
    hidden: 0,
  });
  expect(tableColumn(db, "accounts", "account")).toMatchObject({
    declaredType: "TEXT",
    notNull: 1,
    primaryKey: 0,
  });
  expect(tableColumn(db, "accounts", "role")).toMatchObject({
    declaredType: "TEXT",
    notNull: 1,
    primaryKey: 0,
  });
  expect(tableColumn(db, "accounts", "disabled")).toMatchObject({
    declaredType: "INTEGER",
    notNull: 1,
    primaryKey: 0,
  });
  expect(tableColumn(db, "accounts", "password_hash")).toMatchObject({
    declaredType: "TEXT",
    notNull: 1,
    primaryKey: 0,
  });
  expect(tableColumn(db, "auth_sessions", "id")).toMatchObject({
    declaredType: "TEXT",
    notNull: 1,
    primaryKey: 1,
  });
  expect(tableColumn(db, "auth_sessions", "user_id")).toMatchObject({
    declaredType: "TEXT",
    notNull: 1,
    primaryKey: 0,
  });
  expect(tableColumn(db, "auth_sessions", "expires_at")).toMatchObject({
    declaredType: "INTEGER",
    notNull: 1,
    primaryKey: 0,
  });

  expect(uniqueIndexKeys(db, "accounts")).toEqual([["account"], ["id"]]);
  expect(uniqueIndexKeys(db, "auth_sessions")).toEqual([["id"]]);
  expect(foreignKeysOf(db, "auth_sessions")).toEqual([
    { table: "accounts", from: "user_id", to: "id", on_delete: "CASCADE" },
  ]);
  expect(foreignKeysOf(db, "accounts")).toEqual([]);
  expect(businessObjectNames(db, "table")).toEqual(["accounts", "auth_sessions"]);
  expect(businessObjectNames(db, "index")).toEqual([]);
  expect(businessObjectNames(db, "view")).toEqual([]);
  expect(businessObjectNames(db, "trigger")).toEqual([]);
}

async function expectCanonicalSeedState(db: DatabaseSync): Promise<void> {
  const rows = accountRows(db);
  expect(rows.map(({ id, account, role, disabled }) => ({ id, account, role, disabled }))).toEqual([
    ...CANONICAL_SEEDS,
  ]);
  expect(sessionCount(db)).toBe(0);
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

  const encodings = rows.map((row) => row.password_hash);
  expect(new Set(encodings).size).toBe(4);
  const salts = new Set<string>();
  const digests = new Set<string>();
  for (const encoding of encodings) {
    expect(encoding).not.toBe("demo");
    expect(encoding.includes("demo")).toBe(false);
    const parsed = parseEncodedScrypt(encoding);
    salts.add(parsed.salt.toString("hex"));
    digests.add(parsed.digest.toString("hex"));
    expect(await passwordMatches(parsed, "demo")).toBe(true);
    expect(await passwordMatches(parsed, "wrong")).toBe(false);
  }
  expect(salts.size).toBe(4);
  expect(digests.size).toBe(4);
}

function parseEncodedScrypt(encoding: string): EncodedScrypt {
  const match = HASH_ENCODING.exec(encoding);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`password_hash is not the contracted scrypt encoding: ${encoding}`);
  }
  return {
    salt: Buffer.from(match[1], "hex"),
    digest: Buffer.from(match[2], "hex"),
  };
}

async function passwordMatches(encoded: EncodedScrypt, password: string): Promise<boolean> {
  const actual = await scrypt(password, encoded.salt, 32, { N: 16384, r: 8, p: 1 });
  return actual.length === encoded.digest.length && timingSafeEqual(actual, encoded.digest);
}

function accountRows(db: DatabaseSync): AccountSeedRow[] {
  return db
    .prepare("SELECT id, account, role, disabled, password_hash FROM accounts ORDER BY id")
    .all() as unknown as AccountSeedRow[];
}

function canonicalAccountSnapshot(db: DatabaseSync): AccountSeedRow[] {
  return accountRows(db);
}

function accountHashes(db: DatabaseSync): string[] {
  return accountRows(db).map((row) => row.password_hash);
}

function sessionCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get() as { count: number })
    .count;
}

function accountStorageClasses(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT typeof(id) AS storage FROM accounts ORDER BY id")
    .all()
    .map((row) => String((row as { storage: unknown }).storage));
}

function sessionStorageClasses(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT typeof(id) AS storage FROM auth_sessions ORDER BY id")
    .all()
    .map((row) => String((row as { storage: unknown }).storage));
}

function foreignKeysEnabled(db: DatabaseSync): boolean {
  return (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
}

function visibleColumnNames(db: DatabaseSync, table: string): string[] {
  return tableColumns(db, table)
    .filter((column) => column.hidden === 0)
    .sort((left, right) => left.cid - right.cid)
    .map((column) => column.name);
}

function tableColumn(db: DatabaseSync, table: string, name: string): ColumnInfo {
  const column = tableColumns(db, table).find((entry) => entry.name === name);
  if (column === undefined) {
    throw new Error(`missing column ${table}.${name}`);
  }
  return column;
}

function tableColumns(db: DatabaseSync, table: string): ColumnInfo[] {
  return db
    .prepare(`PRAGMA table_xinfo('${table}')`)
    .all()
    .map((row) => {
      const column = row as {
        cid: unknown;
        name: unknown;
        type: unknown;
        notnull: unknown;
        dflt_value: unknown;
        pk: unknown;
        hidden: unknown;
      };
      return {
        cid: Number(column.cid),
        name: String(column.name),
        declaredType: String(column.type),
        notNull: Number(column.notnull),
        defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
        primaryKey: Number(column.pk),
        hidden: Number(column.hidden),
      };
    });
}

function uniqueIndexKeys(db: DatabaseSync, table: string): string[][] {
  const indexes = db
    .prepare(`PRAGMA index_list('${table}')`)
    .all()
    .map((row) => {
      const index = row as {
        name: unknown;
        unique: unknown;
        origin: unknown;
        partial: unknown;
      };
      return {
        name: String(index.name),
        unique: Number(index.unique),
        origin: String(index.origin),
        isPartial: Number(index.partial),
      } satisfies UniqueIndexInfo;
    });
  expect(indexes.every((index) => index.unique === 1 && index.isPartial === 0)).toBe(true);
  return indexes
    .map((index) => uniqueKeyColumns(db, table, index.name))
    .sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function uniqueKeyColumns(db: DatabaseSync, table: string, indexName: string): string[] {
  const keys = db
    .prepare(`PRAGMA index_xinfo('${indexName}')`)
    .all()
    .map((row) => {
      const entry = row as { seqno: unknown; cid: unknown; name: unknown; key: unknown };
      return {
        seqno: Number(entry.seqno),
        cid: Number(entry.cid),
        columnName: entry.name === null ? null : String(entry.name),
        isKey: Number(entry.key),
      } satisfies UniqueIndexKey;
    })
    .filter((entry) => entry.isKey === 1)
    .sort((left, right) => left.seqno - right.seqno);
  return keys.map((entry) => {
    if (entry.columnName === null) {
      throw new Error(`unexpected expression index on ${table}`);
    }
    return entry.columnName;
  });
}

function foreignKeysOf(
  db: DatabaseSync,
  table: string,
): Array<{
  table: string;
  from: string;
  to: string;
  on_delete: string;
}> {
  return db
    .prepare(`PRAGMA foreign_key_list('${table}')`)
    .all()
    .map((row) => {
      const key = row as {
        table: unknown;
        from: unknown;
        to: unknown;
        on_delete: unknown;
      };
      return {
        referencedTable: String(key.table),
        fromColumn: String(key.from),
        toColumn: String(key.to),
        onDelete: String(key.on_delete),
      } satisfies SessionForeignKey;
    })
    .map((key) => ({
      table: key.referencedTable,
      from: key.fromColumn,
      to: key.toColumn,
      on_delete: key.onDelete,
    }))
    .sort((left, right) =>
      `${left.table}.${left.from}`.localeCompare(`${right.table}.${right.from}`),
    );
}

function businessObjectNames(
  db: DatabaseSync,
  type: "table" | "index" | "view" | "trigger",
): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'schema_migration%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => String((row as { name: string }).name));
}

function businessDataSnapshot(db: DatabaseSync): {
  accounts: unknown;
  sessions: unknown;
} {
  return {
    accounts: tableExists(db, "accounts")
      ? db.prepare("SELECT * FROM accounts ORDER BY rowid").all()
      : null,
    sessions: tableExists(db, "auth_sessions")
      ? db.prepare("SELECT * FROM auth_sessions ORDER BY rowid").all()
      : null,
  };
}

const CREATE_ACCOUNTS_ANCHOR = "CREATE TABLE accounts (";
const INSERT_ACCOUNTS_ANCHOR =
  "INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES";
const CREATE_SESSIONS_ANCHOR = "CREATE TABLE auth_sessions (";

function uniqueStatementAnchor(source: string, anchor: string): number {
  const first = source.indexOf(anchor);
  if (first < 0) {
    throw new Error(`missing SQL statement anchor: ${anchor}`);
  }
  if (source.indexOf(anchor, first + 1) !== -1) {
    throw new Error(`SQL statement anchor is not unique: ${anchor}`);
  }
  return first;
}

function expectAuthSchemaSeedStatementOrder(source: string): void {
  const createAccounts = uniqueStatementAnchor(source, CREATE_ACCOUNTS_ANCHOR);
  const insertAccounts = uniqueStatementAnchor(source, INSERT_ACCOUNTS_ANCHOR);
  const createSessions = uniqueStatementAnchor(source, CREATE_SESSIONS_ANCHOR);
  expect(createAccounts).toBeLessThan(insertAccounts);
  expect(insertAccounts).toBeLessThan(createSessions);
}
