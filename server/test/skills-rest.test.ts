/**
 * s1d-experts-skills group 4 (task 4.2): `GET /api/skills` and `PUT /api/skills/defaults` on the whole
 * createApp mount (skill-switches「技能清单与账号缺省」endpoint part and its「缺省停用」scenario up to
 * session creation; http-service-skeleton「专家、技能与会话能力的归属路由」skills part). Two members:
 * zhangsan (u1) and zhaoliu (u2). The platform skills are real `SKILL.md` files under
 * `ompAgentDir(stateDir)/skills`: `deploy` and `weekly-report`, plus `a,b` and a 129-byte name that the
 * host lists in `GET /api/commands` but that break the skill-name rule. A project skill `proj-only`
 * lives in zhangsan's owner root. Expected values are spec literals and the `account_skill_prefs` rows.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { ompAgentDir } from "../src/sessions/omp/process.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const LIST = "/api/skills";
const DEFAULTS = "/api/skills/defaults";
const UNAUTHORIZED = { error: { code: "unauthorized", message: "请先登录" } };
const BAD_REQUEST = { error: { code: "bad_request", message: "请求格式不正确" } };
const KIB64 = 64 * 1024;
const COMMA_NAME = "a,b";
const LONG_NAME = "x".repeat(129);
const DEPLOY = { name: "deploy", description: "部署到预发环境" };
const WEEKLY = { name: "weekly-report", description: "生成本周周报" };

interface RawBody {
  raw: string;
  type: string;
}
const MALFORMED: RawBody = { raw: '{"disabledSkills": ', type: "application/json" };
const EMPTY: RawBody = { raw: "", type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };

/** A valid body that only differs in size: `fields` padded with JSON whitespace. */
function padded(totalBytes: number, fields: object = { disabledSkills: ["deploy"] }): RawBody {
  const json = JSON.stringify(fields);
  const pad = totalBytes - Buffer.byteLength(json);
  return { raw: `${json.slice(0, -1)}${" ".repeat(pad)}}`, type: "application/json" };
}
const OVER_64K = padded(KIB64 + 1);
const UNDER_64K = padded(KIB64 - 512);

type Who = "zhangsan" | "zhaoliu" | "anonymous";

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  cookies: Record<Exclude<Who, "anonymous">, string>;
}

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

function writeSkill(skillsDir: string, entry: string, description: string): void {
  mkdirSync(join(skillsDir, entry), { recursive: true });
  writeFileSync(
    join(skillsDir, entry, "SKILL.md"),
    `---\ndescription: ${description}\n---\n正文\n`,
  );
}

async function openWorld(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-rest-")));
  const stateDir = join(root, "state");
  const sandboxRoot = join(root, "sandbox");
  const platform = join(ompAgentDir(stateDir), "skills");
  writeSkill(platform, DEPLOY.name, DEPLOY.description);
  writeSkill(platform, WEEKLY.name, WEEKLY.description);
  writeSkill(platform, COMMA_NAME, "名称带逗号");
  writeSkill(platform, LONG_NAME, "名称过长");
  writeSkill(join(sandboxRoot, "u1", ".omp", "skills"), "proj-only", "只在项目里");
  const db = openDb(":memory:");
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: { bin: join(root, "omp"), sandboxRoot, stateDir, modelId: "m1", idleMs: 600_000 },
      onError: () => {},
    },
  });
  opened.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const cookies = {
    zhangsan: await cookieFor(app, "zhangsan"),
    zhaoliu: await cookieFor(app, "zhaoliu"),
  };
  return { app, db, cookies };
}

function call(
  world: World,
  who: Who,
  method: "GET" | "PUT",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = who === "anonymous" ? {} : { cookie: world.cookies[who] };
  if (body === undefined) {
    return world.app.inject({ method, url, headers });
  }
  const raw = isRaw(body) ? body : { raw: JSON.stringify(body), type: "application/json" };
  return world.app.inject({
    method,
    url,
    headers: { ...headers, "content-type": raw.type },
    payload: raw.raw,
  });
}

function isRaw(body: unknown): body is RawBody {
  return typeof body === "object" && body !== null && "raw" in body && "type" in body;
}

