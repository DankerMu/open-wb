/**
 * Issue #921 (s1f-session-list-temp-space task 1.3): the session view's three extension keys
 * `archivedAt` / `pendingApproval` / `temporaryWorkspace` through the REST seam — session-metadata
 * 「会话视图扩展键」 (三键的取值 / 待决确认随结算消失 / 各出口一致) and chat-sessions 「Session views
 * carry the three extension keys」. Temporary workspaces have no REST write entry yet (and cannot
 * be bound by id, #925), so those rows are planted by SQL or the 3.2 helper. Oracles: the spec's
 * key order and the literals written here, never a view returned by the store.
 */
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { ensureSharedDir } from "../src/core/sandbox/dirs.js";
import { createWorkspaceStore } from "../src/workspaces/store.js";
import {
  type ApprovalWorld,
  openApprovalWorld,
  pendingApproval,
  REAL,
} from "./session-approval-helpers.js";
import {
  cookieFor,
  getSessionMessages,
  SESSION_NOW,
  withSessionRest,
} from "./session-rest-helpers.js";
import { seedMessage, seedSession } from "./session-store-helpers.js";
import { OWNER_ID, waitForTurn } from "./session-supervisor-helpers.js";
import { seedTemporaryWorkspaceSession } from "./support/temporary-workspace.js";
import { insertWorkspace } from "./workspaces-http-helpers.js";

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
const ORDINARY_WORKSPACE = "a".repeat(32);
const TEMPORARY_WORKSPACE = "b".repeat(32);
const ORPHAN_SESSION = "c".repeat(32);
const ARCHIVED_AT = 1_740_000_000_777;
const REQUESTED_AT = 1_700_000_000_000;
const JSON_TYPE = "application/json";

type View = Record<string, unknown> & { id: string };

const worlds: ApprovalWorld[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const world of worlds.splice(0)) {
    await world.fixture.close();
  }
});

/** A freshly created, never prompted session's view with the given workspace and extension keys. */
function idleView(id: string, overrides: Record<string, unknown> = {}): View {
  return {
    id,
    title: null,
    status: "idle",
    createdAt: SESSION_NOW,
    updatedAt: SESSION_NOW,
    scene: null,
    workspaceId: null,
    pinnedAt: null,
    archivedAt: null,
    pendingApproval: false,
    temporaryWorkspace: false,
    ...overrides,
  };
}

async function listed(app: FastifyInstance, cookie: string): Promise<View[]> {
  const response = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { sessions: View[] }).sessions;
}

async function listedView(app: FastifyInstance, cookie: string, id: string): Promise<View> {
  const found = (await listed(app, cookie)).find((session) => session.id === id);
  if (found === undefined) {
    throw new Error(`session ${id} is not listed`);
  }
  return found;
}

async function snapshotView(app: FastifyInstance, cookie: string, id: string): Promise<View> {
  const response = await getSessionMessages(app, id, cookie);
  expect(response.statusCode).toBe(200);
  return (response.json() as { session: View }).session;
}

function updateOne(db: DatabaseSync, sql: string, ...values: Array<string | number>): void {
  expect(db.prepare(sql).run(...values).changes).toBe(1);
}

function bind(db: DatabaseSync, sessionId: string, workspaceId: string): void {
  updateOne(db, "UPDATE chat_sessions SET workspace_id = ? WHERE id = ?", workspaceId, sessionId);
}

function plantWorkspaces(db: DatabaseSync): void {
  insertWorkspace(db, ORDINARY_WORKSPACE, "u1", "周报空间", "weekly", SESSION_NOW);
  insertWorkspace(db, TEMPORARY_WORKSPACE, "u1", "tmp-b", "tmp-b", SESSION_NOW);
  updateOne(db, "UPDATE workspaces SET temporary = 1 WHERE id = ?", TEMPORARY_WORKSPACE);
}

function archive(db: DatabaseSync, sessionId: string): void {
  updateOne(db, "UPDATE chat_sessions SET archived_at = ? WHERE id = ?", ARCHIVED_AT, sessionId);
}

