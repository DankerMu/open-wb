/**
 * 生产唯一入口（Issue #7）：validate → DB-parent prepare → openDb → 办公文档 sidecar 预检 → 模型注册表
 * 种子与快照（`model_registry`，`startup-registry.ts`；s1d-model-registry）→ 转换器 →
 * createApp → listen → 托管布局 → 沙箱根 → 预览监听器 listen → 三个托管文件 → 预览缓存目录（含清空
 * spool 的 `jobs/`）→ 转换器开始受理 → 成功记录 → 回收目录首扫（#1070、#1074；主监听器先绑定、托管布局
 * 紧随其后，#1337；沙箱根紧随托管布局，change sandbox-boundary-closure；预检，change office-convert-sandbox）。
 *
 * ESM main guard：import 本模块只暴露纯配置 seam（resolveServerConfig），不产生任何
 * startup/signal/filesystem 副作用；只有直接执行本模块（import.meta.main）才进入主路径。
 * 主路径契约：
 * - 完整 env 配置在 SIGINT/SIGTERM 注册与任何文件系统/DB/listen 副作用之前同步校验；
 * - 配置失败只发一行 generic application stderr JSON，不安装 handler、不获取任何资源；
 * - 失败记录带 reason：失败所处的启动阶段（封闭枚举的源码字面量，#1203），不带 error 的任何内容；
 * - 两次 listen 各用一个 AbortController，主监听器在先（#1337：先占住 `PORT`，系统为缺省的
 *   `PREVIEW_PORT=0` 分配的端口就不可能是它）。ready/pre-bind 窗口内的 signal 也会中止绑定，不会
 *   留下一个逃过 releaseOwned 的后到 listener（Fastify 也因 aborted 跳过 server.listen/在 abort 时
 *   close，Node 原生 listen signal 同样中止未完成绑定）。每次绑定成功后立即换新的 controller：
 *   已绑定的监听器手里的 signal 此后不会再被 abort，主监听器只经 releaseOwned 关闭——预览绑定在途
 *   时到达的信号只中止预览那一次绑定；
 * - 两次绑定之间主监听器已受理请求而预览端口还没有：这段时间的 `preview-token` 答 typed 404
 *   （`workspaces/rest-preview-token.ts`，端口为 0 即未绑定）。托管布局在这两次绑定之间建立
 *   （owner 2026-10-13 裁决）：主 `listen` resolve 之后到 `ensureOmpStateLayout` 返回是同步代码，
 *   没有 await，主监听器受理的第一个请求到达时布局已在（这段时间到达的 prompt 建得出快照目录：
 *   钩子辅助复现，预加载推迟预览监听器的原生 listen，`test/server-startup-preview.test.ts`）。
 *   同一段同步代码随后经 `ensureSandboxRoot` 建出并校正 `SANDBOX_ROOT`（`sandbox_root` 阶段，owner
 *   B2/B3/B4）：第一个请求的处理体运行时根已建出、已校正为 `3770`（读代码推出：其间没有 await）；
 *   校正失败时 `OMP_USER` 模式启动失败；同 uid 模式不再纠正、不回滚，只写一行 `sandbox_root_unchanged`。
 *   布局或沙箱根失败时主监听器已绑定，随失败清理关闭。`models.yml` 与宿主 overlay 仍在两次绑定之后写：
 *   overlay 写出之前 spawn 的 omp v18.0.10 以 `Config overlay not found` 退出码 1 退出、不到
 *   `ready`（实测范围：macOS arm64、无 `OMP_USER`、手工按 `spawnOmp` 的 argv/env 运行官方二进制；
 *   Linux、sudo/setpriv 形状与入口对这次退出的处置未测，见 ADR-0014 的 #1337 行）；
 * - 关停与失败清理同一条路：转换器 `close()`（对在途作业写 `cancel` 并等它们落定）→ 两个周期清理的
 *   定时器 → 预览监听器 → 主实例（其 preClose 里 runtime 退出，再关主监听器）→ DB。预览监听器先于
 *   runtime 关：omp 只连主监听器上的模型代理，预览实例没有 `/api` 与 `/v1`。转换器先于预览监听器关：
 *   在途的 `/o/` 请求因此立即以断开结束，不占监听器的关停预算；
 * - sidecar 预检（`app` 阶段，至多 `await` 5 秒，永不使启动失败）之后、写失败行之前核对信号，与主
 *   listen 之后同形；转换器随后构造（构造不碰文件系统、不起进程），但 `/o/` 要到 `clearWork`（清空
 *   spool 的 `jobs/`）落定之后才启动转换（此前答 503）：那次清空会删掉在途转换的作业目录；
 * - #1286（change sandbox-boundary-closure 有界闭合，owner B1）：本入口给 `sweep`（每次启动与每 6 小时）、
 *   `/w/`、`/o/`、`clearWork` 提供生产调用方。`sweep` 的 `.trash` 换入随根的粘滞位关闭（根为 `3770` 时；
 *   读代码推出），四条读路由的末段换入已闭合（钩子辅助复现）；`clearWork` 对 `jobs/` 的递归删除仍有
 *   中间分量的残余。陈述与证据等级见 `workspaces/trash.ts`、`preview/app.ts`、`preview/office-cache.ts`
 *   的头注释；本入口只是调用方，没有为它们加任何检查；
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
import { ensureOwnedDir, ensureSandboxRoot } from "./core/sandbox/dirs.js";
import type { ModelRegistry } from "./model-proxy/lookup.js";
import { deriveProxyBaseUrl } from "./model-proxy/models-yml.js";
import type { ModelPublishFailedRecord } from "./models/publish.js";
import { createPreviewApp } from "./preview/app.js";
import { createOfficeConverter, type OfficeConverter } from "./preview/office.js";
import { createOfficeCache, createOfficeCleanup } from "./preview/office-cache.js";
import { preflightOfficeSidecar } from "./preview/office-sidecar-health.js";
import { createPreviewTokens, type PreviewTokens } from "./preview/tokens.js";
import { type PreviewSettings, resolvePreviewSettings } from "./preview-config.js";
import type { HandshakeTimeoutRecord } from "./sessions/omp/spawn-gate.js";
import { ensureOmpStateLayout, sweepSessionConfig } from "./sessions/omp/state-layout.js";
import type { TodoRejection } from "./sessions/store-todo.js";
import type { UpstreamFailedRecord } from "./sessions/upstream-failure-log.js";
import {
  createMcpJsonStage,
  createStartupPublisher,
  type ModelEnvIgnoredRecord,
  seedModelRegistry,
  startBackgroundWork,
  workspaceAssemblyOf,
} from "./startup-registry.js";
import { writeManagedLine } from "./startup-writer.js";
import { type MountSettings, resolveMountSettings } from "./workspaces/mounts/config.js";
import type { createTrash } from "./workspaces/trash.js";

const PRIVATE_DB_FILE_MODE = 0o600;
/** 预览缓存目录的两个 mode（design D18）与 spool 的 `jobs/`（change office-convert-sandbox）。 */
const PREVIEW_CACHE_DIR_MODE = 0o2750;
const PREVIEW_PDF_DIR_MODE = 0o700;
const SPOOL_JOBS_DIR_MODE = 0o700;
/** 启动预检的三个时间参数（office-preview「转换 sidecar 的健康与 fail-closed」）；写死。 */
const SIDECAR_PREFLIGHT = { waitMs: 5_000, pollMs: 100, freshMs: 10_000 };
/** 回收目录的清理周期（design D22）：6 小时。 */
const TRASH_SWEEP_INTERVAL_MS = 21_600_000;
/** 转换缓存 `pdf/` 的清理周期（office-preview「转换缓存」）：24 小时。 */
const PDF_SWEEP_INTERVAL_MS = 86_400_000;

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
  "models",
  "experts",
  "skills",
  "connectors",
];