/** Status, exact JSON body and `Cache-Control: no-store` in one go. */
function expectAnswer(response: LightMyRequestResponse, status: number, body?: unknown): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  if (body !== undefined) {
    expect(response.json()).toEqual(body);
  }
}

function putDefaults(world: World, who: Who, body: unknown): Promise<LightMyRequestResponse> {
  return call(world, who, "PUT", DEFAULTS, body);
}

/** Every `account_skill_prefs` row as `[account_id, disabled_skills]`. */
function prefRows(db: DatabaseSync): Array<[string, string]> {
  return db
    .prepare("SELECT account_id, disabled_skills FROM account_skill_prefs ORDER BY account_id")
    .all()
    .map((row) => [String(row.account_id), String(row.disabled_skills)]);
}

function auditCount(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get()?.count);
}

/** The PUT answer, then a GET that must answer the same body, then the row it must match. */
async function putAndCompare(world: World, disabledSkills: unknown[], expected: unknown) {
  const put = await putDefaults(world, "zhangsan", { disabledSkills });
  expectAnswer(put, 200, expected);
  expectAnswer(await call(world, "zhangsan", "GET", LIST), 200, put.json());
  const stored = (expected as { disabledSkills: string[] }).disabledSkills;
  expect(prefRows(world.db)).toEqual([["u1", JSON.stringify(stored)]]);
}

describe("GET /api/skills", () => {
  it("is 401 no-store for an anonymous caller", async () => {
    const world = await openWorld();
    expectAnswer(await call(world, "anonymous", "GET", LIST), 401, UNAUTHORIZED);
  });

  it("lists the platform skills in /api/commands order, without names that break the skill-name rule, and [] with no pref row", async () => {
    const world = await openWorld();
    const commands = await call(world, "zhangsan", "GET", "/api/commands");
    expect(commands.statusCode).toBe(200);
    const listed = (commands.json() as { commands: Array<{ label: string; source: string }> })
      .commands;
    // The host reads all four platform skills and the project skill: the filter is this route's.
    expect(listed.filter((entry) => entry.source === "skill").map((entry) => entry.label)).toEqual([
      COMMA_NAME,
      DEPLOY.name,
      WEEKLY.name,
      LONG_NAME,
    ]);
    expect(
      listed.filter((entry) => entry.source === "project").map((entry) => entry.label),
    ).toEqual(["proj-only"]);

    expectAnswer(await call(world, "zhangsan", "GET", LIST), 200, {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: [],
    });
    expect(prefRows(world.db)).toEqual([]);
  });
});

