/**
 * s1d-model-registry group 2: migration 046 and the model registry store (model-registry「迁移 046 模型表」
 * 「环境种子」「注册表快照是白名单的唯一来源」store part; model-selection「模型白名单配置」shared field
 * rules). `:memory:` databases through the real migrations; expected rows, messages and secret lists
 * are literals from the spec text or the independent `resolveModelCatalog` / `upstreamSecretList`.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { upstreamSecretList } from "../src/core/upstream-failure.js";
import { resolveModelCatalog } from "../src/model-catalog.js";
import { createModelStore, type ModelRow } from "../src/models/store.js";
import {
  MIGRATION_045,
  MIGRATION_046,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import { columnNames, seedPopulated034, seedThrough } from "./core-db-session-fixture.js";

const T0 = 1_760_000_000_000;
const KEY = "sk-store-SENTINEL-4242";
const UP = { baseUrl: "https://gw.example/v1", apiKey: KEY };
const USERINFO_URL = "https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001";
const THREE_MODELS = JSON.stringify([
  {
    id: "m1",
    name: "通用",
    reasoning: true,
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  { id: "m2", maxTokens: 8192 },
  { id: "m3", name: "深度", reasoning: true, vision: true, efforts: ["low", "high"] },
]);
const NEVER = { status: "never", at: null, message: null } as const;

const opened: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) db.close();
  removeTempDirs();
});

function fresh() {
  const db = openDb(":memory:");
  opened.push(db);
  return { db, store: createModelStore(db) };
}

function rawRows(db: DatabaseSync) {
  return db.prepare("SELECT * FROM models ORDER BY created_at, id").all();
}

function codeOf(action: () => unknown): HttpErrorCode | "none" {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).toBe(HTTP_ERROR_MESSAGES[(error as HttpError).code]);
    return (error as HttpError).code;
  }
  return "none";
}

/** Asserts `action` fails with `code` and leaves the table byte-for-byte as it was. */
function expectRefused(db: DatabaseSync, code: HttpErrorCode, action: () => unknown): void {
  const before = rawRows(db);
  expect(codeOf(action)).toBe(code);
  expect(rawRows(db)).toEqual(before);
}

const seedOne = (store: ReturnType<typeof createModelStore>) => {
  store.create({ id: "m1", upstream: UP });
  store.create({ id: "m2" });
};

