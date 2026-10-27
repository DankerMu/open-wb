/**
 * 生产入口的模型注册表装配（s1d-model-registry D2、D7；model-registry「环境种子」「变更即发布」的启动两步）。
 * 从 `server.ts` 抽出（行数预算），只被入口与测试导入；不读 `process.env`，env 由调用方传入。
 *
 * - `seedModelRegistry`：启动阶段 `model_registry`。表空时把解析出的白名单与 `MODEL_UPSTREAM_*` 种进表
 *  （判空与插入在 store 的一个事务里），随后首次 `refresh()`——都是同步 node:sqlite 操作，createApp 拿到的
 *   注册表已填好。表非空且六个模型键任一 `env[key] !== undefined`（空串也算设置）时经 `warn` 恰交出一条
 *   `{"event":"model_env_ignored"}`。任一步抛出原样抛给入口（`reason: "model_registry"`）。
 * - `createStartupPublisher`：给 `createPublisher` 注入两个真实写出器（`models` 模块不导入 model-proxy 与
 *   sessions，system.md §4）。`writeOverlay` 的包装在 `stage.stage === "models_yml"` 时先把它切到
 *   `host_overlay`，启动的两个失败 reason 由此区分；其它阶段（启动之后的发布）不动 stage。`proxyBaseUrl`
 *   是 getter：入口在 `models_yml` 阶段之前给 null，此前的发布只刷新过快照、不写文件。
 * - `createMcpJsonStage`（s1d-connectors D4，启动阶段 `mcp_json`，紧接 `host_overlay`）：返回唯一的托管
 *   `mcp.json` 发布器与 `runStage`。发布器在 createApp 之前构造（写端点共用它，单飞因此覆盖启动与写端点），
 *   此时 agent 目录门控关着，发布只读不写；`runStage()` 把 stage 切到 `mcp_json`、打开门控、再发布一次，
 *   写失败原样抛给入口（`reason: "mcp_json"`）。不并进 `createStartupPublisher`：模型发布不写 `mcp.json`，
 *   连接器写入也不重写模型的两个文件。
 * - `workspaceAssemblyOf` / `startBackgroundWork`（s1b-workspace-mounts D12，同为 `server.ts` 行数预算抽出）：
 *   `appAssemblyOf` 递交的工作空间三项——回收目录服务、挂载设置（mount-manager 要 DB 与审计，在 createApp
 *   里构造）与挂载源的额外保护根；`server_started` 写出之后入口不等待的两件后台工作——回收目录首扫与挂载的
 *   启动恢复。
 */
import type { DatabaseSync } from "node:sqlite";
import { createMcpPublisher } from "./connectors/mcp-json.js";
import { createConnectorStore } from "./connectors/store.js";
import type { ModelCatalog } from "./model-catalog.js";
import { writeManagedModelsYml } from "./model-proxy/models-yml.js";
import { createPublisher } from "./models/publish.js";
import { createRegistry } from "./models/registry.js";
import { createModelStore } from "./models/store.js";
import { writeHostOverlay } from "./sessions/omp/host-overlay.js";
import { ompAgentDir } from "./sessions/omp/state-layout.js";
import type { MountSettings } from "./workspaces/mounts/config.js";
import type { MountManager } from "./workspaces/mounts/manager.js";
import { createTrash } from "./workspaces/trash.js";

/** 只作首次种子的六个键（http-service-skeleton「服务启动与装配」）。 */
const MODEL_ENV_KEYS = [
  "MODEL_CATALOG",
  "MODEL_ID",
  "MODEL_REASONING",
  "MODEL_VISION",
  "MODEL_UPSTREAM_BASE_URL",
  "MODEL_UPSTREAM_API_KEY",
] as const;

/** 表非空时被忽略的环境的那一行（只有 `event` 一个键）。 */
export interface ModelEnvIgnoredRecord {
  event: "model_env_ignored";
}

interface SeedOptions {
  db: DatabaseSync;
  /** 已解析的启动配置里种子要用的三项。 */
  config: {
    modelCatalog: ModelCatalog;
    modelUpstreamBaseUrl?: string | undefined;
    modelUpstreamApiKey?: string | undefined;
  };
  env: Record<string, string | undefined>;
  warn: (record: ModelEnvIgnoredRecord) => void;
}

