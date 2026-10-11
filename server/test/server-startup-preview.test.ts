/**
 * Issue #1070：生产入口接上预览监听器、预览缓存目录与回收目录的清理（http-service-skeleton
 * 「预览监听器的装配与关停」）。每一例都跑真实的 compiled production 入口；次序由 orderTrace 预加载
 * 观察真实的 listener 绑定 / 关闭与 DB close 得出，不替换任何生产模块。
 * 信号窗口两例的证据等级：钩子辅助（预加载推迟原生 listen）、真实编译入口、真实 SIGTERM。
 */

import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { connect as connectTcp, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectFixedFailure, rawAnswer } from "./preview-app-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  expectBindable,
  getJson,
  login,
  releaseStartupFixtures,
  reserveWildcardPort,
  type StartedServer,
  startCompiledServer,
  waitForFile,
} from "./server-startup-helpers.js";
import {
  applicationStderr,
  heldListenHook,
  holdPort,
  openPartialRequest,
  type PartialRequest,
} from "./server-startup-order-helpers.js";

const STARTUP_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
];
const FORCE_CLOSE_RECORD = `${JSON.stringify({ event: "listener_force_close" })}\n`;
const BIG_FILE_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86_400_000;
/** 种子账号 zhangsan 的 id：回收目录的账号一级以它命名。 */
const ZHANGSAN = "u1";
const scratch: string[] = [];
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Entry {
  server: StartedServer;
  root: string;
  port: number;
  /** 显式给了 PREVIEW_PORT 时才有意义；缺省端口的用例从签发响应里取。 */
  previewPort: number;
  readTrace(): string;
}

/**
 * 起入口。端口缺省各预留一个；`ports` 由调用方先定（要先占住再起）；`previewPort: "default"` 时
 * 不设 PREVIEW_PORT。`hook` 是预加载的源码文本。
 */
async function startEntry(
  options: {
    ports?: { port: number; previewPort: number };
    previewPort?: "default" | "same-as-main";
    env?: (root: string) => Record<string, string>;
    hook?: string;
    prepare?: (root: string) => void;
  } = {},
): Promise<Entry> {
  const port = options.ports?.port ?? (await reserveWildcardPort());
  const previewPort =
    options.ports?.previewPort ??
    (options.previewPort === "same-as-main" ? port : await reserveWildcardPort());
  const root = mkdtempSync(join(tmpdir(), "open-wb-startup-preview-"));
  scratch.push(root);
  options.prepare?.(root);
  const trace = join(root, "order.log");
  const hookPath = join(root, "preload.cjs");
  if (options.hook !== undefined) {
    writeFileSync(hookPath, options.hook);
  }
  const server = startCompiledServer(
    compiled.entry,
    compiledFixtureEnv(root, port, join(root, "bin", "missing-omp"), {
      ...(options.previewPort === "default" ? {} : { PREVIEW_PORT: String(previewPort) }),
      ...options.env?.(root),
    }),
    { orderTrace: trace, ...(options.hook === undefined ? {} : { requireHook: hookPath }) },
  );
  return {
    server,
    root,
    port,
    previewPort,
    readTrace: () => (existsSync(trace) ? readFileSync(trace, "utf8") : ""),
  };
}

/**
 * 入口启动时不建 SANDBOX_ROOT，而它不存在时 `POST /api/workspaces` 答 500（既有行为，不属本文件）：
 * 要建正式工作空间的用例先把它建好。
 */
function makeSandboxRoot(root: string): void {
  mkdirSync(join(root, "sandbox"));
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o7777;
}

interface Workspace {
  cookie: string;
  id: string;
  root: string;
  /** `http://127.0.0.1:<预览端口>/w/<token>/` */
  base: string;
}

/** 登录 → 建正式工作空间 → 签发预览令牌，全部经主监听器的真实路由。 */
async function openWorkspace(entry: Entry): Promise<Workspace> {
  const cookie = await login(entry.port);
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`http://127.0.0.1:${entry.port}${path}`, {
      method: "POST",
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const created = await post("/api/workspaces", { name: "preview-entry", dir: "preview-entry" });
  expect(created.status).toBe(201);
  const { id } = created.body as { id: string };
  const issued = await post(`/api/workspaces/${id}/preview-token`);
  expect(issued.status).toBe(200);
  return {
    cookie,
    id,
    // 沙箱里的落点由账号 id 与空间目录名决定（workspaces「工作空间根」），不取自响应。
    root: join(entry.root, "sandbox", ZHANGSAN, "preview-entry"),
    base: (issued.body as { base: string }).base,
  };
}

interface HeldDownload {
  status: number | undefined;
  /** 读完其余字节，返回总字节数。 */
  rest(): Promise<number>;
  destroy(): void;
}

/** 发一个 GET，读到第一块正文就停读：响应此刻在途，服务端被 TCP 背压挡住。 */
function startDownload(url: string): Promise<HeldDownload> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, (response) => {
      response.on("error", () => undefined);
      response.once("data", (first: Buffer) => {
        response.pause();
        resolve({
          status: response.statusCode,
          rest: () =>
            new Promise((done, fail) => {
              let bytes = first.length;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
              });
              response.once("end", () => done(bytes));
              response.once("error", fail);
              response.resume();
            }),
          destroy: () => request.destroy(),
        });
      });
    });
    request.once("error", reject);
  });
}

