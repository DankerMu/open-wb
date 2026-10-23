/**
 * s1d-experts-skills group 2: migration 047 and the expert / skill / session-capability stores (experts
 * 「迁移 047 专家与能力 schema」「内置专家」「专家校验与可见性」store part; skill-switches「技能清单与账号缺省」
 * account defaults and the skill-name rule; session-metadata's two columns). `:memory:` databases through
 * the real migrations (`openDb`, `PRAGMA foreign_keys = ON`); expected rows, names, tags and descriptions
 * are literals from design D2–D4 and the demo (`resource/workbuddy-live-demo.html` :1593-1596).
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { HTTP_ERROR_MESSAGES, HttpError, type HttpErrorCode } from "../src/core/errors/index.js";
import { BUILTIN_EXPERTS } from "../src/experts/builtin.js";
import { createExpertStore, type Expert } from "../src/experts/store.js";
import {
  readSessionCapabilities,
  writeSessionCapabilities,
} from "../src/sessions/store-capabilities.js";
import {
  normalizeSkillNames,
  readAccountDisabledSkills,
  saveAccountDisabledSkills,
} from "../src/skills/store.js";
import {
  COMPLETE_CATALOG,
  ledgerFilenames,
  MIGRATION_046,
  MIGRATION_047,
  removeTempDirs,
  TRACKED_MIGRATION_FILENAMES,
  tempDir,
  withDatabase,
  withOpenDb,
} from "./core-db-helpers.js";
import { S_A, S_B, S_C, S_D, seedPopulated034, seedThrough } from "./core-db-session-fixture.js";

const T0 = 1_760_000_000_000;
const HEX32 = /^[0-9a-f]{32}$/;
const SENTINEL = "SENTINEL-VALUE-7731";
const CJK = "测";
const EMOJI = "😀";
const CJK_42 = CJK.repeat(42); // 126 UTF-8 bytes
const CJK_43 = CJK.repeat(43); // 129 UTF-8 bytes
const VALID = { name: "周报助手", category: "办公", prompt: "你是周报助手。" } as const;

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
  return { db, store: createExpertStore(db) };
}

const rawExperts = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM experts ORDER BY created_at, id").all();
const rawPrefs = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM account_skill_prefs ORDER BY account_id").all();
const rawCapabilities = (db: DatabaseSync) =>
  db.prepare("SELECT id, expert_id, disabled_skills FROM chat_sessions ORDER BY id").all();
const tableInfo = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
const foreignKeys = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA foreign_key_list('${table}')`)
    .all()
    .map((k) => [k.from, k.table, k.to, k.on_delete]);

/** `[name, unique, origin, partial]` of every index on `table`, by name. */
const indexList = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA index_list('${table}')`)
    .all()
    .map((i) => [i.name, i.unique, i.origin, i.partial])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
/** Every sqlite_master object, internal autoindexes included. */
const catalog = (db: DatabaseSync) =>
  db.prepare("SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name").all();

function insertSession(db: DatabaseSync, id: string, ownerId: string): void {
  db.prepare(
    "INSERT INTO chat_sessions(id, owner_id, status, created_at, updated_at) VALUES (?, ?, 'idle', 1, 2)",
  ).run(id, ownerId);
}

/** The code a store call throws (`none` if it returns); every throw is a fixed-message HttpError. */
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

/** Asserts `action` throws `bad_request` and leaves every table this group owns as it was. */
function expectRefused(db: DatabaseSync, action: () => unknown, ...secrets: string[]): void {
  const before = [rawExperts(db), rawPrefs(db), rawCapabilities(db)];
  expect(codeOf(action, ...secrets)).toBe("bad_request");
  expect([rawExperts(db), rawPrefs(db), rawCapabilities(db)]).toEqual(before);
}

describe("migration 047 schema", () => {
  it("is tracked once, right after 046, with its receipt at position 21", () => {
    const pos = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_047);
    expect(TRACKED_MIGRATION_FILENAMES.filter((name) => name === MIGRATION_047)).toHaveLength(1);
    expect(TRACKED_MIGRATION_FILENAMES[pos - 1]).toBe(MIGRATION_046);
    expect(COMPLETE_CATALOG.receipts[pos]).toEqual([21, MIGRATION_047]);
    expect(COMPLETE_CATALOG.sequenceRows).toEqual([["schema_migrations", 21, "integer"]]);
  });

  it("creates the two D2 tables (TEXT primary keys NOT NULL), the owner index and the two session columns", () => {
    const { db } = fresh();
    expect(tableInfo(db, "experts")).toEqual([
      ["id", "TEXT", 1, null, 1],
      ["owner_id", "TEXT", 1, null, 0],
      ["name", "TEXT", 1, null, 0],
      ["description", "TEXT", 1, null, 0],
      ["category", "TEXT", 1, null, 0],
      ["tags", "TEXT", 1, null, 0],
      ["prompt", "TEXT", 1, null, 0],
      ["skills", "TEXT", 1, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
    ]);
    expect(tableInfo(db, "account_skill_prefs")).toEqual([
      ["account_id", "TEXT", 1, null, 1],
      ["disabled_skills", "TEXT", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
    ]);
    expect(tableInfo(db, "chat_sessions").slice(-2)).toEqual([
      ["expert_id", "TEXT", 0, null, 0],
      ["disabled_skills", "TEXT", 1, "'[]'", 0],
    ]);
    expect(foreignKeys(db, "experts")).toEqual([["owner_id", "accounts", "id", "CASCADE"]]);
    expect(foreignKeys(db, "account_skill_prefs")).toEqual([
      ["account_id", "accounts", "id", "CASCADE"],
    ]);
    expect(
      db
        .prepare("PRAGMA index_info('experts_owner')")
        .all()
        .map((c) => c.name),
    ).toEqual(["owner_id", "created_at"]);
    expect(indexList(db, "experts")).toEqual([
      ["experts_owner", 0, "c", 0],
      ["sqlite_autoindex_experts_1", 1, "pk", 0],
    ]);
    expect(indexList(db, "account_skill_prefs")).toEqual([
      ["sqlite_autoindex_account_skill_prefs_1", 1, "pk", 0],
    ]);
    // expert_id has no foreign key: built-in experts are not rows.
    expect(foreignKeys(db, "chat_sessions").map(([from]) => from)).not.toContain("expert_id");
  });

  it("a populated database ending at 046 gains exactly 047's objects and reads every existing session as no expert and nothing disabled", () => {
    const dir = tempDir();
    const file = join(dir, "populated-046.db");
    const through046 = TRACKED_MIGRATION_FILENAMES.slice(
      0,
      TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_047),
    );
    seedThrough(file, through046, seedPopulated034);
    // Stops at exactly 047 so objects of later migrations never enter the diff.
    const file047 = join(dir, "populated-047.db");
    seedThrough(file047, [...through046, MIGRATION_047], seedPopulated034);
    const before = withDatabase(file, catalog);
    const after = withDatabase(file047, catalog);
    const key = (o: Record<string, unknown>) => `${o.type}/${o.name}`;
    const has = (list: Record<string, unknown>[], o: Record<string, unknown>) =>
      list.some((x) => key(x) === key(o));
    expect(after.filter((o) => !has(before, o))).toEqual([
      { type: "index", name: "experts_owner", tbl_name: "experts" },
      {
        type: "index",
        name: "sqlite_autoindex_account_skill_prefs_1",
        tbl_name: "account_skill_prefs",
      },
      { type: "index", name: "sqlite_autoindex_experts_1", tbl_name: "experts" },
      { type: "table", name: "account_skill_prefs", tbl_name: "account_skill_prefs" },
      { type: "table", name: "experts", tbl_name: "experts" },
    ]);
    expect(before.filter((o) => !has(after, o))).toEqual([]);
    withOpenDb(file, (db) => {
      expect(rawCapabilities(db)).toEqual(
        [S_A, S_B, S_C, S_D].map((id) => ({ id, expert_id: null, disabled_skills: "[]" })),
      );
      expect(readSessionCapabilities(db, S_A)).toEqual({ expertId: null, disabledSkills: [] });
      expect(rawExperts(db)).toEqual([]);
      expect(rawPrefs(db)).toEqual([]);
      expect(ledgerFilenames(db)).toEqual([...through046, MIGRATION_047]);
    });
  });

  const INSERT =
    "INSERT INTO experts(id, owner_id, name, description, category, tags, prompt, skills, created_at, updated_at) VALUES (?, 'u1', 'n', '', ?, '[]', 'p', '[]', 1, 1)";
  it("the category CHECK accepts the four categories and rejects any other", () => {
    const { db } = fresh();
    ["开发", "办公", "设计", "产品"].forEach((category, i) => {
      db.prepare(INSERT).run(`e${i}`, category);
    });
    const before = rawExperts(db);
    expect(() => db.prepare(INSERT).run("e9", "运维")).toThrow(/CHECK constraint failed/);
    expect(rawExperts(db)).toEqual(before);
  });

  it("deleting an account cascades to its experts and its skill defaults only", () => {
    const { db, store } = fresh();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    const mine = store.create("u1", VALID);
    const theirs = store.create("u2", VALID);
    saveAccountDisabledSkills(db, "u1", ["deploy"]);
    saveAccountDisabledSkills(db, "u2", ["lint"]);
    db.prepare("DELETE FROM accounts WHERE id = 'u1'").run();
    expect(rawExperts(db).map((row) => row.id)).toEqual([theirs.id]);
    expect(store.get("u1", mine.id)).toBeUndefined();
    expect(rawPrefs(db)).toEqual([
      { account_id: "u2", disabled_skills: '["lint"]', updated_at: T0 },
    ]);
  });
});

describe("built-in experts", () => {
  const DEMO = [
    {
      id: "builtin:frontend-architect",
      name: "前端架构师",
      category: "开发",
      description: "精通 React/Vue 架构设计、性能优化与工程化体系建设，擅长大型前端项目重构。",
      tags: ["前端", "架构", "性能"],
    },
    {
      id: "builtin:data-analyst",
      name: "数据分析师",
      category: "办公",
      description: "擅长数据清洗、指标体系建设与可视化看板搭建，输出结构化分析报告。",
      tags: ["数据分析", "报表"],
    },
    {
      id: "builtin:brand-designer",
      name: "品牌视觉设计师",
      category: "设计",
      description: "品牌 VI、海报、社交媒体视觉全案设计，支持多风格探索与快速迭代。",
      tags: ["品牌", "海报", "VI"],
    },
    {
      id: "builtin:test-engineer",
      name: "测试工程师",
      category: "开发",
      description: "自动化测试用例设计、接口测试与回归测试方案输出，覆盖主流测试框架。",
      tags: ["测试", "自动化"],
    },
  ];

  it("are exactly the four demo experts, in order, with no skills", () => {
    expect(
      BUILTIN_EXPERTS.map(({ id, name, category, description, tags }) => ({
        id,
        name,
        category,
        description,
        tags,
      })),
    ).toEqual(DEMO);
    for (const expert of BUILTIN_EXPERTS) {
      expect(expert.builtin).toBe(true);
      expect(expert.skills).toEqual([]);
    }
  });

  it("each carries a Chinese system prompt of 300..1500 code points: role, way of working, output", () => {
    for (const { name, prompt } of BUILTIN_EXPERTS) {
      const points = [...prompt].length;
      expect(points).toBeGreaterThanOrEqual(300);
      expect(points).toBeLessThanOrEqual(1500);
      expect(prompt).toBe(prompt.trim());
      expect(prompt.match(/\p{Script=Han}/gu)?.length ?? 0).toBeGreaterThan(points / 2);
      expect(prompt.slice(0, 20)).toContain(name);
      expect(prompt).toContain("工作方式");
      expect(prompt).toContain("输出要求");
    }
  });

  it("are visible to every account ahead of its own experts and are not rows", () => {
    const { db, store } = fresh();
    expect(store.list("u1")).toEqual(BUILTIN_EXPERTS);
    expect(store.get("u2", "builtin:data-analyst")).toEqual(BUILTIN_EXPERTS[1]);
    expect(rawExperts(db)).toEqual([]);
    expect(Object.isFrozen(BUILTIN_EXPERTS[0])).toBe(true);
    expect(Object.isFrozen(BUILTIN_EXPERTS[0]?.tags)).toBe(true);
  });

  it("a built-in id is not writable through the store", () => {
    const { db, store } = fresh();
    expect(store.update("u1", "builtin:data-analyst", VALID)).toBeUndefined();
    expect(store.remove("u1", "builtin:data-analyst")).toBeUndefined();
    expect(rawExperts(db)).toEqual([]);
    expect(store.get("u1", "builtin:data-analyst")).toEqual(BUILTIN_EXPERTS[1]);
  });
});

describe("create", () => {
  it("stores the trimmed fields and the defaults under a server-generated 32-hex id", () => {
    const { db, store } = fresh();
    const expert = store.create("u1", {
      name: "  周报助手 ",
      category: "办公",
      prompt: "\n  你是周报助手。  \n",
    });
    expect(expert).toEqual({
      id: expect.stringMatching(HEX32),
      name: "周报助手",
      description: "",
      category: "办公",
      tags: [],
      prompt: "你是周报助手。",
      skills: [],
      builtin: false,
    } satisfies Expert);
    expect(rawExperts(db)).toEqual([
      {
        id: expert.id,
        owner_id: "u1",
        name: "周报助手",
        description: "",
        category: "办公",
        tags: "[]",
        prompt: "你是周报助手。",
        skills: "[]",
        created_at: T0,
        updated_at: T0,
      },
    ]);
    expect(store.create("u1", VALID).id).not.toBe(expert.id);
  });

  it("dedupes tags in order and skills in dictionary order", () => {
    const { db, store } = fresh();
    const expert = store.create("u1", {
      ...VALID,
      tags: [" 周报 ", "汇总", "周报", "🚀"],
      skills: ["weekly-report", "deploy", "weekly-report"],
    });
    expect(expert.tags).toEqual(["周报", "汇总", "🚀"]);
    expect(expert.skills).toEqual(["deploy", "weekly-report"]);
    expect(rawExperts(db)[0]).toMatchObject({
      tags: '["周报","汇总","🚀"]',
      skills: '["deploy","weekly-report"]',
    });
  });

  it("counts code points, not UTF-16 units, at every length bound", () => {
    const { store } = fresh();
    const expert = store.create("u1", {
      name: EMOJI.repeat(32),
      description: EMOJI.repeat(200),
      category: "设计",
      tags: [EMOJI.repeat(12), "a"],
      prompt: EMOJI.repeat(8000),
    });
    expect(expert.name).toBe(EMOJI.repeat(32));
    expect(expert.description).toBe(EMOJI.repeat(200));
    expect(expert.tags).toEqual([EMOJI.repeat(12), "a"]);
    expect(expert.prompt).toBe(EMOJI.repeat(8000));
  });

  it("keeps an 8000-code-point CJK prompt verbatim, on create and on update", () => {
    const { store } = fresh();
    const prompt = CJK.repeat(8000);
    const created = store.create("u1", { ...VALID, prompt });
    expect(created.prompt).toBe(prompt);
    expect(store.update("u1", created.id, { ...VALID, prompt })?.prompt).toBe(prompt);
    expect(store.get("u1", created.id)?.prompt).toBe(prompt);
  });

  it("accepts skill names of 42 CJK (126 bytes) and 128 ASCII bytes", () => {
    const { store } = fresh();
    expect(store.create("u1", { ...VALID, skills: [CJK_42, "x".repeat(128)] }).skills).toEqual([
      "x".repeat(128),
      CJK_42,
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["name missing", { category: "办公", prompt: "p" }],
    ["name not a string", { ...VALID, name: 7 }],
    ["name blank", { ...VALID, name: "   " }],
    ["name 33 code points", { ...VALID, name: EMOJI.repeat(33) }],
    ["description 201 code points", { ...VALID, description: EMOJI.repeat(201) }],
    ["description null", { ...VALID, description: null }],
    ["category 运维", { ...VALID, category: "运维" }],
    ["category missing", { name: "n", prompt: "p" }],
    ["6 tags", { ...VALID, tags: ["a", "b", "c", "d", "e", "f"] }],
    ["tags not an array", { ...VALID, tags: "a" }],
    ["a blank tag", { ...VALID, tags: ["a", "  "] }],
    ["a tag of 13 code points", { ...VALID, tags: [EMOJI.repeat(13)] }],
    ["a non-string tag", { ...VALID, tags: [1] }],
    ["prompt missing", { name: "n", category: "办公" }],
    ["prompt blank", { ...VALID, prompt: " \n\t " }],
    ["prompt 8001 code points", { ...VALID, prompt: CJK.repeat(8001) }],
    ["33 skills", { ...VALID, skills: Array.from({ length: 33 }, (_, i) => `s${i}`) }],
    ["skills not an array", { ...VALID, skills: "a" }],
    ["a non-string skill", { ...VALID, skills: [null] }],
  ])("refuses %s with a fixed 400 and writes nothing", (_label, body) => {
    const { db, store } = fresh();
    expectRefused(db, () => store.create("u1", body));
  });

  it.each([null, [], "body"])("refuses the non-object body %j", (body) => {
    const { db, store } = fresh();
    expectRefused(db, () => store.create("u1", body));
  });

  it("never echoes the refused value in the message", () => {
    const { db, store } = fresh();
    expectRefused(db, () => store.create("u1", { ...VALID, name: SENTINEL.repeat(3) }), SENTINEL);
    expectRefused(db, () => store.create("u1", { ...VALID, category: SENTINEL }), SENTINEL);
    expectRefused(db, () => store.create("u1", { ...VALID, skills: [`${SENTINEL},x`] }), SENTINEL);
  });

  it("allows 50 experts per account and refuses the 51st; another account is not counted", () => {
    const { db, store } = fresh();
    for (let i = 0; i < 50; i += 1) store.create("u1", { ...VALID, name: `专家 ${i}` });
    expect(rawExperts(db)).toHaveLength(50);
    expectRefused(db, () => store.create("u1", VALID));
    expect(store.create("u2", VALID).builtin).toBe(false);
  });

  it("rolls the insert back when the caller's same-transaction step throws", () => {
    const { db, store } = fresh();
    expect(() =>
      store.create("u1", VALID, () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawExperts(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});

describe("skill-name rule (one rule for expert skills, account defaults and session lists)", () => {
  const writers: Array<[string, (db: DatabaseSync, names: string[]) => unknown]> = [
    [
      "expert skills",
      (db, names) => createExpertStore(db).create("u1", { ...VALID, skills: names }),
    ],
    ["account defaults", (db, names) => saveAccountDisabledSkills(db, "u1", names)],
    [
      "session disabled list",
      (db, names) => writeSessionCapabilities(db, S_A, { expertId: null, disabledSkills: names }),
    ],
  ];
  const BAD: Array<[string, string]> = [
    ["empty", ""],
    ["43 CJK (129 bytes)", CJK_43],
    ["129 ASCII bytes", "x".repeat(129)],
    ["a tab", "a\tb"],
    ["a NUL", "a\u0000b"],
    ["a unit separator", "a\u001fb"],
    ["a DEL", "a\u007fb"],
    ["a comma", "a,b"],
  ];

  it.each(
    writers.flatMap(([writer, write]) =>
      BAD.map(([label, name]) => ({ writer, label, name, write })),
    ),
  )("$writer refuses a name with $label", ({ name, write }) => {
    const { db } = fresh();
    insertSession(db, S_A, "u1");
    expectRefused(db, () => write(db, [name]));
  });

  it("normalizes a valid list: dedupe and dictionary order, names kept byte for byte", () => {
    expect(normalizeSkillNames(["b", 'a: #"x', CJK_42, "b", "B"])).toEqual([
      "B",
      'a: #"x',
      "b",
      CJK_42,
    ]);
    expect(normalizeSkillNames([])).toEqual([]);
    expect(codeOf(() => normalizeSkillNames(["ok", 5]))).toBe("bad_request");
  });
});

describe("visibility", () => {
  it("another account's expert and a missing id are both undefined, and the expert is untouched", () => {
    const { db, store } = fresh();
    const x = store.create("u1", VALID);
    const before = rawExperts(db);
    expect(store.list("u2")).toEqual(BUILTIN_EXPERTS);
    for (const id of [x.id, "f".repeat(32)]) {
      expect(store.get("u2", id)).toBeUndefined();
      expect(store.update("u2", id, { ...VALID, name: "改" })).toBeUndefined();
      expect(store.remove("u2", id)).toBeUndefined();
    }
    expect(rawExperts(db)).toEqual(before);
    expect(store.get("u1", x.id)).toEqual(x);
  });

  it("lists built-ins first, then the account's own by creation time", () => {
    const { store } = fresh();
    const first = store.create("u1", { ...VALID, name: "甲" });
    store.create("u2", { ...VALID, name: "他人" });
    const second = store.create("u1", { ...VALID, name: "乙" });
    vi.setSystemTime(T0 - 5_000); // a clock step back still lists the new expert last
    const third = store.create("u1", { ...VALID, name: "丙" });
    expect(store.list("u1")).toEqual([...BUILTIN_EXPERTS, first, second, third]);
  });
});

describe("update", () => {
  it("replaces every field, keeps created_at and bumps updated_at", () => {
    const { db, store } = fresh();
    const x = store.create("u1", { ...VALID, tags: ["旧"], skills: ["old"] });
    vi.setSystemTime(T0 + 10);
    const updated = store.update("u1", x.id, {
      name: "新名",
      description: "新描述",
      category: "产品",
      prompt: " 新提示词 ",
      tags: ["新"],
    });
    expect(updated).toEqual({
      id: x.id,
      name: "新名",
      description: "新描述",
      category: "产品",
      tags: ["新"],
      prompt: "新提示词",
      skills: [],
      builtin: false,
    } satisfies Expert);
    expect(rawExperts(db)[0]).toMatchObject({ created_at: T0, updated_at: T0 + 10 });
  });

  it("refuses an invalid body with a fixed 400 and keeps the row", () => {
    const { db, store } = fresh();
    const x = store.create("u1", VALID);
    expectRefused(db, () => store.update("u1", x.id, { ...VALID, prompt: "  " }));
    expectRefused(db, () =>
      store.update("u1", x.id, { ...VALID, tags: ["a", "b", "c", "d", "e", "f"] }),
    );
  });

  it("rolls the update back when the caller's same-transaction step throws", () => {
    const { db, store } = fresh();
    const x = store.create("u1", VALID);
    const before = rawExperts(db);
    expect(() =>
      store.update("u1", x.id, { ...VALID, name: "改" }, () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(rawExperts(db)).toEqual(before);
  });
});

describe("remove", () => {
  it("deletes the expert and clears every session reference to it, nothing else", () => {
    const { db, store } = fresh();
    const x = store.create("u1", VALID);
    const y = store.create("u1", VALID);
    insertSession(db, S_A, "u1");
    insertSession(db, S_B, "u1");
    insertSession(db, S_C, "u1");
    writeSessionCapabilities(db, S_A, { expertId: x.id, disabledSkills: ["lint"] });
    writeSessionCapabilities(db, S_B, { expertId: x.id, disabledSkills: [] });
    writeSessionCapabilities(db, S_C, { expertId: y.id, disabledSkills: [] });
    let seen: Expert | undefined;
    expect(store.remove("u1", x.id, (removed) => (seen = removed))).toEqual(x);
    expect(seen).toEqual(x);
    expect(rawExperts(db).map((row) => row.id)).toEqual([y.id]);
    expect(rawCapabilities(db)).toEqual([
      { id: S_A, expert_id: null, disabled_skills: '["lint"]' },
      { id: S_B, expert_id: null, disabled_skills: "[]" },
      { id: S_C, expert_id: y.id, disabled_skills: "[]" },
    ]);
    expect(db.prepare("SELECT updated_at FROM chat_sessions WHERE id = ?").get(S_A)).toEqual({
      updated_at: 2,
    });
  });

  it("clears the references in the same transaction: a failing step keeps row and references", () => {
    const { db, store } = fresh();
    const x = store.create("u1", VALID);
    insertSession(db, S_A, "u1");
    writeSessionCapabilities(db, S_A, { expertId: x.id, disabledSkills: [] });
    const before = [rawExperts(db), rawCapabilities(db)];
    expect(() =>
      store.remove("u1", x.id, () => {
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect([rawExperts(db), rawCapabilities(db)]).toEqual(before);
  });
});

describe("account skill defaults", () => {
  it("read [] without a row; a save stores the deduped sorted list and replaces it whole", () => {
    const { db } = fresh();
    expect(readAccountDisabledSkills(db, "u1")).toEqual([]);
    expect(saveAccountDisabledSkills(db, "u1", ["weekly-report", "ghost", "ghost"])).toEqual([
      "ghost",
      "weekly-report",
    ]);
    expect(readAccountDisabledSkills(db, "u1")).toEqual(["ghost", "weekly-report"]);
    expect(rawPrefs(db)).toEqual([
      { account_id: "u1", disabled_skills: '["ghost","weekly-report"]', updated_at: T0 },
    ]);
    vi.setSystemTime(T0 + 1);
    expect(saveAccountDisabledSkills(db, "u1", [])).toEqual([]);
    expect(rawPrefs(db)).toEqual([{ account_id: "u1", disabled_skills: "[]", updated_at: T0 + 1 }]);
    expect(readAccountDisabledSkills(db, "u2")).toEqual([]);
  });
});

describe("session capability columns", () => {
  it("read the raw expert and list; a write stores the list deduped and sorted", () => {
    const { db } = fresh();
    insertSession(db, S_A, "u1");
    insertSession(db, S_B, "u1");
    expect(readSessionCapabilities(db, S_A)).toEqual({ expertId: null, disabledSkills: [] });
    expect(
      writeSessionCapabilities(db, S_A, {
        expertId: "builtin:data-analyst",
        disabledSkills: ["lint", "deploy", "lint"],
      }),
    ).toEqual({ expertId: "builtin:data-analyst", disabledSkills: ["deploy", "lint"] });
    expect(readSessionCapabilities(db, S_A)).toEqual({
      expertId: "builtin:data-analyst",
      disabledSkills: ["deploy", "lint"],
    });
    expect(rawCapabilities(db)).toEqual([
      { id: S_A, expert_id: "builtin:data-analyst", disabled_skills: '["deploy","lint"]' },
      { id: S_B, expert_id: null, disabled_skills: "[]" },
    ]);
    writeSessionCapabilities(db, S_A, { expertId: null, disabledSkills: [] });
    expect(readSessionCapabilities(db, S_A)).toEqual({ expertId: null, disabledSkills: [] });
  });

  it("a missing session reads undefined and refuses a write", () => {
    const { db } = fresh();
    expect(readSessionCapabilities(db, S_D)).toBeUndefined();
    expect(
      codeOf(() => writeSessionCapabilities(db, S_D, { expertId: null, disabledSkills: [] })),
    ).toBe("not_found");
    expect(rawCapabilities(db)).toEqual([]);
  });
});
