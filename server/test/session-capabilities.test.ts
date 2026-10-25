/**
 * s1d-experts-skills group 5 (task 5.2): session capabilities on the production createApp →
 * registerSessions mount over real fake-omp, driven through `app.inject()` on a real in-memory
 * SQLite. Covers `POST /api/sessions {expertId?, disabledSkills?}` (initial values, 400s before the
 * workspace check), `GET` / `PUT /api/sessions/:id/capabilities` (owner pre-check, 400 matrix,
 * archived 409 vs 200, the union rule, the effective expert), a PUT during an in-flight turn, and
 * the fork copy of the two columns. Members: zhangsan (u1, the owner) and zhaoliu (u2).
 * Expected values are spec literals (session-metadata「创建时的专家与停用技能」, skill-switches
 * 「并集与清空」「拒绝与归档」「缺省停用」, session-metadata「继承专家与停用技能」), the
 * envelopes and the database rows themselves.
 */
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openApprovalWorld, pendingApproval, REAL, spawnedAt } from "./session-approval-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { forkAt, forkWorlds, openForkWorld, seedTwoTurns } from "./session-fork-helpers.js";
import { SESSION_VIEW_KEYS } from "./session-meta-fixtures.js";
import {
  cookieFor,
  SESSION_ARCHIVED_ENVELOPE,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  openBareSession,
  type SupervisorApp,
  waitForTurn,
} from "./session-supervisor-helpers.js";

const JSON_TYPE = "application/json";
const KIB64 = 64 * 1024;
const BUILTIN = "builtin:test-engineer";
const NOPE = "builtin:nope";
/** 64 distinct names, each twice, newest first: 128 raw items that dedupe to 64. */
const NAMES_64 = Array.from({ length: 64 }, (_, i) => `s${String(i).padStart(2, "0")}`);
const RAW_128 = [...NAMES_64, ...NAMES_64].reverse();
const RAW_129 = [...RAW_128, "s00"];

const fixtures: SupervisorApp[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  /** zhangsan (u1), the owner of `session`. */
  cookie: string;
  /** zhaoliu (u2). */
  other: string;
  session: string;
  sandboxRoot: string;
}

interface Capabilities {
  expertId: string | null;
  disabledSkills: string[];
  disabledConnectors: string[];
}

interface Raw {
  payload: string;
  type: string;
}

