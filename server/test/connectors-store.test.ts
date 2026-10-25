/**
 * s1d-connectors group 1: migration 048, the connector value rules and the connector store (connectors
 * 「迁移 048 连接器 schema」「连接器取值规则」, the store part of「连接器管理端点」PUT whole replacement and
 * probe reset; the account defaults storage of「连接器账号缺省」). `:memory:` databases through the real
 * migrations (`openDb`); expected values are literals from design D1–D3 and the spec. Credential values
 * are sentinels and no refusal message may carry a submitted value.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectorStore,
  readAccountDisabledConnectors,
  saveAccountDisabledConnectors,
} from "../src/connectors/store.js";
import { normalizeConnectorNames } from "../src/connectors/validate.js";
import { openDb } from "../src/core/db/index.js";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import {
  COMPLETE_CATALOG,
  ledgerFilenames,
  MIGRATION_047,
  MIGRATION_048,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withOpenDb,
} from "./core-db-helpers.js";
import { S_A, S_B, S_C, S_D, seedPopulated034, seedThrough } from "./core-db-session-fixture.js";

const T0 = 1_760_000_000_000;
const SECRET = "SENTINEL-CRED-5519";
const SECRET_2 = "SENTINEL-CRED-8842";
const CJK = "测";
const STDIO = { name: "gitlab", type: "stdio", command: "/usr/bin/gitlab-mcp" } as const;
const HTTP = { name: "wiki", type: "http", url: "https://wiki.example/mcp" } as const;
const FIXED = HTTP_ERROR_MESSAGES.bad_request;
/** omp's `${NAME}` interpolation, spelled so no string literal carries a template placeholder. */
const interp = (name: string) => `$\{${name}}`;

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
  return { db, store: createConnectorStore(db) };
}

const rawConnectors = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM connectors ORDER BY name").all();
const rawOne = (db: DatabaseSync, name: string) =>
  db.prepare("SELECT * FROM connectors WHERE name = ?").get(name) as Record<string, unknown>;
const rawPrefs = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM account_connector_prefs ORDER BY account_id").all();
const tableInfo = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
const setProbe = (db: DatabaseSync, name: string) =>
  db
    .prepare(
      "UPDATE connectors SET probe_status = 'ok', probe_at = 1234, probe_message = NULL WHERE name = ?",
    )
    .run(name);
const probeOf = (db: DatabaseSync, name: string) => {
  const { probe_status, probe_at, probe_message } = rawOne(db, name);
  return [probe_status, probe_at, probe_message];
};

/** `n` distinct names of lowercase letters only: a, b, …, z, ba, bb, … */
function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    let s = "";
    let k = i;
    do {
      s = String.fromCharCode(97 + (k % 26)) + s;
      k = Math.floor(k / 26);
    } while (k > 0);
    return s;
  });
}
const entries = (n: number, value: (i: number) => string) =>
  Object.fromEntries(names(n).map((name, i) => [`K_${name.toUpperCase()}`, value(i)]));

/** The code a call throws (`none` if it returns); a throw is the code's fixed-message HttpError. */
function codeOf(action: () => unknown, ...secrets: string[]): HttpErrorCode | "none" {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const { code, message } = error as HttpError;
    expect(message).toBe(HTTP_ERROR_MESSAGES[code]);
    for (const secret of secrets) expect(message).not.toContain(secret);
    return code;
  }
  return "none";
}

/** `action` throws `bad_request` with the fixed message and leaves both tables as they were. */
function expectRefused(db: DatabaseSync, action: () => unknown, ...secrets: string[]): void {
  const before = [rawConnectors(db), rawPrefs(db)];
  expect(codeOf(action, ...secrets)).toBe("bad_request");
  expect([rawConnectors(db), rawPrefs(db)]).toEqual(before);
}

