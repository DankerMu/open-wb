/**
 * s1d-model-registry group 5 (task 5.2): the compiled production entry's `model_registry` stage —
 * model-registry「环境种子」(empty-table seed, non-empty table ignores the six keys) and the startup half of
 * 「注册表快照是白名单的唯一来源」(the first request after the main bind already reads the seeded snapshot).
 * Oracles: spec literals for the rows and the composer options, the #1563 `models.yml` baseline and the
 * overlay blocks of `omp-layout-helpers.ts`, and for the three-model file the bytes the managed writer
 * produces straight from that `MODEL_CATALOG` (the pre-registry startup path).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { resolveModelCatalog } from "../src/model-catalog.js";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { createModelStore } from "../src/models/store.js";
import { baselineYaml, withVisionInput } from "./models-yml-helpers.js";
import { HOST_OVERLAY_YAML, hostOverlayVisionBlock } from "./omp-layout-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  gatedModelsWriteHook,
  getJson,
  login,
  releaseStartupFixtures,
  reserveWildcardPort,
  type StartedServer,
  startCompiledServer,
  waitForFile,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
const IGNORED_LINE = '{"event":"model_env_ignored"}\n';
const SEED_KEY = "wb-issue1647-seed-upstream-key";
const SEED_BASE = "http://127.0.0.1:9/seed-tenant-1647/v1";
const DEFAULT_ID = "deepseek-v4.1-flash";
const THREE = [
  { id: "m1", reasoning: true, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "m2" },
  { id: "m3", reasoning: true, vision: true, efforts: ["low", "high"] },
];
const SEVEN_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
];
/** The zero-config seed row (model-registry「环境种子」second WHEN), column by column. */
const ZERO_CONFIG_ROW = {
  id: DEFAULT_ID,
  name: DEFAULT_ID,
  reasoning: 1,
  vision: 1,
  max_tokens: 32768,
  efforts: null,
  upstream_base_url: null,
  upstream_api_key: null,
  is_default: 1,
};
/** `GET /api/composer/options`'s one model for the zero-config seed (session-composer-settings「缺省配置」). */
const ZERO_CONFIG_MODEL = {
  id: DEFAULT_ID,
  name: DEFAULT_ID,
  reasoning: true,
  vision: true,
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  defaultEffort: "high",
};

const scratch: string[] = [];
let compiled: CompiledServerEntry;

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "open-wb-model-seed-"));
  scratch.push(root);
  return root;
}

function dbPath(root: string): string {
  return join(root, "db", "dev.db");
}

function agentDir(root: string): string {
  return join(root, "state", "home", ".omp", "agent");
}

/** The `models` table after the entry exited, in list order. */
function rows(root: string): unknown[] {
  const db = new DatabaseSync(dbPath(root), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, name, reasoning, vision, max_tokens, efforts, upstream_base_url, upstream_api_key, is_default FROM models ORDER BY created_at, id",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** A table that already holds `m9` (a previous start, or an administrator's registration). */
function plantRegistered(root: string): void {
  mkdirSync(join(root, "db"), { recursive: true });
  const db = openDb(dbPath(root));
  try {
    createModelStore(db).create({ id: "m9" });
  } finally {
    db.close();
  }
}

async function started(root: string, extra: Record<string, string>) {
  const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
    env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), extra),
  }));
  const record = await server.waitForStarted();
  return { server, port, record };
}

async function stopped(server: StartedServer): Promise<string> {
  try {
    expect(await server.stop()).toBe(0);
    return server.stderr().replace(NODE_SQLITE_WARNING, "");
  } finally {
    await server.dispose();
  }
}

async function composerModels(port: number): Promise<unknown> {
  const options = await getJson(port, "/api/composer/options", await login(port));
  expect(options.status).toBe(200);
  return (options.body as { models: unknown }).models;
}