describe("migration 046 models table", () => {
  it("is tracked right after 045 and creates the D3 columns and the partial unique index", () => {
    expect(
      TRACKED_MIGRATION_FILENAMES[TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_045) + 1],
    ).toBe(MIGRATION_046);
    const { db } = fresh();
    expect(
      db
        .prepare("PRAGMA table_info('models')")
        .all()
        .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
    ).toEqual([
      ["id", "TEXT", 0, null, 1],
      ["name", "TEXT", 1, null, 0],
      ["reasoning", "INTEGER", 1, null, 0],
      ["vision", "INTEGER", 1, null, 0],
      ["max_tokens", "INTEGER", 1, null, 0],
      ["efforts", "TEXT", 0, null, 0],
      ["upstream_base_url", "TEXT", 0, null, 0],
      ["upstream_api_key", "TEXT", 0, null, 0],
      ["is_default", "INTEGER", 1, "0", 0],
      ["probe_status", "TEXT", 1, "'never'", 0],
      ["probe_at", "INTEGER", 0, null, 0],
      ["probe_message", "TEXT", 0, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
    ]);
    expect(
      db
        .prepare("PRAGMA index_list('models')")
        .all()
        .map((i) => [i.name, i.unique, i.origin, i.partial])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["models_default", 1, "c", 1],
      ["sqlite_autoindex_models_1", 1, "pk", 0],
    ]);
  });

  const INSERT =
    "INSERT INTO models(id, name, reasoning, vision, max_tokens, upstream_base_url, upstream_api_key, is_default, probe_status, created_at, updated_at) VALUES (?, 'n', ?, 0, ?, ?, ?, ?, ?, 1, 1)";
  it.each([
    ["a second default row", ["b", 0, 1, null, null, 1, "never"]],
    ["base URL without key", ["b", 0, 1, "https://x", null, 0, "never"]],
    ["key without base URL", ["b", 0, 1, null, "k", 0, "never"]],
    ["reasoning 2", ["b", 2, 1, null, null, 0, "never"]],
    ["max_tokens 0", ["b", 0, 0, null, null, 0, "never"]],
    ["max_tokens 128001", ["b", 0, 128001, null, null, 0, "never"]],
    ["probe_status unknown", ["b", 0, 1, null, null, 0, "pending"]],
  ])("the constraints reject %s and leave the table as it was", (_label, values) => {
    const { db } = fresh();
    db.prepare(INSERT).run("a", 0, 1, null, null, 1, "never");
    const before = rawRows(db);
    expect(() => db.prepare(INSERT).run(...(values as Array<string | number | null>))).toThrow();
    expect(rawRows(db)).toEqual(before);
  });

  it("a populated database ending at 045 gains the table and the index, keeps every prior row, and records 046 right after 045", () => {
    const file = join(tempDir(), "populated-045.db");
    const through045 = TRACKED_MIGRATION_FILENAMES.slice(
      0,
      TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_046),
    );
    seedThrough(file, through045, seedPopulated034);
    // Later migrations may append columns: each prior table is read through the columns it had at 045.
    const snapshot = (db: DatabaseSync, columnsAt045?: Record<string, string[]>) => {
      const objects = db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
      const tables = objects.filter((o) => o.type === "table").map((o) => String(o.name));
      const columns = Object.fromEntries(
        tables.map((t) => [t, columnsAt045?.[t] ?? columnNames(db, t)]),
      );
      const rows = Object.fromEntries(
        tables.map((t) => [t, db.prepare(`SELECT ${columns[t]?.join(", ")} FROM ${t}`).all()]),
      );
      return { objects, columns, rows };
    };
    const before = withDatabase(file, (db) => snapshot(db));
    const after = withOpenDb(file, (db) => snapshot(db, before.columns));
    const added = after.objects.filter((o) => !before.objects.some((b) => b.name === o.name));
    expect(added).toEqual(
      expect.arrayContaining([
        { type: "index", name: "models_default" },
        { type: "table", name: "models" },
      ]),
    );
    // Every object on models, autoindex included: an extra or dropped index fails here.
    expect(
      withDatabase(file, (db) =>
        db
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE tbl_name = 'models' ORDER BY type, name",
          )
          .all(),
      ),
    ).toEqual([
      { type: "index", name: "models_default" },
      { type: "index", name: "sqlite_autoindex_models_1" },
      { type: "table", name: "models" },
    ]);
    const { schema_migrations: receiptsBefore, ...keptBefore } = before.rows;
    const keptAfter = Object.fromEntries(
      Object.keys(keptBefore).map((table) => [table, after.rows[table]]),
    );
    expect(keptAfter).toEqual(keptBefore);
    expect(after.rows.models).toEqual([]);
    const receiptsAfter = after.rows.schema_migrations ?? [];
    expect(receiptsAfter.slice(0, receiptsBefore?.length)).toEqual(receiptsBefore);
    expect(receiptsAfter.slice(receiptsBefore?.length ?? 0).map((r) => r.filename)).toEqual(
      TRACKED_MIGRATION_FILENAMES.slice(TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_046)),
    );
    expect(receiptsAfter[through045.length]?.filename).toBe(MIGRATION_046);
  });
});

