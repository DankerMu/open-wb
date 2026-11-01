import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import type { ModelCatalog } from "../src/model-catalog.js";
import type { SessionSupervisorRuntime } from "../src/sessions/supervisor.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { startRecordingUpstream } from "./model-proxy-helpers.js";
import {
  bearerCookie,
  loginSessionId,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  createControlledRuntime,
  createSession,
  recordedSpawn,
  type SpawnCall,
  sudoPrefix,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";
import { sessionConfigYml } from "./support/session-config.js";
import { useSetprivStub } from "./support/setpriv.js";

/**
 * Issue #101/#128 assembly baseline.
 */

const AGENT_UNAVAILABLE_ENVELOPE = {
  error: { code: "agent_unavailable", message: "Agent 运行时不可用" },
} as const;

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
    // The default assembly mounts the session routes. Its sandbox root is the repository's own
    // var directory, and a create makes a temporary workspace directory there since #930 — so the
    // create itself runs against the same assembly over a per-test sandbox root.
    const mounted = openCurrentApp().app;
    const listed = await mounted.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie: bearerCookie(await loginSessionId(mounted)) },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ sessions: [] });

    const { app } = openConfiguredAssemblyApp("open-wb-assembly-create-");
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

describe("真实配置经认证 prompt 抵达 spawn", () => {
  useSetprivStub();
  it("配置用户 omp 时捕获 sudo 前缀，未配置时保持直接 OMP_BIN", async () => {
    const roots = makeAssemblyRoots();
    const tmpdir = process.env.TMPDIR;
    const configured = await captureAuthenticatedSpawn(roots, "omp");
    const unset = await captureAuthenticatedSpawn(roots);
    // The two apps differ in `--cwd` only (each session's own temporary workspace, asserted below).
    expect(configured.command).toBe("sudo");
    expect(configured.args).toEqual([
      ...sudoPrefix("omp", roots.bin, tmpdir),
      ...ompArgs(roots, configured.cwd),
    ]);
    expect(unset.command).toBe(roots.bin);
    expect(unset.args).toEqual(ompArgs(roots, unset.cwd));
    // Each app's session was created without a workspace: it runs in the root of its own
    // temporary workspace (#930), no longer in the account root.
    // The store answers roots under the sandbox root's real path; the create made that root.
    const accountRoot = join(realpathSync(roots.sandboxRoot), "u1");
    expect(configured.cwd).toBe(join(accountRoot, `tmp-${configured.workspaceId}`));
    expect(unset.cwd).toBe(join(accountRoot, `tmp-${unset.workspaceId}`));
    expect(configured.workspaceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(unset.workspaceId).not.toBe(configured.workspaceId);
    expect(configured.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(unset.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(configured.shell).toBe(false);
    expect(configured.env.HOME).toBe(join(roots.stateDir, "home"));
    expect(configured.env.PI_CODING_AGENT_DIR).toBe(join(roots.stateDir, "home", ".omp", "agent"));
    expect(configured.env.XDG_DATA_HOME).toBe(join(roots.stateDir, "xdg", "data"));
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
    const tmpdir = process.env.TMPDIR;
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
    expect(calls[0]?.args).toEqual([
      ...sudoPrefix("omp", roots.bin, tmpdir),
      ...ompArgs(roots, calls[0]?.cwd),
    ]);
    expect(calls.some((call) => call.command === roots.bin)).toBe(false);
    const issued = calls[0]?.token;
    expect(issued).toEqual(expect.any(String));
    expect(tokens.lookup(issued ?? "")).toBeNull();
  });
});

describe("真实 createApp 挂载 workspaces 与 accounts", () => {
  it("认证后 GET /api/workspaces 与 GET /api/audit 返回真实形状与 no-store，匿名仍 401", async () => {
    const { app, db, sandboxRoot } = openConfiguredAssemblyApp("open-wb-assembly-sandbox-");
    const cookie = bearerCookie(await loginSessionId(app, "zhangsan"));

    const workspacesResponse = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie },
    });
    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json()).toEqual({ workspaces: [] });
    expect(workspacesResponse.headers["cache-control"]).toBe("no-store");

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie },
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json()).toEqual({ events: [] });
    expect(auditResponse.headers["cache-control"]).toBe("no-store");

    for (const url of ["/api/workspaces", "/api/audit"]) {
      const anonymous = await app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toEqual(UNAUTHORIZED_ENVELOPE);
      expect(anonymous.headers["cache-control"]).toBe("no-store");
    }

    expect(existsSync(join(sandboxRoot, "u1"))).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({ count: 0 });
  });

  it("同一装配把工作空间建在注入 runtime 根下，外账号管理员 404 无审计，属主越界 403 可经 GET /api/audit 看见", async () => {
    const { app, db, sandboxRoot } = openConfiguredAssemblyApp("open-wb-assembly-tenant-");
    const ownerCookie = bearerCookie(await loginSessionId(app, "zhangsan"));
    const adminCookie = bearerCookie(await loginSessionId(app, "lisi"));

    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      payload: JSON.stringify({ name: "assembly-root" }),
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json() as { id: string; root: string };
    expect(workspace.root).toBe(join(sandboxRoot, "u1", "assembly-root"));
    expect(existsSync(workspace.root)).toBe(true);

    const listed = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { cookie: ownerCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      workspaces: [
        expect.objectContaining({
          id: workspace.id,
          name: "assembly-root",
          dir: "assembly-root",
          root: workspace.root,
        }),
      ],
    });

    const tree = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/tree`,
      headers: { cookie: ownerCookie },
    });
    expect(tree.statusCode).toBe(200);
    // The repo-root marker is the new workspace's one entry (omp-runtime「会话工作目录的仓库根标记」).
    expect(tree.json()).toEqual({
      path: "",
      entries: [{ name: ".git", type: "dir", size: expect.any(Number), mtime: expect.any(Number) }],
    });

    const foreign = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/tree?path=../outside`,
      headers: { cookie: adminCookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(NOT_FOUND_ENVELOPE);
    expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({ count: 1 });

    const denied = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/tree?path=../outside`,
      headers: { cookie: ownerCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      error: { code: "sandbox_denied", message: "目标路径不在你的沙箱内，操作已拒绝" },
    });

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: ownerCookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toEqual({
      events: [
        expect.objectContaining({
          actorId: "u1",
          kind: "sandbox.reject",
          title: "越界访问被沙箱拦截",
          workspaceId: workspace.id,
          detail: { relPath: "../outside", op: "list", reason: expect.any(String) },
        }),
        expect.objectContaining({
          actorId: "u1",
          kind: "workspace.create",
          title: "创建工作空间 assembly-root",
          workspaceId: workspace.id,
        }),
      ],
    });

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(db.prepare("SELECT id FROM accounts WHERE id = 'u1'").get()).toEqual({ id: "u1" });
  });
});
describe("真实 createApp 把白名单交给模型代理", () => {
  it("Default single-model whitelist：缺省配置只放行 deepseek-v4.1-flash", async () => {
    expect(await proxyStatuses(undefined, ["deepseek-v4.1-flash", "gpt-x"])).toEqual({
      statuses: [202, 400],
      forwarded: ['{"model":"deepseek-v4.1-flash"}'],
    });
  });

  it("给了 modelCatalog 就以它的 id 集合为准，缺省模型不再自动放行", async () => {
    const models = ["m1", "m2", "m3"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      vision: false,
      maxTokens: 32768,
    }));
    expect(
      await proxyStatuses({ models, defaultModelId: "m1" }, [
        "m1",
        "m2",
        "m3",
        "deepseek-v4.1-flash",
      ]),
    ).toEqual({
      statuses: [202, 202, 202, 400],
      forwarded: ['{"model":"m1"}', '{"model":"m2"}', '{"model":"m3"}'],
    });
  });
});

/** 依次以存活 bearer 请求各模型名；返回各自的状态码与记录型上游实际收到的 body。 */
async function proxyStatuses(
  modelCatalog: ModelCatalog | undefined,
  modelIds: readonly string[],
): Promise<{ statuses: number[]; forwarded: string[] }> {
  const upstream = await startRecordingUpstream(({ response }) => {
    response.writeHead(202);
    response.end("ok");
  });
  try {
    const tokens = new TokenRegistry();
    const bearer = tokens.issue("runtime-live");
    const app = createApp({
      db: track(openDb(":memory:")),
      assembly: {
        tokens,
        upstream: { baseUrl: `${upstream.origin}/v1`, apiKey: "k-992" },
        ...(modelCatalog === undefined ? {} : { modelCatalog }),
      },
    });
    apps.push(app);
    const statuses: number[] = [];
    for (const id of modelIds) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        payload: JSON.stringify({ model: id }),
      });
      statuses.push(response.statusCode);
    }
    return { statuses, forwarded: upstream.requests.map((entry) => entry.body.toString("utf8")) };
  } finally {
    await upstream.close();
  }
}

function openConfiguredAssemblyApp(prefix: string): {
  app: FastifyInstance;
  db: DatabaseSync;
  sandboxRoot: string;
} {
  const sandboxRoot = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(sandboxRoot);
  const { app, db } = openCurrentApp({
    runtime: {
      bin: join(sandboxRoot, "omp"),
      sandboxRoot,
      stateDir: join(sandboxRoot, "state"),
      modelId: "deepseek-v4.1-flash",
    },
  });
  return { app, db, sandboxRoot };
}

function openCurrentApp(assembly?: { runtime: SessionSupervisorRuntime }): {
  app: FastifyInstance;
  db: DatabaseSync;
} {
  const db = track(openDb(":memory:"));
  const app = createApp({
    db,
    ...(assembly === undefined ? {} : { assembly }),
  });
  apps.push(app);
  return { app, db };
}

function track(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
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
): Promise<SpawnCall & { workspaceId: string }> {
  const controlled = createControlledRuntime(() => {});
  fakeChildren.push(controlled.children);
  const calls = controlled.calls;
  const db = track(openDb(":memory:"));
  const app = createApp({
    db,
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
  const bound = db.prepare("SELECT workspace_id FROM chat_sessions").all() as Array<{
    workspace_id: string;
  }>;
  expect(bound).toHaveLength(1);
  return { ...call, workspaceId: bound[0]?.workspace_id ?? "" };
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
    "rpc-ui",
    "--cwd",
    cwd ?? join(roots.sandboxRoot, "u1"),
    "--session-dir",
    join(roots.stateDir, "sessions", "u1"),
    "--model",
    "workbuddy/deepseek-v4.1-flash",
    "--approval-mode",
    "write",
    "--no-extensions",
    "--no-lsp",
    "--no-pty",
    "--no-title",
    "--config",
    join(roots.stateDir, "home", ".omp", "agent", "host-overlay.yml"),
    "--config",
    sessionConfigYml(roots.stateDir),
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
