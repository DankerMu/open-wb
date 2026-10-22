/**
 * s1d-model-registry group 3: the publisher (model-registry「变更即发布」; design D7, D13). The two
 * writers are injected: fake writers record their calls and can be held with a deferred; the bytes
 * case runs the real `writeManagedModelsYml` / `writeHostOverlay` in temp dirs against the existing
 * baselines (`models-yml-reasoning-true.yml` via `baselineYaml`, the overlay blocks of
 * `omp-layout-helpers.ts`). Snapshots come from the real store and registry on `:memory:` databases.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { type CatalogModel, resolveModelCatalog } from "../src/model-catalog.js";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { createPublisher, type ModelPublishFailedRecord } from "../src/models/publish.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";
import { writeHostOverlay } from "../src/sessions/omp/host-overlay.js";
import {
  ensureOmpStateLayout,
  ompAgentDir,
  ompHostOverlayPath,
} from "../src/sessions/omp/state-layout.js";
import { baselineYaml, withVisionInput } from "./models-yml-helpers.js";
import {
  HOST_OVERLAY_FIXED,
  hostOverlayBrowserBlock,
  hostOverlayVisionBlock,
} from "./omp-layout-helpers.js";

const AGENT_DIR = "/srv/wb/omp/home/.omp/agent";
const STATE_DIR = "/srv/wb/omp";
const BASE = "http://127.0.0.1:18016/v1";

type ModelsYmlOptions = { proxyBaseUrl: string; models: readonly CatalogModel[] };
type OverlayOptions = { browserEnabled: boolean; visionModelId: string | null };
type Call =
  | { writer: "models"; dir: string; options: ModelsYmlOptions }
  | { writer: "overlay"; dir: string; options: OverlayOptions };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const opened: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A seeded store (`m1`, non-vision) with a refreshed registry and a publisher over two fake writers. */
function fixture(options: { browserEnabled?: boolean; proxyBaseUrl?: () => string | null } = {}) {
  const db = openDb(":memory:");
  opened.push(db);
  const store = createModelStore(db);
  store.create({ id: "m1" });
  const registry = createRegistry(store);
  registry.refresh();
  const calls: Call[] = [];
  /** Each fake writer call takes the next gate of its queue, or completes at once when it is empty. */
  const modelsGates: Deferred[] = [];
  const overlayGates: Deferred[] = [];
  const publisher = createPublisher({
    agentDir: AGENT_DIR,
    stateDir: STATE_DIR,
    proxyBaseUrl: options.proxyBaseUrl ?? (() => BASE),
    browserEnabled: options.browserEnabled ?? false,
    registry,
    writeModelsYml: async (dir, opts) => {
      calls.push({ writer: "models", dir, options: opts });
      await modelsGates.shift()?.promise;
    },
    writeOverlay: async (dir, opts) => {
      calls.push({ writer: "overlay", dir, options: opts });
      await overlayGates.shift()?.promise;
    },
  });
  /** One store write (a plain model `id`, `vision` as given) followed by `refresh()`. */
  const write = (id: string, vision = false) => {
    store.create({ id, vision });
    registry.refresh();
  };
  const count = (writer: Call["writer"]) => calls.filter((call) => call.writer === writer).length;
  return { store, registry, publisher, calls, modelsGates, overlayGates, write, count };
}

const plain = (id: string): CatalogModel => ({
  id,
  name: id,
  reasoning: false,
  vision: false,
  maxTokens: 32768,
});
const seeing = (id: string): CatalogModel => ({ ...plain(id), vision: true });

/** Lets every queued promise reaction run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Tracks whether a promise has resolved or rejected (and with what) without awaiting it. */
function track(promise: Promise<void>) {
  const state: { status: "pending" | "resolved" | "rejected"; error?: unknown } = {
    status: "pending",
  };
  promise.then(
    () => {
      state.status = "resolved";
    },
    (error: unknown) => {
      state.status = "rejected";
      state.error = error;
    },
  );
  return state;
}

