/**
 * Issue #1005 (s1g-composer-capabilities task 8.2): `POST /api/sessions` takes the three composer
 * settings — session-composer-settings「创建会话时的设置与继承」(「缺省与显式」「新会话沿用最近选择」「非法取值」),
 * session-metadata「会话创建与空间绑定」 for both creation kinds, and the creation half of
 * session-permission-tier「档位变更审计」(「创建时的审计」; its fork sentence is task 8.4).
 *
 * Production createApp → registerSessions with the three-model catalog of「有效值解析」 and a chosen
 * `approvalMaxMode`, a real in-memory SQLite and real directories under the runtime's temporary
 * sandbox root; no omp child is ever spawned. Three seeded accounts: zhangsan (`u1`) and zhaoliu
 * (`u2`) are members, lisi (`u3`) is the administrator. Oracles: the spec's literals, SQL rows,
 * `GET /api/audit` and the file system. A last choice the current cap would refuse (`yolo` under
 * `always-ask` / `write`) or that left the catalog (`gone`) cannot be made over REST: its row is
 * planted by SQL.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import type { ComposerConfig } from "../src/sessions/store-composer.js";
import { BAD_REQUEST_ENVELOPE, FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { SESSION_VIEW_KEYS, THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import { cookieFor } from "./session-rest-helpers.js";
import { createControlledRuntime } from "./session-supervisor-helpers.js";

type Cap = ComposerConfig["approvalMaxMode"];
type Account = "zhangsan" | "zhaoliu" | "lisi";
type Composer = [approvalMode: string | null, modelId: string | null, effort: string | null];

const ACCOUNT_ID: Record<Account, string> = { zhangsan: "u1", zhaoliu: "u2", lisi: "u3" };
const JSON_TYPE = "application/json";

interface View {
  id: string;
  createdAt: number;
  workspaceId: string;
  temporaryWorkspace: boolean;
  approvalMode: string;
  modelId: string;
  reasoningEffort: string | null;
}

interface PermissionAudit {
  actor: string;
  title: string;
  workspaceId: string | null;
  detail: unknown;
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
  cookies: Record<Account, string>;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** `cap` undefined is `APPROVAL_MAX_MODE` unset: the assembly's `yolo`. */
async function openWorld(cap?: Cap): Promise<World> {
  const db = openDb(":memory:");
  cleanups.push(() => {
    db.close();
  });
  const { runtime } = createControlledRuntime(() => {});
  // Startup makes no sandbox directory; `POST /api/workspaces` needs the root to exist.
  ensureSharedDir(runtime.sandboxRoot);
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime,
      modelCatalog: THREE_MODEL_CATALOG,
      ...(cap === undefined ? {} : { approvalMaxMode: cap }),
    },
  });
  cleanups.push(() => app.close());
  const cookies = {
    zhangsan: await cookieFor(app, "zhangsan"),
    zhaoliu: await cookieFor(app, "zhaoliu"),
    lisi: await cookieFor(app, "lisi"),
  };
  return { app, db, sandboxRoot: runtime.sandboxRoot, cookies };
}

/** `body` undefined sends no body and no Content-Type. */
function post(world: World, account: Account, body?: unknown): Promise<LightMyRequestResponse> {
  return world.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: {
      cookie: world.cookies[account],
      ...(body === undefined ? {} : { "content-type": JSON_TYPE }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function create(world: World, account: Account, body?: unknown): Promise<View> {
  const response = await post(world, account, body);
  expect(response.statusCode).toBe(201);
  const view = response.json() as View;
  expect(Object.keys(view)).toEqual(SESSION_VIEW_KEYS);
  return view;
}

async function createWorkspace(world: World, account: Account): Promise<string> {
  const made = await world.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie: world.cookies[account], "content-type": JSON_TYPE },
    payload: JSON.stringify({ name: "项目A", dir: "project-a" }),
  });
  expect(made.statusCode).toBe(201);
  return (made.json() as { id: string }).id;
}

