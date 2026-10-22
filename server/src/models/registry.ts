/**
 * models/registry — 进程内注册表快照（s1d-model-registry D1、D5；model-registry「注册表快照是白名单的唯一来源」
 * 的快照部分）。三个读取（`current` / `lookup` / `secrets`）全部来自最近一次成功的 `refresh()` 一次性读出的
 * 同一份快照；store 写入之后由调用方 `refresh()`（单进程，不做跨进程失效）。
 *
 * 构造时不读表：首次 `refresh()`（启动阶段 `model_registry`）之前调任何读取都抛 `Error`。`refresh()` 失败
 *（如空表 `toCatalog` 抛错）原样抛出，旧快照保持不变。返回对象在结构上满足代理的 `models` 契约
 *（`lookup`、`secrets`）与 composer 的 `current()`。
 */
import type { ModelCatalog } from "../model-catalog.js";
import type { createModelStore } from "./store.js";

type ModelStore = Pick<
  ReturnType<typeof createModelStore>,
  "list" | "routeOf" | "toCatalog" | "secrets"
>;

interface Upstream {
  baseUrl: string;
  apiKey: string;
}

interface Snapshot {
  catalog: ModelCatalog;
  /** id → 上游；`null` = 登记了但没有上游。 */
  routes: ReadonlyMap<string, Upstream | null>;
  secrets: readonly string[];
}

export function createRegistry(store: ModelStore) {
  let snapshot: Snapshot | undefined;
  const read = (): Snapshot => {
    if (snapshot === undefined) {
      throw new Error("model registry read before its first refresh");
    }
    return snapshot;
  };

  return {
    current: (): ModelCatalog => read().catalog,

    /** 未登记 → undefined；登记无上游 → `{}`（不带 `upstream` 键）；否则 `{upstream}`（副本）。 */
    lookup(id: string): { upstream?: Upstream } | undefined {
      // 值恒为 `Upstream | null`：`get` 给出 undefined 即未登记。
      const upstream = read().routes.get(id);
      if (upstream === undefined) {
        return undefined;
      }
      return upstream === null ? {} : { upstream: { ...upstream } };
    },

    secrets: (): readonly string[] => read().secrets,

    /** 先整份读出再替换：任一步抛出时 `snapshot` 不动。 */
    refresh(): void {
      const rows = store.list();
      const catalog = store.toCatalog(rows);
      const routes = new Map(rows.map((row) => [row.id, store.routeOf(row.id) ?? null] as const));
      snapshot = { catalog, routes, secrets: store.secrets() };
    },
  };
}
