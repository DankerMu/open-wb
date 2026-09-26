/**
 * Issue #451: OMP_MAX_PROCESSES 与 OMP_IDLE_MS 同一解析纪律，并随同一 runtime settings
 * 对象到达 sessions 模块。期望值取自 issue/spec（缺省 16、值域 1..2147483647），不引用源码常量。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import * as sessions from "../src/sessions/index.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
} from "./server-startup-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const KEY = "OMP_MAX_PROCESSES";
const CANONICAL_MESSAGE = `${KEY} must be a canonical ASCII decimal`;
const RANGE_MESSAGE = `${KEY} must be within 1..2147483647`;
const INVALID_VALUES = ["", "0", "abc", "-1", "1.5", "+3", "016", " 8", "2147483648"] as const;
const FAILED_RECORD = `${JSON.stringify({ event: "server_start_failed" })}\n`;
const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;

const scratchRoots: string[] = [];
const apps: FastifyInstance[] = [];
const dbs: DatabaseSync[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

function thrownMessage(env: Record<string, string>): string {
  try {
    resolveServerConfig(env, SOURCE_ENTRY);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`resolver accepted ${KEY}=${JSON.stringify(env[KEY])}`);
}

function refused(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => {
      socket.destroy();
      done(true);
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
});

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveServerConfig — OMP_MAX_PROCESSES 缺省与合法值", () => {
  it("未设置时为 16，其余十二项保持既有缺省", () => {
    const config = resolveServerConfig({}, SOURCE_ENTRY);
    expect(config.ompMaxProcesses).toBe(16);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      dbPath: join(REPO_ROOT, "var", "dev.db"),
      staticRoot: join(REPO_ROOT, "web", "dist"),
      ompBin: join(REPO_ROOT, "var", "omp", "omp"),
      ompStateDir: join(REPO_ROOT, "var", "omp-state"),
      ompIdleMs: 600_000,
      sandboxRoot: join(REPO_ROOT, "var", "sandbox"),
      modelId: "deepseek-v4.1-flash",
    });
    expect(Object.hasOwn(config, "modelUpstreamBaseUrl")).toBe(false);
    expect(Object.hasOwn(config, "modelUpstreamApiKey")).toBe(false);
    expect(Object.hasOwn(config, "ompUser")).toBe(false);
  });

  it.each([
    ["1", 1],
    ["2", 2],
    ["2147483647", 2_147_483_647],
  ])("接受 %s 原样生效", (raw, expected) => {
    expect(resolveServerConfig({ [KEY]: raw }, SOURCE_ENTRY).ompMaxProcesses).toBe(expected);
  });

  it("设置上限不改变 OMP_IDLE_MS 的解析与命名消息", () => {
    expect(resolveServerConfig({ [KEY]: "3", OMP_IDLE_MS: "1" }, SOURCE_ENTRY).ompIdleMs).toBe(1);
    expect(thrownMessage({ OMP_IDLE_MS: "01" })).toBe(
      "OMP_IDLE_MS must be a canonical ASCII decimal",
    );
    expect(thrownMessage({ OMP_IDLE_MS: "0" })).toBe("OMP_IDLE_MS must be within 1..2147483647");
  });
});

describe("resolveServerConfig — OMP_MAX_PROCESSES 非法值", () => {
  it.each(INVALID_VALUES)("拒绝 %j，消息命名键且不含输入值", (raw) => {
    const message = thrownMessage({ [KEY]: raw });
    expect([CANONICAL_MESSAGE, RANGE_MESSAGE]).toContain(message);
    if (raw.length > 0) {
      expect(message).not.toContain(raw);
    }
  });
});

describe("production entry rejects invalid OMP_MAX_PROCESSES before effects", () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it("compiled entry URL 与 source 得到同一上限", () => {
    const compiledEntry = pathToFileURL(compiled.entry).href;
    expect(resolveServerConfig({}, compiledEntry).ompMaxProcesses).toBe(16);
    expect(resolveServerConfig({ [KEY]: "9" }, compiledEntry).ompMaxProcesses).toBe(9);
  });

  it.each(INVALID_VALUES)(
    "%j：nonzero、恰一行 generic record、无 DB/state/sandbox/listen",
    async (raw) => {
      const root = scratch("open-wb-max-processes-");
      const port = await reserveWildcardPort();
      const env = compiledFixtureEnv(root, port, join(root, "bin", "omp"), { [KEY]: raw });
      const server = startCompiledServer(compiled.entry, env);
      const closed = await server.waitForClose();

      expect(closed).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(FAILED_RECORD);
      for (const owned of ["db", "state", "sandbox", "bin"]) {
        expect(existsSync(join(root, owned))).toBe(false);
      }
      expect(existsSync(join(compiled.root, "var"))).toBe(false);
      await expect(refused(port)).resolves.toBe(true);
    },
    20_000,
  );
});

describe("process cap reaches the sessions module", () => {
  function scratchEnv(root: string): Record<string, string> {
    return {
      OMP_BIN: join(root, "bin", "omp"),
      OMP_STATE_DIR: join(root, "state"),
      SANDBOX_ROOT: join(root, "sandbox"),
    };
  }

  it("sessionRuntimeOf 把 idle 期限与上限放进同一 runtime 对象", () => {
    const root = scratch("open-wb-max-runtime-");
    const runtime = sessionRuntimeOf(
      resolveServerConfig({ ...scratchEnv(root), [KEY]: "7", OMP_IDLE_MS: "1234" }, SOURCE_ENTRY),
    );
    expect(runtime).toMatchObject({ idleMs: 1234, maxProcesses: 7 });
    expect(sessionRuntimeOf(resolveServerConfig({}, SOURCE_ENTRY)).maxProcesses).toBe(16);
  });

  it("createApp 把含 maxProcesses 的同一 runtime 对象交给 registerSessions", () => {
    const root = scratch("open-wb-max-assembly-");
    const runtime = sessionRuntimeOf(
      resolveServerConfig({ ...scratchEnv(root), [KEY]: "5" }, SOURCE_ENTRY),
    );
    const spy = vi.spyOn(sessions, "registerSessions");
    const db = openDb(":memory:");
    dbs.push(db);
    apps.push(createApp({ db, assembly: { runtime } }));

    expect(spy).toHaveBeenCalledTimes(1);
    const received = spy.mock.calls[0]?.[1].runtime;
    expect(received).toBe(runtime);
    expect(received?.maxProcesses).toBe(5);
  });
});
