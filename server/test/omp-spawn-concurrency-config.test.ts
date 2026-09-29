/**
 * Issue #652 OMP_SPAWN_CONCURRENCY (design C1): the OMP_MAX_PROCESSES parsing discipline, default
 * os.availableParallelism() computed here, and the same runtime settings object into sessions.
 * Expected values come from the issue/spec, never from source constants.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
  reserveWildcardPort,
  startCompiledServer,
} from "./server-startup-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const KEY = "OMP_SPAWN_CONCURRENCY";
const REJECTED = ["", "0", "abc", "-1", "1.5", "+3", "016", " 8", "2147483648"];
const GENERIC_FAILURE = '{"event":"server_start_failed"}\n';
const SQLITE_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite[^\n]*\n\(Use `node[^\n]*\n/u;

const roots: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function concurrencyOf(env: Record<string, string>, entry = ENTRY): number {
  return resolveServerConfig(env, entry).ompSpawnConcurrency;
}

describe(`${KEY} resolution`, () => {
  it("defaults to os.availableParallelism() and leaves the process cap at 16", () => {
    const config = resolveServerConfig({}, ENTRY);
    expect(config.ompSpawnConcurrency).toBe(availableParallelism());
    expect(config.ompMaxProcesses).toBe(16);
  });

  it("takes 1, 2 and 2147483647 verbatim", () => {
    expect([concurrencyOf({ [KEY]: "1" }), concurrencyOf({ [KEY]: "2" })]).toEqual([1, 2]);
    expect(concurrencyOf({ [KEY]: "2147483647" })).toBe(2_147_483_647);
  });

  it("refuses each invalid value with a message naming only the key", () => {
    for (const raw of REJECTED) {
      let message: string | undefined;
      try {
        resolveServerConfig({ [KEY]: raw }, ENTRY);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(raw)).toMatch(new RegExp(`^${KEY} must be `, "u"));
      if (raw.length > 0) {
        expect(message).not.toContain(raw);
      }
    }
  });

  it("sessionRuntimeOf carries it beside the idle limit and the process cap", () => {
    const runtime = sessionRuntimeOf(
      resolveServerConfig({ [KEY]: "3", OMP_MAX_PROCESSES: "7", OMP_IDLE_MS: "99" }, ENTRY),
    );
    expect(runtime).toMatchObject({ spawnConcurrency: 3, maxProcesses: 7, idleMs: 99 });
    expect(sessionRuntimeOf(resolveServerConfig({}, ENTRY)).spawnConcurrency).toBe(
      availableParallelism(),
    );
  });
});

describe(`compiled entry with an invalid ${KEY}`, () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it("resolves the same default from the compiled entry URL", () => {
    const url = pathToFileURL(compiled.entry).href;
    expect(concurrencyOf({}, url)).toBe(availableParallelism());
    expect(concurrencyOf({ [KEY]: "5" }, url)).toBe(5);
  });

  it("exits nonzero with exactly the generic record and no filesystem effect", async () => {
    for (const raw of REJECTED) {
      const root = mkdtempSync(join(tmpdir(), "open-wb-spawn-concurrency-"));
      roots.push(root);
      const env = compiledFixtureEnv(root, await reserveWildcardPort(), join(root, "bin", "omp"), {
        [KEY]: raw,
      });
      const server = startCompiledServer(compiled.entry, env);

      expect(await server.waitForClose(), JSON.stringify(raw)).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(server.stderr().replace(SQLITE_WARNING, "")).toBe(GENERIC_FAILURE);
      expect(["db", "state", "sandbox", "bin"].filter((d) => existsSync(join(root, d)))).toEqual(
        [],
      );
    }
    expect(existsSync(join(compiled.root, "var"))).toBe(false);
  }, 60_000);
});
