/**
 * Issue #1282 (s1-followups-batch G6, owner ruling A): the mode a creation inherits from the
 * account's last choice, and the mode a fork copies from its source, are stored no higher than the
 * cap in force at that write — so a session made while the cap was lowered does not widen when the
 * cap is raised again. session-permission-tier「管理员最高档」(「封顶期间新建与 fork 的会话不随上界放回而放宽」),
 * session-composer-settings「继承的档位不高于上界」 and session-metadata「封顶时 fork 不带走超界档位」.
 *
 * One deployment is one in-memory SQLite and one real fake-omp runtime (`branch`, one extra
 * `--branch-entry QUESTION` so a three-turn source forks at its third user message); a restart is
 * the production createApp → registerSessions assembly built again over that same database and
 * runtime under another `approvalMaxMode` (the cap is read once per assembly, as at startup).
 * Everything is driven over `app.inject()`; a source's history is written through the store.
 * Oracles: the `approval_mode` column read by SQL, the session views, the `session.permission`
 * rows by content, the account's last-choice row and the recorded spawn argv.
 */
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { flagValue, REAL, settle } from "./session-approval-helpers.js";
import { postSessionAction } from "./session-bodyless-rest-helpers.js";
import {
  type Cap,
  composerOf,
  create,
  expectBadRequest,
  footprint,
  type PermissionAudit,
  permissionAudits,
  post,
  prefs,
  rawOf,
  type View,
  type World,
} from "./session-composer-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { seedTwoTurns } from "./session-fork-helpers.js";
import { THREE_MODEL_CATALOG } from "./session-meta-fixtures.js";
import { QUESTION, sendPrompt } from "./session-regenerate-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  type RealFakeRuntime,
  type RecordingWorld,
  requiredCall,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";

/** What survives a restart: the rows, the sandbox and state directories, the spawn record. */
interface Deployment {
  db: DatabaseSync;
  rt: RealFakeRuntime;
  app: FastifyInstance | undefined;
}

/** One assembly over a deployment, shaped for both the composer REST and the fork helpers. */
type Running = World & RecordingWorld;

const deployments: Deployment[] = [];

afterEach(async () => {
  for (const deployment of deployments.splice(0)) {
    for (const child of deployment.rt.children) {
      if (isLive(child)) {
        child.kill("SIGKILL");
      }
    }
    await deployment.app?.close();
    deployment.db.close();
  }
});

function deploy(): Deployment {
  const rt = createRealFakeRuntime("branch");
  const inner = rt.runtime.spawnImpl;
  rt.runtime.spawnImpl = (command, args, options) =>
    inner(command, [...args, "--branch-entry", QUESTION], options);
  // Startup makes no sandbox directory; the workspace store resolves the root's real path.
  mkdirSync(rt.runtime.sandboxRoot, { recursive: true });
  const deployment: Deployment = { db: openDb(":memory:"), rt, app: undefined };
  deployments.push(deployment);
  return deployment;
}

/**
 * Stops the running assembly, if any, and starts one under `cap`; undefined is `APPROVAL_MAX_MODE`
 * unset (the assembly's `yolo`). The database stays open across the restart.
 */
async function restart(deployment: Deployment, cap?: Cap): Promise<Running> {
  await deployment.app?.close();
  const { db, rt } = deployment;
  const tokens = new TokenRegistry();
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      tokens,
      runtime: rt.runtime,
      modelCatalog: THREE_MODEL_CATALOG,
      ...(cap === undefined ? {} : { approvalMaxMode: cap }),
    },
  });
  deployment.app = app;
  const cookie = await cookieFor(app, "zhangsan");
  const { store, supervisor } = app.sessions;
  return {
    app,
    db,
    sandboxRoot: rt.runtime.sandboxRoot,
    cookies: { zhangsan: cookie, zhaoliu: "", lisi: "" },
    fixture: { app, db, tokens, store, supervisor, close: () => app.close() },
    errors: [],
    events: [],
    cookie,
    session: "",
  };
}

/** The creation audit of `view`, as the spec words it. */
function createdAs(view: View, to: string): PermissionAudit {
  return {
    actor: "u1",
    title: "修改权限档位",
    workspaceId: view.workspaceId,
    detail: { sessionId: view.id, from: null, to },
  };
}

/** A three-turn history on `session`; returns the fork point (its third user message). */
function seedHistory(world: Running, session: string): number {
  return seedTwoTurns(world, { extraTurn: true }, session).u3;
}

async function fork(world: Running, source: string, messageId: number): Promise<View> {
  const response = await postSessionAction(world.app, "fork", source, world.cookie, {
    name: "fork body",
    payload: JSON.stringify({ messageId }),
    contentType: "application/json",
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { session: View }).session;
}

/** The `approvalMode` each of `ids` reads as in `GET /api/sessions`, in the order given. */
async function shownModes(world: Running, ids: readonly string[]): Promise<unknown[]> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  const { sessions } = response.json() as { sessions: View[] };
  return ids.map((id) => sessions.find((session) => session.id === id)?.approvalMode);
}