export interface ServerConfig extends AgentSettings, PreviewSettings, MountSettings {
  host: string;
  port: number;
  dbPath: string;
  staticRoot: string;
  repoRoot: string;
}

/** 纯配置 seam：消费四十二项应用 key——四项自有，agent 二十一项经 resolveAgentSettings，预览与文件十二项经 resolvePreviewSettings，挂载五项经 resolveMountSettings，未知 key 忽略；repo root 由 entry identity 推导。 */
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
    ...resolveMountSettings(env),
  };
}

/**
 * 纯 seam：sessions 模块的 runtime settings；idle 期限、两个上限与四个快照设置同一对象、唯一来源为已解析 config。
 * `modelId` 缺省取配置白名单的缺省模型；生产入口传注册表快照的缺省（s1d-model-registry D13）。
 */
export function sessionRuntimeOf(
  config: ServerConfig,
  modelId = config.modelCatalog.defaultModelId,
): SessionRuntime {
  return {
    bin: config.ompBin,
    sandboxRoot: config.sandboxRoot,
    stateDir: config.ompStateDir,
    modelId,
    idleMs: config.ompIdleMs,
    maxProcesses: config.ompMaxProcesses,
    spawnConcurrency: config.ompSpawnConcurrency,
    snapshotMaxFileBytes: config.snapshotMaxFileBytes,
    snapshotMaxTotalBytes: config.snapshotMaxTotalBytes,
    snapshotMaxEntries: config.snapshotMaxEntries,
    snapshotExcludeNames: config.snapshotExcludeNames,
    ...(config.ompUser === undefined ? {} : { ompUser: config.ompUser }),
    ...(config.browserBin === undefined ? {} : { browserBin: config.browserBin }),
  };
}