describe("publish()", () => {
  it("calls writeModelsYml then writeOverlay exactly once each with the snapshot and its first vision model", async () => {
    const { publisher, calls, modelsGates, write } = fixture({ browserEnabled: true });
    write("m2", true);
    write("m3", true);
    const gate = deferred();
    modelsGates.push(gate);
    const done = track(publisher.publish());
    await settle();
    expect(calls.map((call) => call.writer)).toEqual(["models"]);
    gate.resolve();
    await settle();
    expect(done.status).toBe("resolved");
    expect(calls).toStrictEqual([
      {
        writer: "models",
        dir: AGENT_DIR,
        options: { proxyBaseUrl: BASE, models: [plain("m1"), seeing("m2"), seeing("m3")] },
      },
      {
        writer: "overlay",
        dir: STATE_DIR,
        options: { browserEnabled: true, visionModelId: "m2" },
      },
    ]);
  });

  it("passes a null vision model when the snapshot has none", async () => {
    const { publisher, calls } = fixture();
    await publisher.publish();
    expect(calls.at(-1)).toStrictEqual({
      writer: "overlay",
      dir: STATE_DIR,
      options: { browserEnabled: false, visionModelId: null },
    });
  });

  it("returns without calling a writer while proxyBaseUrl() is null, and publishes once it is known", async () => {
    let base: string | null = null;
    const { publisher, calls } = fixture({ proxyBaseUrl: () => base });
    await expect(publisher.publish()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    base = "http://[::1]:4000/v1";
    await publisher.publish();
    expect(calls.map((call) => [call.writer, call.options])).toStrictEqual([
      ["models", { proxyBaseUrl: "http://[::1]:4000/v1", models: [plain("m1")] }],
      ["overlay", { browserEnabled: false, visionModelId: null }],
    ]);
  });
});

describe("single flight", () => {
  it("three publishes while the first round is held: two rounds, the second on the latest snapshot, calls 2 and 3 resolve after it", async () => {
    const { publisher, calls, modelsGates, write, count } = fixture();
    const round1 = deferred();
    const round2 = deferred();
    modelsGates.push(round1, round2);

    write("a");
    const first = track(publisher.publish());
    await settle();
    write("b", true);
    const second = track(publisher.publish());
    write("c", true);
    const third = track(publisher.publish());
    await settle();
    expect(count("models")).toBe(1);
    expect(count("overlay")).toBe(0);

    round1.resolve();
    await settle();
    expect(first.status).toBe("resolved");
    expect(second.status).toBe("pending");
    expect(third.status).toBe("pending");
    expect(count("models")).toBe(2);
    expect(count("overlay")).toBe(1);

    round2.resolve();
    await settle();
    expect(second.status).toBe("resolved");
    expect(third.status).toBe("resolved");
    expect(calls.map((call) => [call.writer, call.options])).toStrictEqual([
      ["models", { proxyBaseUrl: BASE, models: [plain("m1"), plain("a")] }],
      ["overlay", { browserEnabled: false, visionModelId: null }],
      [
        "models",
        { proxyBaseUrl: BASE, models: [plain("m1"), plain("a"), seeing("b"), seeing("c")] },
      ],
      ["overlay", { browserEnabled: false, visionModelId: "b" }],
    ]);
  });

  it("a publish from a caller resuming on the finished round joins the queued round instead of starting a third", async () => {
    const { publisher, modelsGates, write, count } = fixture();
    const round1 = deferred();
    modelsGates.push(round1);
    let joined: Promise<void> | undefined;
    const first = publisher.publish().then(() => {
      joined = publisher.publish();
    });
    await settle();
    write("a");
    const second = publisher.publish();
    round1.resolve();
    await first;
    expect(joined).toBe(second);
    await second;
    expect([count("models"), count("overlay")]).toEqual([2, 2]);
  });

  it("a publish after a round completed starts a fresh round", async () => {
    const { publisher, write, count } = fixture();
    await publisher.publish();
    write("a");
    await publisher.publish();
    expect([count("models"), count("overlay")]).toEqual([2, 2]);
  });
});

describe("failure", () => {
  it("a failing writeModelsYml skips writeOverlay and rejects publish() with its error", async () => {
    const { publisher, modelsGates, count } = fixture();
    const gate = deferred();
    modelsGates.push(gate);
    const boom = new Error("models.yml write failed");
    const done = publisher.publish();
    gate.reject(boom);
    await expect(done).rejects.toBe(boom);
    expect(count("overlay")).toBe(0);
  });

  it("a failing writeOverlay rejects publish() with its error", async () => {
    const { publisher, overlayGates, count } = fixture();
    const gate = deferred();
    overlayGates.push(gate);
    const boom = new Error("overlay write failed");
    const done = publisher.publish();
    await settle();
    gate.reject(boom);
    await expect(done).rejects.toBe(boom);
    expect([count("models"), count("overlay")]).toEqual([1, 1]);
  });

  it("only callers coalesced on the failed round are rejected; the queued round still runs", async () => {
    const { publisher, calls, modelsGates, write, count } = fixture();
    const round1 = deferred();
    modelsGates.push(round1);
    const first = track(publisher.publish());
    await settle();
    write("a");
    const second = track(publisher.publish());
    const boom = new Error("models.yml write failed");
    round1.reject(boom);
    await settle();
    expect(first).toStrictEqual({ status: "rejected", error: boom });
    expect(second.status).toBe("resolved");
    expect([count("models"), count("overlay")]).toEqual([2, 1]);
    expect(calls.at(-1)?.writer).toBe("overlay");
    expect(calls[1]).toStrictEqual({
      writer: "models",
      dir: AGENT_DIR,
      options: { proxyBaseUrl: BASE, models: [plain("m1"), plain("a")] },
    });
  });

  it("after a rejection the single flight is reset: the next publish() calls both writers again", async () => {
    const { publisher, modelsGates, count } = fixture();
    const gate = deferred();
    modelsGates.push(gate);
    const done = publisher.publish();
    gate.reject(new Error("models.yml write failed"));
    await expect(done).rejects.toThrow("models.yml write failed");
    await publisher.publish();
    expect([count("models"), count("overlay")]).toEqual([2, 1]);
  });

  it("the failure record group 7 writes is exactly one event key", () => {
    const record: ModelPublishFailedRecord = { event: "model_publish_failed" };
    expect(`${JSON.stringify(record)}\n`).toBe('{"event":"model_publish_failed"}\n');
  });
});

describe("bytes with the real writers", () => {
  it("equal the existing baselines and a direct writeManagedModelsYml / writeHostOverlay call", async () => {
    const db = openDb(":memory:");
    opened.push(db);
    const store = createModelStore(db);
    // Zero configuration: `deepseek-v4.1-flash`, reasoning, vision, 32768, efforts NULL, no upstream.
    expect(store.seedIfEmpty(resolveModelCatalog({}), {})).toBe("seeded");
    const registry = createRegistry(store);
    registry.refresh();

    const published = mkdtempSync(join(tmpdir(), "models-publish-"));
    const direct = mkdtempSync(join(tmpdir(), "models-publish-direct-"));
    dirs.push(published, direct);
    ensureOmpStateLayout(published);
    ensureOmpStateLayout(direct);

    await createPublisher({
      agentDir: ompAgentDir(published),
      stateDir: published,
      proxyBaseUrl: () => BASE,
      browserEnabled: false,
      registry,
      writeModelsYml: writeManagedModelsYml,
      writeOverlay: writeHostOverlay,
    }).publish();
    const model = registry.current().models;
    await writeManagedModelsYml(ompAgentDir(direct), { proxyBaseUrl: BASE, models: model });
    await writeHostOverlay(direct, { browserEnabled: false, visionModelId: "deepseek-v4.1-flash" });

    const modelsYml = (state: string) =>
      readFileSync(join(ompAgentDir(state), "models.yml"), "utf8");
    const overlay = (state: string) => readFileSync(ompHostOverlayPath(state), "utf8");
    expect(modelsYml(published)).toBe(
      withVisionInput(baselineYaml(true, BASE, "deepseek-v4.1-flash")),
    );
    expect(overlay(published)).toBe(
      HOST_OVERLAY_FIXED +
        hostOverlayBrowserBlock(false) +
        hostOverlayVisionBlock("deepseek-v4.1-flash"),
    );
    expect(modelsYml(published)).toBe(modelsYml(direct));
    expect(overlay(published)).toBe(overlay(direct));
  });
});
