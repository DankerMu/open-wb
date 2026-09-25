/**
 * Issue #227：listener 关停有界且无损。
 * 真实 createApp + 真实 listen(127.0.0.1:0) + 真实 HTTP/1.1 keep-alive 客户端（不用 inject）；
 * 入口级记录/退出码走真实 compiled production entry。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, LISTENER_CLOSE_BUDGET_MS } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import {
  compileServerEntry,
  gatedModelsWriteHook,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
  waitForFile,
} from "./server-startup-helpers.js";

/** 与 issue 反例同一 deadline。 */
const SETTLE_DEADLINE_MS = 2_000;
/** http-service-skeleton 规格的默认 listener 预算。 */
const SPEC_DEFAULT_BUDGET_MS = 2_000;
const HELD_BODY = { held: "released", filler: "x".repeat(4096) };
const CONTINUE_LINE = "HTTP/1.1 100 Continue\r\n\r\n";
const FORCE_CLOSE_RECORD = `${JSON.stringify({ event: "listener_force_close" })}\n`;
const STARTUP_FAILED_RECORD = `${JSON.stringify({ event: "server_start_failed" })}\n`;
const SQLITE_EXPERIMENTAL_WARNING =
  "ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

afterAll(releaseStartupFixtures);

interface HeldRoute {
  entered: Promise<void>;
  release(): void;
  /** 处理器越过 barrier 那一刻的 `server.listening`；未越过为 undefined。 */
  listeningAtRelease(): boolean | undefined;
}

