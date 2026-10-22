/**
 * s1d-model-registry group 3: the in-process registry snapshot (model-registry「注册表快照是白名单的唯一来源」
 * snapshot part; design D1, D5). `:memory:` databases through the real migrations and the real store;
 * expected catalogs are spec literals, expected secret lists come from the independent
 * `upstreamSecretList` (upstream-failure「上游原文净化」key-set rule).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { upstreamSecretList } from "../src/core/upstream-failure.js";
import type { ModelCatalog } from "../src/model-catalog.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";

const KEY_A = "sk-registry-A-SENTINEL-7001";
const KEY_B = "sk-registry-B-SENTINEL-7002";
const UP_A = { baseUrl: "https://gw-a.example/v1", apiKey: KEY_A };
const UP_B = { baseUrl: "https://gw-b.example/tenant/v1", apiKey: KEY_B };

/** The model-proxy / composer contract group 4 declares in `model-proxy/lookup.ts` (D5), restated. */
interface ProxyModels {
  current(): ModelCatalog;
  lookup(id: string): { upstream?: { baseUrl: string; apiKey: string } } | undefined;
  secrets(): readonly string[];
  refresh(): void;
}

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function fresh() {
  const db = openDb(":memory:");
  opened.push(db);
  const store = createModelStore(db);
  return { db, store, registry: createRegistry(store) };
}

const M1 = { id: "m1", name: "m1", reasoning: false, vision: false, maxTokens: 32768 } as const;
const M2 = {
  id: "m2",
  name: "深度",
  reasoning: true,
  vision: true,
  maxTokens: 8192,
  efforts: ["low", "high"],
} as const;

function secretsOf(...upstreams: { baseUrl: string; apiKey: string }[]): string[] {
  return [...new Set(upstreams.flatMap((up) => upstreamSecretList({ ...up, paths: [] })))];
}

/** The three reads all throw: no snapshot has been taken yet. */
function expectNoSnapshot(registry: ReturnType<typeof createRegistry>): void {
  expect(() => registry.current()).toThrow(Error);
  expect(() => registry.lookup("m1")).toThrow(Error);
  expect(() => registry.secrets()).toThrow(Error);
}

describe("createRegistry", () => {
  it("satisfies the proxy / composer contract structurally", () => {
    const { registry } = fresh();
    const contract: ProxyModels = registry;
    expect(typeof contract.refresh).toBe("function");
  });

  it("does not read the table when constructed: an empty table is fine until the first refresh", () => {
    const { store } = fresh();
    expect(() => createRegistry(store)).not.toThrow();
  });

  it("every read before the first refresh throws an Error", () => {
    const { store, registry } = fresh();
    store.create({ id: "m1", upstream: UP_A });
    expectNoSnapshot(registry);
  });

  it("a first refresh on an empty table fails as the store does and leaves no snapshot", () => {
    const { registry } = fresh();
    expect(() => registry.refresh()).toThrow("model registry must hold exactly one default model");
    expectNoSnapshot(registry);
  });
});

describe("snapshot captured at refresh()", () => {
  it("store writes without refresh() change none of the three reads; refresh() makes all three see them", () => {
    const { store, registry } = fresh();
    store.create({ id: "m1", upstream: UP_A });
    registry.refresh();
    const expectFirst = () => {
      expect(registry.current()).toStrictEqual({ models: [M1], defaultModelId: "m1" });
      expect(registry.lookup("m1")).toStrictEqual({ upstream: UP_A });
      expect(registry.lookup("m2")).toBeUndefined();
      expect(registry.secrets()).toEqual(secretsOf(UP_A));
    };
    expectFirst();

    store.create({
      id: "m2",
      name: "深度",
      reasoning: true,
      vision: true,
      maxTokens: 8192,
      efforts: ["low", "high"],
      upstream: UP_B,
    });
    store.setDefault("m2");
    store.update("m1", {
      name: "m1",
      reasoning: false,
      vision: false,
      maxTokens: 32768,
      upstream: null,
    });

    expectFirst();

    registry.refresh();
    expect(registry.current()).toStrictEqual({ models: [M1, M2], defaultModelId: "m2" });
    expect(registry.lookup("m1")).toStrictEqual({});
    expect(registry.lookup("m2")).toStrictEqual({ upstream: UP_B });
    expect(registry.secrets()).toEqual(secretsOf(UP_B));
  });

  it("a removed model stays visible until the next refresh()", () => {
    const { store, registry } = fresh();
    store.create({ id: "m1" });
    store.create({ id: "m2", upstream: UP_B });
    registry.refresh();
    store.remove("m2");
    expect(registry.lookup("m2")).toStrictEqual({ upstream: UP_B });
    expect(registry.secrets()).toEqual(secretsOf(UP_B));
    registry.refresh();
    expect(registry.lookup("m2")).toBeUndefined();
    expect(registry.secrets()).toEqual([]);
    expect(registry.current().models.map((model) => model.id)).toEqual(["m1"]);
  });

  it("a failing refresh() throws as is and keeps the previous snapshot for all three reads", () => {
    const { db, store, registry } = fresh();
    store.create({ id: "m1", upstream: UP_A });
    registry.refresh();
    db.prepare("DELETE FROM models").run();
    expect(() => registry.refresh()).toThrow("model registry must hold exactly one default model");
    expect(registry.current()).toStrictEqual({ models: [M1], defaultModelId: "m1" });
    expect(registry.lookup("m1")).toStrictEqual({ upstream: UP_A });
    expect(registry.secrets()).toEqual(secretsOf(UP_A));
  });
});

describe("lookup", () => {
  it("maps an unknown id to undefined, a model without upstream to {} and one with upstream to {upstream}", () => {
    const { store, registry } = fresh();
    store.create({ id: "bare" });
    store.create({ id: "Qwen/Qwen2.5-72B-Instruct", upstream: UP_A });
    registry.refresh();
    expect(registry.lookup("nope")).toBeUndefined();
    expect(registry.lookup("__proto__")).toBeUndefined();
    const bare = registry.lookup("bare");
    expect(bare).toStrictEqual({});
    expect(Object.keys(bare ?? { missing: true })).toEqual([]);
    expect(registry.lookup("Qwen/Qwen2.5-72B-Instruct")).toStrictEqual({
      upstream: { baseUrl: "https://gw-a.example/v1", apiKey: KEY_A },
    });
  });

  it("a caller mutating a lookup result does not change the snapshot", () => {
    const { store, registry } = fresh();
    store.create({ id: "m1", upstream: UP_A });
    registry.refresh();
    const route = registry.lookup("m1");
    if (route?.upstream !== undefined) route.upstream.apiKey = "tampered";
    expect(registry.lookup("m1")).toStrictEqual({ upstream: UP_A });
  });
});
