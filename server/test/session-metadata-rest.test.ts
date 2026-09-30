/**
 * Issue #523 POST /api/sessions optional body (parent s1c-session-metadata-presentation tasks 4.1,
 * design D2): workspace binding, scene choice and the same-transaction `session.bind` audit.
 * Every world is the production createApp → registerSessions assembly (`openBareSession`, which
 * pre-creates one unbound zhangsan session) over the real fake-omp runtime, driven through
 * `app.inject()` on a real in-memory SQLite. Workspaces are created over `POST /api/workspaces`
 * (the sandbox root is created first: the workspace store realpaths it). Oracles: response status,
 * headers and bytes, SQLite rows, `GET /api/audit` per account role and the recorded spawn calls.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
} from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  OWNER_ID,
  openBareSession,
  type RealFakeRuntime,
  type SupervisorApp,
} from "./session-supervisor-helpers.js";

const JSON_TYPE = "application/json";
const BODY_LIMIT = 16 * 1024;
const EIGHT_KEYS = [
  "id",
  "title",
  "status",
  "createdAt",
  "updatedAt",
  "scene",
  "workspaceId",
  "pinnedAt",
] as const;
const SESSION_ID = /^[0-9a-f]{32}$/u;

const fixtures: SupervisorApp[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

interface World {
  app: FastifyInstance;
  db: DatabaseSync;
  cookie: string;
  rt: RealFakeRuntime;
}

interface Workspace {
  id: string;
  root: string;
}

interface CreatedSession {
  id: string;
  title: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  scene: string | null;
  workspaceId: string | null;
  pinnedAt: number | null;
}

interface AuditEventWire {
  id: number;
  ts: number;
  actorId: string;
  kind: string;
  title: string;
  detail: unknown;
  workspaceId: string | null;
}

interface CreateRequest {
  payload?: string;
  contentType?: string;
  cookie?: string;
}

async function openWorld(): Promise<World> {
  const rt = createRealFakeRuntime();
  const { fixture, cookie } = await openBareSession(rt.runtime);
  fixtures.push(fixture);
  mkdirSync(rt.runtime.sandboxRoot, { recursive: true });
  return { app: fixture.app, db: fixture.db, cookie, rt };
}

function postCreate(world: World, request: CreateRequest = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { cookie: request.cookie ?? world.cookie };
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

function postJson(world: World, value: unknown, cookie?: string): Promise<LightMyRequestResponse> {
  return postCreate(world, {
    payload: JSON.stringify(value),
    contentType: JSON_TYPE,
    ...(cookie === undefined ? {} : { cookie }),
  });
}

async function createWorkspace(world: World, name: string): Promise<Workspace> {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { "content-type": JSON_TYPE, cookie: world.cookie },
    payload: JSON.stringify({ name, dir: name }),
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Workspace;
}

async function auditEvents(world: World, cookie: string): Promise<AuditEventWire[]> {
  const response = await world.app.inject({
    method: "GET",
    url: "/api/audit?limit=200",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { events: AuditEventWire[] }).events;
}

function rowCounts(db: DatabaseSync): { sessions: number; audits: number } {
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { sessions: count("chat_sessions"), audits: count("audit_events") };
}

function sessionColumns(db: DatabaseSync, id: string): unknown {
  return db
    .prepare(
      "SELECT owner_id, title, status, created_at, updated_at, workspace_id, scene, pinned_at FROM chat_sessions WHERE id = ?",
    )
    .get(id);
}

/** 201 + no-store + exactly the eight keys in wire order with the default columns. */
function expectCreated(
  response: LightMyRequestResponse,
  expected: { scene: string | null; workspaceId: string | null },
): CreatedSession {
  expect(response.statusCode).toBe(201);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json() as CreatedSession;
  expect(Object.keys(body)).toEqual([...EIGHT_KEYS]);
  expect(body).toEqual({
    id: expect.stringMatching(SESSION_ID),
    title: null,
    status: "idle",
    createdAt: body.createdAt,
    updatedAt: body.createdAt,
    scene: expected.scene,
    workspaceId: expected.workspaceId,
    pinnedAt: null,
  });
  expect(Number.isSafeInteger(body.createdAt)).toBe(true);
  return body;
}

/** The `GET /api/audit` wire form of one zhangsan `session.bind` event. */
function bindEvent(sessionId: string, workspaceId: string, scene: string | null) {
  return {
    id: expect.any(Number),
    ts: expect.any(Number),
    actorId: OWNER_ID,
    kind: "session.bind",
    title: "绑定工作空间",
    detail: { sessionId, scene },
    workspaceId,
  };
}

function wireShape(response: LightMyRequestResponse) {
  return {
    status: response.statusCode,
    cacheControl: response.headers["cache-control"],
    contentType: response.headers["content-type"],
    contentLength: response.headers["content-length"],
    body: response.payload,
  };
}