/**
 * 纯 seam：main 路径交给 createApp 的完整 assembly（runtime、可选 upstream、log、onError）。构造本身零输出；
 * log 把每条握手超时记录、warn 把每条被丢弃的任务清单候选记录（不含任务文本）写成 application stderr 一行 JSON，
 * 写失败吞掉；
 * onError 把 supervisor 每次通知的保留故障写成一行 generic `session_fault`（#664）。
 * 恒带按 `TRASH_RETENTION_DAYS` 建的回收目录服务（构造不碰文件系统）：删除路由与入口的周期清理用同一个；
 * 恒带挂载设置 `mountSettings`（mount-manager 由 createApp 构造；两项经 `startup-registry.ts`）。
 * 给了 `preview`（令牌登记表、返回预览监听器已绑定端口的函数、转换是否可用）才带预览依赖，签发
 * 端点由此注册；`officeAvailable` 原样透传，入口给的是转换器的 `available`。
 * 给了 `registry`（生产入口恒给，s1d-model-registry D5）：带 `models`，`runtime.modelId` 取快照的缺省，
 * 不再带 `modelCatalog` 与 `upstream`——白名单与上游只有注册表一个来源。不给时是静态测试接缝，行为不变。
 */
export function appAssemblyOf(
  config: ServerConfig,
  preview?: { tokens: PreviewTokens; port: () => number; officeAvailable: boolean },
  registry?: ModelRegistry,
): AssemblyDependencies & { trash: ReturnType<typeof createTrash> } {
  return {
    runtime: sessionRuntimeOf(config, registry?.current().defaultModelId),
    ...workspaceAssemblyOf(config),
    ...(preview === undefined
      ? {}
      : {
          preview: {
            tokens: preview.tokens,
            port: preview.port,
            ...(config.previewOrigin === undefined ? {} : { origin: config.previewOrigin }),
            documentMaxBytes: config.previewDocumentMaxBytes,
            officeAvailable: preview.officeAvailable,
          },
        }),
    ...(registry === undefined ? { modelCatalog: config.modelCatalog } : { models: registry }),
    approvalMaxMode: config.approvalMaxMode,
    uploadMaxBytes: config.uploadMaxBytes,
    uploadMaxFiles: config.uploadMaxFiles,
    previewLimits: {
      text: config.previewTextMaxBytes,
      image: config.previewImageMaxBytes,
      notebook: config.previewNotebookMaxBytes,
      archiveEntries: config.previewArchiveMaxEntries,
    },
    ...(registry === undefined &&
    config.modelUpstreamBaseUrl !== undefined &&
    config.modelUpstreamApiKey !== undefined
      ? { upstream: { baseUrl: config.modelUpstreamBaseUrl, apiKey: config.modelUpstreamApiKey } }
      : {}),
    log: writeRecord,
    warn: writeRecord,
    onError: emitSessionFault,
  };
}