describe("migration 048 schema", () => {
  it("is tracked once, right after 047, with its receipt at position 22", () => {
    const pos = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_048);
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_048)).toHaveLength(1);
    expect(TRACKED_MIGRATION_FILENAMES[pos - 1]).toBe(MIGRATION_047);
    expect(COMPLETE_CATALOG.receipts[pos]).toEqual([22, MIGRATION_048]);
    expect(COMPLETE_CATALOG.sequenceRows).toEqual([["schema_migrations", 22, "integer"]]);
  });

  it("creates the D1 tables and appends disabled_connectors to chat_sessions", () => {
    const { db } = fresh();
    expect(tableInfo(db, "connectors")).toEqual([
      ["name", "TEXT", 1, null, 1],
      ["type", "TEXT", 1, null, 0],
      ["description", "TEXT", 1, null, 0],
      ["command", "TEXT", 0, null, 0],
      ["args", "TEXT", 0, null, 0],
      ["env", "TEXT", 0, null, 0],
      ["url", "TEXT", 0, null, 0],
      ["headers", "TEXT", 0, null, 0],
      ["enabled", "INTEGER", 1, "1", 0],
      ["probe_status", "TEXT", 1, "'never'", 0],
      ["probe_at", "INTEGER", 0, null, 0],
      ["probe_message", "TEXT", 0, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
    ]);
    expect(tableInfo(db, "account_connector_prefs")).toEqual([
      ["account_id", "TEXT", 1, null, 1],
      ["disabled_connectors", "TEXT", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
    ]);
    expect(tableInfo(db, "chat_sessions").at(-1)).toEqual([
      "disabled_connectors",
      "TEXT",
      1,
      "'[]'",
      0,
    ]);
    expect(
      db
        .prepare("PRAGMA foreign_key_list('account_connector_prefs')")
        .all()
        .map((k) => [k.from, k.table, k.to, k.on_delete]),
    ).toEqual([["account_id", "accounts", "id", "CASCADE"]]);
  });

  const INSERT =
    "INSERT INTO connectors(name, type, description, command, args, env, url, headers, enabled, probe_status, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, 1, 1)";
  type Row = [string, string, ...Array<string | null>];
  const insert = (db: DatabaseSync, row: Row, enabled = 1, probe = "never") =>
    db.prepare(INSERT).run(...row, enabled, probe);

  it("accepts each type's shape and the CHECKs refuse every other shape", () => {
    const { db } = fresh();
    insert(db, ["s", "stdio", "/bin/x", "[]", "{}", null, null]);
    insert(db, ["t", "stdio", "/bin/x", null, null, null, null]);
    insert(db, ["h", "http", null, null, null, "https://h", "{}"]);
    insert(db, ["i", "http", null, null, null, "https://h", null]);
    const before = rawConnectors(db);
    const refused: Array<[Row, number?, string?]> = [
      [["a", "stdio", null, "[]", "{}", null, null]], // stdio without command
      [["b", "http", null, null, "{}", "https://h", "{}"]], // http with env
      [["c", "stdio", "/bin/x", null, null, "https://h", null]], // stdio with url
      [["d", "stdio", "/bin/x", null, null, null, "{}"]], // stdio with headers
      [["e", "http", null, null, null, null, "{}"]], // http without url
      [["f", "http", "/bin/x", null, null, "https://h", null]], // http with command
      [["g", "http", null, "[]", null, "https://h", null]], // http with args
      [["j", "sse", null, null, null, "https://h", null]], // unknown type
      [["k", "stdio", "/bin/x", null, null, null, null], 2], // enabled not 0/1
      [["l", "stdio", "/bin/x", null, null, null, null], 1, "pending"], // unknown probe status
    ];
    for (const [row, enabled, probe] of refused) {
      expect(() => insert(db, row, enabled, probe)).toThrow(/CHECK constraint failed/);
    }
    expect(rawConnectors(db)).toEqual(before);
  });

  it("a populated database ending at 047 reads every existing session's disabled_connectors as []", () => {
    const file = join(tempDir(), "populated-047.db");
    const through047 = TRACKED_MIGRATION_FILENAMES.slice(
      0,
      TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_048),
    );
    seedThrough(file, through047, seedPopulated034);
    withOpenDb(file, (db) => {
      expect(
        db.prepare("SELECT id, disabled_connectors FROM chat_sessions ORDER BY id").all(),
      ).toEqual([S_A, S_B, S_C, S_D].map((id) => ({ id, disabled_connectors: "[]" })));
      expect(rawConnectors(db)).toEqual([]);
      expect(rawPrefs(db)).toEqual([]);
      expect(ledgerFilenames(db)).toEqual([...through047, MIGRATION_048]);
    });
  });

  it("deleting an account cascades to its connector defaults only; connectors are not owned", () => {
    const { db, store } = fresh();
    store.create(STDIO);
    saveAccountDisabledConnectors(db, "u1", ["gitlab"]);
    saveAccountDisabledConnectors(db, "u2", ["wiki"]);
    db.prepare("DELETE FROM accounts WHERE id = 'u1'").run();
    expect(rawPrefs(db)).toEqual([
      { account_id: "u2", disabled_connectors: '["wiki"]', updated_at: T0 },
    ]);
    expect(rawConnectors(db).map((row) => row.name)).toEqual(["gitlab"]);
  });
});

