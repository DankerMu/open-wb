/**
 * Issue #1529 browser-runtime「浏览器可执行文件配置」: the optional `BROWSER_BIN` read by the one
 * agent-config resolver. Scenarios「未设置 BROWSER_BIN」(the config half),「合法的 BROWSER_BIN」(an
 * absolute 0755 regular file, and a symlink to one kept as given) and「非法的 BROWSER_BIN 使启动失败」
 * (five values, the message names the key and never the value; two of them at the compiled entry:
 * exit 1, empty stdout, one generic record, no DB parent / sandbox / state / models.yml, no listener).
 * Expected values are the spec's, not imported from `src/agent-config.ts`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { expectNeverListened, startListenTraced } from "./server-startup-order-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const KEY = "BROWSER_BIN";
const FAILED_RECORD = `${JSON.stringify({ event: "server_start_failed", reason: "config" })}\n`;
const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;

const scratchRoots: string[] = [];

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

function regularFile(dir: string, name: string, mode: number): string {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  return file;
}

/** The five invalid values of the spec, each built in its own scratch directory. */
function invalidValues(): Array<[string, string]> {
  const root = scratch("open-wb-browser-bin-invalid-");
  const dir = join(root, "a directory");
  mkdirSync(dir);
  return [
    ["empty", ""],
    ["relative", "chromium"],
    ["missing", join(root, "missing-chromium")],
    ["directory", dir],
    ["mode 0644", regularFile(root, "chromium-0644", 0o644)],
  ];
}

describe("resolveServerConfig — BROWSER_BIN", () => {
  it("unset: browserBin is absent, a parent PUPPETEER_EXECUTABLE_PATH is not read", () => {
    const omitted = resolveServerConfig({ PUPPETEER_EXECUTABLE_PATH: "/opt/x" }, SOURCE_ENTRY);
    const explicitUndefined = resolveServerConfig({ BROWSER_BIN: undefined }, SOURCE_ENTRY);
    expect(Object.hasOwn(omitted, "browserBin")).toBe(false);
    expect(Object.hasOwn(explicitUndefined, "browserBin")).toBe(false);
    expect(Object.hasOwn(sessionRuntimeOf(omitted), "browserBin")).toBe(false);
  });

  it("an absolute 0755 regular file, and a symlink to one, resolve to the value as given", () => {
    const root = scratch("open-wb-browser-bin-valid-");
    const file = regularFile(root, "chromium", 0o755);
    const link = join(root, "chromium-link");
    symlinkSync(file, link);

    for (const value of [file, link]) {
      const config = resolveServerConfig({ BROWSER_BIN: value }, SOURCE_ENTRY);
      expect(config.browserBin).toBe(value);
      expect(sessionRuntimeOf(config).browserBin).toBe(value);
    }
  });

  it("rejects each of the five invalid values naming the key, never the value", () => {
    const values = invalidValues();
    expect(values).toHaveLength(5);
    for (const [, value] of values) {
      let message = "";
      try {
        resolveServerConfig({ BROWSER_BIN: value }, SOURCE_ENTRY);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(KEY);
      if (value !== "") {
        expect(message).not.toContain(value);
      }
    }
  });
});

describe("production entry rejects an invalid BROWSER_BIN before effects", () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it.each([
    ["relative", () => "chromium"],
    ["mode 0644", (root: string) => regularFile(root, "chromium-0644", 0o644)],
  ] as const)(
    "%s: exit 1, one generic record, no DB parent/sandbox/state/models.yml, no listener",
    async (_name, valueIn) => {
      const root = scratch("open-wb-browser-bin-entry-");
      const value = valueIn(root);
      const started = await startListenTraced(compiled.entry, root, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { [KEY]: value }),
      }));
      const { server } = started;
      const closed = await server.waitForClose();

      expect(closed).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      const stderr = server.stderr().replace(NODE_SQLITE_WARNING, "");
      expect(stderr).toBe(FAILED_RECORD);
      for (const owned of ["db", "state", "sandbox", "bin"]) {
        expect(existsSync(join(root, owned))).toBe(false);
      }
      expect(existsSync(join(root, "state", "home", ".omp", "agent", "models.yml"))).toBe(false);
      expectNeverListened(started);
    },
    20_000,
  );
});