describe("model-registry「环境种子」on the compiled entry", () => {
  it("zero config: one seed row, the pre-registry models.yml and overlay bytes, seven modules, no ignored line", async () => {
    const root = scratchRoot();
    const { server, port, record } = await started(root, {});
    try {
      expect(record).toMatchObject({ event: "server_started", modules: SEVEN_MODULES });
      expect(await composerModels(port)).toEqual([ZERO_CONFIG_MODEL]);
      const url = `http://127.0.0.1:${String(port)}/v1`;
      expect(readFileSync(join(agentDir(root), "models.yml"), "utf8")).toBe(
        withVisionInput(baselineYaml(true, url, DEFAULT_ID)),
      );
      expect(readFileSync(join(agentDir(root), "host-overlay.yml"), "utf8")).toBe(
        HOST_OVERLAY_YAML + hostOverlayVisionBlock(DEFAULT_ID),
      );
    } finally {
      expect(await stopped(server)).toBe("");
    }
    expect(rows(root)).toEqual([ZERO_CONFIG_ROW]);
  }, 60_000);

  it("three models and an upstream: three rows in order, m3 the default, both sentinels on each row, the same file bytes", async () => {
    const root = scratchRoot();
    const env = {
      MODEL_CATALOG: JSON.stringify(THREE),
      MODEL_ID: "m3",
      MODEL_UPSTREAM_BASE_URL: SEED_BASE,
      MODEL_UPSTREAM_API_KEY: SEED_KEY,
    };
    const { server, port } = await started(root, env);
    let stderr: string;
    try {
      const url = `http://127.0.0.1:${String(port)}/v1`;
      const direct = join(root, "direct");
      mkdirSync(direct);
      await writeManagedModelsYml(direct, {
        proxyBaseUrl: url,
        models: resolveModelCatalog(env).models,
      });
      expect(readFileSync(join(agentDir(root), "models.yml"), "utf8")).toBe(
        readFileSync(join(direct, "models.yml"), "utf8"),
      );
      expect(readFileSync(join(agentDir(root), "host-overlay.yml"), "utf8")).toBe(
        HOST_OVERLAY_YAML + hostOverlayVisionBlock("m3"),
      );
    } finally {
      stderr = await stopped(server);
    }
    expect(stderr).toBe("");
    expect(server.stdout()).not.toContain(SEED_KEY);
    const upstream = { upstream_base_url: SEED_BASE, upstream_api_key: SEED_KEY };
    const common = { max_tokens: 32768, ...upstream };
    expect(rows(root)).toEqual([
      {
        id: "m1",
        name: "m1",
        reasoning: 1,
        vision: 0,
        efforts: '["minimal","low","medium","high","xhigh","max"]',
        is_default: 0,
        ...common,
      },
      { id: "m2", name: "m2", reasoning: 0, vision: 0, efforts: null, is_default: 0, ...common },
      {
        id: "m3",
        name: "m3",
        reasoning: 1,
        vision: 1,
        efforts: '["low","high"]',
        is_default: 1,
        ...common,
      },
    ]);
  }, 60_000);

  it("only MODEL_UPSTREAM_BASE_URL set: starts, the zero-config row with no upstream", async () => {
    const root = scratchRoot();
    const { server } = await started(root, { MODEL_UPSTREAM_BASE_URL: SEED_BASE });
    expect(await stopped(server)).toBe("");
    expect(rows(root)).toEqual([ZERO_CONFIG_ROW]);
  }, 60_000);

  it("the first composer options request after the main bind (models.yml still held) is the seed", async () => {
    const root = scratchRoot();
    const entered = join(root, "models-entered");
    const release = join(root, "models-release");
    const hook = join(root, "gated-models-write.cjs");
    writeFileSync(hook, gatedModelsWriteHook("call-through"));
    const port = await reserveWildcardPort();
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
        MODELS_ENTERED: entered,
        MODELS_RELEASE: release,
      }),
      { requireHook: hook },
    );
    try {
      await waitForFile(entered, 15_000);
      expect(server.stdout()).toBe("");
      expect(await composerModels(port)).toEqual([ZERO_CONFIG_MODEL]);
      writeFileSync(release, "");
      await server.waitForStarted();
    } finally {
      await stopped(server);
    }
  }, 60_000);
});

describe("model-registry「环境种子」: a non-empty table ignores the environment", () => {
  it("MODEL_ID=m1 over a table holding m9: table and snapshot unchanged, exactly one model_env_ignored line", async () => {
    const root = scratchRoot();
    plantRegistered(root);
    const { server, port } = await started(root, { MODEL_ID: "m1" });
    let stderr: string;
    try {
      expect(await composerModels(port)).toEqual([
        { id: "m9", name: "m9", reasoning: false, vision: false, efforts: [], defaultEffort: null },
      ]);
      expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(IGNORED_LINE);
    } finally {
      stderr = await stopped(server);
    }
    expect(stderr).toBe(IGNORED_LINE);
    expect(rows(root).map((row) => (row as { id: string }).id)).toEqual(["m9"]);
  }, 60_000);

  it("none of the six keys set over a non-empty table: no line", async () => {
    const root = scratchRoot();
    plantRegistered(root);
    const { server, port } = await started(root, {});
    try {
      expect(await composerModels(port)).toHaveLength(1);
    } finally {
      expect(await stopped(server)).toBe("");
    }
  }, 60_000);

  it("MODEL_CATALOG=not json over a non-empty table still fails at config", async () => {
    const root = scratchRoot();
    plantRegistered(root);
    const port = await reserveWildcardPort();
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_CATALOG: "not json" }),
    );
    try {
      expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(
        '{"event":"server_start_failed","reason":"config"}\n',
      );
    } finally {
      await server.dispose();
    }
    expect(rows(root).map((row) => (row as { id: string }).id)).toEqual(["m9"]);
  }, 60_000);
});