async function openWorld(): Promise<World> {
  const rt = createRealFakeRuntime();
  const { fixture, cookie, session } = await openBareSession(rt.runtime);
  fixtures.push(fixture);
  const other = await cookieFor(fixture.app, "zhaoliu");
  const { sandboxRoot } = rt.runtime;
  return { app: fixture.app, db: fixture.db, cookie, other, session, sandboxRoot };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A JSON body (`body` serialized), a raw `{payload, type}` body, or none. */
function send(
  app: FastifyInstance,
  method: Method,
  url: string,
  cookie: string | undefined,
  body?: unknown,
  raw?: Raw,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  let payload: string | undefined;
  if (raw !== undefined) {
    headers["content-type"] = raw.type;
    payload = raw.payload;
  } else if (body !== undefined) {
    headers["content-type"] = JSON_TYPE;
    payload = JSON.stringify(body);
  }
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

const capsUrl = (session: string) => `/api/sessions/${session}/capabilities`;

function getCaps(world: World, session: string, cookie = world.cookie, raw?: Raw) {
  return send(world.app, "GET", capsUrl(session), cookie, undefined, raw);
}

function putCaps(world: World, session: string, body: unknown, cookie = world.cookie) {
  return send(world.app, "PUT", capsUrl(session), cookie, body);
}

function expectCaps(response: LightMyRequestResponse, expected: Capabilities): void {
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([200, "no-store"]);
  const body = response.json() as Capabilities;
  expect(Object.keys(body)).toEqual(["expertId", "disabledSkills", "disabledConnectors"]);
  expect(body).toEqual(expected);
}

async function capsOf(world: World, session: string): Promise<Capabilities> {
  const response = await getCaps(world, session);
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([200, "no-store"]);
  return response.json() as Capabilities;
}

async function createExpert(world: World, skills: string[], cookie = world.cookie) {
  const response = await send(world.app, "POST", "/api/experts", cookie, {
    name: "部署专家",
    category: "开发",
    prompt: "你是部署专家。",
    skills,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function putDefaults(world: World, disabledSkills: string[]): Promise<void> {
  const response = await send(world.app, "PUT", "/api/skills/defaults", world.cookie, {
    disabledSkills,
  });
  expect(response.statusCode).toBe(200);
}

function createSession(world: World, body: unknown, cookie = world.cookie) {
  return send(world.app, "POST", "/api/sessions", cookie, body);
}

/** 201, no-store, exactly the fourteen view keys; returns the new id. */
function expectCreated(response: LightMyRequestResponse): string {
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([201, "no-store"]);
  const body = response.json() as { id: string };
  expect(Object.keys(body)).toEqual([...SESSION_VIEW_KEYS]);
  return body.id;
}

/** The whole `chat_sessions` row (every column, `updated_at` included). */
function rowOf(db: DatabaseSync, session: string): Record<string, unknown> {
  return { ...db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(session) };
}

/** The two capability columns with their storage classes. */
function columnsOf(db: DatabaseSync, session: string): unknown {
  return {
    ...db
      .prepare(
        "SELECT expert_id, typeof(expert_id) AS expert_type, disabled_skills, typeof(disabled_skills) AS skills_type FROM chat_sessions WHERE id = ?",
      )
      .get(session),
  };
}

function setColumns(db: DatabaseSync, session: string, expertId: string | null, list: string) {
  const written = db
    .prepare("UPDATE chat_sessions SET expert_id = ?, disabled_skills = ? WHERE id = ?")
    .run(expertId, list, session);
  expect(Number(written.changes)).toBe(1);
}

/** The account-level rows a session write must not touch, and the audit count. */
function accountState(db: DatabaseSync): unknown {
  const all = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  return {
    skillPrefs: all("SELECT * FROM account_skill_prefs ORDER BY account_id"),
    composerPrefs: all("SELECT * FROM account_composer_prefs ORDER BY account_id"),
    audits: all("SELECT id FROM audit_events ORDER BY id"),
  };
}

/** Everything a refused create must leave alone: rows, account state and the sandbox tree. */
function footprint(world: World): unknown {
  const count = (table: string) =>
    Number(
      (world.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n,
    );
  return {
    sessions: count("chat_sessions"),
    workspaces: count("workspaces"),
    account: accountState(world.db),
    tree: readdirSync(world.sandboxRoot, { recursive: true }).map(String).sort(),
  };
}

/** `body` (valid JSON) padded with JSON whitespace to exactly `bytes` bytes. */
function padded(body: object, bytes: number): Raw {
  const json = JSON.stringify(body);
  const payload = `${json.slice(0, -1)}${" ".repeat(bytes - Buffer.byteLength(json))}}`;
  expect(Buffer.byteLength(payload)).toBe(bytes);
  return { payload, type: JSON_TYPE };
}

describe("POST /api/sessions: expertId and disabledSkills initial values", () => {
  it("缺省停用：新会话取账号缺省；改缺省不影响已有会话", async () => {
    const world = await openWorld();
    await putDefaults(world, ["weekly-report", "ghost"]);

    const a = expectCreated(await createSession(world, {}));
    expect(await capsOf(world, a)).toEqual({
      expertId: null,
      disabledSkills: ["ghost", "weekly-report"],
      disabledConnectors: [],
    });

    await putDefaults(world, []);
    expect(await capsOf(world, a)).toEqual({
      expertId: null,
      disabledSkills: ["ghost", "weekly-report"],
      disabledConnectors: [],
    });
    const b = expectCreated(await createSession(world, {}));
    expect(await capsOf(world, b)).toEqual({
      expertId: null,
      disabledSkills: [],
      disabledConnectors: [],
    });
    // A bodyless create reads the default too.
    await putDefaults(world, ["lint"]);
    const bodyless = expectCreated(await send(world.app, "POST", "/api/sessions", world.cookie));
    expect(await capsOf(world, bodyless)).toEqual({
      expertId: null,
      disabledSkills: ["lint"],
      disabledConnectors: [],
    });
  });

  it("创建时的专家与停用技能：四例逐值；视图十四键；账号缺省、最近选择与审计不变", async () => {
    const world = await openWorld();
    await putDefaults(world, ["deploy", "lint"]);
    const e = await createExpert(world, ["deploy"]);
    const before = accountState(world.db);

    const cases: Array<[unknown, Capabilities]> = [
      [{}, { expertId: null, disabledSkills: ["deploy", "lint"], disabledConnectors: [] }],
      [{ expertId: e }, { expertId: e, disabledSkills: ["lint"], disabledConnectors: [] }],
      [
        { expertId: e, disabledSkills: ["deploy"] },
        { expertId: e, disabledSkills: [], disabledConnectors: [] },
      ],
      [{ disabledSkills: [] }, { expertId: null, disabledSkills: [], disabledConnectors: [] }],
    ];
    const ids: string[] = [];
    for (const [body] of cases) {
      ids.push(expectCreated(await createSession(world, body)));
    }

    expect(accountState(world.db)).toEqual(before);
    for (const [index, [, expected]] of cases.entries()) {
      expect(await capsOf(world, ids[index] as string)).toEqual(expected);
    }
    expect(columnsOf(world.db, ids[1] as string)).toEqual({
      expert_id: e,
      expert_type: "text",
      disabled_skills: '["lint"]',
      skills_type: "text",
    });
  });

  it("内置专家正例与 128 原始项（含重复）：201，去重排序", async () => {
    const world = await openWorld();
    await putDefaults(world, ["lint"]);

    const builtin = expectCreated(await createSession(world, { expertId: BUILTIN }));
    expect(await capsOf(world, builtin)).toEqual({
      expertId: BUILTIN,
      disabledSkills: ["lint"],
      disabledConnectors: [],
    });

    const many = expectCreated(await createSession(world, { disabledSkills: RAW_128 }));
    expect(await capsOf(world, many)).toEqual({
      expertId: null,
      disabledSkills: NAMES_64,
      disabledConnectors: [],
    });
  });

  it("400 先于 workspaceId 判定：不写会话 / 空间行、目录与审计，带 no-store", async () => {
    const world = await openWorld();
    const foreign = await createExpert(world, [], world.other);
    const workspace = await send(world.app, "POST", "/api/workspaces", world.cookie, {
      name: "proj",
      dir: "proj",
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = (workspace.json() as { id: string }).id;
    const before = footprint(world);

    const refused: unknown[] = [
      { expertId: null },
      { expertId: NOPE },
      { expertId: foreign },
      { expertId: 1 },
      { disabledSkills: "deploy" },
      { disabledSkills: null },
      { disabledSkills: ["a,b"] },
      { disabledSkills: [1] },
      { disabledSkills: RAW_129 },
      // The unknown workspace would be 404: the capability keys are judged first.
      { expertId: NOPE, workspaceId: UNKNOWN_SESSION_ID },
      { disabledSkills: ["a,b"], workspaceId: UNKNOWN_SESSION_ID },
      // And on a valid workspace nothing is bound or audited.
      { expertId: foreign, workspaceId },
    ];
    for (const body of refused) {
      expectEnvelope(await createSession(world, body), 400, BAD_REQUEST_ENVELOPE);
    }
    expect(footprint(world)).toEqual(before);
    // Control: the same unknown workspace with valid capability keys is the 404.
    expectEnvelope(
      await createSession(world, { expertId: BUILTIN, workspaceId: UNKNOWN_SESSION_ID }),
      404,
      NOT_FOUND_ENVELOPE,
    );
  });
});

describe("GET / PUT /api/sessions/:id/capabilities: owner, refusals and archive", () => {
  it("owner 预检先于 body：未认证 401，他人与不存在的会话 404（各带坏 body）", async () => {
    const world = await openWorld();
    const foreign = expectCreated(await createSession(world, {}, world.other));
    const malformed: Raw = { payload: '{"expertId": ', type: JSON_TYPE };
    const before = rowOf(world.db, foreign);

    for (const method of ["GET", "PUT"] as const) {
      const url = capsUrl(world.session);
      expectEnvelope(await send(world.app, method, url, undefined), 401, UNAUTHORIZED_ENVELOPE);
      expectEnvelope(
        await send(world.app, method, url, undefined, undefined, malformed),
        401,
        UNAUTHORIZED_ENVELOPE,
      );
      for (const session of [foreign, UNKNOWN_SESSION_ID]) {
        for (const raw of [undefined, malformed, padded({ disabledSkills: [] }, KIB64 + 1)]) {
          expectEnvelope(
            await send(world.app, method, capsUrl(session), world.cookie, undefined, raw),
            404,
            NOT_FOUND_ENVELOPE,
          );
        }
      }
    }
    expect(rowOf(world.db, foreign)).toEqual(before);
  });

  it("PUT 的 400 各一例且会话行不变；内置专家与 {expertId:null} 200；128 原始项 200", async () => {
    const world = await openWorld();
    const foreign = await createExpert(world, [], world.other);
    expectCaps(await putCaps(world, world.session, { disabledSkills: ["lint"] }), {
      expertId: null,
      disabledSkills: ["lint"],
      disabledConnectors: [],
    });
    const before = { row: rowOf(world.db, world.session), account: accountState(world.db) };

    const refused: unknown[] = [
      {},
      { skills: [] },
      { expertId: null, extra: 1 },
      { expertId: NOPE },
      { expertId: foreign },
      { expertId: 1 },
      { disabledSkills: ["a,b"] },
      { disabledSkills: "lint" },
      { disabledSkills: null },
      { disabledSkills: RAW_129 },
      { expertId: BUILTIN, disabledSkills: ["ok", "bad\u0007"] },
      [],
      null,
      "x",
    ];
    for (const body of refused) {
      expectEnvelope(await putCaps(world, world.session, body), 400, BAD_REQUEST_ENVELOPE);
    }
    expect({ row: rowOf(world.db, world.session), account: accountState(world.db) }).toEqual(
      before,
    );

    expectCaps(await putCaps(world, world.session, { expertId: BUILTIN }), {
      expertId: BUILTIN,
      disabledSkills: ["lint"],
      disabledConnectors: [],
    });
    expectCaps(await putCaps(world, world.session, { expertId: null }), {
      expertId: null,
      disabledSkills: ["lint"],
      disabledConnectors: [],
    });
    expectCaps(await putCaps(world, world.session, { disabledSkills: RAW_128 }), {
      expertId: null,
      disabledSkills: NAMES_64,
      disabledConnectors: [],
    });
    expect(accountState(world.db)).toEqual(before.account);
  });

  it("content-parser 400（body limit 64 KiB）；恰 64 KiB 200", async () => {
    const world = await openWorld();
    const before = rowOf(world.db, world.session);
    const failures: Raw[] = [
      { payload: '{"disabledSkills": ', type: JSON_TYPE },
      { payload: "", type: JSON_TYPE },
      { payload: '{"disabledSkills":[]}', type: "text/plain" },
      { payload: "binary", type: "application/octet-stream" },
      padded({ disabledSkills: ["deploy"] }, KIB64 + 1),
    ];
    for (const raw of failures) {
      expectEnvelope(
        await send(world.app, "PUT", capsUrl(world.session), world.cookie, undefined, raw),
        400,
        BAD_REQUEST_ENVELOPE,
      );
    }
    expect(rowOf(world.db, world.session)).toEqual(before);

    const boundary = padded({ disabledSkills: ["deploy"] }, KIB64);
    expectCaps(
      await send(world.app, "PUT", capsUrl(world.session), world.cookie, undefined, boundary),
      { expertId: null, disabledSkills: ["deploy"], disabledConnectors: [] },
    );
  });

  it("已归档会话：PUT 409 session_archived 且行不变；GET 200", async () => {
    const world = await openWorld();
    expectCaps(await putCaps(world, world.session, { disabledSkills: ["deploy"] }), {
      expertId: null,
      disabledSkills: ["deploy"],
      disabledConnectors: [],
    });
    const archived = await send(
      world.app,
      "PATCH",
      `/api/sessions/${world.session}`,
      world.cookie,
      {
        archived: true,
      },
    );
    expect(archived.statusCode).toBe(200);
    const before = rowOf(world.db, world.session);

    for (const body of [{ disabledSkills: [] }, { expertId: BUILTIN }, { expertId: null }]) {
      expectEnvelope(await putCaps(world, world.session, body), 409, SESSION_ARCHIVED_ENVELOPE);
    }
    expect(rowOf(world.db, world.session)).toEqual(before);
    expectCaps(await getCaps(world, world.session), {
      expertId: null,
      disabledSkills: ["deploy"],
      disabledConnectors: [],
    });
  });
});

describe("capabilities: union rule and the effective expert", () => {
  it("并集与清空：四步逐值；与当前相同的值 200 且行不变", async () => {
    const world = await openWorld();
    const e = await createExpert(world, ["deploy"]);
    expectCaps(await putCaps(world, world.session, { disabledSkills: ["lint", "deploy"] }), {
      expertId: null,
      disabledSkills: ["deploy", "lint"],
      disabledConnectors: [],
    });

    const steps: Array<[unknown, Capabilities]> = [
      [{ expertId: e }, { expertId: e, disabledSkills: ["lint"], disabledConnectors: [] }],
      [{ expertId: null }, { expertId: null, disabledSkills: ["lint"], disabledConnectors: [] }],
      [
        { expertId: e, disabledSkills: ["deploy"] },
        { expertId: e, disabledSkills: [], disabledConnectors: [] },
      ],
      [
        { disabledSkills: ["deploy"] },
        { expertId: e, disabledSkills: ["deploy"], disabledConnectors: [] },
      ],
    ];
    for (const [body, expected] of steps) {
      expectCaps(await putCaps(world, world.session, body), expected);
      expectCaps(await getCaps(world, world.session), expected);
    }

    const before = rowOf(world.db, world.session);
    expectCaps(await putCaps(world, world.session, { disabledSkills: ["deploy"] }), {
      expertId: e,
      disabledSkills: ["deploy"],
      disabledConnectors: [],
    });
    expect(rowOf(world.db, world.session)).toEqual(before);
  });

  it("有效专家：已删除、他人的或不存在的专家读出 null，GET 不改写行里的原值", async () => {
    const world = await openWorld();
    const own = await createExpert(world, []);
    expectCaps(await putCaps(world, world.session, { expertId: own }), {
      expertId: own,
      disabledSkills: [],
      disabledConnectors: [],
    });
    const deleted = await send(world.app, "DELETE", `/api/experts?id=${own}`, world.cookie);
    expect(deleted.statusCode).toBe(204);
    // The expert delete itself clears the reference (group 3); the read reports no expert.
    expectCaps(await getCaps(world, world.session), {
      expertId: null,
      disabledSkills: [],
      disabledConnectors: [],
    });

    const foreign = await createExpert(world, ["deploy"], world.other);
    for (const raw of [foreign, NOPE]) {
      setColumns(world.db, world.session, raw, '["deploy"]');
      const before = rowOf(world.db, world.session);
      expectCaps(await getCaps(world, world.session), {
        expertId: null,
        disabledSkills: ["deploy"],
        disabledConnectors: [],
      });
      expect(rowOf(world.db, world.session)).toEqual(before);
    }

    // A PUT of only `disabledSkills` keeps the stored id and reports it as no expert.
    expectCaps(await putCaps(world, world.session, { disabledSkills: ["lint"] }), {
      expertId: null,
      disabledSkills: ["lint"],
      disabledConnectors: [],
    });
    expect(columnsOf(world.db, world.session)).toEqual({
      expert_id: NOPE,
      expert_type: "text",
      disabled_skills: '["lint"]',
      skills_type: "text",
    });
  });
});

describe("capabilities: a PUT during an in-flight turn", () => {
  it("回合挂在审批上时 PUT 200：不发帧、不 spawn、不退进程；批准后回合照常结束", REAL, async () => {
    const world = await openApprovalWorld("approval");
    const { app, db } = world.fixture;
    try {
      const pending = await pendingApproval(world);
      const child = spawnedAt(world, 0);
      const frames = child.stdin.length;
      const calls = world.rt.calls.length;
      const before = rowOf(db, world.session);
      expect(before.status).toBe("running");

      const put = await send(app, "PUT", capsUrl(world.session), world.cookie, {
        expertId: BUILTIN,
        disabledSkills: ["deploy"],
      });
      expectCaps(put, { expertId: BUILTIN, disabledSkills: ["deploy"], disabledConnectors: [] });
      expect(rowOf(db, world.session)).toEqual({
        ...before,
        expert_id: BUILTIN,
        disabled_skills: '["deploy"]',
      });
      expect(child.stdin).toHaveLength(frames);
      expect(world.rt.calls).toHaveLength(calls);
      expect(child.child.exitCode).toBeNull();

      const answered = await send(
        app,
        "POST",
        `/api/sessions/${world.session}/approvals/${String(pending.id)}`,
        world.cookie,
        { decision: "allow" },
      );
      expect(answered.statusCode).toBe(200);
      await waitForTurn(world.fixture, world.session, "done");
      expect(child.stdin.slice(frames).map((frame) => frame.type)).toEqual([
        "extension_ui_response",
      ]);
      expect(world.rt.calls).toHaveLength(calls);
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
    }
  });
});

describe("fork copies the two capability columns", () => {
  const worlds = forkWorlds();

  async function forkWith(
    setup: (world: World) => Promise<void>,
  ): Promise<{ world: World; source: string; fresh: string; prefs: unknown }> {
    const opened = worlds.track(await openForkWorld());
    const world: World = {
      app: opened.fixture.app,
      db: opened.fixture.db,
      cookie: opened.cookie,
      other: await cookieFor(opened.fixture.app, "zhaoliu"),
      session: opened.session,
      sandboxRoot: opened.rt.runtime.sandboxRoot,
    };
    await putDefaults(world, ["weekly-report"]);
    await setup(world);
    const seeded = seedTwoTurns(opened);
    const prefs = accountState(world.db);
    const forked = await forkAt(opened, seeded.u2);
    return { world, source: opened.session, fresh: forked.session.id, prefs };
  }

  it("继承专家与停用技能：两列逐值相同，能力读出与源一致，账号缺省不变", REAL, async () => {
    let e = "";
    const { world, source, fresh, prefs } = await forkWith(async (w) => {
      e = await createExpert(w, ["review"]);
      expectCaps(await putCaps(w, w.session, { expertId: e }), {
        expertId: e,
        disabledSkills: [],
        disabledConnectors: [],
      });
      expectCaps(await putCaps(w, w.session, { disabledSkills: ["deploy"] }), {
        expertId: e,
        disabledSkills: ["deploy"],
        disabledConnectors: [],
      });
    });

    expect(columnsOf(world.db, fresh)).toEqual(columnsOf(world.db, source));
    expect(columnsOf(world.db, fresh)).toEqual({
      expert_id: e,
      expert_type: "text",
      disabled_skills: '["deploy"]',
      skills_type: "text",
    });
    expectCaps(await getCaps(world, fresh), {
      expertId: e,
      disabledSkills: ["deploy"],
      disabledConnectors: [],
    });
    expect(await capsOf(world, fresh)).toEqual(await capsOf(world, source));
    expect(accountState(world.db)).toEqual(prefs);
  });

  it("源会话指向已不可见的专家时原样复制，能力读出 expertId null", REAL, async () => {
    const { world, source, fresh } = await forkWith(async (w) => {
      setColumns(w.db, w.session, NOPE, "[]");
    });

    expect(columnsOf(world.db, fresh)).toEqual(columnsOf(world.db, source));
    expect(columnsOf(world.db, fresh)).toEqual({
      expert_id: NOPE,
      expert_type: "text",
      disabled_skills: "[]",
      skills_type: "text",
    });
    expectCaps(await getCaps(world, fresh), {
      expertId: null,
      disabledSkills: [],
      disabledConnectors: [],
    });
  });

  it("源会话无专家：NULL 原样复制", REAL, async () => {
    const { world, source, fresh } = await forkWith(async () => {});
    expect(columnsOf(world.db, fresh)).toEqual(columnsOf(world.db, source));
    expect(columnsOf(world.db, fresh)).toMatchObject({ expert_id: null, expert_type: "null" });
  });
});