describe("value rules (D2, D3): every refusal is the fixed 400 and echoes nothing", () => {
  const refuse = (body: Record<string, unknown>, ...secrets: string[]) => {
    const { db, store } = fresh();
    expectRefused(db, () => store.create(body), ...secrets);
  };
  const accept = (body: Record<string, unknown>) => {
    const { store } = fresh();
    expect(store.create(body).name).toBe(body.name);
  };

  it("name is 1..32 lowercase letters only", () => {
    for (const name of ["a", "git", "z".repeat(32)]) accept({ ...STDIO, name });
    for (const name of ["git2", "Git", "a_", "git_lab", "z".repeat(33), "", "测", " git"]) {
      refuse({ ...STDIO, name }, name || "\u0000");
    }
    refuse({ type: "stdio", command: "/bin/x" });
    refuse({ ...STDIO, name: 7 });
  });

  it("type is stdio or http; description is 0..200 code points", () => {
    refuse({ ...STDIO, type: "sse" });
    refuse({ name: "x", command: "/bin/x" });
    accept({ ...STDIO, description: "" });
    accept({ ...STDIO, description: CJK.repeat(200) });
    refuse({ ...STDIO, description: CJK.repeat(201) });
    refuse({ ...STDIO, description: 1 });
    refuse({ ...STDIO, enabled: "true" });
  });

  it("stdio command: absolute, ≤1024 UTF-8 bytes, no control characters", () => {
    accept({ ...STDIO, command: `/${"a".repeat(1023)}` });
    accept({ ...STDIO, command: `/${CJK.repeat(341)}` }); // 1024 bytes
    for (const command of [
      "node",
      "./bin/x",
      `/${CJK.repeat(342)}`, // 1027 bytes, 343 code points
      "/usr/bin/x\u0000",
      "/usr/bin/x\ny",
      "/usr/bin/\u007f",
      "",
    ]) {
      refuse({ ...STDIO, command }, command || "\u0000");
    }
    refuse({ name: "gitlab", type: "stdio" });
  });

  it("stdio args: ≤32 strings of ≤1024 code points each", () => {
    accept({ ...STDIO, args: names(32) });
    accept({ ...STDIO, args: ["", CJK.repeat(1024)] });
    refuse({ ...STDIO, args: names(33) });
    refuse({ ...STDIO, args: [CJK.repeat(1025)] });
    refuse({ ...STDIO, args: [1] });
    refuse({ ...STDIO, args: "--stdio" });
  });

  it("stdio env: ≤32 keys matching ^[A-Z_][A-Z0-9_]{0,63}$, values 1..4096 code points", () => {
    accept({ ...STDIO, env: entries(32, () => SECRET) });
    accept({ ...STDIO, env: { _X: "1", A1: "2", [`A${"B".repeat(63)}`]: CJK.repeat(4096) } });
    refuse({ ...STDIO, env: entries(33, () => SECRET) }, SECRET);
    for (const key of ["token", "1A", "A-B", `A${"B".repeat(64)}`, "", "__proto__"]) {
      refuse({ ...STDIO, env: { [key]: SECRET } }, SECRET);
    }
    refuse({ ...STDIO, env: { TOKEN: "" } });
    refuse({ ...STDIO, env: { TOKEN: CJK.repeat(4097) } });
    refuse({ ...STDIO, env: { TOKEN: 1 } });
    refuse({ ...STDIO, env: [SECRET] }, SECRET);
  });

  it("http url: the upstream base URL rule (http(s), no whitespace, fragment or userinfo)", () => {
    accept({ ...HTTP, url: "http://10.0.0.5:8080/mcp?x=1" });
    for (const url of [
      "ftp://h/x",
      `https://user:${SECRET}@h/mcp`,
      "https://h/mcp#frag",
      "https://h /mcp",
      "",
    ]) {
      refuse({ ...HTTP, url }, url || "\u0000");
    }
    refuse({ name: "wiki", type: "http" });
  });

  it("http headers: ≤32 RFC 7230 token names; values pass validateHeaderValue; Node's error never leaks", () => {
    accept({ ...HTTP, headers: { "x-token": SECRET, Authorization: `Bearer ${SECRET}`, e: "" } });
    accept({ ...HTTP, headers: Object.fromEntries(names(32).map((n) => [n, SECRET])) });
    refuse({ ...HTTP, headers: Object.fromEntries(names(33).map((n) => [n, SECRET])) }, SECRET);
    for (const name of ["bad header", "a:b", "", "xé"]) {
      refuse({ ...HTTP, headers: { [name]: SECRET } }, SECRET, name || "\u0000", "Header");
    }
    for (const value of [`${SECRET}\r\nx: y`, `${SECRET}\u0000`, `${SECRET}中`]) {
      refuse({ ...HTTP, headers: { authorization: value } }, SECRET, "Invalid", "header");
    }
    refuse({ ...HTTP, headers: { authorization: 1 } });
  });

  it("refuses the other type's keys and any unknown key", () => {
    refuse({ ...STDIO, url: "https://h/mcp" });
    refuse({ ...STDIO, headers: {} });
    refuse({ ...HTTP, env: { TOKEN: SECRET } }, SECRET);
    refuse({ ...HTTP, command: "/bin/x" });
    refuse({ ...HTTP, args: [] });
    refuse({ ...STDIO, cwd: "/tmp" });
    refuse({ ...STDIO, timeout: 1 });
  });

  it("refuses ${ in each of the five written fields", () => {
    refuse({ ...STDIO, command: `/usr/bin/${interp("X")}` }, interp("X"));
    refuse({ ...STDIO, args: [interp("HOME")] }, interp("HOME"));
    refuse({ ...STDIO, env: { TOKEN: `${SECRET}${interp("HOME")}` } }, SECRET);
    refuse({ ...HTTP, url: `https://h/${interp("X")}` }, interp("X"));
    refuse(
      { ...HTTP, headers: { authorization: `Bearer ${interp("WORKBUDDY_MODEL_TOKEN")}` } },
      "Bearer",
    );
    // `$` and `{` alone are literal to omp.
    accept({ ...STDIO, args: ["$HOME", "{x}", "$ {"], env: { TOKEN: "a$b{c}" } });
  });

  it("refuses a leading ! in args, env values and header values", () => {
    refuse({ ...STDIO, args: ["!cat /etc/passwd"] }, "cat /etc/passwd");
    refuse({ ...STDIO, env: { TOKEN: "!cat /etc/passwd" } }, "cat /etc/passwd");
    refuse({ ...HTTP, headers: { authorization: `!echo ${SECRET}` } }, SECRET);
    accept({ ...STDIO, args: ["a!b", " !x"], env: { TOKEN: `${SECRET}!` } });
  });

  it("refuses env and header values that are exactly an OMP_CHILD_ENV_NAMES member, and only those", () => {
    refuse({ ...STDIO, env: { X: "HOME" } });
    refuse({ ...STDIO, env: { X: "PATH" } });
    refuse({ ...STDIO, env: { X: "SUDO_USER" } });
    refuse({ ...STDIO, env: { X: "BUN_BE_BUN" } });
    refuse({ ...HTTP, headers: { authorization: "WORKBUDDY_MODEL_TOKEN" } });
    refuse({ ...HTTP, headers: { authorization: "no_proxy" } });
    // Case-sensitive and exact; args are not resolved by omp.
    accept({ ...STDIO, args: ["HOME"], env: { X: "home", Y: "HOME ", Z: "MY_HOME" } });
    accept({ ...HTTP, headers: { authorization: "Bearer WORKBUDDY_MODEL_TOKEN", x: "Path" } });
  });

  it("refuses a null value on create (there is no existing value to keep)", () => {
    refuse({ ...STDIO, env: { TOKEN: null } });
    refuse({ ...HTTP, headers: { authorization: null } });
  });

  it("refuses a body that is not an object", () => {
    const { db, store } = fresh();
    for (const body of [null, [], "x", 1, undefined]) {
      expectRefused(db, () => store.create(body));
    }
  });
});

