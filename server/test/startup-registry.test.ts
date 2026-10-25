/**
 * s1d-model-registry group 5 (tasks 5.2 / 5.3): the production entry's registry assembly, in process,
 * through `server/src/startup-registry.ts` — the `model_registry` stage (seed + first refresh, the
 * `model_env_ignored` decision over an injected env) and the startup publisher (real writers into a
 * temp state dir, the `proxyBaseUrl` getter, the one stage switch to `host_overlay`). The window
 * between the main listen and `models_yml` cannot be hit deterministically from outside the process;
 * the「null base URL → write + refresh + publish writes nothing, then one publish with the new
 * snapshot」case below is the evidence for model-registry「变更即发布」's startup exception.
 * Expected values are spec literals (model-registry「环境种子」, the overlay blocks of
 * `omp-layout-helpers.ts`), never the store's own mapping.
 *
 * s1d-connectors group 2a: the `mcp_json` stage function — the「两份真相」case (DB vs `mcp.json`): a
 * residual file is replaced with exactly the enabled rows of the table, and a publish before the stage
 * leaves the file alone (connectors「托管 mcp.json」).
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createConnectorStore } from "../src/connectors/store.js";
import { openDb } from "../src/core/db/index.js";
import { resolveModelCatalog } from "../src/model-catalog.js";
import { createModelStore } from "../src/models/store.js";
import { ensureOmpStateLayout, ompAgentDir } from "../src/sessions/omp/state-layout.js";
import {
  createMcpJsonStage,
  createStartupPublisher,
  seedModelRegistry,
} from "../src/startup-registry.js";
import { HOST_OVERLAY_YAML, hostOverlayVisionBlock } from "./omp-layout-helpers.js";

const SIX_KEYS = [
  "MODEL_CATALOG",
  "MODEL_ID",
  "MODEL_REASONING",
  "MODEL_VISION",
  "MODEL_UPSTREAM_BASE_URL",
  "MODEL_UPSTREAM_API_KEY",
] as const;
const SEED_KEY = "wb-issue1647-seed-key";
const SEED_BASE = "http://127.0.0.1:9/seed-tenant-1647/v1";
const THREE = [
  { id: "m1", reasoning: true, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { id: "m2" },
  { id: "m3", reasoning: true, vision: true, efforts: ["low", "high"] },
];

const opened: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function db(): DatabaseSync {
  const made = openDb(":memory:");
  opened.push(made);
  return made;
}

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "startup-registry-"));
  dirs.push(root);
  const state = join(root, "state");
  ensureOmpStateLayout(state);
  return state;
}

/** The config subset the stage reads, from the same resolver the entry uses. */
function seedConfig(env: Record<string, string>) {
  return {
    modelCatalog: resolveModelCatalog(env),
    ...(env.MODEL_UPSTREAM_BASE_URL === undefined
      ? {}
      : { modelUpstreamBaseUrl: env.MODEL_UPSTREAM_BASE_URL }),
    ...(env.MODEL_UPSTREAM_API_KEY === undefined
      ? {}
      : { modelUpstreamApiKey: env.MODEL_UPSTREAM_API_KEY }),
  };
}

function seedWith(database: DatabaseSync, env: Record<string, string | undefined>) {
  const records: unknown[] = [];
  const seeded = seedModelRegistry({
    db: database,
    config: seedConfig({ MODEL_ID: "m-env" }),
    env,
    warn: (record) => {
      records.push(record);
    },
  });
  return { ...seeded, records };
}