function composerOf(view: View): Composer {
  return [view.approvalMode, view.modelId, view.reasoningEffort];
}

function rawOf(world: World, sessionId: string): Composer {
  const row = world.db
    .prepare("SELECT approval_mode, model_id, reasoning_effort FROM chat_sessions WHERE id = ?")
    .get(sessionId) as Record<string, string | null>;
  return [row.approval_mode ?? null, row.model_id ?? null, row.reasoning_effort ?? null];
}

/** Every last-choice row, as `[accountId, approvalMode, modelId, effort, updatedAt]`. */
function prefs(world: World): unknown[] {
  return world.db
    .prepare(
      "SELECT account_id, approval_mode, model_id, reasoning_effort, updated_at FROM account_composer_prefs ORDER BY account_id",
    )
    .all()
    .map((row) => Object.values(row));
}

function plantPrefs(world: World, account: Account, choice: Composer): void {
  world.db
    .prepare(
      "INSERT INTO account_composer_prefs(account_id, approval_mode, model_id, reasoning_effort, updated_at) VALUES (?, ?, ?, ?, 5)",
    )
    .run(ACCOUNT_ID[account], ...choice);
}

/** Every `session.permission` row of the database, oldest first. */
function permissionAudits(world: World): PermissionAudit[] {
  const rows = world.db
    .prepare(
      "SELECT actor_id, CAST(title AS TEXT) AS title, workspace_id, detail FROM audit_events WHERE kind = 'session.permission' ORDER BY id",
    )
    .all() as Array<{
    actor_id: string;
    title: string;
    workspace_id: string | null;
    detail: string;
  }>;
  return rows.map((row) => ({
    actor: row.actor_id,
    title: row.title,
    workspaceId: row.workspace_id,
    detail: JSON.parse(row.detail) as unknown,
  }));
}

/** The creation audit of `view`, as the spec words it: `from` null, the session's own workspace. */
function createdAs(account: Account, view: View, to: string): PermissionAudit {
  return {
    actor: ACCOUNT_ID[account],
    title: "修改权限档位",
    workspaceId: view.workspaceId,
    detail: { sessionId: view.id, from: null, to },
  };
}

async function auditKindsSeenBy(world: World, account: Account): Promise<string[]> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/audit?limit=200",
    headers: { cookie: world.cookies[account] },
  });
  expect(response.statusCode).toBe(200);
  const { events } = response.json() as { events: Array<{ kind: string; actorId: string }> };
  return events.filter((event) => event.kind.startsWith("session.")).map((event) => event.kind);
}

