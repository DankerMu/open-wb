/**
 * Issue #930 (s1f-session-list-temp-space task 5.6): `POST /api/sessions` without `workspaceId`
 * creates a temporary workspace in the session's own transaction — session-metadata
 * 「会话创建与空间绑定」 (「无 body 与空对象按默认创建」「绑定自有工作空间并选择场景」「只选场景不选空间」「非法 body 形状」
 * 「临时空间创建失败不留会话」), temporary-workspaces 「不带空间创建会话」「每个新会话各有自己的临时空间」 and the REST
 * half of 「目录创建失败不留行」, chat-sessions 「Create list and empty history」 and the bodyless THEN of
 * http-service-skeleton 「会话元数据 parser owner 的真实 HTTP 边界」. The cwd scenarios of 「绑定不可改与工作目录」
 * are in session-workspace-cwd.test.ts.
 *
 * Production createApp → registerSessions over the real fake-omp runtime (its spawn recorder is
 * the "no omp child" oracle), a real in-memory SQLite and real directories under the runtime's
 * temporary sandbox root. Oracles: the spec's literals, SQL rows, `GET /api/audit` and the file
 * system. The two failures are real ones: an account root occupied by a regular file (the
 * directory step), and SQLite refusing the session INSERT after the workspace was made.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, type DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  denyStatement,
  FIXED_NOW,
  fixedRuntime,
  INTERNAL_ERROR_ENVELOPE,
  resetDatabase,
} from "./session-db-helpers.js";
import { cookieFor, getSessionMessages } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  openBareSession,
  type RealFakeRuntime,
  type SupervisorApp,
} from "./session-supervisor-helpers.js";

const JSON_TYPE = "application/json";
const OWNER = "u1";
const OTHER = "u2";
const HEX32 = /^[0-9a-f]{32}$/u;
const SHARED_MODE = 0o2770;
const ELEVEN_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
  "archivedAt",
  "pendingApproval",
  "temporaryWorkspace",
];

interface View {
  id: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  scene: string | null;
  workspaceId: string;
  pinnedAt: number | null;
  archivedAt: number | null;
  pendingApproval: boolean;
  temporaryWorkspace: boolean;
}

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  rt: RealFakeRuntime;
  sandboxRoot: string;
  /** zhangsan (`u1`), whose account root exists: opening the world created one session of hers. */
  owner: string;
  /** zhaoliu (`u2`), who has created nothing: no account root yet. */
  other: string;
}

interface CreateRequest {
  payload?: string;
  contentType?: string;
}

const fixtures: Array<Pick<SupervisorApp, "db" | "close">> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    resetDatabase(fixture.db);
    await fixture.close();
  }
});

async function openWorld(): Promise<World> {
  const rt = createRealFakeRuntime();
  const { fixture, cookie } = await openBareSession(rt.runtime);
  fixtures.push(fixture);
  const other = await cookieFor(fixture.app, "zhaoliu");
  return {
    app: fixture.app,
    db: fixture.db,
    rt,
    sandboxRoot: rt.runtime.sandboxRoot,
    owner: cookie,
    other,
  };
}

function post(
  world: World,
  cookie: string,
  request: CreateRequest = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { cookie };
  if (request.contentType !== undefined) {
    headers["content-type"] = request.contentType;
  }
  return world.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers,
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
}

function postJson(world: World, cookie: string, body: unknown): Promise<LightMyRequestResponse> {
  return post(world, cookie, { payload: JSON.stringify(body), contentType: JSON_TYPE });
}

function created(response: LightMyRequestResponse): View {
  expect(response.statusCode).toBe(201);
  expect(response.headers["cache-control"]).toBe("no-store");
  const view = response.json() as View;
  expect(Object.keys(view)).toEqual(ELEVEN_KEYS);
  return view;
}

/** The 201 view of a session created without a workspace: its own new temporary workspace. */
function expectTemporaryView(view: View, scene: string | null): void {
  expect(view).toEqual({
    id: expect.stringMatching(HEX32),
    title: null,
    status: "idle",
    createdAt: view.createdAt,
    updatedAt: view.createdAt,
    scene,
    workspaceId: expect.stringMatching(HEX32),
    pinnedAt: null,
    archivedAt: null,
    pendingApproval: false,
    temporaryWorkspace: true,
  });
  expect(Number.isSafeInteger(view.createdAt)).toBe(true);
}

function counts(db: DatabaseSync) {
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  return {
    sessions: count("chat_sessions"),
    workspaces: count("workspaces"),
    audits: count("audit_events"),
  };
}

function workspaceRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT owner_id, name, dir, temporary FROM workspaces WHERE id = ?").get(id) as
    | { owner_id: string; name: string; dir: string; temporary: number }
    | undefined;
}

function sessionRow(db: DatabaseSync, id: string) {
  return db
    .prepare(
      "SELECT owner_id, workspace_id, scene, pinned_at, archived_at FROM chat_sessions WHERE id = ?",
    )
    .get(id);
}

/** The names under an account root; [] when the root does not exist. */
function accountEntries(world: World, ownerId: string): string[] {
  const root = join(world.sandboxRoot, ownerId);
  return existsSync(root) ? readdirSync(root).sort() : [];
}

function temporaryRoot(world: World, ownerId: string, workspaceId: string): string {
  return join(world.sandboxRoot, ownerId, `tmp-${workspaceId}`);
}

/** The row is a temporary workspace of `ownerId` named after its id, with an empty 2770 directory. */
function expectTemporaryWorkspace(world: World, ownerId: string, workspaceId: string): void {
  expect(workspaceRow(world.db, workspaceId)).toEqual({
    owner_id: ownerId,
    name: `tmp-${workspaceId}`,
    dir: `tmp-${workspaceId}`,
    temporary: 1,
  });
  const root = temporaryRoot(world, ownerId, workspaceId);
  const stats = lstatSync(root);
  expect(stats.isDirectory()).toBe(true);
  expect(stats.mode & 0o7777).toBe(SHARED_MODE);
  expect(readdirSync(root)).toEqual([]);
}

async function audit(world: World, cookie: string): Promise<Array<{ kind: string }>> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/audit?limit=200",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { events: Array<{ kind: string }> }).events;
}

async function listed(world: World, cookie: string): Promise<View[]> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return (response.json() as { sessions: View[] }).sessions;
}

describe("会话创建与空间绑定 — 不带空间即创建临时空间 (#930)", () => {
  it("无 body 与空对象按默认创建: two eleven-key views on two new temporary workspaces, no audit, no child (also the parser-owner boundary's bodyless THEN)", async () => {
    const world = await openWorld();
    const before = counts(world.db);
    const auditBefore = await audit(world, world.owner);

    const bodyless = created(await post(world, world.owner));
    const empty = created(await postJson(world, world.owner, {}));

    for (const view of [bodyless, empty]) {
      expectTemporaryView(view, null);
      expectTemporaryWorkspace(world, OWNER, view.workspaceId);
      expect(sessionRow(world.db, view.id)).toEqual({
        owner_id: OWNER,
        workspace_id: view.workspaceId,
        scene: null,
        pinned_at: null,
        archived_at: null,
      });
    }
    expect(bodyless.id).not.toBe(empty.id);
    expect(bodyless.workspaceId).not.toBe(empty.workspaceId);
    expect(counts(world.db)).toEqual({
      sessions: before.sessions + 2,
      workspaces: before.workspaces + 2,
      audits: before.audits,
    });
    expect(await audit(world, world.owner)).toEqual(auditBefore);
    expect(world.rt.calls).toEqual([]);
  });

  it("绑定自有工作空间并选择场景: the view names W, one session.bind, no workspace row or directory is added", async () => {
    const world = await openWorld();
    const made = await world.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: world.owner, "content-type": JSON_TYPE },
      payload: JSON.stringify({ name: "项目A", dir: "project-a" }),
    });
    expect(made.statusCode).toBe(201);
    const workspace = made.json() as { id: string };
    const before = counts(world.db);
    const entries = accountEntries(world, OWNER);
    const auditBefore = await audit(world, world.owner);

    const view = created(
      await postJson(world, world.owner, { workspaceId: workspace.id, scene: "code" }),
    );

    expect(view).toEqual({
      id: expect.stringMatching(HEX32),
      title: null,
      status: "idle",
      createdAt: view.createdAt,
      updatedAt: view.createdAt,
      scene: "code",
      workspaceId: workspace.id,
      pinnedAt: null,
      archivedAt: null,
      pendingApproval: false,
      temporaryWorkspace: false,
    });
    expect(sessionRow(world.db, view.id)).toEqual({
      owner_id: OWNER,
      workspace_id: workspace.id,
      scene: "code",
      pinned_at: null,
      archived_at: null,
    });
    expect(counts(world.db)).toEqual({
      sessions: before.sessions + 1,
      workspaces: before.workspaces,
      audits: before.audits + 1,
    });
    expect(accountEntries(world, OWNER)).toEqual(entries);
    const auditAfter = await audit(world, world.owner);
    expect(auditAfter.slice(1)).toEqual(auditBefore);
    expect(auditAfter[0]).toMatchObject({
      kind: "session.bind",
      actorId: OWNER,
      workspaceId: workspace.id,
      detail: { sessionId: view.id, scene: "code" },
    });
    expect((await listed(world, world.owner)).find((entry) => entry.id === view.id)).toEqual(view);
    expect(world.rt.calls).toEqual([]);
  });

  it("只选场景不选空间: scene `design` on a new temporary workspace, no audit", async () => {
    const world = await openWorld();
    const before = counts(world.db);

    const view = created(await postJson(world, world.owner, { scene: "design" }));

    expectTemporaryView(view, "design");
    expectTemporaryWorkspace(world, OWNER, view.workspaceId);
    expect(counts(world.db)).toEqual({
      sessions: before.sessions + 1,
      workspaces: before.workspaces + 1,
      audits: before.audits,
    });
    expect(world.rt.calls).toEqual([]);
  });

  it("非法 body 形状: every shape is a no-store 400 with no session row, workspace row, directory or audit", async () => {
    const world = await openWorld();
    const before = counts(world.db);
    const requests: CreateRequest[] = [
      ...[
        { scene: "chat" },
        { scene: null },
        { scene: "Office" },
        { workspaceId: null },
        { workspaceId: 1 },
        { title: "x" },
        [],
        null,
      ].map((shape) => ({ payload: JSON.stringify(shape), contentType: JSON_TYPE })),
      { payload: '{"scene": ', contentType: JSON_TYPE },
      { payload: "{}", contentType: "text/plain" },
    ];
    expect(requests).toHaveLength(10);

    for (const request of requests) {
      // zhaoliu has no account root: a directory made by a rejected request would show.
      expectEnvelope(await post(world, world.other, request), 400, BAD_REQUEST_ENVELOPE);
    }

    expect(counts(world.db)).toEqual(before);
    expect(existsSync(join(world.sandboxRoot, OTHER))).toBe(false);
    expect(world.rt.calls).toEqual([]);
  });
});

