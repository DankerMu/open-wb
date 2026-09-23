import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  recordedSpawn,
  requiredToken,
  type SpawnCall,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

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
const temps: string[] = [];
const fakeChildren: FakeChild[][] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const children of fakeChildren.splice(0)) {
    for (const child of children) {
      child.destroy();
    }
  }
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

describe("真实配置经认证 prompt 抵达 spawn", () => {
  it("配置用户 omp 时捕获 sudo 前缀，未配置时保持直接 OMP_BIN", async () => {
    const roots = makeAssemblyRoots();
    const configured = await captureAuthenticatedSpawn(roots, "omp");
    const unset = await captureAuthenticatedSpawn(roots);
    const directArgs = ompArgs(roots, unset.cwd);
    expect(configured.command).toBe("sudo");
    expect(configured.args).toEqual([
      "-n",
      "-u",
      "omp",
      "--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN",
      "--",
      roots.bin,
      ...directArgs,
    ]);
    expect(unset.command).toBe(roots.bin);
    expect(unset.args).toEqual(directArgs);
    expect(configured.cwd).toBe(join(roots.sandboxRoot, "u1"));
    expect(unset.cwd).toBe(configured.cwd);
    expect(configured.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(unset.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(configured.shell).toBe(false);
    expect(configured.env.HOME).toBe(join(roots.stateDir, "home"));
    expect(configured.env.PI_CODING_AGENT_DIR).toBe(join(roots.stateDir, "agent"));
    expect(configured.env.WORKBUDDY_MODEL_TOKEN).toBe(configured.token);
    expect(unset.env.WORKBUDDY_MODEL_TOKEN).toBe(unset.token);
    expect(allowlistWithoutToken(unset.env)).toEqual(allowlistWithoutToken(configured.env));
    expect(JSON.stringify(configured.args)).not.toContain(configured.token ?? "");
    expect(JSON.stringify(unset.args)).not.toContain(unset.token ?? "");
    expect(configured.env).not.toHaveProperty("OMP_USER");
    expect(configured.env).not.toHaveProperty("MODEL_UPSTREAM_API_KEY");
  });

  it("sudo 形态子进程在就绪前退出时返回 agent_unavailable，撤销 token，且不降级直启", async () => {
    const roots = makeAssemblyRoots();
    const tokens = new TokenRegistry();
    const calls: SpawnCall[] = [];
    const children: FakeChild[] = [];
    fakeChildren.push(children);
    const app = createApp({
      db: track(openDb(":memory:")),
      assembly: {
        tokens,
        runtime: {
          bin: roots.bin,
          sandboxRoot: roots.sandboxRoot,
          stateDir: roots.stateDir,
          modelId: "deepseek-v4.1-flash",
          ompUser: "omp",
          spawnImpl: (command, args, options) => {
            calls.push(recordedSpawn(command, args, options));
            const child = immediateExitChild();
            children.push(child);
            return child.spawnImpl(command, args, options);
          },
        },
        onError: () => {},
      },
    });
    apps.push(app);
    const prompt = await promptHello(app);
    expect(prompt.statusCode).toBe(502);
    expect(prompt.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("sudo");
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      "-n",
      "-u",
      "omp",
      "--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN",
      "--",
      roots.bin,
    ]);
    expect(calls.some((call) => call.command === roots.bin)).toBe(false);
    const issued = calls[0]?.token;
    expect(issued).toEqual(expect.any(String));
    expect(tokens.lookup(issued ?? "")).toBeNull();
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
  const prompt = await postHello(app, sessionId, cookie);
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

function makeAssemblyRoots(): { root: string; bin: string; sandboxRoot: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "omp-user-assembly-"));
  temps.push(root);
  return {
    root,
    bin: join(root, "spaced bin", "omp"),
    sandboxRoot: join(root, "sandbox root"),
    stateDir: join(root, "state dir"),
  };
}

async function captureAuthenticatedSpawn(
  roots: { bin: string; sandboxRoot: string; stateDir: string },
  user?: string,
): Promise<SpawnCall> {
  const controlled = createControlledRuntime(() => {});
  fakeChildren.push(controlled.children);
  const calls = controlled.calls;
  const app = createApp({
    db: track(openDb(":memory:")),
    assembly: {
      tokens: new TokenRegistry(),
      runtime: {
        ...controlled.runtime,
        bin: roots.bin,
        sandboxRoot: roots.sandboxRoot,
        stateDir: roots.stateDir,
        modelId: "deepseek-v4.1-flash",
        ...(user === undefined ? {} : { ompUser: user }),
      },
      onError: () => {},
    },
  });
  apps.push(app);
  const prompt = await promptHello(app);
  expect(prompt.statusCode).toBe(202);
  const call = calls[0];
  if (call === undefined) {
    throw new Error("authenticated prompt did not spawn");
  }
  return call;
}

async function promptHello(app: FastifyInstance) {
  const cookie = bearerCookie(await loginSessionId(app));
  const sessionId = await createSession(app, cookie);
  return postHello(app, sessionId, cookie);
}

function postHello(app: FastifyInstance, sessionId: string, cookie: string) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/prompt`,
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ message: "hello" }),
  });
}

function ompArgs(
  roots: { sandboxRoot: string; stateDir: string },
  cwd: string | undefined,
): string[] {
  return [
    "--mode",
    "rpc",
    "--cwd",
    cwd ?? join(roots.sandboxRoot, "u1"),
    "--session-dir",
    join(roots.stateDir, "sessions", "u1"),
    "--model",
    "workbuddy/deepseek-v4.1-flash",
    "--approval-mode",
    "yolo",
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
  ];
}

function immediateExitChild(): FakeChild {
  const runtime = createControlledRuntime((fake) => {
    fake.pid = undefined as unknown as number;
    fake.exit(1);
  });
  const spawned = runtime.children[0];
  if (spawned === undefined) {
    throw new Error("controlled runtime omitted child");
  }
  return spawned;
}

function allowlistWithoutToken(env: Record<string, string>): Record<string, string> {
  const { WORKBUDDY_MODEL_TOKEN: _token, ...rest } = env;
  return rest;
}
