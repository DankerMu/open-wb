/**
 * Issue #706: the real compiled production entry establishes the managed omp state layout after
 * listen and before the managed models.yml is written, and an obstructed layout fails startup
 * through the generic partial-start path. Paths and modes come from the omp-runtime spec table.
 * Issue #708: the same step writes the host overlay next to models.yml, with the same failure path.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { baselineYaml, withVisionInput } from "./models-yml-helpers.js";
import {
  expectHomeDotenv,
  expectHostOverlay,
  expectLayout,
  HOST_OVERLAY_YAML,
  hostOverlayVisionBlock,
  seedLegacyAgentDir,
} from "./omp-layout-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  getJson,
  login,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import {
  expectBothPortsListenedOnce,
  expectMainPortListenedOnce,
  startListenTraced,
} from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const MODEL_ID = "issue-706-layout-model";
/** Default deployment (#1530: MODEL_VISION defaults on): the single model is the vision role. */
const DEFAULT_OVERLAY = HOST_OVERLAY_YAML + hostOverlayVisionBlock(MODEL_ID);
const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;
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

function scratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(root);
  return root;
}

/**
 * Default startup (no MODEL_CATALOG, MODEL_REASONING and MODEL_VISION unset): one entry, the
 * #1563 reasoning-true baseline plus the `- image` line.
 */
function expectManagedModels(agentDir: string, port: number): void {
  const models = join(agentDir, "models.yml");
  const text = readFileSync(models, "utf8");
  expect(lstatSync(models).mode & 0o7777).toBe(0o640);
  expect(parse(text)).toMatchObject({
    providers: {
      workbuddy: { baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID }] },
    },
  });
  expect(modelEntries(text)).toHaveLength(1);
  const before = baselineYaml(true, `http://127.0.0.1:${port}/v1`, MODEL_ID);
  expect(text).toBe(withVisionInput(before));
  expect(readdirSync(agentDir).toSorted()).toEqual(["host-overlay.yml", "mcp.json", "models.yml"]);
}

function modelEntries(text: string): unknown[] {
  const document = parse(text) as { providers: { workbuddy: { models: unknown[] } } };
  return document.providers.workbuddy.models;
}

/**
 * The entry exits 1 with nothing on stdout, only the generic record on stderr, and closes every
 * listener it bound (its own listen trace, #1825): `state_layout` fails after the main listen only,
 * `host_overlay` after both (the preview port is system-assigned).
 */
async function expectGenericStartFailure(
  root: string,
  state: string,
  reason: "state_layout" | "host_overlay",
): Promise<void> {
  const started = await startListenTraced(compiled.entry, root, (port) => ({
    env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
  }));
  const { server } = started;
  try {
    expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
    expect(server.stdout()).toBe("");
    expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(
      `${JSON.stringify({ event: "server_start_failed", reason })}\n`,
    );
    expect(server.stderr()).not.toContain(state);
    if (reason === "state_layout") {
      expectMainPortListenedOnce(started);
    } else {
      expectBothPortsListenedOnce(started);
    }
  } finally {
    await server.dispose();
  }
}