/** 等到 `port` 不再接受新连接：该监听器已经开始关停。只建连接，不发请求。 */
async function waitUntilRefused(port: number): Promise<void> {
  const deadlineAt = performance.now() + 5_000;
  for (;;) {
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connectTcp({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(true);
      });
    });
    if (refused) {
      return;
    }
    if (performance.now() > deadlineAt) {
      throw new Error(`port ${port} still accepts connections`);
    }
    await delay(10);
  }
}

function writeSparse(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

describe("production entry with the preview listener", () => {
  it("binds the preview listener first, prepares the cache directories and releases both ports on SIGTERM", async () => {
    const entry = await startEntry({
      prepare: (root) => {
        // 上一次运行的遗留：work 下的作业目录要清掉，pdf 下的缓存留着；mode 故意不对。
        mkdirSync(join(root, "preview-cache", "work", "stale"), { recursive: true });
        writeFileSync(join(root, "preview-cache", "work", "stale", "x"), "stale");
        mkdirSync(join(root, "preview-cache", "pdf"), { recursive: true });
        writeFileSync(join(root, "preview-cache", "pdf", "keep.pdf"), "kept");
      },
    });
    const { server, port, previewPort } = entry;
    try {
      const started = await server.waitForStarted();
      expect(server.stdout()).toBe(
        `${JSON.stringify({ event: "server_started", host: "127.0.0.1", port, modules: STARTUP_MODULES })}\n`,
      );
      expect(Object.keys(started as object)).toEqual(["event", "host", "port", "modules"]);
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${previewPort}\nlistening:127.0.0.1:${port}\n`,
      );

      const health = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      const previewOrigin = `http://127.0.0.1:${previewPort}`;
      expectFixedFailure(await rawAnswer(previewOrigin, "/"), 404);
      expectFixedFailure(await rawAnswer(previewOrigin, "/api/healthz"), 404);

      const cache = join(entry.root, "preview-cache");
      expect(modeOf(cache)).toBe(0o2750);
      expect(modeOf(join(cache, "work"))).toBe(0o2770);
      expect(modeOf(join(cache, "pdf"))).toBe(0o700);
      expect(readdirSync(join(cache, "work"))).toEqual([]);
      expect(readFileSync(join(cache, "pdf", "keep.pdf"), "utf8")).toBe("kept");

      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${previewPort}\nlistening:127.0.0.1:${port}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
      await expectBindable("127.0.0.1", port);
      await expectBindable("127.0.0.1", previewPort);
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("binds both listeners to the configured HOST when it is the wildcard address", async () => {
    const entry = await startEntry({ env: () => ({ HOST: "0.0.0.0" }) });
    const { server, port, previewPort } = entry;
    try {
      expect(await server.waitForStarted()).toMatchObject({ host: "0.0.0.0", port });
      expect(entry.readTrace()).toBe(
        `listening:0.0.0.0:${previewPort}\nlistening:0.0.0.0:${port}\n`,
      );
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe(
        `listening:0.0.0.0:${previewPort}\nlistening:0.0.0.0:${port}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("serves a workspace file on a system-assigned preview port and audits a traversal through the shared sandbox", async () => {
    const entry = await startEntry({ previewPort: "default", prepare: makeSandboxRoot });
    const { server, port } = entry;
    try {
      const started = await server.waitForStarted();
      expect(Object.keys(started as object)).toEqual(["event", "host", "port", "modules"]);
      expect(started).toMatchObject({ port });
      const workspace = await openWorkspace(entry);
      const base = new URL(workspace.base);
      expect(base.hostname).toBe("127.0.0.1");
      expect(Number(base.port)).toBeGreaterThan(0);
      expect(Number(base.port)).not.toBe(port);
      expect(base.pathname).toMatch(/^\/w\/[0-9a-f]+\/$/u);

      writeFileSync(join(workspace.root, "文件.html"), "<p>来自工作空间</p>");
      const file = await fetch(`${workspace.base}${encodeURIComponent("文件.html")}`);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("<p>来自工作空间</p>");

      // fetch 会把 %2e%2e 段先行折叠；越界必须经真实 socket 原样送达。
      const denied = await rawAnswer(base.origin, `${base.pathname}%2e%2e/%2e%2e/x`);
      expectFixedFailure(denied, 403);
      const audit = await getJson(port, "/api/audit", workspace.cookie);
      const rejects = (
        audit.body as { events: Array<{ kind: string; actorId: string; workspaceId: string }> }
      ).events.filter((event) => event.kind === "sandbox.reject");
      expect(rejects).toEqual([
        expect.objectContaining({
          kind: "sandbox.reject",
          actorId: ZHANGSAN,
          workspaceId: workspace.id,
          detail: expect.objectContaining({ relPath: "../../x", op: "read" }),
        }),
      ]);
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("removes only the expired recycle batches once after startup, by the configured retention", async () => {
    const now = Date.now();
    const workspaceTrash = join(".trash", ZHANGSAN, "a".repeat(32));
    // 未到期批次的名字排在两个到期批次之间（位数少的时间戳排在最后）。
    const expiredFirst = `${now - 2 * DAY_MS}-${"a".repeat(16)}`;
    const fresh = `${now - DAY_MS / 2}-${"b".repeat(16)}`;
    const expiredLast = `9-${"c".repeat(16)}`;
    const entry = await startEntry({
      env: () => ({ TRASH_RETENTION_DAYS: "1" }),
      prepare: (root) => {
        const sandbox = join(root, "sandbox");
        mkdirSync(sandbox);
        let level = sandbox;
        for (const name of workspaceTrash.split("/")) {
          level = join(level, name);
          mkdirSync(level, 0o700);
        }
        for (const batch of [expiredFirst, fresh, expiredLast]) {
          mkdirSync(join(level, batch, "dir"), { recursive: true, mode: 0o700 });
          writeFileSync(join(level, batch, "dir", "f.txt"), batch);
        }
      },
    });
    const { server } = entry;
    const batches = join(entry.root, "sandbox", workspaceTrash);
    try {
      await server.waitForStarted();
      // 首扫在成功记录之后才开始，入口不等它。
      const deadlineAt = performance.now() + 10_000;
      while (existsSync(join(batches, expiredFirst)) || existsSync(join(batches, expiredLast))) {
        if (performance.now() > deadlineAt) {
          throw new Error(`expired batches still present: ${readdirSync(batches).join(",")}`);
        }
        await delay(20);
      }
      await delay(200);
      expect(readdirSync(batches)).toEqual([fresh]);
      expect(readFileSync(join(batches, fresh, "dir", "f.txt"), "utf8")).toBe(fresh);
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);
});

describe("production entry preview bind failure", () => {
  /** 入口自行以 1 退出：无 success record，stderr 恰一行带 `reason` 的失败记录。 */
  async function expectStartFailure(entry: Entry, reason: string): Promise<void> {
    try {
      expect(await entry.server.waitForClose()).toEqual({ code: 1, signal: null });
      expect(entry.server.stdout()).toBe("");
      expect(applicationStderr(entry.server.stderr())).toBe(
        `{"event":"server_start_failed","reason":"${reason}"}\n`,
      );
    } finally {
      await entry.server.dispose();
    }
  }

  async function withHeld(ports: number[], action: () => Promise<void>): Promise<void> {
    const holders: Server[] = [];
    try {
      for (const port of ports) {
        holders.push(await holdPort(port));
      }
      await action();
    } finally {
      await Promise.all(
        holders.map((holder) => new Promise((resolve) => holder.close(() => resolve(undefined)))),
      );
    }
  }

  it("fails with preview_listen and never binds the main port when the preview port is taken", async () => {
    const port = await reserveWildcardPort();
    const previewPort = await reserveWildcardPort();
    let entry: Entry | undefined;
    await withHeld([previewPort], async () => {
      entry = await startEntry({ ports: { port, previewPort } });
      await expectStartFailure(entry, "preview_listen");
    });
    // 整个进程里没有任何一个 listener 绑定成功过：主端口从未处于可连接状态。
    expect(entry?.readTrace()).toBe("listener-close:-\ndb-close\n");
    await expectBindable("127.0.0.1", port);
    await expectBindable("127.0.0.1", previewPort);
  }, 60_000);

  it("fails with preview_listen when both ports are taken", async () => {
    const port = await reserveWildcardPort();
    const previewPort = await reserveWildcardPort();
    let entry: Entry | undefined;
    await withHeld([previewPort, port], async () => {
      entry = await startEntry({ ports: { port, previewPort } });
      await expectStartFailure(entry, "preview_listen");
    });
    expect(entry?.readTrace()).toBe("listener-close:-\ndb-close\n");
  }, 60_000);

  it("fails with listen when PREVIEW_PORT equals PORT: the preview listener took the port first", async () => {
    const entry = await startEntry({ previewPort: "same-as-main" });
    await expectStartFailure(entry, "listen");
    expect(entry.readTrace()).toBe(
      `listening:127.0.0.1:${entry.port}\nlistener-close:${entry.port}\nlistener-close:-\ndb-close\n`,
    );
    await expectBindable("127.0.0.1", entry.port);
  }, 60_000);
});

describe("production entry shutdown with preview requests in flight", () => {
  it("lets an in-flight preview download finish with every byte and closes the database last", async () => {
    const entry = await startEntry({ prepare: makeSandboxRoot });
    const { server, port, previewPort } = entry;
    let download: HeldDownload | undefined;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeSparse(join(workspace.root, "big.bin"), BIG_FILE_BYTES);
      download = await startDownload(`${workspace.base}big.bin`);
      expect(download.status).toBe(200);
      const stopping = server.stop();
      // SIGTERM 之后不往预览端口发任何新请求：只确认它已停止受理，再把在途的响应读完。
      await waitUntilRefused(previewPort);
      expect(await download.rest()).toBe(BIG_FILE_BYTES);
      expect(await stopping).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${previewPort}\nlistening:127.0.0.1:${port}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      download?.destroy();
      await server.dispose();
    }
  }, 60_000);

  it("writes exactly one listener_force_close when only the preview listener is force-closed", async () => {
    const entry = await startEntry({ prepare: makeSandboxRoot });
    const { server } = entry;
    let download: HeldDownload | undefined;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeSparse(join(workspace.root, "big.bin"), BIG_FILE_BYTES);
      download = await startDownload(`${workspace.base}big.bin`);
      // 停读的客户端自己看不到连接被回收；以进程退出与那一行记录为证。
      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe(FORCE_CLOSE_RECORD);
    } finally {
      download?.destroy();
      await server.dispose();
    }
  }, 60_000);

  it("writes exactly one listener_force_close when both listeners are force-closed", async () => {
    const entry = await startEntry({ prepare: makeSandboxRoot });
    const { server, port, previewPort } = entry;
    let download: HeldDownload | undefined;
    let partial: PartialRequest | undefined;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeSparse(join(workspace.root, "big.bin"), BIG_FILE_BYTES);
      download = await startDownload(`${workspace.base}big.bin`);
      partial = await openPartialRequest(port, "/api/auth/login");
      expect(await server.stop()).toBe(0);
      await partial.closed;
      expect(applicationStderr(server.stderr())).toBe(FORCE_CLOSE_RECORD);
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${previewPort}\nlistening:127.0.0.1:${port}\nlistener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      download?.destroy();
      partial?.destroy();
      await server.dispose();
    }
  }, 60_000);
});

describe("production entry SIGTERM between the two listens", () => {
  it.each([
    { nth: 1, held: "the preview listener's" },
    { nth: 2, held: "the main listener's" },
  ] as const)(
    "publishes nothing and leaves both ports and the database reusable when SIGTERM lands in $held listen",
    async ({ nth }) => {
      const entry = await startEntry({
        hook: heldListenHook(nth),
        env: (root) => ({
          LISTEN_ENTERED: join(root, "listen-entered"),
          LISTEN_RELEASE: join(root, "listen-released"),
        }),
      });
      const { server, port, previewPort, root } = entry;
      try {
        await waitForFile(join(root, "listen-entered"), 15_000);
        expect(existsSync(join(root, "listen-released"))).toBe(false);
        const before = entry.readTrace();
        expect(before).toBe(nth === 1 ? "" : `listening:127.0.0.1:${previewPort}\n`);
        await server.stop();
        expect(await server.waitForClose()).toEqual({ code: 0, signal: null });
        expect(existsSync(join(root, "listen-released"))).toBe(true);
        expect(server.stdout()).toBe("");
        expect(applicationStderr(server.stderr())).toBe("");
        // 被扣住的那个 listener 从未绑定；已绑定的预览监听器先关，DB 在其后。
        expect(entry.readTrace()).toBe(
          nth === 1
            ? "listener-close:-\ndb-close\n"
            : `listening:127.0.0.1:${previewPort}\nlistener-close:${previewPort}\nlistener-close:-\ndb-close\n`,
        );
        await expectBindable("127.0.0.1", port);
        await expectBindable("127.0.0.1", previewPort);
        expect(existsSync(join(root, "state"))).toBe(false);
      } finally {
        await server.dispose();
      }
    },
    60_000,
  );
});
