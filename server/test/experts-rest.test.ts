/**
 * s1d-experts-skills group 3 (task 3.2): `/api/experts` on the whole createApp mount (experts「专家管理端点」
 * 「专家校验与可见性」endpoint scenarios; http-service-skeleton「专家、技能与会话能力的归属路由」expert part).
 * Two members: zhangsan (u1) and zhaoliu (u2). Expected values are spec literals (envelopes, the eight
 * view keys, the four built-in ids, audit kinds and detail) and the database itself (`experts` rows,
 * `audit_events` rows, the session capability columns through group 2's `readSessionCapabilities`).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import {
  readSessionCapabilities,
  writeSessionCapabilities,
} from "../src/sessions/store-capabilities.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

const UNAUTHORIZED = { error: { code: "unauthorized", message: "请先登录" } };
const BAD_REQUEST = { error: { code: "bad_request", message: "请求格式不正确" } };
const FORBIDDEN = { error: { code: "forbidden", message: "没有权限执行此操作" } };
const NOT_FOUND = { error: { code: "not_found", message: "请求的资源不存在" } };
const GENERIC_500 = { error: { message: "服务器内部错误" } };
const BUILTIN_IDS = [
  "builtin:frontend-architect",
  "builtin:data-analyst",
  "builtin:brand-designer",
  "builtin:test-engineer",
];
const VIEW_KEYS = ["builtin", "category", "description", "id", "name", "prompt", "skills", "tags"];
const HEX32 = /^[0-9a-f]{32}$/;
const SENTINEL = "PROMPT-ONLY-SENTINEL-4471";
const VALID = { name: "周报助手", category: "办公", prompt: "你是周报助手。" } as const;
const KIB64 = 64 * 1024;

interface RawBody {
  raw: string;
  type: string;
}
const MALFORMED: RawBody = { raw: '{"name": ', type: "application/json" };
const EMPTY: RawBody = { raw: "", type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };

/** A body that is valid in every field and only differs in size: `VALID` padded with JSON whitespace. */
function padded(totalBytes: number, fields: object = VALID): RawBody {
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

async function openWorld(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "experts-rest-")));
  const db = openDb(":memory:");
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: {
        bin: join(root, "omp"),
        sandboxRoot: join(root, "sandbox"),
        stateDir: join(root, "state"),
        modelId: "m1",
        idleMs: 600_000,
      },
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
  method: "GET" | "POST" | "PUT" | "DELETE",
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

function at(id: string): string {
  return `/api/experts?id=${encodeURIComponent(id)}`;
}