describe("会话视图扩展键 (deterministic store)", () => {
  it("三键的取值：五个会话各十一键，仅对应的那一个取非默认值，列表项与快照 session 逐键相等", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      plantWorkspaces(db);
      const a = store.create("u1").id;
      const b = store.create("u1").id;
      const c = store.create("u1").id;
      const d = store.create("u1").id;
      const e = store.create("u1").id;
      bind(db, a, ORDINARY_WORKSPACE);
      bind(db, b, TEMPORARY_WORKSPACE);
      archive(db, d);
      store.acceptPrompt(e, "u1", "等待确认");
      store.insertApproval(e, { requestId: "r1", tool: "bash", title: "Allow" }, REQUESTED_AT);
      const cookie = await cookieFor(app, "zhangsan");

      const sessions = await listed(app, cookie);

      expect(sessions).toHaveLength(5);
      for (const session of sessions) {
        expect(Object.keys(session)).toEqual(ELEVEN_KEYS);
      }
      const byId = new Map(sessions.map((session) => [session.id, session]));
      expect(byId.get(a)).toEqual(idleView(a, { workspaceId: ORDINARY_WORKSPACE }));
      expect(byId.get(b)).toEqual(
        idleView(b, { workspaceId: TEMPORARY_WORKSPACE, temporaryWorkspace: true }),
      );
      expect(byId.get(c)).toEqual(idleView(c));
      expect(byId.get(d)).toEqual(idleView(d, { archivedAt: ARCHIVED_AT }));
      expect(byId.get(e)).toEqual(
        idleView(e, { title: "等待确认", status: "running", pendingApproval: true }),
      );

      for (const session of sessions) {
        const snapshot = await snapshotView(app, cookie, session.id);
        expect(Object.keys(snapshot)).toEqual(ELEVEN_KEYS);
        expect(snapshot).toEqual(session);
      }
    });
  });

  it("待决确认随结算消失：作答 allow 之后 pendingApproval 为 false", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1").id;
      store.acceptPrompt(session, "u1", "allow me");
      const { approvalId } = store.insertApproval(
        session,
        { requestId: "r1", tool: "bash", title: "Allow" },
        REQUESTED_AT,
      );
      const cookie = await cookieFor(app, "zhangsan");
      expect((await listedView(app, cookie, session)).pendingApproval).toBe(true);

      expect(store.settleApproval(session, approvalId, "allow", REQUESTED_AT + 1)).not.toBeNull();

      expect((await listedView(app, cookie, session)).pendingApproval).toBe(false);
      expect((await snapshotView(app, cookie, session)).pendingApproval).toBe(false);
    });
  });

  it("待决确认随结算消失：审批待决时回合被停止之后 pendingApproval 为 false", async () => {
    await withSessionRest(async ({ app, store }) => {
      const session = store.create("u1").id;
      const turn = store.acceptPrompt(session, "u1", "stop me");
      store.insertApproval(
        session,
        { requestId: "r1", tool: "bash", title: "Allow" },
        REQUESTED_AT,
      );
      const cookie = await cookieFor(app, "zhangsan");
      expect((await listedView(app, cookie, session)).pendingApproval).toBe(true);

      expect(store.finishTurn(turn.assistantMessageId, "stopped")).toBe(true);

      const after = await listedView(app, cookie, session);
      expect(after.status).toBe("stopped");
      expect(after.pendingApproval).toBe(false);
    });
  });

  it("待决确认随结算消失：上一个进程留下的待决审批在启动对账之后 pendingApproval 为 false", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      seedSession(db, {
        id: ORPHAN_SESSION,
        ownerId: "u1",
        title: "orphan",
        status: "running",
        ompSessionFile: null,
        streamEpoch: 1,
        createdAt: SESSION_NOW,
        updatedAt: SESSION_NOW,
      });
      const message = seedMessage(db, {
        sessionId: ORPHAN_SESSION,
        role: "assistant",
        content: "",
        status: "running",
        createdAt: SESSION_NOW,
      });
      db.prepare(
        `INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at)
         VALUES (?, 'r1', 'bash', 'Allow', ?, ?)`,
      ).run(message, REQUESTED_AT, REQUESTED_AT + 60_000);
      const cookie = await cookieFor(app, "zhangsan");
      expect((await listedView(app, cookie, ORPHAN_SESSION)).pendingApproval).toBe(true);

      store.reconcileOnStartup();

      const after = await listedView(app, cookie, ORPHAN_SESSION);
      expect(after.status).toBe("failed");
      expect(after.pendingApproval).toBe(false);
    });
  });

  it("各出口一致：列表项、快照 session 与 PATCH {pinned:true} 的响应键集相同，只有 pinnedAt 不同", async () => {
    await withSessionRest(async ({ app, db, store }) => {
      plantWorkspaces(db);
      const session = store.create("u1").id;
      bind(db, session, TEMPORARY_WORKSPACE);
      archive(db, session);
      store.acceptPrompt(session, "u1", "三键都非默认");
      store.insertApproval(
        session,
        { requestId: "r1", tool: "bash", title: "Allow" },
        REQUESTED_AT,
      );
      const cookie = await cookieFor(app, "zhangsan");
      const expected = idleView(session, {
        title: "三键都非默认",
        status: "running",
        workspaceId: TEMPORARY_WORKSPACE,
        archivedAt: ARCHIVED_AT,
        pendingApproval: true,
        temporaryWorkspace: true,
      });

      const fromList = await listedView(app, cookie, session);
      const fromSnapshot = await snapshotView(app, cookie, session);
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${session}`,
        headers: { "content-type": JSON_TYPE, cookie },
        payload: JSON.stringify({ pinned: true }),
      });

      expect(patched.statusCode).toBe(200);
      const fromPatch = patched.json() as View;
      expect(fromList).toEqual(expected);
      expect(fromSnapshot).toEqual(expected);
      expect(fromPatch).toEqual({ ...expected, pinnedAt: SESSION_NOW });
      for (const view of [fromList, fromSnapshot, fromPatch]) {
        expect(Object.keys(view)).toEqual(ELEVEN_KEYS);
      }
    });
  });

  it("无 body 创建的 201 视图恰十一键，三键为 null / false / true（新建的临时空间），并与列表项相等", async () => {
    await withSessionRest(async ({ app }) => {
      const cookie = await cookieFor(app, "zhangsan");

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
      });

      expect(created.statusCode).toBe(201);
      const body = created.json() as View;
      expect(Object.keys(body)).toEqual(ELEVEN_KEYS);
      // A create without a workspace makes a temporary one (#930): a fresh 32-hex id.
      expect(body).toEqual(
        idleView(body.id, {
          workspaceId: expect.stringMatching(/^[0-9a-f]{32}$/u),
          temporaryWorkspace: true,
        }),
      );
      expect(await listed(app, cookie)).toEqual([body]);
    });
  });
});

describe("会话视图扩展键 over the production assembly (real fake-omp approval)", () => {
  async function open(): Promise<ApprovalWorld> {
    const world = await openApprovalWorld("approval");
    worlds.push(world);
    return world;
  }

  it(
    "回合中有一条待决审批时 pendingApproval 为 true，作答 allow 后读回 false；列表项与快照 session 相等",
    REAL,
    async () => {
      const world = await open();
      const { app } = world.fixture;
      const row = await pendingApproval(world);

      const pending = await listedView(app, world.cookie, world.session);
      expect(Object.keys(pending)).toEqual(ELEVEN_KEYS);
      expect(pending).toMatchObject({
        status: "running",
        archivedAt: null,
        pendingApproval: true,
        // The world's session was created without a workspace: it uses a temporary one (#930).
        temporaryWorkspace: true,
      });
      expect(await snapshotView(app, world.cookie, world.session)).toEqual(pending);

      const answered = await app.inject({
        method: "POST",
        url: `/api/sessions/${world.session}/approvals/${String(row.id)}`,
        headers: { "content-type": JSON_TYPE, cookie: world.cookie },
        payload: JSON.stringify({ decision: "allow" }),
      });
      expect(answered.statusCode).toBe(200);
      expect((await listedView(app, world.cookie, world.session)).pendingApproval).toBe(false);
      await waitForTurn(world.fixture, world.session, "done");

      const settled = await listedView(app, world.cookie, world.session);
      expect(Object.keys(settled)).toEqual(ELEVEN_KEYS);
      expect(settled).toMatchObject({ status: "done", pendingApproval: false });
      expect(await snapshotView(app, world.cookie, world.session)).toEqual(settled);
    },
  );

  it(
    "绑定创建的 201 视图与列表项相等：正式空间 temporaryWorkspace 为 false；用临时空间的会话读回 true，显式绑定它是 404",
    REAL,
    async () => {
      const world = await open();
      const { app, db } = world.fixture;
      const { sandboxRoot } = world.rt.runtime;
      mkdirSync(sandboxRoot, { recursive: true });
      const response = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: { "content-type": JSON_TYPE, cookie: world.cookie },
        payload: JSON.stringify({ name: "view-keys-ordinary", dir: "view-keys-ordinary" }),
      });
      expect(response.statusCode).toBe(201);
      const ordinary = (response.json() as { id: string }).id;

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { "content-type": JSON_TYPE, cookie: world.cookie },
        payload: JSON.stringify({ workspaceId: ordinary }),
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as View;
      expect(Object.keys(body)).toEqual(ELEVEN_KEYS);
      expect(body).toMatchObject({
        workspaceId: ordinary,
        archivedAt: null,
        pendingApproval: false,
        temporaryWorkspace: false,
      });
      expect(await listedView(app, world.cookie, body.id)).toEqual(body);

      // A temporary workspace cannot be bound through POST /api/sessions (#925): its session comes
      // from the store's own createTemporary plus a planted row.
      const workspaces = createWorkspaceStore(db, { sandboxRoot, ensureSharedDir, emit });
      const temporary = seedTemporaryWorkspaceSession(db, workspaces, OWNER_ID, ORPHAN_SESSION).id;
      const refused = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { "content-type": JSON_TYPE, cookie: world.cookie },
        payload: JSON.stringify({ workspaceId: temporary }),
      });
      expect(refused.statusCode).toBe(404);
      const listedTemporary = await listedView(app, world.cookie, ORPHAN_SESSION);
      expect(Object.keys(listedTemporary)).toEqual(ELEVEN_KEYS);
      expect(listedTemporary).toMatchObject({
        workspaceId: temporary,
        archivedAt: null,
        pendingApproval: false,
        temporaryWorkspace: true,
      });
      expect(await snapshotView(app, world.cookie, ORPHAN_SESSION)).toEqual(listedTemporary);
    },
  );
});