describe("create", () => {
  it("fills the MODEL_CATALOG defaults; the first row becomes the default, later rows do not", () => {
    const { store } = fresh();
    expect(store.create({ id: "m1" })).toEqual({
      id: "m1",
      name: "m1",
      reasoning: false,
      vision: false,
      maxTokens: 32768,
      efforts: null,
      upstream: null,
      isDefault: true,
      probe: NEVER,
      createdAt: T0,
      updatedAt: T0,
    } satisfies ModelRow);
    const second = store.create({
      id: "m2",
      reasoning: true,
      efforts: ["low", "high"],
      upstream: UP,
    });
    expect(second).toMatchObject({
      isDefault: false,
      efforts: ["low", "high"],
      upstream: { baseUrl: UP.baseUrl, hasApiKey: true },
    });
    expect(store.routeOf("m2")).toEqual(UP);
    expect(store.list().map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  it("accepts a reasoning model without efforts (stored NULL) and a base URL with path and query", () => {
    const { db, store } = fresh();
    const upstream = { baseUrl: "http://gw.example:8080/tenant/v1?org=a", apiKey: "k é\tb" };
    expect(store.create({ id: "a", reasoning: true, upstream }).efforts).toBeNull();
    expect(rawRows(db)[0]).toMatchObject({ efforts: null, upstream_base_url: upstream.baseUrl });
    expect(store.routeOf("a")).toEqual(upstream);
  });

  it("refuses a duplicate id with 409 and a 33rd model with 400", () => {
    const { db, store } = fresh();
    for (let i = 0; i < 32; i += 1) store.create({ id: `m${i}` });
    expectRefused(db, "conflict", () => store.create({ id: "m3", name: "again" }));
    expectRefused(db, "bad_request", () => store.create({ id: "m32" }));
  });

  // model-selection「非法白名单使启动失败」single entries (array- and count-level cases dropped).
  it.each([
    {},
    { name: "x" },
    { id: "" },
    { id: "a\u0007" },
    { id: "x".repeat(129) },
    { id: "a", name: "n".repeat(65) },
    { id: "a", extra: 1 },
    { id: "a", reasoning: "yes" },
    { id: "a", vision: 1 },
    { id: "a", efforts: ["low"] },
    { id: "a", reasoning: true, efforts: [] },
    { id: "a", reasoning: true, efforts: ["high", "low"] },
    { id: "a", reasoning: true, efforts: ["ultra"] },
    { id: "a", reasoning: true, efforts: ["auto"] },
    { id: "a", maxTokens: 0 },
    { id: "a", maxTokens: 128001 },
    { id: "a", maxTokens: 1.5 },
    { id: "a", maxTokens: "32768" },
    { id: "a", maxTokens: null },
    { id: "a", maxTokens: -1 },
    { id: "a", upstream: null },
    { id: "a", upstream: "https://gw.example" },
    { id: "a", upstream: { baseUrl: "https://gw.example" } },
    { id: "a", upstream: { apiKey: "k" } },
    { id: "a", upstream: { ...UP, extra: 1 } },
    { id: "a", upstream: { ...UP, baseUrl: "" } },
    { id: "a", upstream: { ...UP, baseUrl: "ftp://gw.example" } },
    { id: "a", upstream: { ...UP, baseUrl: "https://u:p@gw.example/v1" } },
    { id: "a", upstream: { ...UP, baseUrl: "https://gw.example/v1#frag" } },
    { id: "a", upstream: { ...UP, baseUrl: "https://gw.example/ v1" } },
    { id: "a", upstream: { ...UP, apiKey: "" } },
    { id: "a", upstream: { ...UP, apiKey: "k\nSENTINEL" } },
    { id: "a", upstream: { ...UP, apiKey: "密钥" } },
    null,
    [],
    "m1",
  ])("body %j is 400 bad_request with the fixed message and no write", (body) => {
    const { db, store } = fresh();
    expectRefused(db, "bad_request", () => store.create(body));
  });

  it("round-trips ids with a slash, a space and a percent sign", () => {
    const { store } = fresh();
    const ids = ["Qwen/Qwen2.5-72B-Instruct", "my model", "50%off"];
    for (const id of ids) store.create({ id, upstream: UP });
    expect(store.list().map((row) => row.id)).toEqual(ids);
    for (const id of ids) {
      expect(store.get(id)?.id).toBe(id);
      expect(store.routeOf(id)).toEqual(UP);
      expect(
        store.update(id, {
          name: "n",
          reasoning: false,
          vision: true,
          maxTokens: 9,
          upstream: null,
        }).vision,
      ).toBe(true);
    }
    expect(store.setDefault(ids[2] as string).changed).toBe(true);
    store.remove(ids[0] as string);
    expect(store.list().map((row) => row.id)).toEqual(ids.slice(1));
  });
});

const BODY = { name: "改名", reasoning: true, vision: true, maxTokens: 100, efforts: ["high"] };

describe("update", () => {
  it("replaces every field but id, keeps createdAt and isDefault, advances updatedAt", () => {
    const { store } = fresh();
    store.create({ id: "m1", upstream: UP });
    vi.setSystemTime(T0 + 5);
    const row = store.update("m1", {
      ...BODY,
      upstream: { baseUrl: "https://other.example/v1", apiKey: "k2" },
    });
    expect(row).toEqual({
      id: "m1",
      name: "改名",
      reasoning: true,
      vision: true,
      maxTokens: 100,
      efforts: ["high"],
      upstream: { baseUrl: "https://other.example/v1", hasApiKey: true },
      isDefault: true,
      probe: NEVER,
      createdAt: T0,
      updatedAt: T0 + 5,
    } satisfies ModelRow);
    expect(store.get("m1")).toEqual(row);
  });

  it("an omitted apiKey keeps the stored key; with no stored key it is 400", () => {
    const { db, store } = fresh();
    seedOne(store);
    store.update("m1", { ...BODY, upstream: { baseUrl: "https://moved.example/v1" } });
    expect(store.routeOf("m1")).toEqual({ baseUrl: "https://moved.example/v1", apiKey: KEY });
    expectRefused(db, "bad_request", () =>
      store.update("m2", { ...BODY, upstream: { baseUrl: "https://moved.example/v1" } }),
    );
  });

  it("a seed row with userinfo: a rename that sends the view form of its address keeps the stored address and key byte for byte", () => {
    const { db, store } = fresh();
    store.seedIfEmpty(resolveModelCatalog({}), { baseUrl: USERINFO_URL, apiKey: KEY });
    const id = "deepseek-v4.1-flash";
    // The address as the view shows it: userinfo removed (independent literal, not recomputed).
    const viewForm = "https://gw.example/tenant-0123456789/v1?org=acme-0001";
    const renamed = store.update(id, {
      name: "深度求索",
      reasoning: true,
      vision: true,
      maxTokens: 32768,
      upstream: { baseUrl: viewForm },
    });
    expect(renamed).toMatchObject({ name: "深度求索", upstream: { baseUrl: USERINFO_URL } });
    expect(store.routeOf(id)).toEqual({ baseUrl: USERINFO_URL, apiKey: KEY });

    // Any other address still goes through the address rule: the raw userinfo form is refused,
    // a plain new address is taken with the kept key.
    const body = { name: "深度求索", reasoning: true, vision: true, maxTokens: 32768 };
    expectRefused(db, "bad_request", () =>
      store.update(id, { ...body, upstream: { baseUrl: USERINFO_URL } }),
    );
    store.update(id, { ...body, upstream: { baseUrl: "https://moved.example/v1" } });
    expect(store.routeOf(id)).toEqual({ baseUrl: "https://moved.example/v1", apiKey: KEY });
  });

  it("a seed row with userinfo: the view form of its address plus a new apiKey rotates only the key; the key still passes the header rule", () => {
    const { db, store } = fresh();
    store.seedIfEmpty(resolveModelCatalog({}), { baseUrl: USERINFO_URL, apiKey: KEY });
    const id = "deepseek-v4.1-flash";
    const viewForm = "https://gw.example/tenant-0123456789/v1?org=acme-0001";
    const body = { name: "深度求索", reasoning: true, vision: true, maxTokens: 32768 };
    const rotated = "wb-issue1708-rotated-key";

    store.update(id, { ...body, upstream: { baseUrl: viewForm, apiKey: rotated } });
    expect(store.routeOf(id)).toEqual({ baseUrl: USERINFO_URL, apiKey: rotated });

    // A key that is not a valid header value is still refused, and nothing changes.
    expectRefused(db, "bad_request", () =>
      store.update(id, { ...body, upstream: { baseUrl: viewForm, apiKey: "bad\nkey" } }),
    );
    expectRefused(db, "bad_request", () =>
      store.update(id, { ...body, upstream: { baseUrl: viewForm, apiKey: "" } }),
    );
    expect(store.routeOf(id)).toEqual({ baseUrl: USERINFO_URL, apiKey: rotated });
  });

  it("upstream null clears both columns; a reasoning model without efforts stores NULL", () => {
    const { db, store } = fresh();
    seedOne(store);
    const { efforts: _dropped, ...withoutEfforts } = BODY;
    expect(store.update("m1", { ...withoutEfforts, upstream: null })).toMatchObject({
      upstream: null,
      efforts: null,
    });
    expect(store.routeOf("m1")).toBeNull();
    expect(rawRows(db)[0]).toMatchObject({
      efforts: null,
      upstream_base_url: null,
      upstream_api_key: null,
    });
  });

  it.each([
    ["no upstream key", { ...BODY }],
    ["no name", { reasoning: false, vision: false, maxTokens: 1, upstream: null }],
    ["an id key", { ...BODY, id: "m1", upstream: null }],
    [
      "a userinfo base URL",
      { ...BODY, upstream: { baseUrl: "https://u:p@x.example", apiKey: "k" } },
    ],
    ["an extra upstream key", { ...BODY, upstream: { ...UP, region: "x" } }],
    ["efforts on a non-reasoning model", { ...BODY, reasoning: false, upstream: null }],
  ])("a body with %s is 400 and changes nothing", (_label, body) => {
    const { db, store } = fresh();
    seedOne(store);
    expectRefused(db, "bad_request", () => store.update("m1", body));
  });
});

describe("remove, setDefault and recordProbe", () => {
  it("removing the default is 409 model_in_use; a non-default row is deleted", () => {
    const { db, store } = fresh();
    seedOne(store);
    expectRefused(db, "model_in_use", () => store.remove("m1"));
    store.remove("m2");
    expect(store.list().map((row) => row.id)).toEqual(["m1"]);
  });

  it("setDefault clears the old and sets the new in one step; already default writes nothing", () => {
    const { db, store } = fresh();
    seedOne(store);
    vi.setSystemTime(T0 + 7);
    const { row, changed } = store.setDefault("m2");
    expect(changed).toBe(true);
    expect(row).toMatchObject({ id: "m2", isDefault: true, updatedAt: T0 + 7 });
    expect(store.get("m1")?.isDefault).toBe(false);
    const before = rawRows(db);
    const within = vi.fn();
    vi.setSystemTime(T0 + 9);
    expect(store.setDefault("m2", within)).toEqual({ row: store.get("m2"), changed: false });
    expect(within).not.toHaveBeenCalled();
    expect(rawRows(db)).toEqual(before);
  });

  it("a setDefault that fails part-way leaves both rows as they were", () => {
    const { db, store } = fresh();
    seedOne(store);
    const before = rawRows(db);
    expect(() =>
      store.setDefault("m2", () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawRows(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
  });

  it("recordProbe writes the three probe columns, keeps updatedAt and returns the new row", () => {
    const { store } = fresh();
    seedOne(store);
    vi.setSystemTime(T0 + 50);
    const row = store.recordProbe("m1", {
      status: "failed",
      message: "HTTP 401：bad key",
      at: T0 + 40,
    });
    expect(row).toEqual({
      ...store.get("m1"),
      probe: { status: "failed", at: T0 + 40, message: "HTTP 401：bad key" },
    });
    expect(row.updatedAt).toBe(T0);
    expect(store.recordProbe("m1", { status: "ok", message: null, at: T0 + 60 }).probe).toEqual({
      status: "ok",
      at: T0 + 60,
      message: null,
    });
  });

  it("unknown ids: get and routeOf undefined, every write 404 with nothing changed", () => {
    const { db, store } = fresh();
    seedOne(store);
    expect(store.get("nope")).toBeUndefined();
    expect(store.routeOf("nope")).toBeUndefined();
    expect(store.routeOf("m2")).toBeNull();
    expectRefused(db, "not_found", () => store.update("nope", { ...BODY, upstream: null }));
    expectRefused(db, "not_found", () => store.remove("nope"));
    expectRefused(db, "not_found", () => store.setDefault("nope"));
    expectRefused(db, "not_found", () =>
      store.recordProbe("nope", { status: "ok", message: null, at: 1 }),
    );
  });
});

describe("within: the caller's step inside the write transaction", () => {
  const writes: Array<
    [
      string,
      (s: ReturnType<typeof createModelStore>, w: (row: ModelRow) => void) => unknown,
      string,
    ]
  > = [
    ["create", (s, w) => s.create({ id: "m3" }, w), "m3"],
    ["update", (s, w) => s.update("m2", { ...BODY, upstream: null }, w), "m2"],
    ["remove", (s, w) => s.remove("m2", w), "m2"],
    ["setDefault", (s, w) => s.setDefault("m2", w), "m2"],
    ["recordProbe", (s, w) => s.recordProbe("m2", { status: "ok", message: null, at: 7 }, w), "m2"],
  ];
  it.each(writes)(
    "%s calls it once inside the transaction and rolls back when it throws",
    (_l, write, id) => {
      const { db, store } = fresh();
      seedOne(store);
      const before = rawRows(db);
      const seen: Array<[string, boolean]> = [];
      const failure = new Error("emit failed");
      expect(() =>
        write(store, (row) => {
          seen.push([row.id, db.isTransaction]);
          throw failure;
        }),
      ).toThrow(failure);
      expect(seen).toEqual([[id, true]]);
      expect(rawRows(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);
      write(store, (row) => seen.push([row.id, db.isTransaction]));
      expect(seen).toEqual([
        [id, true],
        [id, true],
      ]);
      expect(rawRows(db)).not.toEqual(before);
    },
  );
});

describe("seedIfEmpty", () => {
  it("seeds the three-model catalog in env order with the default and both upstream columns", () => {
    const { db, store } = fresh();
    const catalog = resolveModelCatalog({ MODEL_CATALOG: THREE_MODELS, MODEL_ID: "m3" });
    expect(store.seedIfEmpty(catalog, UP)).toBe("seeded");
    expect(
      rawRows(db).map((r) => [
        r.id,
        r.is_default,
        r.efforts,
        r.upstream_base_url,
        r.upstream_api_key,
        r.created_at,
      ]),
    ).toEqual([
      ["m1", 0, '["minimal","low","medium","high","xhigh","max"]', UP.baseUrl, KEY, T0],
      ["m2", 0, null, UP.baseUrl, KEY, T0 + 1],
      ["m3", 1, '["low","high"]', UP.baseUrl, KEY, T0 + 2],
    ]);
  });

  it("zero config seeds the single model with efforts NULL and no upstream", () => {
    const { db, store } = fresh();
    expect(store.seedIfEmpty(resolveModelCatalog({}), {})).toBe("seeded");
    expect(rawRows(db)).toEqual([
      {
        id: "deepseek-v4.1-flash",
        name: "deepseek-v4.1-flash",
        reasoning: 1,
        vision: 1,
        max_tokens: 32768,
        efforts: null,
        upstream_base_url: null,
        upstream_api_key: null,
        is_default: 1,
        probe_status: "never",
        probe_at: null,
        probe_message: null,
        created_at: T0,
        updated_at: T0,
      },
    ]);
  });

  it.each([
    ["only a base URL", { baseUrl: UP.baseUrl }],
    ["only a key", { apiKey: KEY }],
    ["an explicitly undefined key", { baseUrl: UP.baseUrl, apiKey: undefined }],
  ])("%s seeds both upstream columns NULL", (_label, upstream) => {
    const { db, store } = fresh();
    store.seedIfEmpty(resolveModelCatalog({}), upstream);
    expect(rawRows(db)[0]).toMatchObject({ upstream_base_url: null, upstream_api_key: null });
  });

  it("an env base URL with userinfo is stored byte for byte (the seed skips validateUpstream)", () => {
    const { db, store } = fresh();
    expect(store.seedIfEmpty(resolveModelCatalog({}), { baseUrl: USERINFO_URL, apiKey: KEY })).toBe(
      "seeded",
    );
    expect(rawRows(db)[0]).toMatchObject({
      upstream_base_url: USERINFO_URL,
      upstream_api_key: KEY,
    });
  });

  it("a non-empty table is skipped without any write", () => {
    const { db, store } = fresh();
    store.create({ id: "m9" });
    const before = rawRows(db);
    expect(store.seedIfEmpty(resolveModelCatalog({ MODEL_ID: "m1" }), UP)).toBe("skipped");
    expect(rawRows(db)).toEqual(before);
  });

  it("is all-or-nothing: a failing second insert leaves the table empty and throws", () => {
    const { db, store } = fresh();
    const model = { id: "a", name: "a", reasoning: false, vision: false, maxTokens: 1 };
    const broken = { models: [model, { ...model, id: "b", maxTokens: 0 }], defaultModelId: "a" };
    expect(() => store.seedIfEmpty(broken, UP)).toThrow();
    expect(rawRows(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it.each([
    [
      "an unsorted catalog",
      {
        MODEL_CATALOG: JSON.stringify([
          { id: "zz", reasoning: true, efforts: ["low"] },
          { id: "aa", vision: true },
        ]),
        MODEL_ID: "aa",
      },
    ],
    ["zero config", {}],
    ["the three-model catalog", { MODEL_CATALOG: THREE_MODELS }],
  ])("toCatalog(list()) after seeding %s equals resolveModelCatalog(env)", (_label, env) => {
    const { store } = fresh();
    store.seedIfEmpty(resolveModelCatalog(env), {});
    expect(store.toCatalog(store.list())).toStrictEqual(resolveModelCatalog(env));
  });
});

describe("list, toCatalog and secrets", () => {
  it("lists in registration order even within one clock millisecond", () => {
    const { store } = fresh();
    for (const id of ["b", "c", "a"]) store.create({ id });
    expect(store.list().map((row) => [row.id, row.createdAt])).toEqual([
      ["b", T0],
      ["c", T0 + 1],
      ["a", T0 + 2],
    ]);
  });

  it("toCatalog refuses rows without exactly one default", () => {
    const { store } = fresh();
    expect(() => store.toCatalog([])).toThrow();
  });

  it("secrets() is the de-duplicated union of each upstream's secret list; NULL rows add nothing", () => {
    const { store } = fresh();
    expect(store.secrets()).toEqual([]);
    const catalog = resolveModelCatalog({
      MODEL_CATALOG: JSON.stringify([{ id: "a" }, { id: "b" }]),
    });
    store.seedIfEmpty(catalog, { baseUrl: USERINFO_URL, apiKey: KEY });
    store.create({ id: "c" });
    const first = upstreamSecretList({ apiKey: KEY, baseUrl: USERINFO_URL, paths: [] });
    expect(store.secrets()).toEqual(first);
    const two = { baseUrl: "https://two.example/v1", apiKey: KEY };
    store.create({ id: "d", upstream: two });
    const second = upstreamSecretList({ ...two, paths: [] });
    expect(store.secrets()).toEqual([...new Set([...first, ...second])]);
    expect(store.secrets().filter((entry) => entry === KEY)).toEqual([KEY]);
  });

  it("the key is readable only through routeOf and secrets", () => {
    const { db, store } = fresh();
    store.seedIfEmpty(resolveModelCatalog({}), UP);
    const outputs: unknown[] = [];
    const within = (row: ModelRow) => outputs.push(row);
    outputs.push(store.create({ id: "m2", upstream: UP }, within));
    outputs.push(store.update("m2", { ...BODY, upstream: { baseUrl: UP.baseUrl } }, within));
    outputs.push(
      store.setDefault("m2", within),
      store.recordProbe("m2", { status: "ok", message: null, at: 1 }),
    );
    outputs.push(store.list(), store.get("m2"), store.toCatalog(store.list()));
    const failures = [
      () => store.create({ id: "m2", upstream: UP }),
      () => store.create({ id: "x", upstream: { ...UP, apiKey: `${KEY}\n` } }),
      () => store.update("m2", { ...BODY, upstream: { baseUrl: `https://${KEY}@x` } }),
      () => store.remove("m2"),
    ];
    for (const failure of failures) {
      try {
        failure();
      } catch (error) {
        outputs.push((error as Error).message);
      }
    }
    expect(outputs).toHaveLength(14);
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("apiKey");
    expect(store.routeOf("m2")?.apiKey).toBe(KEY);
    expect(store.secrets()).toContain(KEY);
    expect(rawRows(db)).toHaveLength(2);
  });
});
