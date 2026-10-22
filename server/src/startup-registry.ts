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
 */
import type { DatabaseSync } from "node:sqlite";
import type { ModelCatalog } from "./model-catalog.js";
import { writeManagedModelsYml } from "./model-proxy/models-yml.js";
import { createPublisher } from "./models/publish.js";
import { createRegistry } from "./models/registry.js";
import { createModelStore } from "./models/store.js";
import { writeHostOverlay } from "./sessions/omp/host-overlay.js";
import { ompAgentDir } from "./sessions/omp/state-layout.js";

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
