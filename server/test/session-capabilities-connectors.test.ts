/**
 * s1d-connectors group 5 (task 5.2): the session's disabled connectors on the production createApp →
 * registerSessions mount over real fake-omp children and a real in-memory SQLite, driven over REST.
 * Covers `POST /api/sessions {disabledConnectors?}` (session-metadata「创建时的停用连接器」: body, else the
 * account default, else `[]`; 400s before any write), the third key of `GET` / `PUT
 * /api/sessions/:id/capabilities` (skill-switches「停用连接器」), connectors「缺省决定新会话」, the spawn's
 * session config `disabledExtensions` as `skill:` ∪ `mcp:` (skill-switches「停用技能对 omp 生效」), and the
 * fork copy of the three capability columns with the temporary process's expert prompt file and
 * `disabledExtensions` (session-metadata「继承专家与停用技能」). Members: zhangsan (the owner)
 * and zhaoliu. Expected values are spec literals and the database rows themselves.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { flagValue, REAL, settle } from "./session-approval-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import { BAD_REQUEST_ENVELOPE } from "./session-db-helpers.js";
import { forkAt, forkWorlds, openForkWorld, seedTwoTurns } from "./session-fork-helpers.js";
import { SESSION_VIEW_KEYS } from "./session-meta-fixtures.js";
import { sendPrompt } from "./session-regenerate-helpers.js";
import { UNKNOWN_SESSION_ID } from "./session-rest-helpers.js";
import { waitForTurn } from "./session-supervisor-helpers.js";

const worlds = forkWorlds();
/** 33 distinct names of lowercase letters only. */
const NAMES_33 = Array.from(
  { length: 33 },
  (_, i) => `n${String.fromCharCode(97 + (i % 26))}${"x".repeat(Math.floor(i / 26))}`,
);

type World = Awaited<ReturnType<typeof openForkWorld>>;

interface Capabilities {
  expertId: string | null;
  disabledSkills: string[];
  disabledConnectors: string[];
}