describe("临时空间的创建 (#930)", () => {
  it("不带空间创建会话: one `temporary = 1` row named tmp-<id>, its 2770 directory under u1, no audit, no child", async () => {
    const world = await openWorld();
    const before = counts(world.db);
    const entries = accountEntries(world, OWNER);
    const auditBefore = await audit(world, world.owner);

    const view = created(await post(world, world.owner));

    expect(view.workspaceId).toMatch(HEX32);
    expect(view.temporaryWorkspace).toBe(true);
    expect(counts(world.db).workspaces).toBe(before.workspaces + 1);
    expectTemporaryWorkspace(world, OWNER, view.workspaceId);
    expect(accountEntries(world, OWNER)).toEqual([...entries, `tmp-${view.workspaceId}`].sort());
    expect(await audit(world, world.owner)).toEqual(auditBefore);
    expect(counts(world.db).audits).toBe(before.audits);
    expect(world.rt.calls).toEqual([]);
  });

  it("每个新会话各有自己的临时空间: two creates, two workspace ids, two directories", async () => {
    const world = await openWorld();
    const entries = accountEntries(world, OWNER);

    const first = created(await post(world, world.owner));
    const second = created(await post(world, world.owner));

    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(accountEntries(world, OWNER)).toEqual(
      [...entries, `tmp-${first.workspaceId}`, `tmp-${second.workspaceId}`].sort(),
    );
    expectTemporaryWorkspace(world, OWNER, first.workspaceId);
    expectTemporaryWorkspace(world, OWNER, second.workspaceId);
  });
});