/** `{"scene":"code"}` padded with trailing ASCII spaces to exactly `bytes` bytes. */
function paddedSceneBody(bytes: number): string {
  const core = JSON.stringify({ scene: "code" });
  const payload = core + " ".repeat(bytes - core.length);
  expect(Buffer.byteLength(payload, "utf8")).toBe(bytes);
  return payload;
}

describe("POST /api/sessions default creation", () => {
  it("E1 no body and JSON {} both create the default eight-key session without audit", async () => {
    const world = await openWorld();
    const before = rowCounts(world.db);

    const bodyless = expectCreated(await postCreate(world), { scene: null, workspaceId: null });
    const empty = expectCreated(await postJson(world, {}), { scene: null, workspaceId: null });

    expect(bodyless.id).not.toBe(empty.id);
    expect(rowCounts(world.db)).toEqual({ sessions: before.sessions + 2, audits: before.audits });
    expect(sessionColumns(world.db, empty.id)).toEqual({
      owner_id: OWNER_ID,
      title: null,
      status: "idle",
      created_at: empty.createdAt,
      updated_at: empty.createdAt,
      workspace_id: null,
      scene: null,
      pinned_at: null,
    });
    expect(world.rt.calls).toEqual([]);
  });
});

describe("POST /api/sessions workspace binding and scene", () => {
  it("E2 binds an owned workspace with a scene, audits session.bind and spawns nothing", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    const auditBefore = await auditEvents(world, world.cookie);
    const before = rowCounts(world.db);

    const created = expectCreated(
      await postJson(world, { workspaceId: workspace.id, scene: "code" }),
      { scene: "code", workspaceId: workspace.id },
    );

    expect(rowCounts(world.db)).toEqual({
      sessions: before.sessions + 1,
      audits: before.audits + 1,
    });
    expect(sessionColumns(world.db, created.id)).toMatchObject({
      owner_id: OWNER_ID,
      workspace_id: workspace.id,
      scene: "code",
      pinned_at: null,
    });
    const auditAfter = await auditEvents(world, world.cookie);
    expect(auditAfter.slice(1)).toEqual(auditBefore);
    expect(auditAfter[0]).toEqual(bindEvent(created.id, workspace.id, "code"));
    const listed = await world.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: world.cookie },
    });
    const sessions = (listed.json() as { sessions: CreatedSession[] }).sessions;
    const row = sessions.find((session) => session.id === created.id);
    expect(row).toEqual(created);
    expect(Object.keys(row ?? {})).toEqual([...EIGHT_KEYS]);
    expect(world.rt.calls).toEqual([]);
  });

  it("E2 scene-only is unaudited; workspace-only audits a null scene", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    const before = rowCounts(world.db);

    const sceneOnly = expectCreated(await postJson(world, { scene: "design" }), {
      scene: "design",
      workspaceId: null,
    });
    expect(rowCounts(world.db)).toEqual({ sessions: before.sessions + 1, audits: before.audits });
    expect(sessionColumns(world.db, sceneOnly.id)).toMatchObject({
      workspace_id: null,
      scene: "design",
    });

    const boundOnly = expectCreated(await postJson(world, { workspaceId: workspace.id }), {
      scene: null,
      workspaceId: workspace.id,
    });
    expect(rowCounts(world.db)).toEqual({
      sessions: before.sessions + 2,
      audits: before.audits + 1,
    });
    expect(
      world.db
        .prepare("SELECT actor_id, kind, detail, workspace_id FROM audit_events ORDER BY id DESC")
        .get(),
    ).toEqual({
      actor_id: OWNER_ID,
      kind: "session.bind",
      detail: JSON.stringify({ sessionId: boundOnly.id, scene: null }),
      workspace_id: workspace.id,
    });
    expect(world.rt.calls).toEqual([]);
  });

  it("E3 another owner's, an unknown and a malformed workspace id are byte-identical 404s", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    const other = await cookieFor(world.app, "zhaoliu");
    const before = rowCounts(world.db);

    const foreign = await postJson(world, { workspaceId: workspace.id }, other);
    const unknown = await postJson(world, { workspaceId: randomBytes(16).toString("hex") });
    const malformed = await postJson(world, { workspaceId: "abc", scene: "office" });

    const envelope = JSON.stringify(NOT_FOUND_ENVELOPE);
    const expected = {
      status: 404,
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      contentLength: String(Buffer.byteLength(envelope, "utf8")),
      body: envelope,
    };
    expect(wireShape(foreign)).toEqual(expected);
    expect(wireShape(unknown)).toEqual(expected);
    expect(wireShape(malformed)).toEqual(expected);
    expect(rowCounts(world.db)).toEqual(before);
  });
});

