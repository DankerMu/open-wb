/**
 * models/publish — 托管文件发布（s1d-model-registry D7、D13；model-registry「变更即发布」）。一轮发布读一次
 * 快照，依次写托管 `models.yml` 与宿主 overlay（`visionModelId` = 快照里第一个 `vision` 模型，没有则 null）；
 * `models.yml` 写出失败则不写 overlay，本轮拒绝。
 *
 * 两个写出器与代理地址由装配根注入（`models` 不导入 model-proxy 与 sessions，system.md §4）；`proxyBaseUrl()`
 * 为 null（启动阶段 `models_yml` 之前）时不调写出器直接返回。
 *
 * 单飞：同一时刻只有一轮在跑；期间到达的调用合并为紧随其后的一轮（开跑时读最新快照），合并在同一轮上的
 * 调用方等这一轮结束、共享它的结果。一轮失败只拒绝合并在它上面的调用方，已排到下一轮的不受影响；
 * 失败或成功之后状态都复位。
 */
import type { CatalogModel, ModelCatalog } from "../model-catalog.js";

/** 发布失败时装配层经 `onPublishFailed` 写出的一行记录（只有 `event` 一个键）。 */
export interface ModelPublishFailedRecord {
  event: "model_publish_failed";
}

interface PublisherOptions {
  agentDir: string;
  stateDir: string;
  /** 主监听器的代理地址；绑定并交给发布器之前为 null。 */
  proxyBaseUrl: () => string | null;
  browserEnabled: boolean;
  registry: { current(): ModelCatalog };
  /** 结构同 `model-proxy/models-yml.ts` 的 `writeManagedModelsYml`。 */
  writeModelsYml: (
    agentDir: string,
    options: { proxyBaseUrl: string; models: readonly CatalogModel[] },
  ) => Promise<void>;
  /** 结构同 `sessions/omp/host-overlay.ts` 的 `writeHostOverlay`。 */
  writeOverlay: (
    stateDir: string,
    options: { browserEnabled: boolean; visionModelId: string | null },
  ) => Promise<void>;
}

export function createPublisher(options: PublisherOptions) {
  const { agentDir, stateDir, browserEnabled, registry, writeModelsYml, writeOverlay } = options;

  const round = async (): Promise<void> => {
    const proxyBaseUrl = options.proxyBaseUrl();
    if (proxyBaseUrl === null) {
      return;
    }
    const { models } = registry.current();
    await writeModelsYml(agentDir, { proxyBaseUrl, models });
    await writeOverlay(stateDir, {
      browserEnabled,
      visionModelId: models.find((model) => model.vision)?.id ?? null,
    });
  };

  // 单飞的全部状态：在跑的一轮与排在它后面的那一轮（两者各至多一个）。
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const current = round().finally(() => {
      running = null;
    });
    running = current;
    return current;
  };

  return {
    publish(): Promise<void> {
      if (queued !== null) {
        return queued;
      }
      if (running === null) {
        return start();
      }
      // 不论上一轮成败都接着跑；它的拒绝只交给合并在它上面的调用方。
      queued = running
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return start();
        });
      return queued;
    },
  };
}
