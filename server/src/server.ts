/**
 * 生产唯一入口（Issue #7）：validate → DB-parent prepare → openDb → createApp → listen → 成功记录。
 *
 * ESM main guard：import 本模块只暴露纯配置 seam（resolveServerConfig），不产生任何
 * startup/signal/filesystem 副作用；只有直接执行本模块（import.meta.main）才进入主路径。
 * 主路径契约：
 * - 完整 env 配置在 SIGINT/SIGTERM 注册与任何文件系统/DB/listen 副作用之前同步校验；
 * - 配置失败只发一行 generic application stderr JSON，不安装 handler、不获取任何资源；
 * - 一个 per-entry AbortController 随 listen 传递：ready/pre-bind 窗口内的 signal 也会
 *   中止绑定，不会留下一个逃过 releaseOwned 的后到 listener（Fastify 也因 aborted 跳过
 *   server.listen/在 abort 时 close，Node 原生 listen signal 同样中止未完成绑定）；
 * - 启动成功/失败发布都走 Promise 管理的单行 writer：同步 throw / write callback /
 *   stream error 三路只 settle 一次，error 事件被消费后才移除监听，绝不抛原始 stack。
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { openDb } from "./core/db/index.js";
import { writeManagedLine } from "./startup-writer.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_DB_RELATIVE = join("var", "dev.db");
const DEFAULT_STATIC_RELATIVE = join("web", "dist");
const STARTUP_MODULES = ["core/db", "auth", "http"];

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  staticRoot: string;
  repoRoot: string;
}

/** 纯配置 seam：只消费自有 HOST/PORT/DB_PATH/STATIC_ROOT，未知 key 忽略；repo root 由 entry identity 推导。 */
export function resolveServerConfig(
  env: Record<string, string | undefined>,
  entryUrl: string,
): ServerConfig {
  const repoRoot = repoRootOf(entryUrl);
  return {
    host: resolveHost(env.HOST),
    port: resolvePort(env.PORT),
    dbPath: resolveDatabasePath(env.DB_PATH, repoRoot),
    staticRoot: resolveStaticRoot(env.STATIC_ROOT, repoRoot),
    repoRoot,
  };
}

function repoRootOf(entryUrl: string): string {
  return resolve(fileURLToPath(new URL("../../", entryUrl)));
}

function resolveHost(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_HOST;
  }
  if (raw.length === 0 || /^\s+$/u.test(raw)) {
    throw new Error("HOST must be a nonempty string");
  }
  return raw;
}

function resolvePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error("PORT must be canonical ASCII decimal");
  }
  if (raw.length > 1 && raw.startsWith("0")) {
    throw new Error("PORT must not have a leading zero");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be within 1..65535");
  }
  return port;
}

function resolveDatabasePath(raw: string | undefined, repoRoot: string): string {
  if (raw === undefined) {
    return join(repoRoot, DEFAULT_DB_RELATIVE);
  }
  if (raw.length === 0) {
    throw new Error("DB_PATH must not be empty");
  }
  if (raw === ":memory:") {
    return raw;
  }
  return resolveSettingPath(raw, repoRoot);
}

function resolveStaticRoot(raw: string | undefined, repoRoot: string): string {
  if (raw === undefined) {
    return join(repoRoot, DEFAULT_STATIC_RELATIVE);
  }
  if (raw.length === 0) {
    throw new Error("STATIC_ROOT must not be empty");
  }
  return resolveSettingPath(raw, repoRoot);
}

function resolveSettingPath(raw: string, repoRoot: string): string {
  return isAbsolute(raw) ? raw : join(repoRoot, raw);
}

/** 失败记录：generic application stderr 一行；sink 不可用时吞掉（退出码已定，不递归/不抛原始 stack）。 */
async function emitStartupFailed(): Promise<void> {
  try {
    await writeManagedLine(process.stderr, `${JSON.stringify({ event: "server_start_failed" })}\n`);
  } catch {
    // Sink unavailable: generic line is physically impossible; nonzero already decided.
  }
}

