/**
 * Issue #1530 model-selection「模型白名单配置」/ http-service-skeleton「服务启动与装配」: the optional
 * `MODEL_VISION` read by the one agent-config resolver (`on` default → true, `off` → false; any other
 * value, empty included, and any value next to `MODEL_CATALOG` fail startup naming only the key), and
 * model-proxy「Single-model default declares image input」's startup half: with `MODEL_CATALOG` unset,
 * `MODEL_VISION` unset / `on` / `off` write the single entry with / with / without the `input` list.
 * Expected values are the spec's, not imported from `src/model-catalog.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveServerConfig } from "../src/server.js";
import { baselineYaml, withVisionInput } from "./models-yml-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { expectNeverListened, startListenTraced } from "./server-startup-order-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const KEY = "MODEL_VISION";
const MODEL_ID = "deepseek-v4.1-flash";
const CATALOG = '[{"id":"m1"},{"id":"m2","vision":true}]';
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

function messageOf(env: Record<string, string | undefined>): string {
  try {
    resolveServerConfig(env, SOURCE_ENTRY);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the configuration to be rejected");
}

describe("resolveServerConfig — MODEL_VISION", () => {
  it.each([
    ["unset", true, {}],
    ["explicit undefined", true, { [KEY]: undefined }],
    ["on", true, { [KEY]: "on" }],
    ["off", false, { [KEY]: "off" }],
  ] as const)("%s: the single model's vision is %s", (_label, vision, env) => {
    expect(resolveServerConfig(env, SOURCE_ENTRY).modelCatalog).toStrictEqual({
      models: [{ id: MODEL_ID, name: MODEL_ID, reasoning: true, vision, maxTokens: 32768 }],
      defaultModelId: MODEL_ID,
    });
  });

  it("rejects empty, yes, ON and true naming the key, with one message whatever the value", () => {
    const messages = ["", "yes", "ON", "true"].map((raw) => messageOf({ [KEY]: raw }));
    for (const message of messages) {
      expect(message).toContain(KEY);
      expect(message).not.toContain("MODEL_CATALOG");
      expect(message).not.toContain("yes");
      expect(message).not.toContain("true");
    }
    expect(new Set(messages).size).toBe(1);
  });

  it.each(["on", "off", ""])(
    "rejects MODEL_VISION=%j next to a valid MODEL_CATALOG, naming only MODEL_VISION",
    (raw) => {
      const message = messageOf({ MODEL_CATALOG: CATALOG, [KEY]: raw });
      expect(message).toContain(KEY);
      expect(message).not.toContain("MODEL_CATALOG");
      expect(message).not.toContain("MODEL_ID");
      expect(message).not.toContain("MODEL_REASONING");
    },
  );

  it("a MODEL_CATALOG without MODEL_VISION keeps each element's own vision", () => {
    expect(
      resolveServerConfig({ MODEL_CATALOG: CATALOG }, SOURCE_ENTRY).modelCatalog,
    ).toStrictEqual({
      models: [
        { id: "m1", name: "m1", reasoning: false, vision: false, maxTokens: 32768 },
        { id: "m2", name: "m2", reasoning: false, vision: true, maxTokens: 32768 },
      ],
      defaultModelId: "m1",
    });
  });
});

describe("production entry — MODEL_VISION", () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it("an empty MODEL_VISION: exit 1, one generic record, no DB parent/sandbox/state/models.yml, no listener", async () => {
    const root = scratch("open-wb-vision-invalid-");
    const started = await startListenTraced(compiled.entry, root, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { [KEY]: "" }),
    }));
    const { server } = started;
    const closed = await server.waitForClose();

    expect(closed).toEqual({ code: 1, signal: null });
    expect(server.stdout()).toBe("");
    expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(FAILED_RECORD);
    for (const owned of ["db", "state", "sandbox", "bin"]) {
      expect(existsSync(join(root, owned))).toBe(false);
    }
    expect(existsSync(join(root, "state", "home", ".omp", "agent", "models.yml"))).toBe(false);
    expectNeverListened(started);
  }, 20_000);

  it.each([
    ["unset", true, {}],
    ["on", true, { [KEY]: "on" }],
    ["off", false, { [KEY]: "off" }],
  ] as const)(
    "MODEL_VISION %s: the managed models.yml single entry declares image input: %s",
    async (_label, vision, extra) => {
      const root = scratch("open-wb-vision-models-");
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), extra),
      }));
      try {
        await server.waitForStarted();
        const text = readFileSync(
          join(root, "state", "home", ".omp", "agent", "models.yml"),
          "utf8",
        );
        const plain = baselineYaml(true, `http://127.0.0.1:${port}/v1`, MODEL_ID);
        expect(text).toBe(vision ? withVisionInput(plain) : plain);
        const entry = (
          parse(text) as { providers: { workbuddy: { models: [{ input: unknown }] } } }
        ).providers.workbuddy.models[0];
        expect(entry.input).toEqual(vision ? ["text", "image"] : ["text"]);
      } finally {
        await server.dispose();
      }
    },
    30_000,
  );
});