export function seedModelRegistry(options: SeedOptions) {
  const { db, config, env, warn } = options;
  const store = createModelStore(db);
  const outcome = store.seedIfEmpty(config.modelCatalog, {
    baseUrl: config.modelUpstreamBaseUrl,
    apiKey: config.modelUpstreamApiKey,
  });
  const registry = createRegistry(store);
  registry.refresh();
  if (outcome === "skipped" && MODEL_ENV_KEYS.some((key) => env[key] !== undefined)) {
    warn({ event: "model_env_ignored" });
  }
  return { store, registry };
}

interface StartupPublisherOptions {
  registry: { current(): ModelCatalog };
  stateDir: string;
  browserEnabled: boolean;
  proxyBaseUrl: () => string | null;
  /** 入口的当前启动阶段（入口传 `owned` 本身）；只在 `models_yml` 时被切到 `host_overlay`。 */
  stage: { stage: string };
}

export function createStartupPublisher(options: StartupPublisherOptions) {
  const { registry, stateDir, browserEnabled, proxyBaseUrl, stage } = options;
  return createPublisher({
    agentDir: ompAgentDir(stateDir),
    stateDir,
    proxyBaseUrl,
    browserEnabled,
    registry,
    writeModelsYml: writeManagedModelsYml,
    writeOverlay: (dir, overlay) => {
      if (stage.stage === "models_yml") {
        stage.stage = "host_overlay";
      }
      return writeHostOverlay(dir, overlay);
    },
  });
}

interface McpJsonStageOptions {
  db: DatabaseSync;
  stateDir: string;
  /** 入口的当前启动阶段（入口传 `owned` 本身）；`runStage()` 把它切到 `mcp_json`。 */
  stage: { stage: string };
}

export function createMcpJsonStage(options: McpJsonStageOptions) {
  const { db, stateDir, stage } = options;
  let agentDir: string | null = null;
  const publisher = createMcpPublisher({
    agentDir: () => agentDir,
    store: createConnectorStore(db),
  });
  return {
    publisher,
    runStage(): Promise<void> {
      stage.stage = "mcp_json";
      agentDir = ompAgentDir(stateDir);
      return publisher.publish();
    },
  };
}

interface WorkspaceAssemblyConfig extends MountSettings {
  sandboxRoot: string;
  trashRetentionDays: number;
  previewCacheDir: string;
  officeSpoolDir?: string;
}

/**
 * 按 `TRASH_RETENTION_DAYS` 建的回收目录服务（构造不碰文件系统；删除路由与入口的周期清理用同一个）与
 * `resolveMountSettings` 的结果（未配置 `RCLONE_BIN` 时 createApp 构造的 manager 功能关闭）。挂载设置只取
 * 它自己的五项，不把整个 config（含上游密钥）递进装配。`extraProtectedRoots` 是 createApp 自己推不出的两个
 * 挂载源保护根（#1786）：`PREVIEW_CACHE_DIR`，以及已配置时的 `OFFICE_SPOOL_DIR`（未配置即省略，不放 `undefined`）。
 */
export function workspaceAssemblyOf(config: WorkspaceAssemblyConfig) {
  const { rcloneBin, fusermountBin, ompUid, mountHostAllow, mountMaxPerWorkspace } = config;
  const { previewCacheDir, officeSpoolDir } = config;
  const mountSettings: MountSettings = {
    ...(rcloneBin === undefined ? {} : { rcloneBin }),
    ...(fusermountBin === undefined ? {} : { fusermountBin }),
    ...(ompUid === undefined ? {} : { ompUid }),
    ...(mountHostAllow === undefined ? {} : { mountHostAllow }),
    mountMaxPerWorkspace,
  };
  return {
    trash: createTrash({
      sandboxRoot: config.sandboxRoot,
      retentionDays: config.trashRetentionDays,
    }),
    mountSettings,
    extraProtectedRoots: [
      previewCacheDir,
      ...(officeSpoolDir === undefined ? [] : [officeSpoolDir]),
    ],
  };
}

/**
 * `server_started` 写出之后、未收到信号时入口调用一次，两者都不等待、永不 reject：回收目录首扫（关停不中止
 * 在途的一轮，进程待它落定后退出）；挂载的启动恢复（逐个依次，失败只使该挂载离线并退避，不产生 failure
 * record、不改变退出码；关停时 app 关闭钩子上的 `closeAll` 收住在途的那次尝试）。
 */
export function startBackgroundWork(work: {
  trash: ReturnType<typeof createTrash>;
  mounts: Pick<MountManager, "restoreAll">;
}): void {
  void work.trash.sweep(Date.now());
  void work.mounts.restoreAll();
}
