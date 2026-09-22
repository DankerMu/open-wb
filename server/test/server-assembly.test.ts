import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CreateAppOptions, createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import * as modelProxy from "../src/model-proxy/index.js";
import * as sessions from "../src/sessions/index.js";
import type { SessionSupervisorRuntime } from "../src/sessions/supervisor.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import {
  bearerCookie,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { seedMessage, seedSession, seedStep } from "./session-store-helpers.js";
import {
  closeOnEof,
  createControlledRuntime,
  createSession,
  requiredToken,
  type SpawnCall,
} from "./session-supervisor-helpers.js";

/**
 * Issue #101 assembly baseline.
 * Order observation is a call-through spy on the live module exports.
 */

const STALE_SESSION_ID = "a".repeat(32);
const AGENT_UNAVAILABLE_ENVELOPE = {
  error: { code: "agent_unavailable", message: "Agent 运行时不可用" },
} as const;

interface AssemblyDependencies {
  tokens: TokenRegistry;
  upstream?: { baseUrl: string; apiKey: string } | undefined;
  runtime: SessionSupervisorRuntime;
  onError: (error: Error) => void;
}

type AssemblyAppOptions = CreateAppOptions & {
  assembly?: AssemblyDependencies;
};

const apps: FastifyInstance[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describe("真实 createApp 缺省挂载 sessions 与 model-proxy", () => {
  it("认证后 POST /api/sessions 创建会话并返回 201", async () => {
    const { app } = openCurrentApp();
    const cookie = bearerCookie(await loginSessionId(app));
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toEqual(NOT_FOUND_ENVELOPE);
  });

  it("未携带 bearer 的 POST /v1/chat/completions 返回 401 unauthorized", async () => {
    const { app } = openCurrentApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(UNAUTHORIZED_ENVELOPE);
  });

  it("调用方 DB 在 app.close 后仍可读取既有账号", async () => {
    const { app, db } = openCurrentApp();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(db.prepare("SELECT id FROM accounts ORDER BY id").all()).toEqual([
      { id: "u1" },
      { id: "u2" },
      { id: "u3" },
      { id: "u4" },
    ]);
  });
});

describe("真实 createApp 消费共享 registry 并先挂 proxy 再挂 sessions", () => {
  it("对账先于放量，prompt 发出的 token 能通过同一 registry 打到 proxy，旧 token 失效", async () => {
    const db = track(openDb(":memory:"));
    seedStaleRunningRows(db);
    const tokens = new TokenRegistry();
    const controlled = createControlledRuntime((child) => {
      closeOnEof(child);
    });
    const order = spyRegistrationOrder();
    const app = createApp({
      db,
      assembly: {
        tokens,
        runtime: controlled.runtime,
        onError: () => {},
      },
    } satisfies AssemblyAppOptions);
    apps.push(app);
    await app.ready();

    expect(order).toEqual(["model-proxy", "sessions"]);
    expect(rowStatus(db, "chat_sessions", STALE_SESSION_ID)).toBe("failed");
    expect(runningCount(db, "chat_messages")).toBe(0);
    expect(runningCount(db, "chat_steps")).toBe(0);

    const cookie = bearerCookie(await loginSessionId(app));
    const sessionId = await createSession(app, cookie);
    const anonymous = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual(UNAUTHORIZED_ENVELOPE);

    const retired = tokens.issue(sessionId);
    const issued = await promptAndCaptureToken(app, sessionId, cookie, controlled.calls);
    expect(issued).not.toBe(retired);
    expect(tokens.lookup(retired)).toBeNull();
    expect(tokens.lookup(issued)).toBe(sessionId);

    const cookieOnly = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { cookie, authorization: `Bearer ${retired}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(cookieOnly.statusCode).toBe(401);

    const live = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued}`, cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(live.statusCode).toBe(502);
    expect(live.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
  });

  it("缺席上游仍允许创建会话；非法 bearer 为 401，运行时发出的 bearer 为 502", async () => {
    const db = track(openDb(":memory:"));
    const tokens = new TokenRegistry();
    const controlled = createControlledRuntime((child) => {
      closeOnEof(child);
    });
    const app = createApp({
      db,
      assembly: {
        tokens,
        upstream: undefined,
        runtime: controlled.runtime,
        onError: () => {},
      },
    } satisfies AssemblyAppOptions);
    apps.push(app);
    await app.ready();

    const cookie = bearerCookie(await loginSessionId(app));
    const sessionId = await createSession(app, cookie);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer not-a-token", "content-type": "application/json" },
      payload: "{}",
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual(UNAUTHORIZED_ENVELOPE);

    const issued = await promptAndCaptureToken(app, sessionId, cookie, controlled.calls);
    const live = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${issued}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(live.statusCode).toBe(502);
    expect(live.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
  });
});
function spyRegistrationOrder(): string[] {
  const order: string[] = [];
  vi.spyOn(modelProxy, "registerModelProxy").mockImplementationOnce((app, options) => {
    order.push("model-proxy");
    return modelProxy.registerModelProxy(app, options);
  });
  vi.spyOn(sessions, "registerSessions").mockImplementationOnce((app, options) => {
    order.push("sessions");
    return sessions.registerSessions(app, options);
  });
  return order;
}

function openCurrentApp(): { app: FastifyInstance; db: DatabaseSync } {
  const db = track(openDb(":memory:"));
  const app = createApp({ db });
  apps.push(app);
  return { app, db };
}

function track(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
}

async function promptAndCaptureToken(
  app: FastifyInstance,
  sessionId: string,
  cookie: string,
  calls: readonly SpawnCall[],
): Promise<string> {
  const prompt = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/prompt`,
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ message: "hello" }),
  });
  expect(prompt.statusCode).toBe(202);
  return requiredToken(firstSpawn(calls).token);
}

function firstSpawn(calls: readonly SpawnCall[]): SpawnCall {
  const call = calls[0];
  if (call === undefined) {
    throw new Error("runtime did not spawn");
  }
  return call;
}

function seedStaleRunningRows(db: DatabaseSync): void {
  seedSession(db, {
    id: STALE_SESSION_ID,
    ownerId: "u1",
    title: null,
    status: "running",
    ompSessionFile: null,
    streamEpoch: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const messageId = seedMessage(db, {
    sessionId: STALE_SESSION_ID,
    role: "assistant",
    content: "",
    status: "running",
    createdAt: 1,
  });
  seedStep(db, {
    messageId,
    ordinal: 0,
    name: "stale",
    detail: "",
    status: "running",
    startedAt: 1,
    endedAt: null,
  });
}

function rowStatus(db: DatabaseSync, table: "chat_sessions", id: string): string {
  const row = db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id);
  if (
    row === undefined ||
    typeof row !== "object" ||
    !("status" in row) ||
    typeof row.status !== "string"
  ) {
    throw new Error(`missing ${table} row ${id}`);
  }
  return row.status;
}

function runningCount(db: DatabaseSync, table: "chat_messages" | "chat_steps"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status = 'running'`).get();
  if (row === undefined || typeof row !== "object" || !("count" in row)) {
    throw new Error(`missing count for ${table}`);
  }
  return Number(row.count);
}
