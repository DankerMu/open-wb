/**
 * 生产唯一入口（Issue #7）：validate → DB-parent prepare → openDb → createApp → listen → 成功记录。
 *
 * ESM main guard：import 本模块只暴露纯配置 seam（resolveServerConfig），不产生任何
 * startup/signal/filesystem 副作用；只有直接执行本模块（import.meta.main）才进入主路径。
 * 主路径契约：
 * - 完整 env 配置在 SIGINT/SIGTERM 注册与任何文件系统/DB/listen 副作用之前同步校验；
 * - 配置失败只发一行 generic application stderr JSON，不安装 handler、不获取任何资源；
 * - 失败记录带 reason：失败所处的启动阶段（封闭枚举的源码字面量，#1203），不带 error 的任何内容；
 * - 一个 per-entry AbortController 随 listen 传递：ready/pre-bind 窗口内的 signal 也会
 *   中止绑定，不会留下一个逃过 releaseOwned 的后到 listener（Fastify 也因 aborted 跳过
 *   server.listen/在 abort 时 close，Node 原生 listen signal 同样中止未完成绑定）；
 * - 启动成功/失败发布都走 Promise 管理的单行 writer：同步 throw / write callback /
 *   stream error 三路只 settle 一次，error 事件被消费后才移除监听，绝不抛原始 stack。
 */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { type AgentSettings, resolveAgentSettings } from "./agent-config.js";
import { type AssemblyDependencies, createApp, type SessionRuntime } from "./app.js";
import { openDb } from "./core/db/index.js";
import { deriveProxyBaseUrl, writeManagedModelsYml } from "./model-proxy/models-yml.js";
import { type PreviewSettings, resolvePreviewSettings } from "./preview-config.js";
import { writeHostOverlay } from "./sessions/omp/host-overlay.js";
import type { HandshakeTimeoutRecord } from "./sessions/omp/spawn-gate.js";
import { ensureOmpStateLayout, ompAgentDir } from "./sessions/omp/state-layout.js";
import type { TodoRejection } from "./sessions/store-todo.js";
import { writeManagedLine } from "./startup-writer.js";

const PRIVATE_DB_FILE_MODE = 0o600;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_DB_RELATIVE = join("var", "dev.db");
const DEFAULT_STATIC_RELATIVE = join("web", "dist");
const STARTUP_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
];

export interface ServerConfig extends AgentSettings, PreviewSettings {
  host: string;
  port: number;
  dbPath: string;
  staticRoot: string;
  repoRoot: string;
}

/** 纯配置 seam：消费三十五项应用 key——四项自有，agent 十九项经 resolveAgentSettings，预览与文件十二项经 resolvePreviewSettings，未知 key 忽略；repo root 由 entry identity 推导。 */
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
    ...resolveAgentSettings(env, repoRoot),
    ...resolvePreviewSettings(env, repoRoot),
  };
}

/** 纯 seam：sessions 模块的 runtime settings；idle 期限、两个上限与四个快照设置同一对象、唯一来源为已解析 config。 */
export function sessionRuntimeOf(config: ServerConfig): SessionRuntime {
  return {
    bin: config.ompBin,
    sandboxRoot: config.sandboxRoot,
    stateDir: config.ompStateDir,
    modelId: config.modelCatalog.defaultModelId,
    idleMs: config.ompIdleMs,
    maxProcesses: config.ompMaxProcesses,
    spawnConcurrency: config.ompSpawnConcurrency,
    snapshotMaxFileBytes: config.snapshotMaxFileBytes,
    snapshotMaxTotalBytes: config.snapshotMaxTotalBytes,
    snapshotMaxEntries: config.snapshotMaxEntries,
    snapshotExcludeNames: config.snapshotExcludeNames,
    ...(config.ompUser === undefined ? {} : { ompUser: config.ompUser }),
  };
}