describe("临时空间创建失败不留会话 / 目录创建失败不留行 — REST (#930)", () => {
  it("an account root occupied by a regular file: generic 500, no row in either table, the file untouched; 201 once it is gone", async () => {
    const world = await openWorld();
    const root = join(world.sandboxRoot, OTHER);
    writeFileSync(root, "not a directory");
    const before = counts(world.db);
    const sandboxEntries = readdirSync(world.sandboxRoot).sort();

    expectEnvelope(await post(world, world.other), 500, INTERNAL_ERROR_ENVELOPE);

    expect(counts(world.db)).toEqual(before);
    expect(world.db.isTransaction).toBe(false);
    expect(lstatSync(root).isFile()).toBe(true);
    expect(readFileSync(root, "utf8")).toBe("not a directory");
    expect(readdirSync(world.sandboxRoot).sort()).toEqual(sandboxEntries);

    rmSync(root);
    const view = created(await post(world, world.other));

    expectTemporaryView(view, null);
    expectTemporaryWorkspace(world, OTHER, view.workspaceId);
    expect(accountEntries(world, OTHER)).toEqual([`tmp-${view.workspaceId}`]);
    expect(counts(world.db)).toEqual({
      sessions: before.sessions + 1,
      workspaces: before.workspaces + 1,
      audits: before.audits,
    });
    expect(world.rt.calls).toEqual([]);
  });

  it("the session INSERT refused after the workspace was made: generic 500, the workspace row rolled back, the account root and directory this request made removed; 201 afterwards", async () => {
    const world = await openWorld();
    const before = counts(world.db);
    expect(existsSync(join(world.sandboxRoot, OTHER))).toBe(false);
    denyStatement(world.db, constants.SQLITE_INSERT, "chat_sessions");

    expectEnvelope(await post(world, world.other), 500, INTERNAL_ERROR_ENVELOPE);

    resetDatabase(world.db);
    expect(counts(world.db)).toEqual(before);
    expect(existsSync(join(world.sandboxRoot, OTHER))).toBe(false);

    const view = created(await post(world, world.other));

    expectTemporaryWorkspace(world, OTHER, view.workspaceId);
    expect(accountEntries(world, OTHER)).toEqual([`tmp-${view.workspaceId}`]);
    expect(world.rt.calls).toEqual([]);
  });

  it("the same refusal for an owner whose account root already holds a temporary workspace: only this request's directory is removed", async () => {
    const world = await openWorld();
    const before = counts(world.db);
    const entries = accountEntries(world, OWNER);
    expect(entries).toHaveLength(1);
    denyStatement(world.db, constants.SQLITE_INSERT, "chat_sessions");

    expectEnvelope(await post(world, world.owner), 500, INTERNAL_ERROR_ENVELOPE);

    resetDatabase(world.db);
    expect(counts(world.db)).toEqual(before);
    expect(accountEntries(world, OWNER)).toEqual(entries);
    expect(lstatSync(join(world.sandboxRoot, OWNER)).isDirectory()).toBe(true);
  });
});

describe("沙箱根在首次创建时才建出 (#930)", () => {
  it("app start leaves a missing SANDBOX_ROOT absent; the first bodyless create makes the sandbox root, the account root and tmp-<id>, each 2770", async () => {
    const { runtime, calls } = createRealFakeRuntime();
    const db = openDb(":memory:");
    const app = createApp({
      db,
      authRuntime: fixedRuntime(() => FIXED_NOW),
      assembly: { tokens: new TokenRegistry(), runtime, onError: () => {} },
    });
    fixtures.push({
      db,
      async close() {
        try {
          await app.close();
        } finally {
          db.close();
        }
      },
    });
    await app.ready();
    const cookie = await cookieFor(app, "zhangsan");
    expect(existsSync(runtime.sandboxRoot)).toBe(false);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
    });

    const view = created(response);
    expect(view.temporaryWorkspace).toBe(true);
    const chain = [
      runtime.sandboxRoot,
      join(runtime.sandboxRoot, OWNER),
      join(runtime.sandboxRoot, OWNER, `tmp-${view.workspaceId}`),
    ];
    for (const dir of chain) {
      const stats = lstatSync(dir);
      expect(stats.isDirectory(), dir).toBe(true);
      expect(stats.mode & 0o7777, dir).toBe(SHARED_MODE);
    }
    expect(readdirSync(runtime.sandboxRoot)).toEqual([OWNER]);
    expect(readdirSync(join(runtime.sandboxRoot, OWNER))).toEqual([`tmp-${view.workspaceId}`]);
    expect(calls).toEqual([]);
  });
});

describe("会话 REST — Create list and empty history (#930)", () => {
  it("create is 201 idle on a temporary workspace, the list has it, history is the four keys with the same session, all no-store", async () => {
    const world = await openWorld();

    const view = created(await post(world, world.other));

    expectTemporaryView(view, null);
    expect(await listed(world, world.other)).toEqual([view]);
    const history = await getSessionMessages(world.app, view.id, world.other);
    expect(history.statusCode).toBe(200);
    expect(history.headers["cache-control"]).toBe("no-store");
    const body = history.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["session", "messages", "streamCursor", "todo"]);
    expect(body).toEqual({
      session: view,
      messages: [],
      streamCursor: { epoch: 0, seq: null },
      todo: null,
    });
    expect(world.rt.calls).toEqual([]);
  });
});