function storedModes(world: Running, ids: readonly string[]): unknown[] {
  return ids.map((id) => rawOf(world, id)[0]);
}

/** One REST turn on `session` to done. */
async function answered(world: Running, session: string): Promise<void> {
  expect((await sendPrompt(world, QUESTION, session)).statusCode).toBe(202);
  await waitForTurn(world.fixture, session, "done");
  await settle();
}

/** `--approval-mode` and `--model` of the deployment's n-th spawn (restarts do not reset it). */
function argvOf(deployment: Deployment, index: number): Array<string | undefined> {
  const { args } = requiredCall(deployment.rt.calls, index);
  return [flagValue(args, "--approval-mode"), flagValue(args, "--model")];
}

describe("封顶期间新建与 fork 的会话不随上界放回而放宽 (session-permission-tier「管理员最高档」)", () => {
  it(
    "上界 write 期间的无 body 创建与 fork 存 write，S0 与最近选择仍为 yolo；放回后 S1、S2 仍是 write，S0 恢复 yolo，新建的 S3 写创建审计",
    REAL,
    async () => {
      const site = deploy();
      let world = await restart(site);
      const s0 = await create(world, "zhangsan", { approvalMode: "yolo" });
      const forkPoint = seedHistory(world, s0.id);
      const chosen = prefs(world);
      const audits = permissionAudits(world);
      expect(chosen).toEqual([["u1", "yolo", null, null, s0.createdAt]]);
      expect(audits).toEqual([createdAs(s0, "yolo")]);

      world = await restart(site, "write");
      const s1 = await create(world, "zhangsan");
      const s2 = await fork(world, s0.id, forkPoint);

      expect([s1.approvalMode, s2.approvalMode]).toEqual(["write", "write"]);
      expect(storedModes(world, [s1.id, s2.id])).toEqual(["write", "write"]);
      expect(permissionAudits(world)).toEqual(audits);
      expect(storedModes(world, [s0.id])).toEqual(["yolo"]);
      expect(prefs(world)).toEqual(chosen);
      // The fork's temporary process is the deployment's only spawn so far.
      expect(site.rt.calls).toHaveLength(1);
      expect(argvOf(site, 0)[0]).toBe("write");

      world = await restart(site);
      const ids = [s1.id, s2.id, s0.id];
      expect(await shownModes(world, ids)).toEqual(["write", "write", "yolo"]);
      for (const id of ids) {
        await answered(world, id);
      }

      expect(site.rt.calls).toHaveLength(4);
      expect([1, 2, 3].map((index) => argvOf(site, index)[0])).toEqual(["write", "write", "yolo"]);
      expect(storedModes(world, ids)).toEqual(["write", "write", "yolo"]);
      expect(await shownModes(world, ids)).toEqual(["write", "write", "yolo"]);
      // Neither the reads nor the three dispatches wrote an audit.
      expect(permissionAudits(world)).toEqual(audits);

      const s3 = await create(world, "zhangsan");

      expect(s3.approvalMode).toBe("yolo");
      expect(storedModes(world, [s3.id])).toEqual(["yolo"]);
      expect(permissionAudits(world)).toEqual([...audits, createdAs(s3, "yolo")]);
      expect(prefs(world)).toEqual(chosen);
    },
  );

  it(
    "上界 always-ask 期间由最近选择 write 继承的创建存 always-ask；放回后视图与 argv 仍是 always-ask",
    REAL,
    async () => {
      const site = deploy();
      let world = await restart(site);
      const first = await create(world, "zhangsan", { approvalMode: "write" });
      const chosen = prefs(world);
      expect(chosen).toEqual([["u1", "write", null, null, first.createdAt]]);

      world = await restart(site, "always-ask");
      const capped = await create(world, "zhangsan");

      expect(capped.approvalMode).toBe("always-ask");
      expect(storedModes(world, [capped.id])).toEqual(["always-ask"]);
      expect(permissionAudits(world)).toEqual([]);
      expect(prefs(world)).toEqual(chosen);

      world = await restart(site);

      expect(await shownModes(world, [capped.id, first.id])).toEqual(["always-ask", "write"]);
      await answered(world, capped.id);
      expect(site.rt.calls).toHaveLength(1);
      expect(argvOf(site, 0)[0]).toBe("always-ask");
      expect(storedModes(world, [capped.id])).toEqual(["always-ask"]);
      expect(permissionAudits(world)).toEqual([]);
    },
  );

  it(
    "从未选过档位的账号：上界 always-ask 期间的创建与 fork 仍存 NULL（不是 always-ask），放回后读成缺省档 write",
    REAL,
    async () => {
      const site = deploy();
      let world = await restart(site, "always-ask");
      const made = await create(world, "zhangsan");
      const copy = await fork(world, made.id, seedHistory(world, made.id));

      expect([made.approvalMode, copy.approvalMode]).toEqual(["always-ask", "always-ask"]);
      expect(argvOf(site, 0)[0]).toBe("always-ask");
      expect(storedModes(world, [made.id, copy.id])).toEqual([null, null]);
      expect(prefs(world)).toEqual([]);

      world = await restart(site);

      expect(await shownModes(world, [made.id, copy.id])).toEqual(["write", "write"]);
      expect(permissionAudits(world)).toEqual([]);
    },
  );
});

