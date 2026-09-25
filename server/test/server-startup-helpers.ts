/**
 * 真实 production 入口夹具（Issue #102）：
 * 用已声明的 TypeScript 编译器把 tracked server/src 编进测试私有 ESM 树，
 * 带上真实 migrations，再以 node 直接执行 compiled main。
 * 产物几何与 production 一致：<root>/server/dist/server.js，repo root 为 ../../。
 * 不读仓库 dist，不引入 jiti。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const FAKE_OMP = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
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
  options: { orderTrace?: string; requireHook?: string } = {},
): StartedServer {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin",
      ...(options.orderTrace === undefined && options.requireHook === undefined
        ? {}
        : {
            NODE_OPTIONS: [
              options.requireHook === undefined ? undefined : `--require ${options.requireHook}`,
              options.orderTrace === undefined
                ? undefined
                : `--require ${orderPreload(options.orderTrace)}`,
            ]
              .filter((entry) => entry !== undefined)
              .join(" "),
            ...(options.orderTrace === undefined
              ? {}
              : { OPEN_WB_ORDER_TRACE: options.orderTrace }),
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

/** production 入口的显式 fixture env：全部路径落在调用方 scratch 下。 */
export function compiledFixtureEnv(
  scratchRoot: string,
  port: number,
  bin: string,
  extra: Record<string, string>,
): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    PORT: String(port),
    DB_PATH: join(scratchRoot, "db", "dev.db"),
    OMP_STATE_DIR: join(scratchRoot, "state"),
    SANDBOX_ROOT: join(scratchRoot, "sandbox"),
    OMP_BIN: bin,
    ...extra,
  };
}

/**
 * 生成可执行的 fake-omp 启动器（omp spawn env 从零重建，参数只能写进启动器文本）。
 * bearerCapture：先把收到的 WORKBUDDY_MODEL_TOKEN 写到该绝对路径，供密钥不外泄断言使用。
 */