/**
 * 纯 seam：main 路径交给 createApp 的完整 assembly（runtime、可选 upstream、log、onError）。构造本身零输出；
 * log 把每条握手超时记录、warn 把每条被丢弃的任务清单候选记录（不含任务文本）写成 application stderr 一行 JSON，
 * 写失败吞掉；
 * onError 把 supervisor 每次通知的保留故障写成一行 generic `session_fault`（#664）。
 */
export function appAssemblyOf(config: ServerConfig): AssemblyDependencies {
  return {
    runtime: sessionRuntimeOf(config),
    modelCatalog: config.modelCatalog,
    approvalMaxMode: config.approvalMaxMode,
    uploadMaxBytes: config.uploadMaxBytes,
    uploadMaxFiles: config.uploadMaxFiles,
    ...(config.modelUpstreamBaseUrl !== undefined && config.modelUpstreamApiKey !== undefined
      ? { upstream: { baseUrl: config.modelUpstreamBaseUrl, apiKey: config.modelUpstreamApiKey } }
      : {}),
    log: writeRecord,
    warn: writeRecord,
    onError: emitSessionFault,
  };
}

function writeRecord(record: HandshakeTimeoutRecord | TodoRejection): void {
  void writeManagedLine(process.stderr, `${JSON.stringify(record)}\n`).catch(() => {
    // Sink unavailable: the record is observation only and never changes the request or exit code.
  });
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
  // Fastify 对 exact "localhost" 按 DNS 全部回环地址多重绑定，次级 listener 不受有界关停约束（#340）。
  if (raw === "localhost") {
    return DEFAULT_HOST;
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

/**
 * 启动失败所处的阶段（#1203）：封闭枚举，取值全是这里的字面量；只由「失败发生在哪一步」
 * 决定，绝不取自 error 对象。
 */
type StartupStage =
  | "config"
  | "db"
  | "app"
  | "listen"
  | "state_layout"
  | "models_yml"
  | "host_overlay"
  | "publish";

/** 失败记录：generic application stderr 一行，恰 event 与 reason 两个键；退出码已定。 */
function emitStartupFailed(reason: StartupStage): Promise<void> {
  return emitStderrRecord({ event: "server_start_failed", reason });
}

/**
 * listener 预算到期强制回收的 generic 记录（#227）。升级不是失败：不改退出码。
 * 以 void 调用，写入被拒绝也不会成为未处理 rejection。
 */
function emitListenerForceClose(): void {
  void emitStderrRecord({ event: "listener_force_close" });
}

/**
 * supervisor 保留故障的 generic 记录（#664）：不带原始 error 的任何内容。同步返回 undefined
 * （sink 契约不允许 thenable）；以 void 调用，写入被拒绝也不会成为未处理 rejection 或再次通知。
 */
function emitSessionFault(): void {
  void emitStderrRecord({ event: "session_fault" });
}

/** generic application stderr 一行；sink 不可用时吞掉（不递归/不抛原始 stack）。 */
async function emitStderrRecord(record: { event: string; reason?: StartupStage }): Promise<void> {
  try {
    await writeManagedLine(process.stderr, `${JSON.stringify(record)}\n`);
  } catch {
    // Sink unavailable: the generic line is physically impossible; exit code is decided elsewhere.
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
  /** 正在进行的启动步骤：每一步开始之前推进，失败出口读它作为 reason。 */
  stage: StartupStage;
}

function runEntrypoint(): void {
  const entryUrl = import.meta.url;
  let config: ServerConfig;
  try {
    config = resolveServerConfig(process.env, entryUrl);
  } catch {
    process.exitCode = 1;
    void emitStartupFailed("config");
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
    stage: "db",
  };

  process.on("SIGINT", () => requestShutdown(owned));
  process.on("SIGTERM", () => requestShutdown(owned));

  void start(owned, config);
}

async function start(owned: OwnedResources, config: ServerConfig): Promise<void> {
  try {
    if (config.dbPath !== ":memory:") {
      mkdirSync(dirname(config.dbPath), { recursive: true });
      preparePrivateDbFiles(config.dbPath);
    }
    owned.db = openDb(config.dbPath);
    owned.stage = "app";
    owned.app = createApp({
      db: owned.db,
      staticRoot: config.staticRoot,
      // 启动失败一经判定，失败路径只留 generic 失败记录：强制回收不再发布。
      onListenerForceClose: () => {
        if (!owned.failed) {
          emitListenerForceClose();
        }
      },
      assembly: appAssemblyOf(config),
    });
    owned.stage = "listen";
    await owned.app.listen({
      host: config.host,
      port: config.port,
      signal: owned.controller.signal,
    });
    owned.controller = new AbortController();
    if (owned.signalReceived) {
      await releaseOwned(owned);
      return;
    }
    await publishStarted(owned, config);
  } catch {
    // 真实失败判定必须先于本失败路径的第一次 yield：一旦决定失败，signal 不得压制其
    // generic 发布，也不得把退出码降为 0（sticky failure）。
    owned.failed = true;
    process.exitCode = 1;
    await releaseOwned(owned);
    await emitStartupFailed(owned.stage);
  }
}

/** 成功记录：listen 之后建托管布局、写托管 models 与宿主 overlay，再发实际 bound address/port。 */
async function publishStarted(owned: OwnedResources, config: ServerConfig): Promise<void> {
  // publish 涵盖发布步骤里三个具名子步骤之外的一切，包括开头这两项核对。
  owned.stage = "publish";
  const app = owned.app;
  if (app === undefined) {
    throw new Error("startup owns no app instance");
  }
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("startup owns no bound address");
  }
  if (owned.signalReceived) {
    return;
  }
  owned.stage = "state_layout";
  ensureOmpStateLayout(config.ompStateDir);
  owned.stage = "models_yml";
  await writeManagedModelsYml(ompAgentDir(config.ompStateDir), {
    proxyBaseUrl: deriveProxyBaseUrl(address),
    models: config.modelCatalog.models,
  });
  owned.stage = "host_overlay";
  await writeHostOverlay(config.ompStateDir);
  owned.stage = "publish";
  if (owned.signalReceived || owned.app === undefined) {
    return;
  }
  const published = app.server.address();
  if (!sameAddress(published, address)) {
    throw new Error("startup bound address changed before publication");
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

function sameAddress(left: string | AddressInfo | null, right: AddressInfo): boolean {
  return (
    left !== null &&
    typeof left !== "string" &&
    left.address === right.address &&
    left.port === right.port
  );
}

function requestShutdown(owned: OwnedResources): void {
  owned.signalReceived = true;
  const app = owned.app;
  const bound = app !== undefined && addressOf(app) !== undefined;
  if (!bound && !owned.controller.signal.aborted) {
    owned.controller.abort();
  }
  void releaseOwned(owned).then(() => {
    // 已判定的启动/输出失败不得被 shutdown 降为 0；只允许在无失败历史时写 0。
    process.exitCode = owned.releaseFailed || owned.failed ? 1 : 0;
  });
}

function addressOf(app: FastifyInstance): AddressInfo | undefined {
  const address = app.server.address();
  return address !== null && typeof address !== "string" ? address : undefined;
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

function preparePrivateDbFiles(dbPath: string): void {
  preparePrivateDbMain(dbPath);
  prepareExistingSidecar(`${dbPath}-wal`);
  prepareExistingSidecar(`${dbPath}-shm`);
}

function preparePrivateDbMain(dbPath: string): void {
  let fd: number;
  try {
    fd = openSync(
      dbPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_DB_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    chmodExistingPrivateFile(dbPath);
    return;
  }
  try {
    fchmodSync(fd, PRIVATE_DB_FILE_MODE);
  } finally {
    closeSync(fd);
  }
}

function prepareExistingSidecar(path: string): void {
  try {
    chmodExistingPrivateFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function chmodExistingPrivateFile(path: string): void {
  if (!statSync(path).isFile()) {
    throw new Error("private db path is not a regular file");
  }
  chmodSync(path, PRIVATE_DB_FILE_MODE);
}