async function create(world: World, who: Who, body: object = VALID): Promise<string> {
  const response = await call(world, who, "POST", "/api/experts", body);
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function expertRows(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT * FROM experts ORDER BY created_at, id")
    .all()
    .map((row) => ({ ...row }));
}

function expertAudits(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM audit_events WHERE kind LIKE 'expert.%' ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
}

/** What a refused request must not move: the expert rows and the `expert.*` audit rows. */
function footprint(world: World) {
  return { rows: expertRows(world.db), audits: expertAudits(world.db) };
}

async function listIds(world: World, who: Who): Promise<string[]> {
  const response = await call(world, who, "GET", "/api/experts");
  expectAnswer(response, 200);
  return (response.json() as { experts: Array<{ id: string }> }).experts.map(({ id }) => id);
}

async function createSession(world: World, who: Exclude<Who, "anonymous">): Promise<string> {
  const response = await call(world, who, "POST", "/api/sessions");
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

describe("判定次序：401 → id 400 → 内置 403 → 不可见 404 → body 400，前四者先于 body 解析", () => {
  it("anonymous requests are 401 on all four methods, whatever the body or id", async () => {
    const world = await openWorld();
    const own = await create(world, "zhangsan");
    const before = footprint(world);
    const cases: Array<[method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown]> = [
      ["GET", "/api/experts"],
      ["POST", "/api/experts", VALID],
      ["POST", "/api/experts", MALFORMED],
      ["POST", "/api/experts", OVER_64K],
      ["PUT", at(own), VALID],
      ["PUT", at(own), MALFORMED],
      ["PUT", at(own), OVER_64K],
      ["DELETE", at(own)],
      ["DELETE", at(own), MALFORMED],
      // Adjacent conditions: no id and a malformed body, a built-in id → still 401.
      ["PUT", "/api/experts", MALFORMED],
      ["PUT", at("builtin:data-analyst"), MALFORMED],
      ["DELETE", "/api/experts?id=a&id=b", MALFORMED],
    ];
    for (const [method, url, body] of cases) {
      expectAnswer(await call(world, "anonymous", method, url, body), 401, UNAUTHORIZED);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("PUT / DELETE with a missing, empty or repeated id are 400 before the body is parsed", async () => {
    const world = await openWorld();
    const own = await create(world, "zhangsan");
    const before = footprint(world);
    const urls = [
      "/api/experts",
      "/api/experts?id=",
      `/api/experts?id=${own}&id=${own}`,
      // Adjacent condition: a built-in id among repeated ids is the id 400, not the 403.
      "/api/experts?id=builtin:data-analyst&id=x",
    ];
    for (const url of urls) {
      for (const body of [VALID, MALFORMED, OVER_64K]) {
        expectAnswer(await call(world, "zhangsan", "PUT", url, body), 400, BAD_REQUEST);
        expectAnswer(await call(world, "zhangsan", "DELETE", url, body), 400, BAD_REQUEST);
      }
      expectAnswer(await call(world, "zhangsan", "DELETE", url), 400, BAD_REQUEST);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("built-in experts are read-only: PUT / DELETE 403 forbidden with any body, no audit", async () => {
    const world = await openWorld();
    const before = footprint(world);
    for (const id of BUILTIN_IDS) {
      for (const body of [VALID, MALFORMED, TEXT, OVER_64K]) {
        expectAnswer(await call(world, "zhangsan", "PUT", at(id), body), 403, FORBIDDEN);
        expectAnswer(await call(world, "zhaoliu", "DELETE", at(id), body), 403, FORBIDDEN);
      }
      expectAnswer(await call(world, "zhangsan", "DELETE", at(id)), 403, FORBIDDEN);
    }
    expect(footprint(world)).toEqual(before);
    expect((await listIds(world, "zhangsan")).slice(0, 4)).toEqual(BUILTIN_IDS);
  });

  it("another account's expert, an unknown id and an unknown builtin: id are all 404 before the body", async () => {
    const world = await openWorld();
    const foreign = await create(world, "zhangsan", { ...VALID, name: "甲的专家" });
    const before = footprint(world);
    // `builtin:nope` has the prefix but is not one of the four: 404, not 403.
    for (const id of [foreign, "f".repeat(32), "builtin:nope"]) {
      for (const body of [VALID, MALFORMED, TEXT, OVER_64K]) {
        expectAnswer(await call(world, "zhaoliu", "PUT", at(id), body), 404, NOT_FOUND);
        expectAnswer(await call(world, "zhaoliu", "DELETE", at(id), body), 404, NOT_FOUND);
      }
      expectAnswer(await call(world, "zhaoliu", "DELETE", at(id)), 404, NOT_FOUND);
    }
    expect(footprint(world)).toEqual(before);
    expect(await listIds(world, "zhaoliu")).toEqual(BUILTIN_IDS);
    expect(await listIds(world, "zhangsan")).toEqual([...BUILTIN_IDS, foreign]);
  });

  it("POST and PUT on an own expert: the four parser failures are exact 400 with no write", async () => {
    const world = await openWorld();
    const own = await create(world, "zhangsan");
    const before = footprint(world);
    for (const body of [MALFORMED, EMPTY, TEXT, OVER_64K]) {
      expectAnswer(await call(world, "zhangsan", "POST", "/api/experts", body), 400, BAD_REQUEST);
      expectAnswer(await call(world, "zhangsan", "PUT", at(own), body), 400, BAD_REQUEST);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("the key set is strict and the body must be an object: 400 with no write", async () => {
    const world = await openWorld();
    const own = await create(world, "zhangsan");
    const before = footprint(world);
    const bodies: unknown[] = [
      { ...VALID, extra: 1 },
      { ...VALID, id: own },
      { ...VALID, builtin: false },
      [VALID],
      "text",
      null,
      { name: VALID.name, category: VALID.category },
    ];
    for (const body of bodies) {
      expectAnswer(await call(world, "zhangsan", "POST", "/api/experts", body), 400, BAD_REQUEST);
      expectAnswer(await call(world, "zhangsan", "PUT", at(own), body), 400, BAD_REQUEST);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("字段边界: each refused field is 400 and the table does not change; the 51st expert is 400", async () => {
    const world = await openWorld();
    const own = await create(world, "zhangsan");
    const before = footprint(world);
    const refused = [
      { ...VALID, name: "名".repeat(33) },
      { ...VALID, category: "运维" },
      { ...VALID, tags: ["a", "b", "c", "d", "e", "f"] },
      { ...VALID, prompt: " \n\t " },
      { ...VALID, prompt: "测".repeat(8001) },
      { ...VALID, skills: ["a,b"] },
    ];
    for (const body of refused) {
      expectAnswer(await call(world, "zhangsan", "POST", "/api/experts", body), 400, BAD_REQUEST);
      expectAnswer(await call(world, "zhangsan", "PUT", at(own), body), 400, BAD_REQUEST);
    }
    expect(footprint(world)).toEqual(before);
    for (let index = 2; index <= 50; index += 1) {
      await create(world, "zhangsan", { ...VALID, name: `专家${String(index)}` });
    }
    const full = footprint(world);
    expect(full.rows).toHaveLength(50);
    expectAnswer(await call(world, "zhangsan", "POST", "/api/experts", VALID), 400, BAD_REQUEST);
    expect(footprint(world)).toEqual(full);
  });
});

describe("body limit 64 KiB", () => {
  it("an 8000-CJK-code-point prompt (~24 KiB) POSTs 201 and PUTs 200 verbatim", async () => {
    const world = await openWorld();
    const prompt = "测".repeat(8000);
    const body = { ...VALID, prompt };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(16 * 1024);
    const created = await call(world, "zhangsan", "POST", "/api/experts", body);
    expectAnswer(created, 201);
    const { id, prompt: createdPrompt } = created.json() as { id: string; prompt: string };
    expect(createdPrompt).toBe(prompt);
    const updated = await call(world, "zhangsan", "PUT", at(id), body);
    expectAnswer(updated, 200);
    expect((updated.json() as { prompt: string }).prompt).toBe(prompt);
  });

  it("a valid body just under 64 KiB is accepted; the same body just over 64 KiB is 400", async () => {
    const world = await openWorld();
    expectAnswer(await call(world, "zhangsan", "POST", "/api/experts", UNDER_64K), 201);
    const id = (await listIds(world, "zhangsan"))[4] as string;
    expectAnswer(await call(world, "zhangsan", "PUT", at(id), UNDER_64K), 200);
    const before = footprint(world);
    expectAnswer(await call(world, "zhangsan", "POST", "/api/experts", OVER_64K), 400, BAD_REQUEST);
    expectAnswer(await call(world, "zhangsan", "PUT", at(id), OVER_64K), 400, BAD_REQUEST);
    expect(footprint(world)).toEqual(before);
  });
});

describe("自建、修改与删除", () => {
  it("POST 201 returns exactly the eight view keys with the stored, normalised fields", async () => {
    const world = await openWorld();
    const response = await call(world, "zhangsan", "POST", "/api/experts", {
      name: "  周报助手  ",
      description: "写周报",
      category: "办公",
      tags: [" 周报 ", "周报", "效率"],
      prompt: "  你是周报助手。  ",
      skills: ["b", "a", "b"],
    });
    expectAnswer(response, 201);
    const view = response.json() as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    expect(view.id).toMatch(HEX32);
    expect(view).toEqual({
      id: view.id,
      name: "周报助手",
      description: "写周报",
      category: "办公",
      tags: ["周报", "效率"],
      prompt: "你是周报助手。",
      skills: ["a", "b"],
      builtin: false,
    });
  });

  it("GET lists the four built-ins first, then the caller's own in creation order, never another's", async () => {
    const world = await openWorld();
    const first = await create(world, "zhangsan", { ...VALID, name: "一" });
    const theirs = await create(world, "zhaoliu", { ...VALID, name: "乙的" });
    const second = await create(world, "zhangsan", { ...VALID, name: "二" });
    const response = await call(world, "zhangsan", "GET", "/api/experts");
    expectAnswer(response, 200);
    const { experts } = response.json() as { experts: Array<Record<string, unknown>> };
    expect(Object.keys(response.json() as object)).toEqual(["experts"]);
    expect(experts.map(({ id }) => id)).toEqual([...BUILTIN_IDS, first, second]);
    expect(experts.map(({ builtin }) => builtin)).toEqual([true, true, true, true, false, false]);
    for (const expert of experts) {
      expect(Object.keys(expert).sort()).toEqual(VIEW_KEYS);
    }
    expect(await listIds(world, "zhaoliu")).toEqual([...BUILTIN_IDS, theirs]);
  });

  it("PUT is a whole replacement: omitted optional keys go back to their defaults", async () => {
    const world = await openWorld();
    const id = await create(world, "zhangsan", {
      ...VALID,
      description: "d",
      tags: ["a"],
      skills: ["s"],
    });
    const response = await call(world, "zhangsan", "PUT", at(id), {
      name: "新名字",
      category: "开发",
      prompt: "新的提示词",
    });
    expectAnswer(response, 200, {
      id,
      name: "新名字",
      description: "",
      category: "开发",
      tags: [],
      prompt: "新的提示词",
      skills: [],
      builtin: false,
    });
    const listed = await call(world, "zhangsan", "GET", "/api/experts");
    expect((listed.json() as { experts: unknown[] }).experts[4]).toEqual(response.json());
  });

  it("DELETE 204 with no body clears the deleted expert from referencing sessions only", async () => {
    const world = await openWorld();
    const doomed = await create(world, "zhangsan", { ...VALID, name: "要删的" });
    const kept = await create(world, "zhangsan", { ...VALID, name: "留下的" });
    const sessionS = await createSession(world, "zhangsan");
    const sessionT = await createSession(world, "zhangsan");
    writeSessionCapabilities(world.db, sessionS, {
      expertId: doomed,
      disabledSkills: ["k"],
      disabledConnectors: [],
    });
    writeSessionCapabilities(world.db, sessionT, {
      expertId: kept,
      disabledSkills: [],
      disabledConnectors: [],
    });

    const response = await call(world, "zhangsan", "DELETE", at(doomed));
    expectAnswer(response, 204);
    expect(response.body).toBe("");
    expect(readSessionCapabilities(world.db, sessionS)).toEqual({
      expertId: null,
      disabledSkills: ["k"],
      disabledConnectors: [],
    });
    expect(readSessionCapabilities(world.db, sessionT)).toEqual({
      expertId: kept,
      disabledSkills: [],
      disabledConnectors: [],
    });
    expect(await listIds(world, "zhangsan")).toEqual([...BUILTIN_IDS, kept]);
    expectAnswer(await call(world, "zhangsan", "DELETE", at(doomed)), 404, NOT_FOUND);
  });

  it("DELETE with a malformed JSON body stays the generic 500 and deletes nothing", async () => {
    const world = await openWorld();
    const id = await create(world, "zhangsan");
    const before = footprint(world);
    const response = await call(world, "zhangsan", "DELETE", at(id), MALFORMED);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(GENERIC_500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(footprint(world)).toEqual(before);
    expect(await listIds(world, "zhangsan")).toEqual([...BUILTIN_IDS, id]);
  });
});

describe("审计", () => {
  it("create / update / delete each write one row: kind, actor, detail exactly {expertId, name}, no prompt", async () => {
    const world = await openWorld();
    const id = await create(world, "zhangsan", { ...VALID, prompt: `创建 ${SENTINEL}` });
    expectAnswer(
      await call(world, "zhangsan", "PUT", at(id), {
        ...VALID,
        name: "改名",
        prompt: `修改 ${SENTINEL}`,
      }),
      200,
    );
    expectAnswer(await call(world, "zhangsan", "DELETE", at(id)), 204);

    const rows = expertAudits(world.db);
    expect(
      rows.map((row) => ({
        kind: row.kind,
        actorId: row.actor_id,
        detail: JSON.parse(String(row.detail)) as unknown,
        workspaceId: row.workspace_id,
      })),
    ).toEqual([
      {
        kind: "expert.create",
        actorId: "u1",
        detail: { expertId: id, name: VALID.name },
        workspaceId: null,
      },
      {
        kind: "expert.update",
        actorId: "u1",
        detail: { expertId: id, name: "改名" },
        workspaceId: null,
      },
      {
        kind: "expert.delete",
        actorId: "u1",
        detail: { expertId: id, name: "改名" },
        workspaceId: null,
      },
    ]);
    for (const row of rows) {
      // Positive control: the title is a readable string naming the expert, so the scan below is real.
      expect(typeof row.title).toBe("string");
      expect(String(row.title)).toContain(
        String((JSON.parse(String(row.detail)) as { name: string }).name),
      );
      expect(JSON.stringify(row)).not.toContain(SENTINEL);
    }
  });

  it("the audit row is in the write's transaction: an aborting audit insert rolls the write back", async () => {
    const world = await openWorld();
    const id = await create(world, "zhangsan");
    const sessionId = await createSession(world, "zhangsan");
    writeSessionCapabilities(world.db, sessionId, {
      expertId: id,
      disabledSkills: [],
      disabledConnectors: [],
    });
    const before = footprint(world);
    world.db.exec(
      `CREATE TRIGGER audit_abort BEFORE INSERT ON audit_events
       BEGIN SELECT RAISE(ABORT, 'probe audit blocked'); END`,
    );
    try {
      const created = await call(world, "zhangsan", "POST", "/api/experts", {
        ...VALID,
        name: "回滚",
      });
      expect(created.statusCode).toBe(500);
      expect(created.json()).toEqual(GENERIC_500);
      const updated = await call(world, "zhangsan", "PUT", at(id), { ...VALID, name: "回滚" });
      expect(updated.statusCode).toBe(500);
      const deleted = await call(world, "zhangsan", "DELETE", at(id));
      expect(deleted.statusCode).toBe(500);
      expect(deleted.json()).toEqual(GENERIC_500);
    } finally {
      world.db.exec("DROP TRIGGER audit_abort");
    }
    expect(footprint(world)).toEqual(before);
    expect(world.db.isTransaction).toBe(false);
    expect(readSessionCapabilities(world.db, sessionId)?.expertId).toBe(id);
  });
});