describe("model_registry stage: seed and first refresh", () => {
  it("an empty table takes the configured whitelist and upstream, and the snapshot is ready", () => {
    const env = {
      MODEL_CATALOG: JSON.stringify(THREE),
      MODEL_ID: "m3",
      MODEL_UPSTREAM_BASE_URL: SEED_BASE,
      MODEL_UPSTREAM_API_KEY: SEED_KEY,
    };
    const records: unknown[] = [];
    const { registry } = seedModelRegistry({
      db: db(),
      config: seedConfig(env),
      env,
      warn: (record) => {
        records.push(record);
      },
    });

    expect(registry.current()).toEqual({
      models: [
        {
          id: "m1",
          name: "m1",
          reasoning: true,
          vision: false,
          maxTokens: 32768,
          efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        },
        { id: "m2", name: "m2", reasoning: false, vision: false, maxTokens: 32768 },
        {
          id: "m3",
          name: "m3",
          reasoning: true,
          vision: true,
          maxTokens: 32768,
          efforts: ["low", "high"],
        },
      ],
      defaultModelId: "m3",
    });
    for (const id of ["m1", "m2", "m3"]) {
      expect(registry.lookup(id)).toEqual({ upstream: { baseUrl: SEED_BASE, apiKey: SEED_KEY } });
    }
    expect(registry.secrets()).toContain(SEED_KEY);
    // A seeded table is not「ignored」even though the six keys are set.
    expect(records).toEqual([]);
  });

  it("only a base URL configured seeds the zero-config model with no upstream", () => {
    const env = { MODEL_UPSTREAM_BASE_URL: SEED_BASE };
    const { registry } = seedModelRegistry({
      db: db(),
      config: seedConfig(env),
      env,
      warn: () => {
        throw new Error("no model_env_ignored on an empty table");
      },
    });

    expect(registry.current()).toEqual({
      models: [
        {
          id: "deepseek-v4.1-flash",
          name: "deepseek-v4.1-flash",
          reasoning: true,
          vision: true,
          maxTokens: 32768,
        },
      ],
      defaultModelId: "deepseek-v4.1-flash",
    });
    expect(registry.lookup("deepseek-v4.1-flash")).toEqual({});
    expect(registry.secrets()).toEqual([]);
  });

  it("a non-empty table is left as it is and the snapshot reads it", () => {
    const database = db();
    createModelStore(database).create({ id: "m9" });

    const { registry, records } = seedWith(database, {});

    expect(registry.current()).toEqual({
      models: [{ id: "m9", name: "m9", reasoning: false, vision: false, maxTokens: 32768 }],
      defaultModelId: "m9",
    });
    expect(registry.lookup("m-env")).toBeUndefined();
    expect(records).toEqual([]);
  });

  it.each(SIX_KEYS)(
    "a non-empty table and %s set (even to the empty string) writes model_env_ignored once",
    (key) => {
      const database = db();
      createModelStore(database).create({ id: "m9" });

      const { registry, records } = seedWith(database, { [key]: "" });

      expect(records).toEqual([{ event: "model_env_ignored" }]);
      expect(Object.keys(records[0] as object)).toEqual(["event"]);
      expect(registry.current().models.map((model) => model.id)).toEqual(["m9"]);
    },
  );

  it("a key present with the value undefined, or only other keys set, is「not set」", () => {
    const database = db();
    createModelStore(database).create({ id: "m9" });

    expect(seedWith(database, { MODEL_ID: undefined, PORT: "3000", MODEL: "x" }).records).toEqual(
      [],
    );
  });

  it("a seed that cannot be inserted throws out of the stage", () => {
    const database = db();
    database.exec("DROP TABLE models; CREATE VIEW models AS SELECT 'x' AS id WHERE 0");

    expect(() => seedWith(database, {})).toThrow();
  });
});