function call(
  world: World,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return world.fixture.app.inject({
    method,
    url,
    headers: {
      cookie: world.cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** 200, no-store, exactly the three capability keys in order; returns the body. */
function capsAnswer(response: LightMyRequestResponse): Capabilities {
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([200, "no-store"]);
  const body = response.json() as Capabilities;
  expect(Object.keys(body)).toEqual(["expertId", "disabledSkills", "disabledConnectors"]);
  return body;
}

async function capsOf(world: World, session = world.session): Promise<Capabilities> {
  return capsAnswer(await call(world, "GET", `/api/sessions/${session}/capabilities`));
}

async function putCaps(world: World, body: unknown): Promise<LightMyRequestResponse> {
  return call(world, "PUT", `/api/sessions/${world.session}/capabilities`, body);
}

async function created(world: World, body: unknown): Promise<string> {
  const response = await call(world, "POST", "/api/sessions", body);
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([201, "no-store"]);
  const view = response.json() as { id: string };
  expect(Object.keys(view)).toEqual([...SESSION_VIEW_KEYS]);
  return view.id;
}

async function putConnectorDefaults(world: World, disabledConnectors: string[]): Promise<void> {
  const response = await call(world, "PUT", "/api/connectors/defaults", { disabledConnectors });
  expect(response.statusCode).toBe(200);
}

async function createExpert(world: World, skills: string[]): Promise<string> {
  const response = await call(world, "POST", "/api/experts", {
    name: "部署专家",
    category: "开发",
    prompt: "你是部署专家。",
    skills,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

/** The account-level rows a session write must not touch, and the audit rows. */
function accountState(world: World): unknown {
  const all = (sql: string) =>
    world.fixture.db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  return {
    connectorPrefs: all("SELECT * FROM account_connector_prefs ORDER BY account_id"),
    skillPrefs: all("SELECT * FROM account_skill_prefs ORDER BY account_id"),
    composerPrefs: all("SELECT * FROM account_composer_prefs ORDER BY account_id"),
    audits: all("SELECT id FROM audit_events ORDER BY id"),
  };
}

function footprint(world: World): unknown {
  const count = (table: string) =>
    Number(
      (
        world.fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number | bigint;
        }
      ).n,
    );
  return {
    sessions: count("chat_sessions"),
    workspaces: count("workspaces"),
    account: accountState(world),
    tree: readdirSync(world.rt.runtime.sandboxRoot, { recursive: true }).map(String).sort(),
  };
}

function connectorsColumn(world: World, session: string): unknown {
  return world.fixture.db
    .prepare("SELECT disabled_connectors FROM chat_sessions WHERE id = ?")
    .get(session)?.disabled_connectors;
}

/**
 * Wraps spawnImpl to read, at spawn time, each spawn's session yml (the second `--config`) into
 * `ymls` and its `--append-system-prompt` file's text (null without the flag) into `mds`.
 */
function recordSpawns(world: World): { ymls: string[]; mds: Array<string | null> } {
  const ymls: string[] = [];
  const mds: Array<string | null> = [];
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) => {
    const configs = args.flatMap((arg, index) => (arg === "--config" ? [args[index + 1]] : []));
    ymls.push(readFileSync(String(configs[1]), "utf8"));
    const md = flagValue(args, "--append-system-prompt");
    mds.push(md === undefined ? null : readFileSync(md, "utf8"));
    return inner(command, args, options);
  };
  return { ymls, mds };
}

async function promptOn(world: World, session: string): Promise<void> {
  expect((await sendPrompt(world, "hello", session)).statusCode).toBe(202);
  await waitForTurn(world.fixture, session, "done");
  await settle();
}

describe("POST /api/sessions: disabledConnectors 的初值 (session-metadata「创建时的停用连接器」)", () => {
  it("body ?? 账号缺省 ?? []：四例逐值，视图十四键；账号缺省、最近选择与审计不变", async () => {
    const world = worlds.track(await openForkWorld());
    const none = await created(world, {});
    expect((await capsOf(world, none)).disabledConnectors).toEqual([]);

    await putConnectorDefaults(world, ["wiki"]);
    const e = await createExpert(world, ["deploy"]);
    const before = accountState(world);
    const bodies = [
      {},
      { disabledConnectors: ["wiki", "gitlab", "wiki"] },
      { disabledConnectors: [] },
      { expertId: e },
    ];
    const ids: string[] = [];
    for (const body of bodies) {
      ids.push(await created(world, body));
    }
    const lists: string[][] = [];
    for (const id of ids) {
      lists.push((await capsOf(world, id)).disabledConnectors);
    }
    expect(lists).toEqual([["wiki"], ["gitlab", "wiki"], [], ["wiki"]]);
    expect(connectorsColumn(world, ids[1] as string)).toBe('["gitlab","wiki"]');
    expect(await capsOf(world, ids[3] as string)).toEqual({
      expertId: e,
      disabledSkills: [],
      disabledConnectors: ["wiki"],
    });
    expect(accountState(world)).toEqual(before);
  });

  it("不合规的 disabledConnectors 400（含 null 与非数组）：无会话行、空间行、目录与审计", async () => {
    const world = worlds.track(await openForkWorld());
    const before = footprint(world);
    const refused: unknown[] = [
      { disabledConnectors: ["Git"] },
      { disabledConnectors: "gitlab" },
      { disabledConnectors: NAMES_33 },
      { disabledConnectors: null },
      { disabledConnectors: [1] },
      { disabledConnectors: ["git_lab"] },
      { disabledConnectors: {} },
      // Judged before the workspace's 404.
      { disabledConnectors: ["Git"], workspaceId: UNKNOWN_SESSION_ID },
    ];
    for (const body of refused) {
      expectEnvelope(await call(world, "POST", "/api/sessions", body), 400, BAD_REQUEST_ENVELOPE);
    }
    expect(footprint(world)).toEqual(before);
  });
});

describe("会话能力端点的 disabledConnectors (skill-switches「停用连接器」)", () => {
  it("PUT 整体替换、未登记也照存；专家不影响它；不合规 400 且行不变", async () => {
    const world = worlds.track(await openForkWorld());
    capsAnswer(await putCaps(world, { disabledSkills: ["lint"] }));
    const e = await createExpert(world, ["deploy"]);

    expect(
      capsAnswer(await putCaps(world, { disabledConnectors: ["wiki", "gitlab", "wiki"] })),
    ).toEqual({
      expertId: null,
      disabledSkills: ["lint"],
      disabledConnectors: ["gitlab", "wiki"],
    });
    expect(capsAnswer(await putCaps(world, { expertId: e }))).toEqual({
      expertId: e,
      disabledSkills: ["lint"],
      disabledConnectors: ["gitlab", "wiki"],
    });
    expect(await capsOf(world)).toEqual({
      expertId: e,
      disabledSkills: ["lint"],
      disabledConnectors: ["gitlab", "wiki"],
    });

    const row = () => ({
      ...world.fixture.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(world.session),
    });
    const before = row();
    for (const body of [
      { disabledConnectors: ["Git"] },
      { disabledConnectors: "gitlab" },
      { disabledConnectors: NAMES_33 },
      { disabledConnectors: null },
      { disabledConnectors: [], extra: 1 },
    ]) {
      expectEnvelope(await putCaps(world, body), 400, BAD_REQUEST_ENVELOPE);
    }
    expect(row()).toEqual(before);
    expect(capsAnswer(await putCaps(world, { disabledConnectors: [] })).disabledConnectors).toEqual(
      [],
    );
    expect(connectorsColumn(world, world.session)).toBe("[]");
  });
});

describe("spawn 的 disabledExtensions：skill: 与 mcp: 的并集 (skill-switches, connectors「缺省决定新会话」)", () => {
  it(
    "账号缺省停用 gitlab 后新建会话：能力为 [gitlab]，spawn 的会话配置为 mcp: 与 skill: 并集、字典序去重",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { ymls } = recordSpawns(world);
      await putConnectorDefaults(world, ["gitlab"]);
      const fresh = await created(world, { disabledSkills: ["deploy"] });
      expect(await capsOf(world, fresh)).toEqual({
        expertId: null,
        disabledSkills: ["deploy"],
        disabledConnectors: ["gitlab"],
      });

      await promptOn(world, fresh);

      expect(ymls).toEqual(['disabledExtensions: ["mcp:gitlab", "skill:deploy"]\n']);
      expect(world.errors).toEqual([]);
    },
  );
});

/** The three capability columns of a session row, as stored. */
function capabilityColumns(world: World, session: string): unknown {
  return {
    ...world.fixture.db
      .prepare(
        "SELECT expert_id, disabled_skills, disabled_connectors FROM chat_sessions WHERE id = ?",
      )
      .get(session),
  };
}

describe("fork 复制 disabled_connectors (session-metadata「继承专家与停用技能」)", () => {
  it(
    "源会话为自建专家 E、停用 deploy 与 gitlab：新会话三列与能力相同，临时进程带 E 的提示词文件、disabledExtensions 为 [mcp:gitlab, skill:deploy]；账号缺省不变",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const spawns = recordSpawns(world);
      // E declares no skill: the union rule would otherwise drop `deploy` from the disabled set.
      const e = await createExpert(world, []);
      capsAnswer(await putCaps(world, { expertId: e }));
      capsAnswer(
        await putCaps(world, { disabledSkills: ["deploy"], disabledConnectors: ["gitlab"] }),
      );
      expect(capabilityColumns(world, world.session)).toEqual({
        expert_id: e,
        disabled_skills: '["deploy"]',
        disabled_connectors: '["gitlab"]',
      });
      const seeded = seedTwoTurns(world);
      const before = accountState(world);

      const forked = await forkAt(world, seeded.u2);

      const fresh = forked.session.id;
      expect(capabilityColumns(world, fresh)).toEqual(capabilityColumns(world, world.session));
      expect(await capsOf(world, fresh)).toEqual({
        expertId: e,
        disabledSkills: ["deploy"],
        disabledConnectors: ["gitlab"],
      });
      expect(spawns).toEqual({
        ymls: ['disabledExtensions: ["mcp:gitlab", "skill:deploy"]\n'],
        mds: ["你是部署专家。"],
      });
      expect(accountState(world)).toEqual(before);
      expect(world.errors).toEqual([]);
    },
  );
});
