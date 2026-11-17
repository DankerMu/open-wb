/**
 * `kb-session-search.test.ts` 与 `kb-shared-audit.test.ts` 共用的会话检索夹具（#2034 s2c-kb-visibility 组 8）：
 * 取 `registerKb` 交回的会话检索、直接种库、带外改范围、读检索请求。
 */
import { afterEach, beforeEach, type MockInstance, vi } from "vitest";
import * as kb from "../src/kb/index.js";
import { resourceName } from "../src/kb/pipeline.js";
import type { IngestWorld } from "./kb-ingest-helpers.js";
import { OWNER } from "./mounts-manager-helpers.js";

export const ROUTE = "POST /api/v1/retrieval";

export type SessionSearch = NonNullable<ReturnType<typeof kb.registerKb>>["sessionSearch"];

/**
 * 在所在文件登记对 `registerKb` 的透传 spy（照 `server-assembly-modules.test.ts`），返回取值函数：开启的 `registerKb`
 * 最近一次交回的会话检索。
 */
export function useSessionSearch(): () => SessionSearch {
  let registered: MockInstance<typeof kb.registerKb>;
  beforeEach(() => {
    registered = vi.spyOn(kb, "registerKb");
  });
  afterEach(() => {
    registered.mockRestore();
  });
  return () => {
    const result = registered.mock.results.at(-1);
    if (result?.type !== "return" || result.value === null) {
      throw new Error("registerKb did not return a registration");
    }
    return result.value.sessionSearch;
  };
}

interface BaseSeed {
  id: string;
  name: string;
  createdAt: number;
  ownerId?: string;
  state?: "ready" | "rebuilding" | "rebuild_failed";
  threshold?: number;
  vectorWeight?: number;
}

/** 直接插一行库并改建库时间、状态与检索参数，返回它的 dataset id。 */
export function seedBase(world: IngestWorld, seed: BaseSeed): string {
  const datasetId = world.fake.addDataset(resourceName(seed.id, 0));
  world.store.createBase({
    id: seed.id,
    ownerId: seed.ownerId ?? OWNER,
    name: seed.name,
    template: "naive",
    raptor: false,
    graph: false,
    datasetId,
    canvasId: null,
    templateGroupId: null,
  });
  world.fw.world.db
    .prepare(
      "UPDATE knowledge_bases SET created_at = ?, state = ?, retrieval_threshold = ?, retrieval_vector_weight = ? WHERE id = ?",
    )
    .run(
      seed.createdAt,
      seed.state ?? "ready",
      seed.threshold ?? 0.2,
      seed.vectorWeight ?? 0.7,
      seed.id,
    );
  return datasetId;
}

/** 带外改范围（053 的 CHECK 要求两列同改）：`group` 用种子组 g1（成员 u1、u2），其余档组 id 为 NULL。 */
export function share(world: IngestWorld, id: string, scope: "me" | "group" | "all"): void {
  world.fw.world.db
    .prepare("UPDATE knowledge_bases SET scope = ?, scope_group_id = ? WHERE id = ?")
    .run(scope, scope === "group" ? "g1" : null, id);
}

/** 假 RAGFlow 收到的检索请求。 */
export const retrievals = (world: IngestWorld) =>
  world.fake.requests().filter((entry) => `${entry.method} ${entry.path}` === ROUTE);