describe("继承的档位不高于上界 (session-composer-settings「创建会话时的设置与继承」)", () => {
  it("上界 write、最近选择 yolo/m3/low：无 body 创建的视图与会话行都是 write/m3/low，最近选择行不动，没有新审计", async () => {
    const site = deploy();
    let world = await restart(site);
    const first = await create(world, "zhangsan", {
      approvalMode: "yolo",
      modelId: "m3",
      reasoningEffort: "low",
    });
    const chosen = prefs(world);
    const audits = permissionAudits(world);
    expect(chosen).toEqual([["u1", "yolo", "m3", "low", first.createdAt]]);

    world = await restart(site, "write");
    const view = await create(world, "zhangsan");

    expect(composerOf(view)).toEqual(["write", "m3", "low"]);
    expect(rawOf(world, view.id)).toEqual(["write", "m3", "low"]);
    expect(prefs(world)).toEqual(chosen);
    expect(permissionAudits(world)).toEqual(audits);
    expect(audits).toEqual([createdAs(first, "yolo")]);
  });

  it("上界 write、最近选择 yolo：只给模型的创建同样夹取继承的档位，最近选择只改模型列、档位列仍是 yolo", async () => {
    const site = deploy();
    let world = await restart(site);
    await create(world, "zhangsan", {
      approvalMode: "yolo",
      modelId: "m3",
      reasoningEffort: "low",
    });
    const audits = permissionAudits(world);

    world = await restart(site, "write");
    const view = await create(world, "zhangsan", { modelId: "m1" });

    expect(composerOf(view)).toEqual(["write", "m1", "low"]);
    expect(rawOf(world, view.id)).toEqual(["write", "m1", "low"]);
    expect(prefs(world)).toEqual([["u1", "yolo", "m1", "low", view.createdAt]]);
    expect(permissionAudits(world)).toEqual(audits);
  });

  it("上界 write、最近选择 yolo：请求显式给出 yolo 仍是 400 且什么都不写；显式给出 always-ask 原样入行并写创建审计", async () => {
    const site = deploy();
    let world = await restart(site);
    await create(world, "zhangsan", { approvalMode: "yolo" });
    const audits = permissionAudits(world);

    world = await restart(site, "write");
    const before = footprint(world);
    expectBadRequest(await post(world, "zhangsan", { approvalMode: "yolo" }));
    expect(footprint(world)).toEqual(before);

    const view = await create(world, "zhangsan", { approvalMode: "always-ask" });

    expect(view.approvalMode).toBe("always-ask");
    expect(rawOf(world, view.id)).toEqual(["always-ask", null, null]);
    expect(permissionAudits(world)).toEqual([...audits, createdAs(view, "always-ask")]);
  });
});

describe("封顶时 fork 不带走超界档位 (session-metadata「fork 继承会话元数据」)", () => {
  it(
    "上界 write、源会话行 yolo/m3/low：临时进程 argv 为 write，新行 write/m3/low，源行与最近选择不动，没有新审计",
    REAL,
    async () => {
      const site = deploy();
      let world = await restart(site);
      const source = await create(world, "zhangsan", {
        approvalMode: "yolo",
        modelId: "m3",
        reasoningEffort: "low",
      });
      const forkPoint = seedHistory(world, source.id);
      const chosen = prefs(world);
      const audits = permissionAudits(world);
      expect(audits).toEqual([createdAs(source, "yolo")]);

      world = await restart(site, "write");
      const copy = await fork(world, source.id, forkPoint);

      expect(site.rt.calls).toHaveLength(1);
      expect(argvOf(site, 0)).toEqual(["write", "workbuddy/m3"]);
      expect(rawOf(world, copy.id)).toEqual(["write", "m3", "low"]);
      expect(rawOf(world, source.id)).toEqual(["yolo", "m3", "low"]);
      expect(composerOf(copy)).toEqual(["write", "m3", "low"]);
      expect(permissionAudits(world)).toEqual(audits);
      expect(prefs(world)).toEqual(chosen);
    },
  );
});