/** Everything a refused creation must leave alone. */
function footprint(world: World): unknown {
  const count = (table: string): number =>
    Number((world.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const dirs = Object.values(ACCOUNT_ID).flatMap((id) => {
    const accountRoot = join(world.sandboxRoot, id);
    return existsSync(accountRoot) ? readdirSync(accountRoot).map((name) => `${id}/${name}`) : [];
  });
  return {
    sessions: count("chat_sessions"),
    workspaces: count("workspaces"),
    audits: count("audit_events"),
    prefs: prefs(world),
    dirs: dirs.sort(),
  };
}

function expectBadRequest(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual(BAD_REQUEST_ENVELOPE);
  expect(response.headers["cache-control"]).toBe("no-store");
}

const EXPLICIT = { approvalMode: "always-ask", modelId: "m3", reasoningEffort: "low" };

describe("创建会话时的设置与继承", () => {
  it("缺省与显式：无 body 读成缺省有效值且不留最近选择；三键创建写入会话行与最近选择", async () => {
    const world = await openWorld();

    const first = await create(world, "zhangsan");

    expect(composerOf(first)).toEqual(["write", "m1", "high"]);
    expect(rawOf(world, first.id)).toEqual([null, null, null]);
    expect(prefs(world)).toEqual([]);

    const second = await create(world, "zhangsan", EXPLICIT);

    expect(composerOf(second)).toEqual(["always-ask", "m3", "low"]);
    expect(second.temporaryWorkspace).toBe(true);
    expect(rawOf(world, second.id)).toEqual(["always-ask", "m3", "low"]);
    expect(prefs(world)).toEqual([["u1", "always-ask", "m3", "low", second.createdAt]]);
    // 列表读到同一个视图。
    const list = await world.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: world.cookies.zhangsan },
    });
    const { sessions } = list.json() as { sessions: View[] };
    expect(sessions.find((session) => session.id === second.id)).toEqual(second);
  });

  it("新会话沿用最近选择：同账号的无 body 创建照抄三列，另一个账号仍是缺省，最近选择行不动", async () => {
    const world = await openWorld();
    await create(world, "zhangsan");
    const second = await create(world, "zhangsan", EXPLICIT);
    const chosen = prefs(world);

    const third = await create(world, "zhangsan");
    const emptyObject = await create(world, "zhangsan", {});
    const foreign = await create(world, "zhaoliu");

    for (const inherited of [third, emptyObject]) {
      expect(composerOf(inherited)).toEqual(["always-ask", "m3", "low"]);
      expect(rawOf(world, inherited.id)).toEqual(["always-ask", "m3", "low"]);
    }
    expect(composerOf(foreign)).toEqual(["write", "m1", "high"]);
    expect(rawOf(world, foreign.id)).toEqual([null, null, null]);
    // 未带三键的创建不改最近选择：zhangsan 的行原样，zhaoliu 没有行。
    expect(prefs(world)).toEqual(chosen);
    expect(chosen).toEqual([["u1", "always-ask", "m3", "low", second.createdAt]]);
  });

  it("新会话沿用最近选择：绑定工作空间的创建同样继承，只给一键时其余两键照抄且最近选择只改该列", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "zhangsan");
    await create(world, "zhangsan", EXPLICIT);

    const bound = await create(world, "zhangsan", { workspaceId: workspace, scene: "code" });
    const partial = await create(world, "zhangsan", {
      workspaceId: workspace,
      reasoningEffort: "max",
    });

    expect(bound.temporaryWorkspace).toBe(false);
    expect(bound.workspaceId).toBe(workspace);
    expect(rawOf(world, bound.id)).toEqual(["always-ask", "m3", "low"]);
    expect(composerOf(partial)).toEqual(["always-ask", "m3", "max"]);
    expect(rawOf(world, partial.id)).toEqual(["always-ask", "m3", "max"]);
    expect(prefs(world)).toEqual([["u1", "always-ask", "m3", "max", partial.createdAt]]);
  });

  it("新会话沿用最近选择：第三个账号 {m3,xhigh} 为 201，行与最近选择为 NULL/m3/xhigh，没有审计", async () => {
    const world = await openWorld();
    await create(world, "zhangsan", EXPLICIT);
    const before = permissionAudits(world);

    const view = await create(world, "lisi", { modelId: "m3", reasoningEffort: "xhigh" });

    expect(composerOf(view)).toEqual(["write", "m3", "xhigh"]);
    expect(rawOf(world, view.id)).toEqual([null, "m3", "xhigh"]);
    expect(prefs(world)).toContainEqual(["u3", null, "m3", "xhigh", view.createdAt]);
    expect(prefs(world)).toHaveLength(2);
    expect(permissionAudits(world)).toEqual(before);
    expect(before.map((audit) => audit.actor)).toEqual(["u1"]);
  });
});