describe("PUT /api/skills/defaults", () => {
  it("is 401 no-store for an anonymous caller with a malformed body, and writes nothing", async () => {
    const world = await openWorld();
    expectAnswer(await putDefaults(world, "anonymous", MALFORMED), 401, UNAUTHORIZED);
    expect(prefRows(world.db)).toEqual([]);
  });

  it("缺省停用: the answer equals the next GET and the row; a later [] replaces it whole", async () => {
    const world = await openWorld();
    await putAndCompare(world, ["weekly-report", "ghost"], {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: false },
      ],
      disabledSkills: ["ghost", "weekly-report"],
    });
    await putAndCompare(world, [], {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: [],
    });
  });

  it("keeps names outside the list (not installed, project-only) in disabledSkills and out of skills", async () => {
    const world = await openWorld();
    await putAndCompare(world, ["proj-only", "ghost", "deploy"], {
      skills: [
        { ...DEPLOY, enabledByDefault: false },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: ["deploy", "ghost", "proj-only"],
    });
  });

  it("replaces the list whole", async () => {
    const world = await openWorld();
    await putAndCompare(world, ["deploy", "ghost"], {
      skills: [
        { ...DEPLOY, enabledByDefault: false },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: ["deploy", "ghost"],
    });
    await putAndCompare(world, ["weekly-report"], {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: false },
      ],
      disabledSkills: ["weekly-report"],
    });
  });

  it("caps the raw item count at 128: 129 with duplicates is 400, 128 with duplicates is 200 deduplicated and sorted", async () => {
    const world = await openWorld();
    const distinct = Array.from(
      { length: 126 },
      (_, index) => `n${String(index).padStart(3, "0")}`,
    );
    const raw128 = [...distinct].reverse().concat(["n000", "n001"]);
    expect(raw128).toHaveLength(128);
    const raw129 = raw128.concat(["n002"]);

    expectAnswer(
      await putDefaults(world, "zhangsan", { disabledSkills: raw129 }),
      400,
      BAD_REQUEST,
    );
    expect(prefRows(world.db)).toEqual([]);

    await putAndCompare(world, raw128, {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: distinct,
    });
  });

  it.each([
    ["an empty name", ""],
    ["a name with a comma", COMMA_NAME],
    ["a name over 128 UTF-8 bytes", `${"é".repeat(64)}x`],
    ["a name with U+0001", "a\u0001b"],
    ["a name with U+007F", "a\u007fb"],
    ["a number", 1],
    ["null", null],
  ])("is 400 no-store for %s and leaves the stored list alone", async (_label, name) => {
    const world = await openWorld();
    await putDefaults(world, "zhangsan", { disabledSkills: ["deploy"] });
    const before = prefRows(world.db);
    expectAnswer(
      await putDefaults(world, "zhangsan", { disabledSkills: ["ghost", name] }),
      400,
      BAD_REQUEST,
    );
    expect(prefRows(world.db)).toEqual(before);
  });

  it("accepts a name of exactly 128 UTF-8 bytes that is not installed", async () => {
    const world = await openWorld();
    const name = "é".repeat(64);
    await putAndCompare(world, [name], {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: [name],
    });
  });

  it.each([
    ["{}", {}],
    ["an extra key", { disabledSkills: [], extra: 1 }],
    ["a different key", { skills: [] }],
    ["an array body", ["deploy"]],
    ["a string list", { disabledSkills: "deploy" }],
    ["a null list", { disabledSkills: null }],
  ])(
    "is 400 no-store for %s (strict key set) and leaves the stored list alone",
    async (_label, body) => {
      const world = await openWorld();
      await putDefaults(world, "zhangsan", { disabledSkills: ["deploy"] });
      const before = prefRows(world.db);
      expectAnswer(await putDefaults(world, "zhangsan", body), 400, BAD_REQUEST);
      expect(prefRows(world.db)).toEqual(before);
    },
  );

  it.each([
    ["malformed JSON", MALFORMED],
    ["an empty JSON body", EMPTY],
    ["text/plain", TEXT],
    ["a body over 64 KiB", OVER_64K],
  ])(
    "content-parser: %s is exact 400 bad_request, no-store, no pref write or audit row",
    async (_label, body) => {
      const world = await openWorld();
      const audits = auditCount(world.db);
      expectAnswer(await putDefaults(world, "zhangsan", body), 400, BAD_REQUEST);
      expect(prefRows(world.db)).toEqual([]);
      expect(auditCount(world.db)).toBe(audits);
    },
  );

  it("takes a valid body just under 64 KiB", async () => {
    const world = await openWorld();
    expectAnswer(await putDefaults(world, "zhangsan", UNDER_64K), 200);
    expect(prefRows(world.db)).toEqual([["u1", '["deploy"]']]);
  });

  it("keeps each account's defaults to itself", async () => {
    const world = await openWorld();
    await putAndCompare(world, ["deploy", "weekly-report"], {
      skills: [
        { ...DEPLOY, enabledByDefault: false },
        { ...WEEKLY, enabledByDefault: false },
      ],
      disabledSkills: ["deploy", "weekly-report"],
    });
    expectAnswer(await call(world, "zhaoliu", "GET", LIST), 200, {
      skills: [
        { ...DEPLOY, enabledByDefault: true },
        { ...WEEKLY, enabledByDefault: true },
      ],
      disabledSkills: [],
    });
    expect(prefRows(world.db)).toEqual([["u1", '["deploy","weekly-report"]']]);
  });

  it("writes no audit row", async () => {
    const world = await openWorld();
    const before = auditCount(world.db);
    expectAnswer(await putDefaults(world, "zhangsan", { disabledSkills: ["deploy"] }), 200);
    expectAnswer(await putDefaults(world, "zhangsan", { disabledSkills: [] }), 200);
    expectAnswer(await putDefaults(world, "zhangsan", { disabledSkills: [COMMA_NAME] }), 400);
    expect(auditCount(world.db)).toBe(before);
  });
});