describe("create", () => {
  it("stores a stdio row with the defaults and returns the admin view", () => {
    const { db, store } = fresh();
    const view = store.create({ ...STDIO, env: { TOKEN: SECRET } });
    expect(view).toEqual({
      name: "gitlab",
      type: "stdio",
      description: "",
      enabled: true,
      command: "/usr/bin/gitlab-mcp",
      args: [],
      envKeys: ["TOKEN"],
      url: null,
      headerKeys: null,
      probe: { status: "never", at: null, message: null },
      updatedAt: T0,
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(rawConnectors(db)).toEqual([
      {
        name: "gitlab",
        type: "stdio",
        description: "",
        command: "/usr/bin/gitlab-mcp",
        args: "[]",
        env: `{"TOKEN":"${SECRET}"}`,
        url: null,
        headers: null,
        enabled: 1,
        probe_status: "never",
        probe_at: null,
        probe_message: null,
        created_at: T0,
        updated_at: T0,
      },
    ]);
    expect(store.get("gitlab")).toEqual(view);
  });

  it("stores an http row: command, args and env NULL; omitted headers are {}", () => {
    const { db, store } = fresh();
    const view = store.create({ ...HTTP, description: "知识库", enabled: false });
    expect(view).toMatchObject({
      type: "http",
      description: "知识库",
      enabled: false,
      command: null,
      args: null,
      envKeys: null,
      url: "https://wiki.example/mcp",
      headerKeys: [],
    });
    expect(rawOne(db, "wiki")).toMatchObject({
      command: null,
      args: null,
      env: null,
      url: "https://wiki.example/mcp",
      headers: "{}",
      enabled: 0,
    });
  });

  it("stores env and headers with keys sorted; the view lists the key names sorted", () => {
    const { db, store } = fresh();
    const s = store.create({ ...STDIO, env: { Z: SECRET, A: SECRET_2 } });
    const h = store.create({ ...HTTP, headers: { "x-b": SECRET, Authorization: SECRET_2 } });
    expect(s.envKeys).toEqual(["A", "Z"]);
    expect(h.headerKeys).toEqual(["Authorization", "x-b"]);
    expect(rawOne(db, "gitlab").env).toBe(`{"A":"${SECRET_2}","Z":"${SECRET}"}`);
    expect(rawOne(db, "wiki").headers).toBe(`{"Authorization":"${SECRET_2}","x-b":"${SECRET}"}`);
  });

  it("a duplicate name is conflict and changes nothing", () => {
    const { db, store } = fresh();
    store.create({ ...STDIO, env: { TOKEN: SECRET } });
    const before = rawConnectors(db);
    expect(codeOf(() => store.create({ ...HTTP, name: "gitlab" }), SECRET)).toBe("conflict");
    expect(rawConnectors(db)).toEqual(before);
  });

  it("allows 32 connectors and refuses the 33rd; a duplicate at the cap is still conflict", () => {
    const { db, store } = fresh();
    for (const name of names(32)) store.create({ ...STDIO, name });
    expectRefused(db, () => store.create({ ...STDIO, name: "zzz" }));
    expect(codeOf(() => store.create({ ...STDIO, name: "a" }))).toBe("conflict");
    expect(rawConnectors(db)).toHaveLength(32);
  });

  it("runs within() in the same transaction: a throw rolls the insert back", () => {
    const { db, store } = fresh();
    const seen: unknown[] = [];
    expect(() =>
      store.create(STDIO, (view) => {
        seen.push(view.name, rawConnectors(db).length);
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(seen).toEqual(["gitlab", 1]);
    expect(rawConnectors(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});

describe("list and get", () => {
  it("lists every row by name; get of an unknown name is undefined", () => {
    const { store } = fresh();
    store.create({ ...STDIO, name: "zeta" });
    store.create({ ...HTTP, name: "alpha", enabled: false });
    store.create({ ...STDIO, name: "mid" });
    expect(store.list().map((view) => view.name)).toEqual(["alpha", "mid", "zeta"]);
    expect(store.get("nope")).toBeUndefined();
  });
});

describe("update (PUT whole replacement)", () => {
  const T1 = T0 + 5000;
  const seeded = () => {
    const ctx = fresh();
    ctx.store.create({
      ...STDIO,
      description: "代码库",
      args: ["--stdio"],
      env: { TOKEN: SECRET, B: SECRET_2 },
    });
    ctx.store.create({ ...HTTP, headers: { authorization: SECRET, "x-b": SECRET_2 } });
    vi.setSystemTime(T1);
    return ctx;
  };

  it("an unknown name is undefined and writes nothing, even with an invalid body", () => {
    const { db, store } = seeded();
    const before = rawConnectors(db);
    expect(store.update("nope", { command: "/bin/x" })).toBeUndefined();
    expect(store.update("nope", { command: "node" })).toBeUndefined();
    expect(rawConnectors(db)).toEqual(before);
  });

  it("omitted keys take the POST defaults: env empty, args [], description '', enabled true", () => {
    const { db, store } = seeded();
    db.prepare("UPDATE connectors SET enabled = 0 WHERE name = 'gitlab'").run();
    const view = store.update("gitlab", { command: "/usr/bin/gitlab-mcp" });
    expect(view).toMatchObject({ description: "", args: [], envKeys: [], enabled: true });
    expect(rawOne(db, "gitlab")).toMatchObject({
      args: "[]",
      env: "{}",
      enabled: 1,
      created_at: T0,
      updated_at: T1,
    });
    store.update("wiki", { url: HTTP.url });
    expect(rawOne(db, "wiki").headers).toBe("{}");
  });

  it("a null value keeps that key's stored value; new keys are taken as given", () => {
    const { db, store } = seeded();
    const view = store.update("gitlab", {
      command: STDIO.command,
      env: { TOKEN: null, EXTRA: "1" },
    });
    expect(view?.envKeys).toEqual(["EXTRA", "TOKEN"]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(rawOne(db, "gitlab").env).toBe(`{"EXTRA":"1","TOKEN":"${SECRET}"}`);
    store.update("wiki", { url: HTTP.url, headers: { "x-b": null } });
    expect(rawOne(db, "wiki").headers).toBe(`{"x-b":"${SECRET_2}"}`);
  });

  it("a null for a key with no stored value is 400 and keeps the row", () => {
    const { db, store } = seeded();
    expectRefused(db, () =>
      store.update("gitlab", { command: STDIO.command, env: { NOPE: null } }),
    );
    expectRefused(db, () => store.update("wiki", { url: HTTP.url, headers: { nope: null } }));
  });

  it("name and type are not in the PUT body; the stored type decides the shape", () => {
    const { db, store } = seeded();
    expectRefused(db, () => store.update("gitlab", { name: "gitlab", command: STDIO.command }));
    expectRefused(db, () => store.update("gitlab", { type: "stdio", command: STDIO.command }));
    expectRefused(db, () => store.update("gitlab", { url: HTTP.url }));
    expectRefused(db, () => store.update("wiki", { command: STDIO.command }));
    expectRefused(db, () => store.update("wiki", { url: HTTP.url, env: {} }));
  });

  it("applies every value rule and echoes nothing", () => {
    const { db, store } = seeded();
    const base = { command: STDIO.command };
    expectRefused(db, () => store.update("gitlab", { ...base, env: { X: "HOME" } }));
    expectRefused(db, () => store.update("gitlab", { ...base, env: { T: `!${SECRET}` } }), SECRET);
    expectRefused(db, () => store.update("gitlab", { ...base, args: [interp("HOME")] }));
    expectRefused(db, () => store.update("gitlab", { command: "node" }));
    expectRefused(
      db,
      () => store.update("wiki", { url: HTTP.url, headers: { authorization: "HOME" } }),
      "HOME",
    );
  });

  it("only description / enabled changed (same command and args, every env key null): probe kept", () => {
    const { db, store } = seeded();
    setProbe(db, "gitlab");
    const same = { command: STDIO.command, args: ["--stdio"], env: { TOKEN: null, B: null } };
    const view = store.update("gitlab", { ...same, description: "新描述", enabled: false });
    expect(view?.probe).toEqual({ status: "ok", at: 1234, message: null });
    expect(probeOf(db, "gitlab")).toEqual(["ok", 1234, null]);
    store.update("gitlab", { ...same, description: "代码库", enabled: true });
    expect(probeOf(db, "gitlab")).toEqual(["ok", 1234, null]);
  });

  it("env given in another key order, with the same values: probe kept", () => {
    const { db, store } = seeded();
    setProbe(db, "gitlab");
    store.update("gitlab", {
      command: STDIO.command,
      args: ["--stdio"],
      env: { TOKEN: SECRET, B: SECRET_2 },
    });
    expect(probeOf(db, "gitlab")).toEqual(["ok", 1234, null]);
    setProbe(db, "wiki");
    store.update("wiki", { url: HTTP.url, headers: { "x-b": null, authorization: SECRET } });
    expect(probeOf(db, "wiki")).toEqual(["ok", 1234, null]);
  });

  it("any change to command, args, env, url or headers resets the three probe columns", () => {
    const { db, store } = seeded();
    const same = { command: STDIO.command, args: ["--stdio"], env: { TOKEN: null, B: null } };
    const stdioChanges = [
      { ...same, args: ["--verbose"] },
      { ...same, command: "/opt/gitlab-mcp" },
      { ...same, env: { TOKEN: "other", B: null } },
      { ...same, env: { TOKEN: null } },
      { ...same, env: { TOKEN: null, B: null, C: "1" } },
    ];
    for (const body of stdioChanges) {
      setProbe(db, "gitlab");
      const view = store.update("gitlab", body);
      expect(view?.probe).toEqual({ status: "never", at: null, message: null });
      expect(probeOf(db, "gitlab")).toEqual(["never", null, null]);
      store.update("gitlab", { ...same, env: { TOKEN: SECRET, B: SECRET_2 } });
    }
    const headers = { authorization: null, "x-b": null };
    for (const body of [
      { url: "https://wiki.example/mcp2", headers },
      { url: HTTP.url, headers: { authorization: null } },
      { url: HTTP.url, headers: { ...headers, authorization: "Bearer x" } },
    ]) {
      setProbe(db, "wiki");
      store.update("wiki", body);
      expect(probeOf(db, "wiki")).toEqual(["never", null, null]);
      store.update("wiki", { url: HTTP.url, headers: { authorization: SECRET, "x-b": SECRET_2 } });
    }
  });

  it("runs within() in the same transaction: a throw rolls the update back", () => {
    const { db, store } = seeded();
    const before = rawConnectors(db);
    expect(() =>
      store.update("gitlab", { command: "/opt/x" }, (view) => {
        expect(view.command).toBe("/opt/x");
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawConnectors(db)).toEqual(before);
  });
});

describe("remove", () => {
  it("deletes the row and returns its last view; disabled lists naming it are kept", () => {
    const { db, store } = fresh();
    const created = store.create({ ...STDIO, env: { TOKEN: SECRET } });
    store.create(HTTP);
    saveAccountDisabledConnectors(db, "u1", ["gitlab"]);
    expect(store.remove("gitlab")).toEqual(created);
    expect(rawConnectors(db).map((row) => row.name)).toEqual(["wiki"]);
    expect(readAccountDisabledConnectors(db, "u1")).toEqual(["gitlab"]);
  });

  it("an unknown name is undefined and deletes nothing", () => {
    const { db, store } = fresh();
    store.create(STDIO);
    const before = rawConnectors(db);
    expect(store.remove("nope")).toBeUndefined();
    expect(rawConnectors(db)).toEqual(before);
  });

  it("runs within() in the same transaction: a throw keeps the row", () => {
    const { db, store } = fresh();
    store.create(STDIO);
    const before = rawConnectors(db);
    expect(() =>
      store.remove("gitlab", () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawConnectors(db)).toEqual(before);
  });
});

describe("connector-name lists and account defaults", () => {
  it("normalizeConnectorNames dedupes and sorts; counts the raw items; needs no registration", () => {
    expect(normalizeConnectorNames(["jira", "git", "git"])).toEqual(["git", "jira"]);
    expect(normalizeConnectorNames([])).toEqual([]);
    expect(normalizeConnectorNames(Array(32).fill("git"))).toEqual(["git"]);
    for (const value of [
      ["Git"],
      ["git2"],
      ["git_lab"],
      [""],
      [1],
      Array(33).fill("git"),
      names(33),
      "git",
      null,
    ]) {
      expect(codeOf(() => normalizeConnectorNames(value))).toBe("bad_request");
    }
  });

  it("read [] without a row; a save stores the normalized list and replaces it whole", () => {
    const { db } = fresh();
    expect(readAccountDisabledConnectors(db, "u1")).toEqual([]);
    expect(saveAccountDisabledConnectors(db, "u1", ["jira", "git", "git"])).toEqual([
      "git",
      "jira",
    ]);
    expect(readAccountDisabledConnectors(db, "u1")).toEqual(["git", "jira"]);
    vi.setSystemTime(T0 + 1);
    expect(saveAccountDisabledConnectors(db, "u1", ["wiki"])).toEqual(["wiki"]);
    expect(saveAccountDisabledConnectors(db, "u2", [])).toEqual([]);
    expect(rawPrefs(db)).toEqual([
      { account_id: "u1", disabled_connectors: '["wiki"]', updated_at: T0 + 1 },
      { account_id: "u2", disabled_connectors: "[]", updated_at: T0 + 1 },
    ]);
  });

  it("a refused list is the fixed 400 and leaves the row as it was", () => {
    const { db } = fresh();
    saveAccountDisabledConnectors(db, "u1", ["git"]);
    expectRefused(db, () => saveAccountDisabledConnectors(db, "u1", ["Git"]), "Git");
    expectRefused(db, () => saveAccountDisabledConnectors(db, "u1", names(33)));
    expectRefused(db, () => saveAccountDisabledConnectors(db, "u1", Array(33).fill("git")));
    expect(readAccountDisabledConnectors(db, "u1")).toEqual(["git"]);
    expect(FIXED).toBe("请求格式不正确");
  });
});