describe("production entry managed omp state layout", () => {
  it("cold start builds the exact layout, writes models.yml into home/.omp/agent and ignores a legacy agent dir", async () => {
    const root = scratchRoot("open-wb-layout-cold-");
    const state = join(root, "state");
    const legacy = seedLegacyAgentDir(state);
    // A state root left wide by the old layout is corrected; the legacy directory is not touched.
    chmodSync(state, 0o2770);
    const legacyBefore = lstatSync(join(legacy, "models.yml"));
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
    }));
    try {
      await server.waitForStarted();
      expectLayout(state);
      expectManagedModels(join(state, "home", ".omp", "agent"), port);
      expectHostOverlay(state, DEFAULT_OVERLAY);
      expectHomeDotenv(state);
      expect(readdirSync(join(state, "home")).toSorted()).toEqual([".env", ".omp"]);
      expect(readdirSync(state).toSorted()).toEqual([
        "agent",
        "home",
        "mounts",
        "session-config",
        "sessions",
        "snapshots",
        "trash",
        "xdg",
      ]);
      expect(readFileSync(join(legacy, "models.yml"), "utf8")).toBe("legacy-models");
      expect(lstatSync(join(legacy, "models.yml")).mtimeMs).toBe(legacyBefore.mtimeMs);
      expect(lstatSync(legacy).mode & 0o7777).toBe(0o2770);
      expect(readdirSync(legacy).toSorted()).toEqual(["models.yml", "skills"]);
      // Startup makes SANDBOX_ROOT at exactly 3770 with nothing below it (owner B4, 编排方默认 3770).
      expect(lstatSync(join(root, "sandbox")).mode & 0o7777).toBe(0o3770);
      expect(readdirSync(join(root, "sandbox"))).toEqual([]);
    } finally {
      await server.dispose();
    }
  }, 60_000);

  // s1d-experts-skills group 1: omp-runtime「OMP_STATE_DIR 托管布局」scenario「启动清扫会话配置残留」.
  it("startup sweeps session-config leftovers, unlinks a symlink without following it, and keeps 2710", async () => {
    const root = scratchRoot("open-wb-layout-sweep-");
    const dir = join(root, "state", "session-config");
    const outside = join(root, "outside.yml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.yml"), "disabledExtensions: []\n");
    writeFileSync(join(dir, "a.md"), "leftover prompt");
    writeFileSync(outside, "outside bytes");
    symlinkSync(outside, join(dir, "b.yml"));
    const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
    }));
    try {
      await server.waitForStarted();
      expect(readdirSync(dir)).toEqual([]);
      expect(lstatSync(dir).mode & 0o7777).toBe(0o2710);
      expect(readFileSync(outside, "utf8")).toBe("outside bytes");
    } finally {
      await server.dispose();
    }
  }, 60_000);

  // s1d-connectors group 2a: omp-runtime「OMP_STATE_DIR 托管布局」scenario「托管 mcp.json 的模式与属主」
  // (first half) — no connector registered, a residual file from an earlier run is overwritten.
  it("a start with no connectors overwrites a residual mcp.json with the empty table, a 0640 regular file of this uid", async () => {
    const root = scratchRoot("open-wb-layout-mcp-");
    const agentDir = join(root, "state", "home", ".omp", "agent");
    const file = join(agentDir, "mcp.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(file, '{"mcpServers":{"old":{"type":"stdio","command":"/bin/old"}}}\n');
    const { server } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
    }));
    try {
      await server.waitForStarted();
      expect(readFileSync(file, "utf8")).toBe('{\n  "mcpServers": {}\n}\n');
      const stat = lstatSync(file);
      expect(stat.isFile()).toBe(true);
      expect(stat.uid).toBe(process.getuid?.());
      expect(stat.mode & 0o7777).toBe(0o640);
      expect(lstatSync(agentDir).mode & 0o7777).toBe(0o2750);
      expect(readdirSync(agentDir).toSorted()).toEqual([
        "host-overlay.yml",
        "mcp.json",
        "models.yml",
      ]);
    } finally {
      await server.dispose();
    }
  }, 60_000);

  // http-service-skeleton「四个新配置键的取值与非法值」: both halves of the valid four-key start — the
  // managed models.yml, and what `GET /api/composer/options` reports (#1008).
  it("a three-model MODEL_CATALOG writes three model entries in whitelist order, and the four keys reach GET /api/composer/options", async () => {
    const root = scratchRoot("open-wb-layout-catalog-");
    const catalog = [
      { id: "m1", name: "通用", reasoning: true, efforts: ["minimal", "low", "medium", "high"] },
      { id: "m2", maxTokens: 8192 },
      { id: "m3", name: "深度", reasoning: true, vision: true, efforts: ["low", "high"] },
    ];
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
        MODEL_CATALOG: JSON.stringify(catalog),
        APPROVAL_MAX_MODE: "write",
        UPLOAD_MAX_BYTES: "1048576",
        UPLOAD_MAX_FILES: "3",
      }),
    }));
    try {
      await server.waitForStarted();
      const agentDir = join(root, "state", "home", ".omp", "agent");
      // m1 and m3 take the default limit, m2 the one it declares.
      const limits = { contextWindow: 128000, maxTokens: 32768 };
      const reasoning = { reasoning: true, compat: { reasoningContentField: "reasoning_content" } };
      expect(modelEntries(readFileSync(join(agentDir, "models.yml"), "utf8"))).toEqual([
        {
          id: "m1",
          name: "通用",
          ...limits,
          ...reasoning,
          thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
          input: ["text"],
        },
        {
          id: "m2",
          name: "m2",
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: false,
          input: ["text"],
        },
        {
          id: "m3",
          name: "深度",
          ...limits,
          ...reasoning,
          thinking: { mode: "effort", efforts: ["low", "high"] },
          input: ["text", "image"],
        },
      ]);
      expect(readdirSync(agentDir).toSorted()).toEqual([
        "host-overlay.yml",
        "mcp.json",
        "models.yml",
      ]);

      const options = await getJson(port, "/api/composer/options", await login(port));

      expect(options.status).toBe(200);
      expect(options.headers.get("cache-control")).toBe("no-store");
      expect(options.body).toEqual({
        approvalModes: ["always-ask", "write"],
        models: [
          {
            id: "m1",
            name: "通用",
            reasoning: true,
            vision: false,
            efforts: ["off", "minimal", "low", "medium", "high"],
            defaultEffort: "high",
          },
          {
            id: "m2",
            name: "m2",
            reasoning: false,
            vision: false,
            efforts: [],
            defaultEffort: null,
          },
          {
            id: "m3",
            name: "深度",
            reasoning: true,
            vision: true,
            efforts: ["off", "low", "high"],
            defaultEffort: "high",
          },
        ],
        defaults: { approvalMode: "write", modelId: "m1", reasoningEffort: "high" },
        upload: { maxBytes: 1048576, maxFiles: 3 },
      });
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("starts when OMP_STATE_DIR is a symlink to a directory and builds the layout under its target", async () => {
    const root = scratchRoot("open-wb-layout-link-");
    const target = join(root, "real-state");
    const link = join(root, "state-link");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, link);
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {
        MODEL_ID,
        OMP_STATE_DIR: link,
      }),
    }));
    try {
      await server.waitForStarted();
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expectLayout(target);
      expectManagedModels(join(target, "home", ".omp", "agent"), port);
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("exits 1 with only the generic failure record when home/.omp is occupied by a file", async () => {
    const root = scratchRoot("open-wb-layout-blocked-");
    const state = join(root, "state");
    mkdirSync(join(state, "home"), { recursive: true });
    writeFileSync(join(state, "home", ".omp"), "not-a-directory");
    await expectGenericStartFailure(root, state, "state_layout");
    expect(readFileSync(join(state, "home", ".omp"), "utf8")).toBe("not-a-directory");
    expect(existsSync(join(state, "xdg"))).toBe(false);
    expect(existsSync(join(state, "agent"))).toBe(false);
    expect(existsSync(join(root, "sandbox"))).toBe(false);
  }, 60_000);

  it("a restart on the same state dir rewrites the host overlay to the same bytes and leaves no temporary file", async () => {
    const root = scratchRoot("open-wb-overlay-restart-");
    const state = join(root, "state");
    const agentDir = join(state, "home", ".omp", "agent");
    for (const _start of [1, 2]) {
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
      }));
      try {
        await server.waitForStarted();
        expectHostOverlay(state, DEFAULT_OVERLAY);
        expectManagedModels(agentDir, port);
      } finally {
        await server.dispose();
      }
    }
  }, 60_000);

  it("exits 1 with only the generic failure record when host-overlay.yml is occupied by a directory", async () => {
    const root = scratchRoot("open-wb-overlay-blocked-");
    const state = join(root, "state");
    const overlay = join(state, "home", ".omp", "agent", "host-overlay.yml");
    mkdirSync(overlay, { recursive: true });
    await expectGenericStartFailure(root, state, "host_overlay");
    expect(lstatSync(overlay).isDirectory()).toBe(true);
    expect(readdirSync(overlay)).toEqual([]);
    // models.yml was written first; the overlay's temporary file is removed on the failed rename.
    expect(readdirSync(join(state, "home", ".omp", "agent")).toSorted()).toEqual([
      "host-overlay.yml",
      "models.yml",
    ]);
  }, 60_000);
});