export function writeFakeOmpLauncher(
  scratchRoot: string,
  scenario: string,
  bearerCapture?: string,
): string {
  const binDir = join(scratchRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, `${scenario}-omp.mjs`);
  const capture =
    bearerCapture === undefined
      ? ""
      : `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(bearerCapture)}, process.env.WORKBUDDY_MODEL_TOKEN ?? "");
`;
  writeFileSync(
    bin,
    `#!${process.execPath}
${capture}process.argv.push("--scenario", ${JSON.stringify(scenario)});
await import(${JSON.stringify(FAKE_OMP)});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

export function login(port: number): Promise<string> {
  return requestJson(port, "POST", "/api/auth/login", undefined, {
    account: "zhangsan",
    password: "demo",
  }).then((response) => {
    const cookie = response.headers.get("set-cookie");
    if (response.status !== 200 || cookie === null || !cookie.startsWith("workbuddy_session=")) {
      throw new Error(`login failed: ${response.status} ${response.body}`);
    }
    return cookie.slice(0, cookie.indexOf(";"));
  });
}

export function createSession(port: number, cookie: string): Promise<string> {
  return requestJson(port, "POST", "/api/sessions", cookie).then((response) => {
    const body = JSON.parse(response.body) as { id?: unknown };
    if (response.status !== 201 || typeof body.id !== "string") {
      throw new Error(`session create failed: ${response.status} ${response.body}`);
    }
    return body.id;
  });
}

export function prompt(
  port: number,
  cookie: string,
  session: string,
  message: string,
): Promise<void> {
  return expectPromptStatus(port, cookie, session, message, 202);
}

export function expectPromptStatus(
  port: number,
  cookie: string,
  session: string,
  message: string,
  status: number,
): Promise<void> {
  return requestJson(port, "POST", `/api/sessions/${session}/prompt`, cookie, { message }).then(
    (response) => {
      if (response.status !== status) {
        throw new Error(`prompt failed: ${response.status} ${response.body}`);
      }
    },
  );
}

function requestJson(
  port: number,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<{ status: number; headers: Headers; body: string }> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  }).then(async (response) => ({
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }));
}

export interface PublicAssistantMessage {
  role: string;
  content: string;
  status: string;
  steps: Array<{ name: string; status: string }>;
}

/** 以 deadline 轮询 history，直到最后一条 assistant 消息离开 running。 */
export async function waitForTerminalAssistant(
  port: number,
  cookie: string,
  session: string,
  deadlineMs: number,
): Promise<PublicAssistantMessage> {
  const deadlineAt = performance.now() + deadlineMs;
  for (;;) {
    const response = await requestJson(port, "GET", `/api/sessions/${session}/messages`, cookie);
    const body = JSON.parse(response.body) as { messages?: PublicAssistantMessage[] };
    const assistant = body.messages?.findLast((message) => message.role === "assistant");
    if (response.status === 200 && assistant !== undefined && assistant.status !== "running") {
      return assistant;
    }
    if (performance.now() > deadlineAt) {
      throw new Error(`assistant turn did not finish: ${response.status} ${response.body}`);
    }
    await delay(20);
  }
}

/** 以 deadline 轮询等待标记文件出现（preload barrier 的进入/放行信号）。 */
export async function waitForFile(path: string, deadlineMs: number): Promise<void> {
  const deadlineAt = performance.now() + deadlineMs;
  while (!existsSync(path)) {
    if (performance.now() > deadlineAt) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await delay(10);
  }
}

/** 继任 listener 能在同一 host:port 上绑定并关闭：原进程已释放端口。 */
export function expectBindable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const successor = createServer();
    successor.once("error", reject);
    successor.listen(port, host, () => {
      successor.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

/**
 * 扣住真实 models.yml 写入：先落 MODELS_ENTERED 标记，再轮询等待 MODELS_RELEASE 出现。
 * - throw（#227）：测试写 release；放行后以 EACCES 拒绝（等价于 state 目录不可写），
 *   让测试能在失败判定前放入在飞请求。不安装 SIGTERM 监听。
 * - call-through（#210）：写 entered 之前安装 SIGTERM 监听，由它写 release；放行后调用真实
 *   writeFile。入口与本监听在同一次 process.emit 内同步执行，而被扣住的写入只在之后的定时器
 *   宏任务恢复，所以 signalReceived 必然先于写入完成与其后的发布守卫。
 */
export function gatedModelsWriteHook(mode: "throw" | "call-through"): string {
  const onEnter =
    mode === "call-through"
      ? ["    process.once('SIGTERM', () => fs.writeFileSync(process.env.MODELS_RELEASE, ''));"]
      : [];
  const onRelease =
    mode === "throw"
      ? [
          "    const error = new Error('EACCES: permission denied');",
          "    error.code = 'EACCES';",
          "    throw error;",
        ]
      : [];
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const fsp = require('node:fs/promises');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const nativeWriteFile = fsp.writeFile;",
    "fsp.writeFile = async function gatedWriteFile(path, ...rest) {",
    "  if (typeof path === 'string' && path.endsWith('models.yml')) {",
    ...onEnter,
    "    fs.writeFileSync(process.env.MODELS_ENTERED, '');",
    "    while (!fs.existsSync(process.env.MODELS_RELEASE)) {",
    "      await new Promise((resolve) => setTimeout(resolve, 10));",
    "    }",
    ...onRelease,
    "  }",
    "  return nativeWriteFile.call(this, path, ...rest);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n");
}

export function observeOpenDbHook(): string {
  return `'use strict';
const fs = require('node:fs');
const { appendFileSync, writeFileSync } = fs;
const sqlite = require('node:sqlite');
const original = sqlite.DatabaseSync;
function DatabaseSyncObserved(...args) {
  const path = args[0];
  if (process.env.UMASK_LOG) {
    writeFileSync(process.env.UMASK_LOG, process.umask().toString(8));
  }
  appendFileSync(process.env.MODE_LOG, JSON.stringify({
    path,
    main: fileMode(path),
    wal: fileMode(path + '-wal'),
    shm: fileMode(path + '-shm'),
  }) + '\\n');
  return Reflect.construct(original, args, new.target ?? original);
}
Object.setPrototypeOf(DatabaseSyncObserved, original);
DatabaseSyncObserved.prototype = original.prototype;
sqlite.DatabaseSync = DatabaseSyncObserved;
function fileMode(path) {
  if (path === ':memory:') {
    return null;
  }
  try {
    return fs.lstatSync(path).mode & 0o777;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
`;
}

export function childUmaskHook(): string {
  return `'use strict';
process.umask(0o777);
${observeOpenDbHook().replace(/^'use strict';\n/u, "")}`;
}

export function denyChmodHook(targets: string[]): string {
  return `'use strict';
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const denied = new Set(${JSON.stringify(targets)});
const nativeChmod = fs.chmodSync;
const nativeFchmod = fs.fchmodSync;
const nativeOpen = fs.openSync;
const fds = new Set();
fs.openSync = function observeOpen(path, flags, mode) {
  const fd = nativeOpen.call(this, path, flags, mode);
  if (denied.has(path)) {
    fds.add(fd);
  }
  return fd;
};
fs.chmodSync = function deny(path, mode) {
  if (denied.has(path)) {
    const error = new Error('EPERM');
    error.code = 'EPERM';
    throw error;
  }
  return nativeChmod.call(this, path, mode);
};
fs.fchmodSync = function denyFd(fd, mode) {
  if (fds.has(fd)) {
    const error = new Error('EPERM');
    error.code = 'EPERM';
    throw error;
  }
  return nativeFchmod.call(this, fd, mode);
};
syncBuiltinESMExports();
`;
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
