/**
 * 真实 production 入口夹具（Issue #102）：
 * 用已声明的 TypeScript 编译器把 tracked server/src 编进测试私有 ESM 树，
 * 带上真实 migrations，再以 node 直接执行 compiled main。
 * 产物几何与 production 一致：<root>/server/dist/server.js，repo root 为 ../../。
 * 不读仓库 dist，不引入 jiti。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_ROOT = join(REPO_ROOT, "server");
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const BUILD_CONFIG = join(SERVER_ROOT, "tsconfig.build.json");
const MIGRATION_SOURCE = join(SERVER_ROOT, "src", "core", "db", "migrations");

const COMPILE_DEADLINE_MS = 60_000;
/** 覆盖既有 native 5s EOF + 3s TERM 宽限，再留收尾。 */
const GRACEFUL_DEADLINE_MS = 20_000;

export interface CompiledServerEntry {
  /** server/dist/server.js 向上两级：与 production 相同的 repo root。 */
  root: string;
  entry: string;
}

export interface StartedServer {
  stdout: () => string;
  stderr: () => string;
  waitForStarted(deadlineMs?: number): Promise<unknown>;
  waitForClose(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 只向主服务发 SIGTERM，由它自己回收 runtime；返回真实退出码。 */
  stop(): Promise<number | null>;
  /** 强制回收本夹具拥有的进程组。关闭超时会抛出，不得当成已回收。 */
  dispose(): Promise<void>;
}

interface OwnedChild {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: () => string;
  stderr: () => string;
}

const ownedRoots = new Set<string>();
const ownedChildren = new Set<OwnedChild>();

/** 编译一次真实入口。非零编译或资产缺失是 SETUP，调用方必须原样抛出。 */
export async function compileServerEntry(): Promise<CompiledServerEntry> {
  const root = mkdtempSync(join(tmpdir(), "open-wb-startup-"));
  ownedRoots.add(root);
  const dist = join(root, "server", "dist");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));

  const compiled = spawn(process.execPath, [TSC, "-p", BUILD_CONFIG, "--outDir", dist], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin" },
  });
  const output = await collectAndWait(compiled, COMPILE_DEADLINE_MS, "typescript compile");
  if (output.code !== 0) {
    throw new Error(
      `SETUP: declared tsc exited ${String(output.code)} signal=${String(output.signal)}\n${output.stderr}`,
    );
  }

  cpSync(MIGRATION_SOURCE, join(dist, "core", "db", "migrations"), { recursive: true });
  return { root, entry: join(dist, "server.js") };
}

/** 绑定 0.0.0.0:0 取一个可用端口后立刻释放。PORT=0 不是合法生产配置。 */
export function reserveWildcardPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "0.0.0.0", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("wildcard probe did not bind a TCP port"));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * 以显式环境启动 compiled main，并成为新进程组组长，便于失败时整组强杀。
 * 不继承调用方环境，避免把密钥带进子进程。
 * orderTrace 只观察真实 listener/DB close，不替换生产模块。
 */
export function startCompiledServer(
  entry: string,
  env: Record<string, string>,
  options: { orderTrace?: string } = {},
): StartedServer {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin",
      ...(options.orderTrace === undefined
        ? {}
        : {
            NODE_OPTIONS: `--require ${orderPreload(options.orderTrace)}`,
            OPEN_WB_ORDER_TRACE: options.orderTrace,
          }),
      ...env,
    },
  });
  const owned = track(child);
  ownedChildren.add(owned);
  return {
    stdout: owned.stdout,
    stderr: owned.stderr,
    waitForStarted(deadlineMs = 15_000) {
      return waitForStartedRecord(owned, deadlineMs);
    },
    waitForClose() {
      return owned.closed;
    },
    stop() {
      return stopMain(owned);
    },
    dispose() {
      return disposeOwned(owned);
    },
  };
}