describe("创建会话时的非法取值", () => {
  const cases: Array<[string, Cap | undefined, Record<string, unknown>]> = [
    ["越过最高档 write 的 yolo", "write", { approvalMode: "yolo" }],
    ["大小写不同的档位名", undefined, { approvalMode: "Write" }],
    ["档位为 null", undefined, { approvalMode: null }],
    ["不在白名单的模型", undefined, { modelId: "nope" }],
    ["模型不是字符串", undefined, { modelId: 1 }],
    ["不支持推理的模型带强度", undefined, { modelId: "m2", reasoningEffort: "high" }],
    ["强度 auto", undefined, { modelId: "m1", reasoningEffort: "auto" }],
    ["七个名字之外的强度", undefined, { modelId: "m3", reasoningEffort: "ultra" }],
    ["强度为 null", undefined, { reasoningEffort: null }],
    // 规格九例之外：合法键与非法键同在一个 body 里，合法的那一键也不落。
    ["合法档位与非法模型同在", undefined, { approvalMode: "always-ask", modelId: "nope" }],
    ["强度不是字符串", undefined, { reasoningEffort: 3 }],
    // 数组会被当作属性名转成 "high"：只有路由的字符串判定拦得住。
    ["强度是数组", undefined, { reasoningEffort: ["high"] }],
  ];

  it.each(cases)("非法取值（临时空间的创建）：%s → 400，什么都不写", async (_name, cap, body) => {
    const world = await openWorld(cap);
    await create(world, "zhangsan", { modelId: "m1", reasoningEffort: "low" });
    await create(world, "zhaoliu", { approvalMode: "always-ask" });
    const before = footprint(world);

    const response = await post(world, "zhangsan", body);

    expectBadRequest(response);
    expect(footprint(world)).toEqual(before);
  });

  it.each(cases)(
    "非法取值（绑定工作空间的创建）：%s → 400，什么都不写",
    async (_name, cap, body) => {
      const world = await openWorld(cap);
      const workspace = await createWorkspace(world, "zhangsan");
      await create(world, "zhangsan", { modelId: "m1", reasoningEffort: "low" });
      const before = footprint(world);

      const response = await post(world, "zhangsan", { workspaceId: workspace, ...body });

      expectBadRequest(response);
      // 审计行数不变：既没有 session.permission，也没有 session.bind。
      expect(footprint(world)).toEqual(before);
    },
  );

  it("强度所对的模型取最近选择：最近选择 m2 时 {reasoningEffort} 为 400，同一 body 带 modelId m1 为 201", async () => {
    const world = await openWorld();
    await create(world, "zhangsan", { modelId: "m2" });
    const before = footprint(world);

    expectBadRequest(await post(world, "zhangsan", { reasoningEffort: "high" }));

    expect(footprint(world)).toEqual(before);
    // 另一个账号没有最近选择，所得模型是缺省的 m1：同一 body 为 201。
    const foreign = await create(world, "zhaoliu", { reasoningEffort: "high" });
    expect(rawOf(world, foreign.id)).toEqual([null, null, "high"]);
    // body 的 modelId 先于最近选择。
    const explicit = await create(world, "zhangsan", { modelId: "m1", reasoningEffort: "high" });
    expect(rawOf(world, explicit.id)).toEqual([null, "m1", "high"]);
  });

  it("强度所对的模型取最近选择的有效值：最近选择 gone 回落到 m1，{reasoningEffort} 为 201，行照抄 gone", async () => {
    const world = await openWorld();
    plantPrefs(world, "zhangsan", [null, "gone", null]);

    const view = await create(world, "zhangsan", { reasoningEffort: "high" });

    expect(composerOf(view)).toEqual(["write", "m1", "high"]);
    expect(rawOf(world, view.id)).toEqual([null, "gone", "high"]);
    expect(prefs(world)).toEqual([["u1", null, "gone", "high", view.createdAt]]);
  });

  it("继承值不再校验：最近选择 m2 + high（不支持推理的模型配了强度）照抄入行，视图强度为 null", async () => {
    const world = await openWorld();
    plantPrefs(world, "zhangsan", ["write", "m2", "high"]);

    const view = await create(world, "zhangsan");

    expect(composerOf(view)).toEqual(["write", "m2", null]);
    expect(rawOf(world, view.id)).toEqual(["write", "m2", "high"]);
    expect(prefs(world)).toEqual([["u1", "write", "m2", "high", 5]]);
  });
});