describe("startup publisher", () => {
  function published(state: string): { ids: string[]; baseUrl: string; overlay: string } {
    const agent = ompAgentDir(state);
    const document = parse(readFileSync(join(agent, "models.yml"), "utf8")) as {
      providers: { workbuddy: { baseUrl: string; models: Array<{ id: string }> } };
    };
    return {
      ids: document.providers.workbuddy.models.map((model) => model.id),
      baseUrl: document.providers.workbuddy.baseUrl,
      overlay: readFileSync(join(agent, "host-overlay.yml"), "utf8"),
    };
  }

  it("before the proxy address is known a write is only refreshed; the first publish with an address writes the new snapshot", async () => {
    const database = db();
    const { store, registry } = seedWith(database, {});
    const state = stateDir();
    let proxyBaseUrl: string | null = null;
    const stage = { stage: "listen" };
    const publisher = createStartupPublisher({
      registry,
      stateDir: state,
      browserEnabled: false,
      proxyBaseUrl: () => proxyBaseUrl,
      stage,
    });

    store.create({ id: "m-late", vision: true });
    registry.refresh();
    await publisher.publish();
    expect(readdirSync(ompAgentDir(state))).toEqual([]);

    proxyBaseUrl = "http://127.0.0.1:18016/v1";
    stage.stage = "models_yml";
    await publisher.publish();

    expect(published(state)).toEqual({
      ids: ["m-env", "m-late"],
      baseUrl: "http://127.0.0.1:18016/v1",
      // `m-env` (MODEL_VISION unset → on) is the first vision model of the snapshot.
      overlay: HOST_OVERLAY_YAML + hostOverlayVisionBlock("m-env"),
    });
    expect(readdirSync(ompAgentDir(state)).toSorted()).toEqual(["host-overlay.yml", "models.yml"]);
    expect(stage.stage).toBe("host_overlay");
  });

  it("switches the stage to host_overlay only from models_yml, before the overlay is written", async () => {
    const { registry } = seedWith(db(), {});
    const state = stateDir();
    // The overlay target is a directory: the overlay write fails after the switch.
    mkdirSync(join(ompAgentDir(state), "host-overlay.yml"));
    const stage = { stage: "models_yml" };
    const publisher = createStartupPublisher({
      registry,
      stateDir: state,
      browserEnabled: false,
      proxyBaseUrl: () => "http://127.0.0.1:18016/v1",
      stage,
    });

    await expect(publisher.publish()).rejects.toThrow();
    expect(stage.stage).toBe("host_overlay");
  });

  it("a models.yml failure leaves the stage at models_yml", async () => {
    const { registry } = seedWith(db(), {});
    const state = stateDir();
    mkdirSync(join(ompAgentDir(state), "models.yml"));
    const stage = { stage: "models_yml" };
    const publisher = createStartupPublisher({
      registry,
      stateDir: state,
      browserEnabled: false,
      proxyBaseUrl: () => "http://127.0.0.1:18016/v1",
      stage,
    });

    await expect(publisher.publish()).rejects.toThrow();
    expect(stage.stage).toBe("models_yml");
  });

  it("a publish after startup (any other stage) writes both files and leaves the stage alone", async () => {
    const { registry } = seedWith(db(), {});
    const state = stateDir();
    const stage = { stage: "publish" };
    const publisher = createStartupPublisher({
      registry,
      stateDir: state,
      browserEnabled: true,
      proxyBaseUrl: () => "http://127.0.0.1:18016/v1",
      stage,
    });

    await publisher.publish();

    expect(published(state).ids).toEqual(["m-env"]);
    expect(stage.stage).toBe("publish");
  });
});

describe("mcp_json stage", () => {
  const STALE = '{"mcpServers":{"old":{"type":"stdio","command":"/bin/old","args":[],"env":{}}}}\n';
  const SENTINEL = "SENTINEL-MCP-STAGE-6610";

  it("replaces a residual mcp.json with exactly the enabled connector; a publish before the stage writes nothing", async () => {
    const database = db();
    const connectors = createConnectorStore(database);
    connectors.create({
      name: "gitlab",
      type: "stdio",
      command: "/usr/bin/gitlab-mcp",
      args: ["--stdio"],
      env: { TOKEN: SENTINEL },
    });
    connectors.create({
      name: "wiki",
      type: "http",
      url: "https://wiki.example/mcp",
      enabled: false,
    });
    const state = stateDir();
    const file = join(ompAgentDir(state), "mcp.json");
    writeFileSync(file, STALE);
    const stage = { stage: "host_overlay" };
    const { publisher, runStage } = createMcpJsonStage({ db: database, stateDir: state, stage });

    await publisher.publish();
    expect(readFileSync(file, "utf8")).toBe(STALE);
    expect(stage.stage).toBe("host_overlay");

    await runStage();

    expect(readFileSync(file, "utf8")).toBe(
      [
        "{",
        '  "mcpServers": {',
        '    "gitlab": {',
        '      "type": "stdio",',
        '      "command": "/usr/bin/gitlab-mcp",',
        '      "args": [',
        '        "--stdio"',
        "      ],",
        '      "env": {',
        `        "TOKEN": "${SENTINEL}"`,
        "      }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expect(lstatSync(file).mode & 0o7777).toBe(0o640);
    expect(readdirSync(ompAgentDir(state))).toEqual(["mcp.json"]);
    expect(stage.stage).toBe("mcp_json");

    // After the stage the same publisher writes on every call (the write endpoints share it).
    connectors.create({ name: "jira", type: "http", url: "https://jira.example/mcp" });
    await publisher.publish();
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual([
      "gitlab",
      "jira",
    ]);
  });

  it("switches the stage to mcp_json before writing: a failed write rejects with the stage there", async () => {
    const state = stateDir();
    mkdirSync(join(ompAgentDir(state), "mcp.json"));
    const stage = { stage: "host_overlay" };
    const { runStage } = createMcpJsonStage({ db: db(), stateDir: state, stage });

    await expect(runStage()).rejects.toThrow();
    expect(stage.stage).toBe("mcp_json");
  });
});