describe("POST /api/sessions body validation", () => {
  it("E4 every non-subset shape is a no-store 400 with no write", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    const before = rowCounts(world.db);
    const shapes: unknown[] = [
      { scene: "chat" },
      { scene: null },
      { scene: "Office" },
      { scene: "" },
      { workspaceId: null },
      { workspaceId: 1 },
      { workspaceId: workspace.id, scene: "CODE" },
      { title: "x" },
      { workspaceId: workspace.id, extra: true },
      [],
      null,
      "x",
    ];

    for (const shape of shapes) {
      expectEnvelope(await postJson(world, shape), 400, BAD_REQUEST_ENVELOPE);
    }
    expect(rowCounts(world.db)).toEqual(before);
  });

  it("E5 malformed, empty and non-JSON media parser failures are owned 400s", async () => {
    const world = await openWorld();
    const before = rowCounts(world.db);
    const failures: CreateRequest[] = [
      { payload: '{"scene": ', contentType: JSON_TYPE },
      { payload: "", contentType: JSON_TYPE },
      { payload: "binary", contentType: "application/octet-stream" },
    ];

    for (const request of failures) {
      expectEnvelope(await postCreate(world, request), 400, BAD_REQUEST_ENVELOPE);
    }
    expect(rowCounts(world.db)).toEqual(before);
  });

  it("E5 over 16 KiB and text/plain bodies are 400s; exactly 16 KiB is accepted", async () => {
    const world = await openWorld();
    const before = rowCounts(world.db);
    const rejected: CreateRequest[] = [
      { payload: paddedSceneBody(BODY_LIMIT + 1), contentType: JSON_TYPE },
      {
        payload: JSON.stringify({ scene: "code", pad: "x".repeat(BODY_LIMIT) }),
        contentType: JSON_TYPE,
      },
      { payload: "{}", contentType: "text/plain" },
      { payload: '{"scene":"code"}', contentType: "text/plain" },
    ];

    for (const request of rejected) {
      expectEnvelope(await postCreate(world, request), 400, BAD_REQUEST_ENVELOPE);
    }
    expect(rowCounts(world.db)).toEqual(before);

    const boundary = paddedSceneBody(BODY_LIMIT);
    expectCreated(await postCreate(world, { payload: boundary, contentType: JSON_TYPE }), {
      scene: "code",
      workspaceId: null,
    });
    expect(rowCounts(world.db)).toEqual({ sessions: before.sessions + 1, audits: before.audits });
  });
});

describe("POST /api/sessions audit atomicity and visibility", () => {
  it("E6 a failed session.bind write rolls the session row back; unbound creation is unaffected", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    world.db.exec(`CREATE TEMP TRIGGER reject_audit
      BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit denied'); END`);
    try {
      const before = rowCounts(world.db);

      const bound = await postJson(world, { workspaceId: workspace.id, scene: "code" });
      expectEnvelope(bound, 500, INTERNAL_ERROR_ENVELOPE);
      expect(rowCounts(world.db)).toEqual(before);
      expect(world.db.isTransaction).toBe(false);

      expectCreated(await postJson(world, { scene: "office" }), {
        scene: "office",
        workspaceId: null,
      });
      expect(rowCounts(world.db)).toEqual({
        sessions: before.sessions + 1,
        audits: before.audits,
      });
    } finally {
      world.db.exec("DROP TRIGGER reject_audit");
    }
    expect(world.rt.calls).toEqual([]);
  });

  it("E7 the admin audit view returns session.bind; another member's view does not", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    const created = expectCreated(
      await postJson(world, { workspaceId: workspace.id, scene: "code" }),
      { scene: "code", workspaceId: workspace.id },
    );
    const admin = await auditEvents(world, await cookieFor(world.app, "lisi"));
    expect(admin.filter((event) => event.kind === "session.bind")).toEqual([
      bindEvent(created.id, workspace.id, "code"),
    ]);

    const member = await auditEvents(world, await cookieFor(world.app, "zhaoliu"));
    expect(member.filter((event) => event.kind === "session.bind")).toEqual([]);
    expect(member.every((event) => event.actorId === "u2")).toBe(true);
  });

  it("E8 a workspace root that is no longer a directory is a generic 500 with no write", async () => {
    const world = await openWorld();
    const workspace = await createWorkspace(world, "proj");
    rmSync(workspace.root, { recursive: true });
    writeFileSync(workspace.root, "not a directory");
    const before = rowCounts(world.db);

    const response = await postJson(world, { workspaceId: workspace.id, scene: "code" });

    expectEnvelope(response, 500, INTERNAL_ERROR_ENVELOPE);
    expect(rowCounts(world.db)).toEqual(before);
    expect(world.rt.calls).toEqual([]);
  });
});
