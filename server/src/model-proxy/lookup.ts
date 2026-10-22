/**
 * 代理的按模型查找契约（s1d-model-registry D5；model-proxy「透传端点与 bearer 鉴权」）。
 *
 * `ModelRegistry` 是代理（`lookup`、`secrets`）、composer（`current`）与会话侧净化（`secrets`）共用的一个对象；
 * 生产装配给的是 `models/registry.ts` 的注册表快照（结构一致，本模块不导入它），没有它时由 `staticRegistry`
 * 把静态白名单与可选的单一上游适配成同一个接口（静态测试接缝）。
 */
import { upstreamSecretList } from "../core/upstream-failure.js";
import type { ModelCatalog } from "../model-catalog.js";

export interface ModelUpstream {
  baseUrl: string;
  apiKey: string;
}

/** 一个已登记模型的转发目标；登记了但没有上游时是 `{}`（不带 `upstream` 键）。 */
export interface ModelRoute {
  upstream?: ModelUpstream;
}

export interface ModelRegistry {
  current(): ModelCatalog;
  /** 未登记 → undefined。 */
  lookup(id: string): ModelRoute | undefined;
  /** 此刻全部已登记上游的 apiKey 与 base URL 各部分（upstream-failure 的密钥集规则）。 */
  secrets(): readonly string[];
  refresh(): void;
}

/** 白名单 = `catalog` 的模型 id；有上游时每个模型都转发到它，没有时每个模型都是 `{}`。`refresh` 不做事。 */
export function staticRegistry(
  catalog: ModelCatalog,
  upstream?: ModelUpstream | undefined,
): ModelRegistry {
  const ids = new Set(catalog.models.map((model) => model.id));
  const secrets =
    upstream === undefined
      ? []
      : upstreamSecretList({ apiKey: upstream.apiKey, baseUrl: upstream.baseUrl, paths: [] });
  return {
    current: () => catalog,
    lookup(id: string): ModelRoute | undefined {
      if (!ids.has(id)) {
        return undefined;
      }
      return upstream === undefined ? {} : { upstream: { ...upstream } };
    },
    secrets: () => secrets,
    refresh(): void {},
  };
}
