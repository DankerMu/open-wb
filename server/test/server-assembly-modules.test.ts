import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as accounts from "../src/accounts/index.js";
import { type CreateAppOptions, createApp } from "../src/app.js";
import * as auth from "../src/auth/index.js";
import * as connectors from "../src/connectors/rest.js";
import { openDb } from "../src/core/db/index.js";
import * as experts from "../src/experts/rest.js";
import * as http from "../src/http/index.js";
import * as modelProxy from "../src/model-proxy/index.js";
import * as models from "../src/models/rest.js";
import * as sessions from "../src/sessions/index.js";
import type { SessionSupervisorRuntime } from "../src/sessions/supervisor.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import * as skills from "../src/skills/rest.js";
import * as workspaces from "../src/workspaces/index.js";
import { compileServerEntry, releaseStartupFixtures } from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";
import { bearerCookie, loginSessionId, UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE, postPrompt } from "./session-rest-helpers.js";
import { seedMessage, seedSession, seedStep } from "./session-store-helpers.js";
import {
  closeOnEof,
  createControlledRuntime,
  createSession,
  requiredToken,
  type SpawnCall,
} from "./session-supervisor-helpers.js";

/**
 * Issue #101/#128 assembly baseline: registration order and the startup record's module list
 * (moved out of `server-assembly.test.ts`, s2a-kb-ragflow D18).
 * Order observation is a call-through spy on the live module exports.
 */

const STALE_SESSION_ID = "a".repeat(32);

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
const temps: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const db of databases.splice(0)) {
    db.close();
  }
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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

    expect(order).toEqual([
      "auth",
      "http",
      "model-proxy",
      "sessions",
      "workspaces",
      "accounts",
      "models",
      "experts",
      "skills",
      "connectors",
    ]);
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
      // A registered model: without upstream only that is 502 (s1d-model-registry check order).
      payload: JSON.stringify({ model: controlled.runtime.modelId }),
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
      payload: JSON.stringify({ model: controlled.runtime.modelId }),
    });
    expect(live.statusCode).toBe(502);
    expect(live.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
  });
});

describe("真实 createApp 挂载 workspaces 与 accounts", () => {
  it("call-through 注册顺序与 compiled STARTUP_MODULES 记录一致", async () => {
    const compiled = await compileServerEntry();
    const scratchRoot = mkdtempSync(join(tmpdir(), "open-wb-assembly-startup-"));
    temps.push(scratchRoot);
    const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: {
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: join(scratchRoot, "db", "dev.db"),
        OMP_STATE_DIR: join(scratchRoot, "state"),
        SANDBOX_ROOT: join(scratchRoot, "sandbox"),
        OMP_BIN: join(scratchRoot, "bin", "omp"),
      },
    }));
    try {
      const started = (await server.waitForStarted()) as { modules: string[] };
      const order = spyRegistrationOrder();
      const { app } = openCurrentApp();
      await app.ready();
      expect(["core/db", ...order]).toEqual([
        "core/db",
        "auth",
        "http",
        "model-proxy",
        "sessions",
        "workspaces",
        "accounts",
        "models",
        "experts",
        "skills",
        "connectors",
      ]);
      expect(started.modules).toEqual(["core/db", ...order]);
      expect(existsSync(join(scratchRoot, "sandbox", "u1"))).toBe(false);
    } finally {
      await server.dispose();
      await releaseStartupFixtures();
    }
  }, 90_000);
});

/** Records each module's registration call (then runs the real one) in the order createApp makes it. */
function spyRegistrationOrder(): string[] {
  const order: string[] = [];
  const once = <M extends object>(label: string, module: M, name: keyof M & string): void => {
    const registrations = module as Record<string, (...args: unknown[]) => unknown>;
    const register = registrations[name] as (...args: unknown[]) => unknown;
    vi.spyOn(registrations, name).mockImplementationOnce((...args) => {
      order.push(label);
      return register(...args);
    });
  };
  once("auth", auth, "registerAuth");
  once("http", http, "registerAuthGuard");
  once("model-proxy", modelProxy, "registerModelProxy");
  once("sessions", sessions, "registerSessions");
  once("workspaces", workspaces, "registerWorkspaces");
  once("accounts", accounts, "registerAccounts");
  once("models", models, "registerModels");
  once("experts", experts, "registerExperts");
  once("skills", skills, "registerSkills");
  once("connectors", connectors, "registerConnectors");
  return order;
}

function openCurrentApp(): { app: FastifyInstance } {
  const app = createApp({ db: track(openDb(":memory:")) });
  apps.push(app);
  return { app };
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
  const prompt = await postPrompt(app, sessionId, cookie, JSON.stringify({ message: "hello" }));
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
