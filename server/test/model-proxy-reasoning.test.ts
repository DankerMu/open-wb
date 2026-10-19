/**
 * Issue #511：MODEL_REASONING 启动配置键与托管 models.yml 的 reasoning 声明。
 * 期望值取自 issue/spec（缺省 on、只接受精确 on/off、固定错误文本、8/10 格三行），不引用源码常量。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { resolveServerConfig } from "../src/server.js";
import { plainYaml, reasoningYaml, withMaxTokens, withVisionInput } from "./models-yml-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const KEY = "MODEL_REASONING";
const INVALID_MESSAGE = "MODEL_REASONING must be exactly on or off";
const RESOLVER_INVALID = ["", "ON", "Off", "true", "yes", " on"] as const;
const ENTRY_INVALID = ["", "ON", "true", "yes"] as const;
const PROXY_BASE_URL = "http://127.0.0.1:18016/v1";
const MODEL_ID = "deepseek-v4.1-flash";
const FAILED_RECORD = `${JSON.stringify({ event: "server_start_failed", reason: "config" })}\n`;
const NODE_SQLITE_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u;

function plainModel(): Record<string, unknown> {
  return { id: MODEL_ID, name: MODEL_ID, contextWindow: 128000, maxTokens: 32768 };
}

/** The single-model output today: the pre-change fixture with its maxTokens line at 32768. */
const plainNow = (baseUrl: string) => withMaxTokens(plainYaml(baseUrl, MODEL_ID), 32768);
const reasoningNow = (baseUrl: string) => withMaxTokens(reasoningYaml(baseUrl, MODEL_ID), 32768);

function documentWith(baseUrl: string, model: Record<string, unknown>): unknown {
  return {
    providers: {
      workbuddy: {
        api: "openai-completions",
        baseUrl,
        apiKey: "WORKBUDDY_MODEL_TOKEN",
        models: [model],
      },
    },
  };
}

const REASONING_MODEL = {
  ...plainModel(),
  reasoning: true,
  compat: { reasoningContentField: "reasoning_content" },
};

const scratchRoots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

function thrownMessage(env: Record<string, string>): string {
  try {
    resolveServerConfig(env, SOURCE_ENTRY);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`resolver accepted ${KEY}=${JSON.stringify(env[KEY])}`);
}

function refused(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => {
      socket.destroy();
      done(true);
    });
  });
}

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveServerConfig — MODEL_REASONING", () => {
  it("未设置时为 true（缺省 on），且是自有字段", () => {
    const config = resolveServerConfig({}, SOURCE_ENTRY);
    expect(Object.hasOwn(config, "modelCatalog")).toBe(true);
    expect(Object.hasOwn(config.modelCatalog.models[0] ?? {}, "reasoning")).toBe(true);
    expect(config.modelCatalog.models[0]?.reasoning).toBe(true);
  });

  it.each([
    ["on", true],
    ["off", false],
  ])("精确 %s → %s", (raw, expected) => {
    expect(
      resolveServerConfig({ [KEY]: raw }, SOURCE_ENTRY).modelCatalog.models[0]?.reasoning,
    ).toBe(expected);
  });

  it("设置 MODEL_REASONING 不改变其它键的解析与命名消息", () => {
    const config = resolveServerConfig({ [KEY]: "off", OMP_IDLE_MS: "7" }, SOURCE_ENTRY);
    expect(config.ompIdleMs).toBe(7);
    expect(config.modelCatalog.defaultModelId).toBe(MODEL_ID);
    expect(thrownMessage({ [KEY]: "on", OMP_IDLE_MS: "01" })).toBe(
      "OMP_IDLE_MS must be a canonical ASCII decimal",
    );
  });

  it.each(RESOLVER_INVALID)("拒绝 %j，消息恰为与输入无关的固定文本", (raw) => {
    expect(thrownMessage({ [KEY]: raw })).toBe(INVALID_MESSAGE);
  });
});