/** 测试私有的普通 JSON 路由：进入处理器后被确定性 barrier 扣住。 */
function holdRoute(app: FastifyInstance, path: string): HeldRoute {
  let release = (): void => undefined;
  let markEntered = (): void => undefined;
  let listening: boolean | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  app.get(path, async () => {
    markEntered();
    await gate;
    listening = app.server.listening;
    return HELD_BODY;
  });
  return { entered, release: () => release(), listeningAtRelease: () => listening };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test app did not bind a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

interface KeepAliveResponse {
  status: number | undefined;
  connection: string | undefined;
  contentLength: string | undefined;
  body: string;
}

function keepAliveGet(agent: Agent, url: string): Promise<KeepAliveResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () =>
        resolve({
          status: res.statusCode,
          connection: res.headers.connection,
          contentLength: res.headers["content-length"],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

/** 返回 settle 耗时；超出 deadline 则以明确信息失败（不等待 keep-alive 超时）。 */
function settleWithin(pending: Promise<unknown>, startedAt: number, ms: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`app.close did not settle within ${ms}ms`)),
      ms - (performance.now() - startedAt),
    );
    pending.then(
      () => {
        clearTimeout(timer);
        resolve(Math.round(performance.now() - startedAt));
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PartialRequest {
  received(): string;
  closed: Promise<void>;
  destroy(): void;
}

/**
 * 发出头部完整、body 永不补齐的请求（Content-Length 大于已写字节）。
 * `Expect: 100-continue` 让服务端在解析完头部后回 100，作为请求已被接受的确定性信号。
 */
async function openPartialRequest(port: number, target: string): Promise<PartialRequest> {
  const socket = connect({ host: "127.0.0.1", port });
  let received = "";
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => undefined);
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const accepted = new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes(CONTINUE_LINE)) {
        resolve();
      }
    });
    socket.once("close", () => reject(new Error(`closed before 100 Continue: ${received}`)));
  });
  socket.write(
    `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
      "Content-Length: 64\r\nExpect: 100-continue\r\n\r\n",
  );
  await accepted;
  socket.write('{"partial":');
  return { received: () => received, closed, destroy: () => socket.destroy() };
}

describe("listener shutdown re-drain", () => {
  it("closes within 2 s after a keep-alive REST response completes post-preClose, losslessly", async () => {
    const db = openDb(":memory:");
    let forced = 0;
    const app = createApp({
      db,
      listenerCloseBudgetMs: 10_000,
      onListenerForceClose: () => {
        forced += 1;
      },
    });
    const held = holdRoute(app, "/drain/held");
    let probeRan = false;
    // 根 preClose 按注册顺序执行：本探针在 createApp 注册的全部模块 preClose 之后运行；
    // setImmediate 放行时 server.close() 的唯一一次 idle 清扫已发生。
    app.addHook("preClose", (complete) => {
      probeRan = true;
      complete();
      setImmediate(() => held.release());
    });
    const agent = new Agent({ keepAlive: true });
    let closing: Promise<undefined> | undefined;
    try {
      const origin = await listen(app);
      const response = keepAliveGet(agent, `${origin}/drain/held`);
      await held.entered;
      const startedAt = performance.now();
      let settled = false;
      closing = app.close();
      void closing.then(() => {
        settled = true;
      });
      const received = await response;
      const settledBeforeBody = settled;
      expect(probeRan).toBe(true);
      expect(held.listeningAtRelease()).toBe(false);
      expect(received.status).toBe(200);
      expect(received.connection).toBe("keep-alive");
      expect(Buffer.byteLength(received.body)).toBe(Number(received.contentLength));
      expect(JSON.parse(received.body)).toEqual(HELD_BODY);
      expect(settledBeforeBody).toBe(false);
      const settleMs = await settleWithin(closing, startedAt, SETTLE_DEADLINE_MS);
      console.info(`[#227] re-drained listener close settled in ${settleMs}ms`);
      expect(forced).toBe(0);
    } finally {
      agent.destroy();
      await (closing ?? app.close());
      db.close();
    }
  });

  it("never notifies and leaves no live timer after an idle keep-alive close", async () => {
    const db = openDb(":memory:");
    let forced = 0;
    const app = createApp({
      db,
      listenerCloseBudgetMs: 50,
      onListenerForceClose: () => {
        forced += 1;
      },
    });
    const agent = new Agent({ keepAlive: true });
    try {
      const origin = await listen(app);
      const health = await keepAliveGet(agent, `${origin}/api/healthz`);
      expect(health.status).toBe(200);
      expect(health.connection).toBe("keep-alive");
      const startedAt = performance.now();
      await settleWithin(app.close(), startedAt, SETTLE_DEADLINE_MS);
      await pause(150);
      expect(forced).toBe(0);
    } finally {
      agent.destroy();
      db.close();
    }
  });

  it("is a no-op for an inject-only app that never listened", async () => {
    const db = openDb(":memory:");
    let forced = 0;
    const app = createApp({
      db,
      listenerCloseBudgetMs: 1,
      onListenerForceClose: () => {
        forced += 1;
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/healthz" });
      expect(response.statusCode).toBe(200);
      await app.close();
      await pause(50);
      expect(forced).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("listener shutdown budget", () => {
  it("force-closes a request still unfinished at budget expiry and notifies exactly once", async () => {
    const db = openDb(":memory:");
    const budgetMs = 250;
    let forced = 0;
    const app = createApp({
      db,
      listenerCloseBudgetMs: budgetMs,
      onListenerForceClose: () => {
        forced += 1;
        throw new Error("notifier fault must not break close");
      },
    });
    app.post("/drain/upload", async () => ({ unreachable: true }));
    let partial: PartialRequest | undefined;
    let closing: Promise<undefined> | undefined;
    try {
      const origin = new URL(await listen(app));
      partial = await openPartialRequest(Number(origin.port), "/drain/upload");
      const startedAt = performance.now();
      closing = app.close();
      const settleMs = await settleWithin(closing, startedAt, SETTLE_DEADLINE_MS);
      console.info(`[#227] forced listener close settled in ${settleMs}ms (budget ${budgetMs}ms)`);
      expect(settleMs).toBeGreaterThanOrEqual(budgetMs - 5);
      await partial.closed;
      expect(partial.received()).toBe(CONTINUE_LINE);
      expect(forced).toBe(1);
      await pause(budgetMs + 100);
      expect(forced).toBe(1);
    } finally {
      partial?.destroy();
      await (closing ?? app.close());
      db.close();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "rejects listenerCloseBudgetMs=%s at assembly",
    (value) => {
      const db = openDb(":memory:");
      try {
        expect(() => createApp({ db, listenerCloseBudgetMs: value })).toThrow(
          "listener close budget",
        );
      } finally {
        db.close();
      }
    },
  );

  it("accepts the largest timer-safe budget and an explicit undefined", async () => {
    const db = openDb(":memory:");
    try {
      await createApp({ db, listenerCloseBudgetMs: 2 ** 31 - 1 }).close();
      await createApp({ db, listenerCloseBudgetMs: undefined }).close();
    } finally {
      db.close();
    }
  });
});

const SUPERVISOR_SHUTDOWN_FAILURE = "supervisor shutdown failed";

/** 让 sessions 模块的 preClose 以 complete(error) 结束：Fastify 随即跳过其后全部根 preClose。 */
function failSessionsPreClose(app: FastifyInstance): void {
  app.sessions.supervisor.shutdown = () => Promise.reject(new Error(SUPERVISOR_SHUTDOWN_FAILURE));
}

/** server.close() 同步置 listening=false；其唯一一次 idle 清扫之后才放行 barrier。 */
function releaseAfterListenerClose(app: FastifyInstance, held: HeldRoute): void {
  const poll = (): void => {
    if (app.server.listening) {
      setImmediate(poll);
      return;
    }
    held.release();
  };
  setImmediate(poll);
}

/** 返回 rejection 的耗时与错误；resolve 或超出 deadline 都以明确信息失败。 */
async function rejectWithin(
  pending: Promise<unknown>,
  startedAt: number,
  ms: number,
): Promise<{ settleMs: number; error: unknown }> {
  try {
    await settleWithin(pending, startedAt, ms);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("app.close did not settle")) {
      throw error;
    }
    return { settleMs: Math.round(performance.now() - startedAt), error };
  }
  throw new Error("app.close resolved although a module preClose failed");
}

describe("listener shutdown with a failing module preClose", () => {
  it("still re-drains within 2 s and surfaces the teardown failure", async () => {
    const db = openDb(":memory:");
    let forced = 0;
    const app = createApp({
      db,
      listenerCloseBudgetMs: 10_000,
      onListenerForceClose: () => {
        forced += 1;
      },
    });
    const held = holdRoute(app, "/drain/held-failing");
    failSessionsPreClose(app);
    const agent = new Agent({ keepAlive: true });
    let closing: Promise<undefined> | undefined;
    try {
      const origin = await listen(app);
      const response = keepAliveGet(agent, `${origin}/drain/held-failing`);
      await held.entered;
      let listenerClosed = false;
      app.server.once("close", () => {
        listenerClosed = true;
      });
      const startedAt = performance.now();
      closing = app.close();
      closing.catch(() => undefined);
      releaseAfterListenerClose(app, held);
      const received = await response;
      expect(held.listeningAtRelease()).toBe(false);
      expect(received.status).toBe(200);
      expect(received.connection).toBe("keep-alive");
      expect(Buffer.byteLength(received.body)).toBe(Number(received.contentLength));
      expect(JSON.parse(received.body)).toEqual(HELD_BODY);
      const { settleMs, error } = await rejectWithin(closing, startedAt, SETTLE_DEADLINE_MS);
      console.info(`[#227] failing-preClose re-drained close rejected in ${settleMs}ms`);
      expect(listenerClosed).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SUPERVISOR_SHUTDOWN_FAILURE);
      expect(forced).toBe(0);
    } finally {
      agent.destroy();
      await (closing ?? app.close()).catch(() => undefined);
      db.close();
    }
  });

  it("still force-closes once at budget expiry and surfaces the teardown failure", async () => {
    const db = openDb(":memory:");
    const budgetMs = 250;
    let forced = 0;
    const app = createApp({
      db,
      listenerCloseBudgetMs: budgetMs,
      onListenerForceClose: () => {
        forced += 1;
      },
    });
    app.post("/drain/upload-failing", async () => ({ unreachable: true }));
    failSessionsPreClose(app);
    let partial: PartialRequest | undefined;
    let closing: Promise<undefined> | undefined;
    try {
      const origin = new URL(await listen(app));
      partial = await openPartialRequest(Number(origin.port), "/drain/upload-failing");
      const startedAt = performance.now();
      closing = app.close();
      closing.catch(() => undefined);
      const { settleMs, error } = await rejectWithin(closing, startedAt, SETTLE_DEADLINE_MS);
      console.info(
        `[#227] failing-preClose forced close rejected in ${settleMs}ms (budget ${budgetMs}ms)`,
      );
      expect((error as Error).message).toBe(SUPERVISOR_SHUTDOWN_FAILURE);
      expect(settleMs).toBeGreaterThanOrEqual(budgetMs - 5);
      await partial.closed;
      expect(partial.received()).toBe(CONTINUE_LINE);
      expect(forced).toBe(1);
      await pause(budgetMs + 100);
      expect(forced).toBe(1);
    } finally {
      partial?.destroy();
      await (closing ?? app.close()).catch(() => undefined);
      db.close();
    }
  });
});

describe("production entry listener force close", () => {
  it("writes exactly one listener_force_close stderr record and still exits 0", async () => {
    const compiled = await compileServerEntry();
    const port = await reserveWildcardPort();
    const root = mkdtempSync(join(tmpdir(), "open-wb-listener-close-"));
    const server = startCompiledServer(compiled.entry, {
      HOST: "127.0.0.1",
      PORT: String(port),
      DB_PATH: join(root, "db", "dev.db"),
      OMP_STATE_DIR: join(root, "state"),
      SANDBOX_ROOT: join(root, "sandbox"),
      OMP_BIN: join(root, "bin", "missing-omp"),
      MODEL_ID: "issue-227-model",
    });
    let partial: PartialRequest | undefined;
    try {
      await server.waitForStarted();
      partial = await openPartialRequest(port, "/api/auth/login");
      const startedAt = performance.now();
      const exitCode = await server.stop();
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.info(`[#227] compiled entry forced shutdown took ${elapsedMs}ms`);
      expect(exitCode).toBe(0);
      expect(applicationStderr(server.stderr())).toBe(FORCE_CLOSE_RECORD);
      await partial.closed;
      expect(partial.received()).toBe(CONTINUE_LINE);
      expect(LISTENER_CLOSE_BUDGET_MS).toBe(SPEC_DEFAULT_BUDGET_MS);
      // Node 定时器可能按毫秒取整提前约 1ms 触发。
      expect(elapsedMs).toBeGreaterThanOrEqual(SPEC_DEFAULT_BUDGET_MS - 5);
    } finally {
      partial?.destroy();
      await server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("keeps only the generic failure record when a post-listen startup failure forces close", async () => {
    const compiled = await compileServerEntry();
    const port = await reserveWildcardPort();
    const root = mkdtempSync(join(tmpdir(), "open-wb-listener-close-failed-"));
    const entered = join(root, "models-entered");
    const release = join(root, "models-release");
    const hook = join(root, "gated-models-write.cjs");
    writeFileSync(hook, gatedModelsWriteHook("throw"));
    const server = startCompiledServer(
      compiled.entry,
      {
        HOST: "127.0.0.1",
        PORT: String(port),
        DB_PATH: join(root, "db", "dev.db"),
        OMP_STATE_DIR: join(root, "state"),
        SANDBOX_ROOT: join(root, "sandbox"),
        OMP_BIN: join(root, "bin", "missing-omp"),
        MODEL_ID: "issue-227-model",
        MODELS_ENTERED: entered,
        MODELS_RELEASE: release,
      },
      { requireHook: hook },
    );
    let partial: PartialRequest | undefined;
    try {
      // listen 已完成、models.yml 写入被扣住：此时接受一个永不补齐 body 的请求。
      await waitForFile(entered, 15_000);
      partial = await openPartialRequest(port, "/api/auth/login");
      const startedAt = performance.now();
      writeFileSync(release, "");
      const closed = await server.waitForClose();
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.info(`[#227] post-listen startup failure with forced close took ${elapsedMs}ms`);
      expect(closed.code).toBe(1);
      expect(closed.signal).toBeNull();
      expect(server.stdout()).toBe("");
      expect(applicationStderr(server.stderr())).toBe(STARTUP_FAILED_RECORD);
      await partial.closed;
      expect(partial.received()).toBe(CONTINUE_LINE);
      // 失败路径确实走到了预算到期的强制回收，只是记录被压制。
      expect(elapsedMs).toBeGreaterThanOrEqual(SPEC_DEFAULT_BUDGET_MS - 5);
    } finally {
      partial?.destroy();
      await server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});

/** 与 server-startup-order.test.ts 同一精确剥离：只去掉已知的 SQLite ExperimentalWarning。 */
function applicationStderr(stderr: string): string {
  return stderr.replace(/^\(node:\d+\) /u, "").replace(SQLITE_EXPERIMENTAL_WARNING, "");
}