if (import.meta.main) {
  runEntrypoint();
}

/** 入口拥有的一次性资源状态：app 与 DB 均只在此关闭，避免重复/二次关闭。 */
interface OwnedResources {
  controller: AbortController;
  app: FastifyInstance | undefined;
  db: DatabaseSync | undefined;
  releasing: Promise<void> | undefined;
  releaseFailed: boolean;
  /** 已判定的真实启动失败（sticky）：signal 不得压制其 generic 发布或将退出码降为 0。 */
  failed: boolean;
  signalReceived: boolean;
}

function runEntrypoint(): void {
  const entryUrl = import.meta.url;
  let config: ServerConfig;
  try {
    config = resolveServerConfig(process.env, entryUrl);
  } catch {
    process.exitCode = 1;
    void emitStartupFailed();
    return;
  }

  const owned: OwnedResources = {
    controller: new AbortController(),
    app: undefined,
    db: undefined,
    releasing: undefined,
    releaseFailed: false,
    failed: false,
    signalReceived: false,
  };

  process.on("SIGINT", () => requestShutdown(owned));
  process.on("SIGTERM", () => requestShutdown(owned));

  void start(owned, config);
}

async function start(owned: OwnedResources, config: ServerConfig): Promise<void> {
  try {
    if (config.dbPath !== ":memory:") {
      mkdirSync(dirname(config.dbPath), { recursive: true });
    }
    owned.db = openDb(config.dbPath);
    owned.app = createApp({ db: owned.db, staticRoot: config.staticRoot });
    await owned.app.listen({
      host: config.host,
      port: config.port,
      signal: owned.controller.signal,
    });
    if (owned.signalReceived) {
      await releaseOwned(owned);
      return;
    }
    await publishStarted(owned);
  } catch {
    // 真实失败判定必须先于本失败路径的第一次 yield：一旦决定失败，signal 不得压制其
    // generic 发布，也不得把退出码降为 0（sticky failure）。
    owned.failed = true;
    process.exitCode = 1;
    await releaseOwned(owned);
    await emitStartupFailed();
  }
}

/** 成功记录：listen 之后、实际 bound address/port；无效 app/address 抛给唯一的 start catch。 */
async function publishStarted(owned: OwnedResources): Promise<void> {
  const app = owned.app;
  if (app === undefined) {
    throw new Error("startup owns no app instance");
  }
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("startup owns no bound address");
  }
  await writeManagedLine(
    process.stdout,
    `${JSON.stringify({
      event: "server_started",
      host: address.address,
      port: address.port,
      modules: STARTUP_MODULES,
    })}\n`,
  );
}

function requestShutdown(owned: OwnedResources): void {
  owned.signalReceived = true;
  owned.controller.abort();
  void releaseOwned(owned).then(() => {
    // 已判定的启动/输出失败不得被 shutdown 降为 0；只允许在无失败历史时写 0。
    process.exitCode = owned.releaseFailed || owned.failed ? 1 : 0;
  });
}

async function releaseOwned(owned: OwnedResources): Promise<void> {
  if (owned.releasing === undefined) {
    owned.releasing = (async () => {
      await closeOwnedApp(owned);
      closeOwnedDb(owned);
    })();
  }
  await owned.releasing;
}

async function closeOwnedApp(owned: OwnedResources): Promise<void> {
  if (owned.app === undefined) {
    return;
  }
  const app = owned.app;
  owned.app = undefined;
  try {
    await app.close();
  } catch {
    owned.releaseFailed = true;
  }
}

function closeOwnedDb(owned: OwnedResources): void {
  if (owned.db === undefined) {
    return;
  }
  const db = owned.db;
  owned.db = undefined;
  try {
    db.close();
  } catch {
    owned.releaseFailed = true;
  }
}