function writeRecord(
  record:
    | HandshakeTimeoutRecord
    | UpstreamFailedRecord
    | TodoRejection
    | ModelEnvIgnoredRecord
    | ModelPublishFailedRecord
    | { event: "mcp_publish_failed" }
    | { event: "office_convert_sidecar_unavailable" },
): void {
  void writeManagedLine(process.stderr, `${JSON.stringify(record)}\n`).catch(() => {
    // Sink unavailable: the record is observation only and never changes the request or exit code.
  });
}

type Office = ReturnType<typeof officeOf>;

/**
 * 办公文档转换器（外面包缓存、排队与去重）、清理对象与要建的 `jobs/`；构造不碰文件系统、不起进程。
 * 只有预检通过（`sidecarOk`）时两者才拿到 spool，否则转换器 `available` 为 `false`、清理不碰 spool。
 * `OMP_USER` 不参与；转换器的 `log` 是同一受管 stderr writer。
 */
function officeOf(config: ServerConfig, sidecarOk: boolean) {
  const spoolDir = sidecarOk ? config.officeSpoolDir : undefined;
  const spool = {
    cacheDir: config.previewCacheDir,
    ...(spoolDir === undefined ? {} : { spoolDir }),
  };
  const timeoutMs = config.officeConvertTimeoutMs;
  return {
    converter: createOfficeCache({
      cacheDir: config.previewCacheDir,
      converter: createOfficeConverter({ ...spool, timeoutMs, log: writeRecord }),
      concurrency: config.officeConvertConcurrency,
    }),
    cleanup: createOfficeCleanup(spool),
    jobs: spoolDir === undefined ? undefined : join(spoolDir, "jobs"),
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
  | "model_registry"
  | "app"
  | "listen"
  | "state_layout"
  | "sandbox_root"
  | "preview_listen"
  | "models_yml"
  | "host_overlay"
  | "mcp_json"
  | "preview_cache"
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

/** 同 uid 模式下沙箱根没能校正（owner B3）：恰 `event` 一个键；以 void 调用，启动不等它、写失败吞掉。 */
function emitSandboxRootUnchanged(): void {
  void emitStderrRecord({ event: "sandbox_root_unchanged" });
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

/** 入口拥有的一次性资源状态：转换器、定时器、两个实例与 DB 均只在此关闭，避免重复/二次关闭。 */
interface OwnedResources {
  /** 只管 `listening` 那个实例的那一次 listen；该次绑定成功后立即换新的。 */
  controller: AbortController;
  /** 当前 `controller` 的 signal 交给了哪个实例的 listen：先主实例，它绑定成功后是预览实例。 */
  listening: FastifyInstance | undefined;
  app: FastifyInstance | undefined;
  /** 预览监听器的实例：后于主实例 listen，先于主实例关闭。 */
  preview: FastifyInstance | undefined;
  /** 办公文档转换器：先于两个监听器关闭。 */
  converter: OfficeConverter | undefined;
  /** `clearWork` 落定之后才为真：此前 `/o/` 不启动转换。 */
  officeReady: boolean;
  /** 回收目录清理的周期定时器（已 unref）。 */
  trashTimer: NodeJS.Timeout | undefined;
  /** 转换缓存清理的周期定时器（已 unref）。 */
  pdfTimer: NodeJS.Timeout | undefined;
  /** 一次关停无论几个监听器被强制回收，`listener_force_close` 至多一行。 */
  forceCloseEmitted: boolean;
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
    listening: undefined,
    app: undefined,
    preview: undefined,
    converter: undefined,
    officeReady: false,
    trashTimer: undefined,
    pdfTimer: undefined,
    forceCloseEmitted: false,
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
    // 预检永不 reject；等待中到达的信号在这里核对：此时只拥有 DB，返回即干净取消、不写那一行。
    const spoolDir = config.officeSpoolDir;
    const sidecarOk =
      spoolDir !== undefined && (await preflightOfficeSidecar({ spoolDir, ...SIDECAR_PREFLIGHT }));
    if (owned.signalReceived) {
      await releaseOwned(owned);
      return;
    }
    // 没过（owner B3）：恰 `event` 一个键的一行，位于 `server_started` 之前；写失败吞掉。
    if (spoolDir !== undefined && !sidecarOk) {
      void emitStderrRecord({ event: "office_convert_sidecar_unavailable" });
    }
    // 注册表种子与首次快照（同步）：createApp 拿到的注册表已填好，主监听器的第一个请求就读到快照。
    owned.stage = "model_registry";
    const { registry } = seedModelRegistry({
      db: owned.db,
      config,
      env: process.env,
      warn: writeRecord,
    });
    // `models_yml` 阶段之前为 null：此前的发布只刷新过快照，启动阶段随后整体发布一次。
    let proxyBaseUrl: string | null = null;
    const publisher = createStartupPublisher({
      registry,
      stateDir: config.ompStateDir,
      browserEnabled: config.browserBin !== undefined,
      proxyBaseUrl: () => proxyBaseUrl,
      stage: owned,
    });
    const mcp = createMcpJsonStage({ db: owned.db, stateDir: config.ompStateDir, stage: owned });
    owned.stage = "app";
    // 启动失败一经判定，失败路径只留 generic 失败记录：强制回收不再发布。两个实例共用这一个回调。
    const onListenerForceClose = (): void => {
      if (!owned.failed && !owned.forceCloseEmitted) {
        owned.forceCloseEmitted = true;
        emitListenerForceClose();
      }
    };
    // 预览监听器绑定之后才有值。主监听器先于它 listen：两次绑定之间到达的签发请求读到 0，
    // 签发端点据此按未装配作答。
    let previewPort = 0;
    const tokens = createPreviewTokens();
    // 先登记到 owned 再做别的：此后任何一步失败或收到信号，releaseOwned 都会关掉转换器。
    const office = officeOf(config, sidecarOk);
    owned.converter = office.converter;
    const assembly = {
      ...appAssemblyOf(
        config,
        { tokens, port: () => previewPort, officeAvailable: office.converter.available },
        registry,
      ),
      publish: publisher.publish,
      mcpPublish: mcp.publisher.publish,
      onPublishFailed: writeRecord,
    };
    owned.app = createApp({
      db: owned.db,
      staticRoot: config.staticRoot,
      onListenerForceClose,
      assembly,
    });
    // 与主实例同一个 store 与沙箱 facade（越界由它写 sandbox.reject），同一张令牌登记表。
    const { store, sandbox } = owned.app.workspaces;
    owned.preview = createPreviewApp({
      store,
      sandbox,
      tokens,
      converter: office.converter,
      limits: { documentMaxBytes: config.previewDocumentMaxBytes },
      officeReady: () => owned.officeReady,
      onListenerForceClose,
    });
    owned.stage = "listen";
    owned.listening = owned.app;
    await owned.app.listen({
      host: config.host,
      port: config.port,
      signal: owned.controller.signal,
    });
    // 主监听器的 signal 到此作废：预览那一次绑定用新的，信号中止它时原生 close 碰不到主监听器。
    owned.controller = new AbortController();
    owned.listening = owned.preview;
    if (owned.signalReceived) {
      await releaseOwned(owned);
      return;
    }
    // 主 listen resolve 之后到沙箱根返回没有 await：主监听器受理的第一个请求到达时两者都已在。
    owned.stage = "state_layout";
    ensureOmpStateLayout(config.ompStateDir);
    sweepSessionConfig(config.ompStateDir);
    owned.stage = "sandbox_root";
    const strict = config.ompUser !== undefined;
    if (ensureSandboxRoot(config.sandboxRoot, { strict }).outcome === "unchanged") {
      emitSandboxRootUnchanged();
    }
    owned.stage = "preview_listen";
    await owned.preview.listen({
      host: config.host,
      port: config.previewPort,
      signal: owned.controller.signal,
    });
    owned.controller = new AbortController();
    if (owned.signalReceived) {
      await releaseOwned(owned);
      return;
    }
    previewPort = boundAddressOf(owned.preview, "preview").port;
    await publishStarted(owned, config, assembly.trash, office, async (address) => {
      proxyBaseUrl = deriveProxyBaseUrl(address);
      await publisher.publish();
      return owned.signalReceived ? undefined : mcp.runStage();
    });
  } catch {
    // reason 在入口、任何 await 之前取定：releaseOwned 等待期间排队的 REST 发布会经 overlay 包装翻 stage。
    const stage = owned.stage;
    // 真实失败判定必须先于本失败路径的第一次 yield：一旦决定失败，signal 不得压制其
    // generic 发布，也不得把退出码降为 0（sticky failure）。
    owned.failed = true;
    process.exitCode = 1;
    await releaseOwned(owned);
    await emitStartupFailed(stage);
  }
}

/**
 * 成功记录：两次 listen 之后写三个托管文件、建预览缓存目录并清空 spool 的 `jobs/`，然后才让 `/o/`
 * 受理转换、扫一轮转换缓存并起周期清理，再发主监听器实际的 bound address/port；记录之后回收目录扫第一轮、
 * 挂载启动恢复，入口不等它们。`publishModels`：交出代理地址后注册表发布器写 models 与 overlay（写 overlay 前把 stage 切到
 * `host_overlay`），随后 `mcp_json` 阶段读库写 `mcp.json`——其间已收到信号则不读（库可能正在关闭）；
 * 见 `startup-registry.ts`。
 */
async function publishStarted(
  owned: OwnedResources,
  config: ServerConfig,
  trash: ReturnType<typeof createTrash>,
  office: Office,
  publishModels: (address: AddressInfo) => Promise<void>,
): Promise<void> {
  const { cleanup } = office;
  // publish 涵盖发布步骤里具名子步骤之外的一切，包括开头这两项核对。
  owned.stage = "publish";
  const app = owned.app;
  if (app === undefined) {
    throw new Error("startup owns no app instance");
  }
  const address = boundAddressOf(app, "main");
  if (owned.signalReceived) {
    return;
  }
  owned.stage = "models_yml";
  await publishModels(address);
  // 上面两步等待期间收到的信号：`releaseOwned` 已经开始。不建目录、不清空，同样直接返回。
  if (owned.signalReceived) {
    return;
  }
  owned.stage = "preview_cache";
  await preparePreviewCache(config.previewCacheDir, office);
  owned.stage = "publish";
  if (owned.signalReceived || owned.app === undefined) {
    return;
  }
  const published = app.server.address();
  if (!sameAddress(published, address)) {
    throw new Error("startup bound address changed before publication");
  }
  // 上面的 signalReceived 核对到这里是同步代码（没有 await）：releaseOwned 若已开始，上面已经返回；
  // 之后才开始的 releaseOwned 会清掉这两个定时器。
  // `clearWork` 已经落定（永不 reject；预检未过时不碰 spool）：从这里起 `/o/` 才启动转换。
  owned.officeReady = true;
  // 不等待：sweepPdf 永不 reject。启动时扫一轮，此后每 24 小时一轮；不看 OFFICE_SPOOL_DIR 是否配置。
  void cleanup.sweepPdf(Date.now());
  owned.pdfTimer = setInterval(() => void cleanup.sweepPdf(Date.now()), PDF_SWEEP_INTERVAL_MS);
  owned.pdfTimer.unref();
  owned.trashTimer = setInterval(() => void trash.sweep(Date.now()), TRASH_SWEEP_INTERVAL_MS);
  owned.trashTimer.unref();
  await writeManagedLine(
    process.stdout,
    `${JSON.stringify({
      event: "server_started",
      host: address.address,
      port: address.port,
      modules: STARTUP_MODULES,
    })}\n`,
  );
  if (!owned.signalReceived) {
    // 不等待：回收目录首扫与挂载的启动恢复（`startup-registry.ts`）。
    startBackgroundWork({ trash, mounts: app.mounts });
  }
}

/**
 * 预览缓存目录（office-preview「转换缓存与作业目录清理」）：缓存根与 `pdf` 校正到精确 mode（不再建
 * `work`）；预检通过时再建出 spool 的 `jobs/`（`0700`；spool 根是部署方的卷，不建、不校正），然后本进程
 * 递归删 `jobs/` 下的遗留条目（`jobs` 自身不删、不启动子进程、不提权）。`ensureOwnedDir` 不递归，所以
 * 先建缺失的父目录；建目录失败是启动失败（`preview_cache`），`clearWork` 永不 reject。
 */
async function preparePreviewCache(cacheDir: string, office: Office): Promise<void> {
  mkdirSync(dirname(cacheDir), { recursive: true });
  ensureOwnedDir(cacheDir, PREVIEW_CACHE_DIR_MODE);
  ensureOwnedDir(join(cacheDir, "pdf"), PREVIEW_PDF_DIR_MODE);
  if (office.jobs !== undefined) {
    ensureOwnedDir(office.jobs, SPOOL_JOBS_DIR_MODE);
  }
  await office.cleanup.clearWork();
}

/** 已绑定的 TCP 地址；未绑定（含 listen 被 signal 中止后 resolve 的情形）即抛出。 */
function boundAddressOf(instance: FastifyInstance, name: "main" | "preview"): AddressInfo {
  const address = addressOf(instance);
  if (address === undefined) {
    throw new Error(`startup owns no bound ${name} address`);
  }
  return address;
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
  // 只中止在途的绑定：当前 controller 所管的那个实例还没有 bound（装配之前也算）。预览绑定在途时
  // 这里中止的只是预览那一次；已绑定的监听器不经 signal 的原生 close，只由 releaseOwned 关
  // （主实例：runtime → listener → DB）。
  const listening = owned.listening;
  const bound = listening !== undefined && addressOf(listening) !== undefined;
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
      // 先关转换器：对在途作业写 `cancel`、等它们落定。
      await closeOwnedConverter(owned);
      clearInterval(owned.trashTimer);
      clearInterval(owned.pdfTimer);
      await closeOwnedInstance(owned, "preview");
      await closeOwnedInstance(owned, "app");
      closeOwnedDb(owned);
    })();
  }
  await owned.releasing;
}

/** 对在途转换写 `cancel` 并等它们落定；此后的 `/o/` 请求以断开结束。 */
async function closeOwnedConverter(owned: OwnedResources): Promise<void> {
  const converter = owned.converter;
  if (converter === undefined) {
    return;
  }
  owned.converter = undefined;
  try {
    await converter.close();
  } catch {
    owned.releaseFailed = true;
  }
}

async function closeOwnedInstance(owned: OwnedResources, which: "preview" | "app"): Promise<void> {
  const instance = owned[which];
  if (instance === undefined) {
    return;
  }
  owned[which] = undefined;
  try {
    await instance.close();
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