describe("创建时的审计 (session-permission-tier「档位变更审计」)", () => {
  it("创建时的审计：上界 yolo——无选择不写，显式 yolo 写，继承 yolo 写；另一个账号看不到也不受影响", async () => {
    const world = await openWorld();

    const first = await create(world, "zhangsan");
    expect(permissionAudits(world)).toEqual([]);

    const second = await create(world, "zhangsan", { approvalMode: "yolo" });
    expect(permissionAudits(world)).toEqual([createdAs("zhangsan", second, "yolo")]);

    const third = await create(world, "zhangsan");
    expect(composerOf(third)).toEqual(["yolo", "m1", "high"]);
    expect(permissionAudits(world)).toEqual([
      createdAs("zhangsan", second, "yolo"),
      createdAs("zhangsan", third, "yolo"),
    ]);
    expect(first.workspaceId).not.toBe(second.workspaceId);

    // zhaoliu 不继承 zhangsan 的 yolo，自己的创建不写审计。
    const foreign = await create(world, "zhaoliu");
    expect(composerOf(foreign)).toEqual(["write", "m1", "high"]);
    expect(permissionAudits(world)).toHaveLength(2);
    // 临时空间的创建没有 session.bind：三个出口各自看到的 session.* 审计。
    expect(await auditKindsSeenBy(world, "zhangsan")).toEqual([
      "session.permission",
      "session.permission",
    ]);
    expect(await auditKindsSeenBy(world, "zhaoliu")).toEqual([]);
    expect(await auditKindsSeenBy(world, "lisi")).toEqual([
      "session.permission",
      "session.permission",
    ]);
  });

  it("创建时的审计：绑定工作空间的创建先写 session.bind 再写 session.permission，workspaceId 为所绑空间", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "zhangsan");

    const view = await create(world, "zhangsan", { workspaceId: workspace, approvalMode: "yolo" });

    expect(view.workspaceId).toBe(workspace);
    expect(permissionAudits(world)).toEqual([createdAs("zhangsan", view, "yolo")]);
    const kinds = world.db
      .prepare("SELECT kind FROM audit_events WHERE kind LIKE 'session.%' ORDER BY id")
      .all()
      .map((row) => row.kind);
    expect(kinds).toEqual(["session.bind", "session.permission"]);
  });

  // 上界 / 原始档位的来源 → 是否写、`to`、视图档位。前三行是规格「创建时的审计」的第二段。
  it.each<
    [
      string,
      Cap | undefined,
      "none" | "explicit" | "inherited",
      string | null,
      string | null,
      string,
    ]
  >([
    ["上界 always-ask、无选择", "always-ask", "none", null, null, "always-ask"],
    [
      "上界 always-ask、继承 yolo（夹成缺省档）",
      "always-ask",
      "inherited",
      "yolo",
      null,
      "always-ask",
    ],
    ["上界 yolo、显式 write（就是缺省档）", undefined, "explicit", "write", null, "write"],
    ["上界 yolo、显式 always-ask", undefined, "explicit", "always-ask", "always-ask", "always-ask"],
    [
      "上界 yolo、继承 always-ask",
      undefined,
      "inherited",
      "always-ask",
      "always-ask",
      "always-ask",
    ],
    ["上界 write、继承 yolo（行存 yolo，视图 write）", "write", "inherited", "yolo", null, "write"],
    ["上界 write、显式 always-ask", "write", "explicit", "always-ask", "always-ask", "always-ask"],
    [
      "上界 always-ask、显式 always-ask（就是缺省档）",
      "always-ask",
      "explicit",
      "always-ask",
      null,
      "always-ask",
    ],
  ])("创建时的审计：%s", async (_name, cap, source, raw, to, shown) => {
    const world = await openWorld(cap);
    if (source === "inherited") {
      plantPrefs(world, "zhaoliu", [raw, null, null]);
    }

    const view = await create(
      world,
      "zhaoliu",
      source === "explicit" ? { approvalMode: raw } : undefined,
    );

    expect(view.approvalMode).toBe(shown);
    expect(rawOf(world, view.id)).toEqual([raw, null, null]);
    expect(permissionAudits(world)).toEqual(to === null ? [] : [createdAs("zhaoliu", view, to)]);
  });
});
