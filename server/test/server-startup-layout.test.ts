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
import {
  expectHomeDotenv,
  expectHostOverlay,
  expectLayout,
  seedLegacyAgentDir,
} from "./omp-layout-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  expectBindable,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
} from "./server-startup-helpers.js";

const MODEL_ID = "issue-706-layout-model";
const FAILED_RECORD = `${JSON.stringify({ event: "server_start_failed" })}\n`;
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

function expectManagedModels(agentDir: string, port: number): void {
  const models = join(agentDir, "models.yml");
  expect(lstatSync(models).mode & 0o7777).toBe(0o640);
  expect(parse(readFileSync(models, "utf8"))).toMatchObject({
    providers: {
      workbuddy: { baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID }] },
    },
  });
  expect(readdirSync(agentDir).toSorted()).toEqual(["host-overlay.yml", "models.yml"]);
}

/** The entry exits 1 with nothing on stdout, only the generic record on stderr, and frees its port. */
async function expectGenericStartFailure(root: string, state: string): Promise<void> {
  const port = await reserveWildcardPort();
  const server = startCompiledServer(
    compiled.entry,
    compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
  );
  try {
    expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
    expect(server.stdout()).toBe("");
    expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(FAILED_RECORD);
    expect(server.stderr()).not.toContain(state);
    await expectBindable("127.0.0.1", port);
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
    const port = await reserveWildcardPort();
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
    );
    try {
      await server.waitForStarted();
      expectLayout(state);
      expectManagedModels(join(state, "home", ".omp", "agent"), port);
      expectHostOverlay(state);
      expectHomeDotenv(state);
      expect(readdirSync(join(state, "home")).toSorted()).toEqual([".env", ".omp"]);
      expect(readdirSync(state).toSorted()).toEqual([
        "agent",
        "home",
        "sessions",
        "snapshots",
        "trash",
        "xdg",
      ]);
      expect(readFileSync(join(legacy, "models.yml"), "utf8")).toBe("legacy-models");
      expect(lstatSync(join(legacy, "models.yml")).mtimeMs).toBe(legacyBefore.mtimeMs);
      expect(lstatSync(legacy).mode & 0o7777).toBe(0o2770);
      expect(readdirSync(legacy).toSorted()).toEqual(["models.yml", "skills"]);
      expect(existsSync(join(root, "sandbox"))).toBe(false);
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
    const port = await reserveWildcardPort();
    const server = startCompiledServer(
      compiled.entry,
      compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID, OMP_STATE_DIR: link }),
    );
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
    await expectGenericStartFailure(root, state);
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
      const port = await reserveWildcardPort();
      const server = startCompiledServer(
        compiled.entry,
        compiledFixtureEnv(root, port, join(root, "bin", "omp"), { MODEL_ID }),
      );
      try {
        await server.waitForStarted();
        expectHostOverlay(state);
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
    await expectGenericStartFailure(root, state);
    expect(lstatSync(overlay).isDirectory()).toBe(true);
    expect(readdirSync(overlay)).toEqual([]);
    // models.yml was written first; the overlay's temporary file is removed on the failed rename.
    expect(readdirSync(join(state, "home", ".omp", "agent")).toSorted()).toEqual([
      "host-overlay.yml",
      "models.yml",
    ]);
  }, 60_000);
});