/** 断言失败路径也回收本夹具拥有的进程组与临时目录。回收失败会抛出。 */
export async function releaseStartupFixtures(): Promise<void> {
  const children = [...ownedChildren];
  const failures: unknown[] = [];
  for (const owned of children) {
    try {
      await disposeOwned(owned);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const root of ownedRoots) {
    rmSync(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "startup fixture did not reclaim every owned process");
  }
}

function track(child: ChildProcess): OwnedChild {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  closed.catch(() => undefined);
  return {
    child,
    closed,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function stopMain(owned: OwnedChild): Promise<number | null> {
  const { child } = owned;
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    const closed = await owned.closed;
    ownedChildren.delete(owned);
    return closed.code;
  }
  process.kill(child.pid, "SIGTERM");
  const closed = await deadline(
    owned.closed,
    GRACEFUL_DEADLINE_MS,
    "compiled entry did not exit after SIGTERM",
  );
  ownedChildren.delete(owned);
  return closed.code;
}

async function disposeOwned(owned: OwnedChild): Promise<void> {
  const { child } = owned;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    signalGroup(child.pid, "SIGKILL");
  }
  try {
    await deadline(
      owned.closed,
      GRACEFUL_DEADLINE_MS,
      "owned process group did not close after SIGKILL",
    );
  } finally {
    ownedChildren.delete(owned);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function waitForStartedRecord(owned: OwnedChild, deadlineMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `timed out waiting for server_started\nstdout=${owned.stdout()}\nstderr=${owned.stderr()}`,
        ),
      );
    }, deadlineMs);
    const finish = (error: Error | undefined, record?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      owned.child.stdout?.off("data", onChange);
      owned.child.stderr?.off("data", onChange);
      owned.child.off("close", onChange);
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(record);
    };
    const onChange = (): void => {
      const record = startedRecord(owned.stdout());
      if (record !== undefined) {
        finish(undefined, record);
        return;
      }
      if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
        finish(
          new Error(
            `compiled entry exited before server_started code=${String(owned.child.exitCode)} signal=${String(owned.child.signalCode)}\nstdout=${owned.stdout()}\nstderr=${owned.stderr()}`,
          ),
        );
      }
    };
    owned.child.stdout?.on("data", onChange);
    owned.child.stderr?.on("data", onChange);
    owned.child.on("close", onChange);
    onChange();
  });
}

/** 返回 stdout 里第一条 JSON 对象本身，不重建字段，额外 key 会留在断言里。 */
function startedRecord(text: string): unknown {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      return JSON.parse(line);
    } catch {}
  }
  return undefined;
}

function collectAndWait(
  child: ChildProcess,
  deadlineMs: number,
  label: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const owned = track(child);
  return deadline(owned.closed, deadlineMs, `SETUP: ${label} exceeded ${deadlineMs}ms`)
    .then((exit) => ({ ...exit, stderr: owned.stderr() }))
    .catch((error: unknown) => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        process.kill(child.pid, "SIGKILL");
      }
      return deadline(
        owned.closed,
        GRACEFUL_DEADLINE_MS,
        `SETUP: ${label} did not close after SIGKILL`,
      ).then(() => {
        throw error;
      });
    });
}

function orderPreload(trace: string): string {
  const root = mkdtempSync(join(tmpdir(), "open-wb-order-preload-"));
  ownedRoots.add(root);
  const path = join(root, "order-preload.cjs");
  writeFileSync(
    path,
    `'use strict';
const { appendFileSync } = require('node:fs');
const Module = require('node:module');
const cp = require('node:child_process');
const net = require('node:net');
const sqlite = require('node:sqlite');
const trace = ${JSON.stringify(trace)};
const mark = (event) => {
  appendFileSync(trace, event + '\\n');
};
const spawn = cp.spawn;
cp.spawn = function observedSpawn(...args) {
  const child = spawn.apply(this, args);
  child.once('exit', () => mark('runtime-exit'));
  return child;
};
Module.syncBuiltinESMExports();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function observedListen(...args) {
  this.once('close', () => mark('listener-close'));
  return listen.apply(this, args);
};
const close = sqlite.DatabaseSync.prototype.close;
sqlite.DatabaseSync.prototype.close = function observedClose(...args) {
  const result = close.apply(this, args);
  mark('db-close');
  return result;
};
`,
  );
  return path;
}

function deadline<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