describe("writeManagedModelsYml — reasoning 声明", () => {
  /** 未设置 MODEL_CATALOG、MODEL_VISION=off 的单模型白名单：name 同 id、不带 efforts、vision 为假。 */
  function single(reasoning: boolean): Parameters<typeof writeManagedModelsYml>[1] {
    return {
      proxyBaseUrl: PROXY_BASE_URL,
      models: [{ id: MODEL_ID, name: MODEL_ID, reasoning, vision: false, maxTokens: 32768 }],
    };
  }

  async function written(reasoning: boolean): Promise<Buffer> {
    const options = single(reasoning);
    const agentDir = scratch("open-wb-reasoning-yml-");
    await writeManagedModelsYml(agentDir, options);
    const first = readFileSync(join(agentDir, "models.yml"));
    await writeManagedModelsYml(agentDir, options);
    const second = readFileSync(join(agentDir, "models.yml"));
    expect(second.equals(first)).toBe(true);
    return second;
  }

  it("reasoning: true 写出精确 13 行，解析后模型条目恰多 reasoning 与 compat", async () => {
    const bytes = await written(true);
    const text = bytes.toString("utf8");
    expect(text).toBe(reasoningNow(PROXY_BASE_URL));
    expect(text.split("\n")).toHaveLength(14);
    expect(parse(text)).toEqual(documentWith(PROXY_BASE_URL, REASONING_MODEL));
  });

  it("reasoning: false 等于变更前输出换掉 maxTokens 一行", async () => {
    const text = (await written(false)).toString("utf8");
    expect(text).toBe(plainNow(PROXY_BASE_URL));
    expect(text.split("\n")).toHaveLength(11);
    expect(parse(text)).toEqual(documentWith(PROXY_BASE_URL, plainModel()));
  });

  it("同一 agentDir 先写 true 再写 false：无 reasoning/compat 残留", async () => {
    const agentDir = scratch("open-wb-reasoning-overwrite-");
    const path = join(agentDir, "models.yml");
    await writeManagedModelsYml(agentDir, single(true));
    expect(readFileSync(path, "utf8")).toBe(reasoningNow(PROXY_BASE_URL));
    await writeManagedModelsYml(agentDir, single(false));
    const text = readFileSync(path, "utf8");
    for (const stale of ["reasoning", "compat", "reasoningContentField"]) {
      expect(text).not.toContain(stale);
    }
    expect(text).toBe(plainNow(PROXY_BASE_URL));
  });
});

describe("production entry — MODEL_REASONING", () => {
  let compiled: CompiledServerEntry;

  beforeAll(async () => {
    compiled = await compileServerEntry();
  }, 90_000);

  it("compiled entry URL 与 source 得到同一缺省", () => {
    const compiledEntry = pathToFileURL(compiled.entry).href;
    expect(resolveServerConfig({}, compiledEntry).modelCatalog.models[0]?.reasoning).toBe(true);
    expect(
      resolveServerConfig({ [KEY]: "off" }, compiledEntry).modelCatalog.models[0]?.reasoning,
    ).toBe(false);
  });

  it.each(ENTRY_INVALID)(
    "%j：nonzero、恰一行 generic record、无 DB/state/sandbox/listen",
    async (raw) => {
      const root = scratch("open-wb-reasoning-invalid-");
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { [KEY]: raw }),
      }));
      const closed = await server.waitForClose();

      expect(closed).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(server.stderr().replace(NODE_SQLITE_WARNING, "")).toBe(FAILED_RECORD);
      for (const owned of ["db", "state", "sandbox", "bin"]) {
        expect(existsSync(join(root, owned))).toBe(false);
      }
      expect(existsSync(join(root, "state", "home", ".omp", "agent", "models.yml"))).toBe(false);
      expect(existsSync(join(compiled.root, "var"))).toBe(false);
      await expect(refused(port)).resolves.toBe(true);
    },
    20_000,
  );

  it("未设置时写出含 reasoning 声明的 models.yml（MODEL_VISION 缺省 on：另有 input 三行）", async () => {
    const root = scratch("open-wb-reasoning-default-");
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
      env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), {}),
    }));
    try {
      await server.waitForStarted();
      const text = readFileSync(join(root, "state", "home", ".omp", "agent", "models.yml"), "utf8");
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = { ...REASONING_MODEL, input: ["text", "image"] };
      expect(parse(text)).toEqual(documentWith(baseUrl, model));
      expect(text).toBe(withVisionInput(reasoningNow(baseUrl)));
    } finally {
      await server.dispose();
    }
  }, 30_000);

  // thinking-fold「关闭 reasoning」：同时 MODEL_VISION=off 时即 vision-false 的单模型输出（改前夹具换掉
  // maxTokens 一行）；MODEL_VISION 缺省 on 时另有 input 三行。
  it.each([
    ["MODEL_VISION=off：与变更前只差 maxTokens 一行", { MODEL_VISION: "off" }, false],
    ["MODEL_VISION 缺省：再多 input 三行", {}, true],
  ] as const)(
    "MODEL_REASONING=off，%s",
    async (_label, vision, declared) => {
      const root = scratch("open-wb-reasoning-off-");
      const { server, port } = await startCompiledServerWithRetry(compiled.entry, (port) => ({
        env: compiledFixtureEnv(root, port, join(root, "bin", "omp"), { [KEY]: "off", ...vision }),
      }));
      try {
        await server.waitForStarted();
        const text = readFileSync(
          join(root, "state", "home", ".omp", "agent", "models.yml"),
          "utf8",
        );
        const baseUrl = `http://127.0.0.1:${port}/v1`;
        const model = declared ? { ...plainModel(), input: ["text", "image"] } : plainModel();
        expect(parse(text)).toEqual(documentWith(baseUrl, model));
        expect(text).toBe(declared ? withVisionInput(plainNow(baseUrl)) : plainNow(baseUrl));
      } finally {
        await server.dispose();
      }
    },
    30_000,
  );
});
