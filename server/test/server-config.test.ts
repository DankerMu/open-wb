import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSafeSudoPath } from "../src/core/process-path.js";
import { resolveServerConfig } from "../src/server.js";
import { useSetprivStub } from "./support/setpriv.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const DIST_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "dist", "server.js")).href;
const DEFAULT_DB_PATH = join(REPO_ROOT, "var", "dev.db");
const DEFAULT_STATIC_ROOT = join(REPO_ROOT, "web", "dist");
const DEFAULT_OMP_BIN = join(REPO_ROOT, "var", "omp", "omp");
const DEFAULT_OMP_STATE_DIR = join(REPO_ROOT, "var", "omp-state");
const DEFAULT_OMP_IDLE_MS = 600_000;
const DEFAULT_SANDBOX_ROOT = join(REPO_ROOT, "var", "sandbox");
const DEFAULT_MODEL_ID = "deepseek-v4.1-flash";
const MAX_IDLE_MS = 2_147_483_647;
interface AgentSettings {
  ompBin: string | undefined;
  ompStateDir: string | undefined;
  ompIdleMs: number | undefined;
  sandboxRoot: string | undefined;
  modelUpstreamBaseUrl: string | undefined;
  modelUpstreamApiKey: string | undefined;
  modelId: string | undefined;
  ompUser: string | undefined;
}

function sevenDefaults(config: {
  ompBin?: string;
  ompStateDir?: string;
  ompIdleMs?: number;
  sandboxRoot?: string;
  modelUpstreamBaseUrl?: string;
  modelUpstreamApiKey?: string;
  modelCatalog?: { defaultModelId: string };
  ompUser?: string;
}): AgentSettings {
  return {
    ompBin: config.ompBin,
    ompStateDir: config.ompStateDir,
    ompIdleMs: config.ompIdleMs,
    sandboxRoot: config.sandboxRoot,
    modelUpstreamBaseUrl: config.modelUpstreamBaseUrl,
    modelUpstreamApiKey: config.modelUpstreamApiKey,
    modelId: config.modelCatalog?.defaultModelId,
    ompUser: config.ompUser,
  };
}

function expectNamedInvalid(key: string, patch: Record<string, string>): void {
  expect(() => resolveServerConfig(patch, SOURCE_ENTRY)).toThrow(
    expect.objectContaining({ message: expect.stringContaining(key) as unknown }),
  );
}

function expectInvalid(patch: Record<string, string>): void {
  expect(() => resolveServerConfig(patch, SOURCE_ENTRY)).toThrow();
}

describe("resolveServerConfig — 缺省身份", () => {
  it("source 与 compiled entry URL 形状得到同一组缺省", () => {
    const fromSource = resolveServerConfig({}, SOURCE_ENTRY);
    const fromDist = resolveServerConfig({}, DIST_ENTRY);

    expect(fromSource).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      dbPath: DEFAULT_DB_PATH,
      staticRoot: DEFAULT_STATIC_ROOT,
      repoRoot: REPO_ROOT,
    });
    expect(sevenDefaults(fromSource)).toEqual({
      ompBin: DEFAULT_OMP_BIN,
      ompStateDir: DEFAULT_OMP_STATE_DIR,
      ompIdleMs: DEFAULT_OMP_IDLE_MS,
      sandboxRoot: DEFAULT_SANDBOX_ROOT,
      modelUpstreamBaseUrl: undefined,
      modelUpstreamApiKey: undefined,
      modelId: DEFAULT_MODEL_ID,
      ompUser: undefined,
    });
    expect(sevenDefaults(fromDist)).toEqual(sevenDefaults(fromSource));
    for (const config of [fromSource, fromDist]) {
      expect(config.snapshotMaxFileBytes).toBe(20_971_520);
      expect(config.snapshotMaxTotalBytes).toBe(524_288_000);
      expect(config.snapshotMaxEntries).toBe(50_000);
      expect(config.snapshotExcludeNames).toEqual(["node_modules", ".venv", "__pycache__"]);
      // 未设置 MODEL_CATALOG 的单模型一项不带 efforts 键（toStrictEqual 连键的有无一起比）。
      expect(config.modelCatalog).toStrictEqual({
        models: [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_ID, reasoning: true, vision: false }],
        defaultModelId: DEFAULT_MODEL_ID,
      });
      expect(config.approvalMaxMode).toBe("yolo");
      expect(config.uploadMaxBytes).toBe(524_288_000);
      expect(config.uploadMaxFiles).toBe(10);
    }
  });

  it("路径身份不受 process.cwd() 影响，只由 entry module identity 推导", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const fromTmp = resolveServerConfig({}, SOURCE_ENTRY);
      process.chdir("/");
      const fromRoot = resolveServerConfig({}, SOURCE_ENTRY);

      expect(fromTmp).toEqual(fromRoot);
      expect(fromTmp.dbPath).toBe(DEFAULT_DB_PATH);
      expect(fromTmp.staticRoot).toBe(DEFAULT_STATIC_ROOT);
      expect(fromTmp.ompBin).toBe(DEFAULT_OMP_BIN);
      expect(fromTmp.ompStateDir).toBe(DEFAULT_OMP_STATE_DIR);
      expect(fromTmp.sandboxRoot).toBe(DEFAULT_SANDBOX_ROOT);
      expect(fromTmp.ompIdleMs).toBe(DEFAULT_OMP_IDLE_MS);
      expect(fromTmp.modelCatalog.defaultModelId).toBe(DEFAULT_MODEL_ID);
      expect(fromTmp.modelUpstreamBaseUrl).toBeUndefined();
      expect(fromTmp.modelUpstreamApiKey).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("unknown env keys 一律忽略", () => {
    const base = resolveServerConfig({}, SOURCE_ENTRY);
    const noisy = resolveServerConfig(
      {
        UNKNOWN_HOST: "",
        UNKNOWN_PORT: "not-a-port",
        WORKBUDDY_COOKIE: "secret",
        DB_PATH_EXTRA: "x",
      },
      SOURCE_ENTRY,
    );
    expect(noisy).toEqual(base);
  });

  it("显式写回缺省值得到同一身份（相对路径绑 repo root）", () => {
    const explicit = resolveServerConfig(
      {
        HOST: "127.0.0.1",
        PORT: "3000",
        DB_PATH: "var/dev.db",
        STATIC_ROOT: "web/dist",
        OMP_BIN: "var/omp/omp",
        OMP_STATE_DIR: "var/omp-state",
        OMP_IDLE_MS: "600000",
        SANDBOX_ROOT: "var/sandbox",
        MODEL_ID: "deepseek-v4.1-flash",
      },
      SOURCE_ENTRY,
    );
    expect(explicit).toEqual(resolveServerConfig({}, SOURCE_ENTRY));
  });
});

describe("resolveServerConfig — PORT", () => {
  it("接受 canonical 边界 1 与 65535", () => {
    expect(resolveServerConfig({ PORT: "1" }, SOURCE_ENTRY).port).toBe(1);
    expect(resolveServerConfig({ PORT: "65535" }, SOURCE_ENTRY).port).toBe(65535);
  });

  it("拒绝空、空白、符号、前导零、分数、指数、0、越界与杂散字符", () => {
    for (const bad of [
      "",
      " ",
      " 1",
      "1 ",
      "+1",
      "-1",
      "01",
      "007",
      "1.0",
      "1e2",
      "0",
      "000",
      "65536",
      "12a",
      "0x10",
      "1_000",
      "１",
    ]) {
      expectInvalid({ PORT: bad });
    }
  });
});

describe("resolveServerConfig — HOST", () => {
  it("missing 取缺省；empty/whitespace-only 非法；其它 nonempty 原样透传", () => {
    expect(resolveServerConfig({}, SOURCE_ENTRY).host).toBe("127.0.0.1");
    expectInvalid({ HOST: "" });
    expectInvalid({ HOST: "   " });
    expect(resolveServerConfig({ HOST: " example " }, SOURCE_ENTRY).host).toBe(" example ");
    expect(resolveServerConfig({ HOST: "::" }, SOURCE_ENTRY).host).toBe("::");
    expect(resolveServerConfig({ HOST: "0.0.0.0", PORT: "8080" }, SOURCE_ENTRY)).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it("exact localhost 规范为 127.0.0.1；其它写法原样透传", () => {
    expect(resolveServerConfig({ HOST: "localhost" }, SOURCE_ENTRY).host).toBe("127.0.0.1");
    expect(resolveServerConfig({ HOST: "LOCALHOST" }, SOURCE_ENTRY).host).toBe("LOCALHOST");
    expect(resolveServerConfig({ HOST: " localhost " }, SOURCE_ENTRY).host).toBe(" localhost ");
    expect(resolveServerConfig({ HOST: "::1" }, SOURCE_ENTRY).host).toBe("::1");
  });
});

describe("resolveServerConfig — DB_PATH", () => {
  it("relative 绑 repo root；absolute 原样精确；:memory: 保留特殊 identity", () => {
    expect(resolveServerConfig({ DB_PATH: "data/dev.db" }, SOURCE_ENTRY).dbPath).toBe(
      join(REPO_ROOT, "data", "dev.db"),
    );
    expect(resolveServerConfig({ DB_PATH: "/opt/var/dev.db" }, SOURCE_ENTRY).dbPath).toBe(
      "/opt/var/dev.db",
    );
    expect(resolveServerConfig({ DB_PATH: "/opt/../opt/var/dev.db" }, SOURCE_ENTRY).dbPath).toBe(
      "/opt/../opt/var/dev.db",
    );
    expect(resolveServerConfig({ DB_PATH: ":memory:" }, SOURCE_ENTRY).dbPath).toBe(":memory:");
  });

  it("explicit empty 非法", () => {
    expectInvalid({ DB_PATH: "" });
  });
});

describe("resolveServerConfig — STATIC_ROOT", () => {
  it("relative 绑 repo root；absolute 原样精确；explicit empty 非法", () => {
    expect(resolveServerConfig({ STATIC_ROOT: "static" }, SOURCE_ENTRY).staticRoot).toBe(
      join(REPO_ROOT, "static"),
    );
    expect(resolveServerConfig({ STATIC_ROOT: "/srv/www" }, SOURCE_ENTRY).staticRoot).toBe(
      "/srv/www",
    );
    expect(resolveServerConfig({ STATIC_ROOT: "/srv/../srv/www" }, SOURCE_ENTRY).staticRoot).toBe(
      "/srv/../srv/www",
    );
    expectInvalid({ STATIC_ROOT: "" });
  });
});

describe("resolveServerConfig — 新增七项缺省与逐项覆盖", () => {
  it("缺省路径、idle 与模型身份按 entry root 固定，上游保持缺席", () => {
    const config = resolveServerConfig({}, SOURCE_ENTRY);
    expect(config).toMatchObject({
      ompBin: DEFAULT_OMP_BIN,
      ompStateDir: DEFAULT_OMP_STATE_DIR,
      ompIdleMs: DEFAULT_OMP_IDLE_MS,
      sandboxRoot: DEFAULT_SANDBOX_ROOT,
      modelCatalog: { defaultModelId: DEFAULT_MODEL_ID },
    });
    expect(config.modelUpstreamBaseUrl).toBeUndefined();
    expect(config.modelUpstreamApiKey).toBeUndefined();
  });

  it("相对路径绑 repo root，绝对路径与模型字节原样保留", () => {
    const config = resolveServerConfig(
      {
        OMP_BIN: "bin/omp",
        OMP_STATE_DIR: "/state/omp",
        OMP_IDLE_MS: "1",
        SANDBOX_ROOT: "sandboxes/root",
        MODEL_UPSTREAM_BASE_URL: "http://upstream.example/v1",
        MODEL_UPSTREAM_API_KEY: "key-with-space ",
        MODEL_ID: " custom-model ",
      },
      SOURCE_ENTRY,
    );
    expect(config).toMatchObject({
      ompBin: join(REPO_ROOT, "bin", "omp"),
      ompStateDir: "/state/omp",
      ompIdleMs: 1,
      sandboxRoot: join(REPO_ROOT, "sandboxes", "root"),
      modelUpstreamBaseUrl: "http://upstream.example/v1",
      modelUpstreamApiKey: "key-with-space ",
      modelCatalog: { defaultModelId: " custom-model " },
    });
    expect(resolveServerConfig({ OMP_BIN: "/opt/../opt/omp" }, SOURCE_ENTRY).ompBin).toBe(
      "/opt/../opt/omp",
    );
  });

  it("source 与 compiled entry 在无关 cwd 下得到同一组七项覆盖", () => {
    const patch = {
      OMP_BIN: "agents/omp",
      OMP_STATE_DIR: "agents/state",
      OMP_IDLE_MS: String(MAX_IDLE_MS),
      SANDBOX_ROOT: "/srv/sandbox",
      MODEL_UPSTREAM_BASE_URL: "https://models.example",
      MODEL_UPSTREAM_API_KEY: "sentinel-key",
      MODEL_ID: "model-bytes",
      SNAPSHOT_MAX_FILE_BYTES: "4096",
      SNAPSHOT_MAX_TOTAL_BYTES: "65536",
      SNAPSHOT_MAX_ENTRIES: "12",
      SNAPSHOT_EXCLUDE_NAMES: "target,.cache",
      // 设了 MODEL_CATALOG 就不设 MODEL_REASONING；推理模型必带 efforts，MODEL_ID 选第二项为缺省。
      MODEL_CATALOG: JSON.stringify([
        { id: "plain-model", vision: true },
        { id: "model-bytes", name: "Model Bytes", reasoning: true, efforts: ["low", "high"] },
      ]),
      APPROVAL_MAX_MODE: "write",
      UPLOAD_MAX_BYTES: "1048576",
      UPLOAD_MAX_FILES: "3",
    };
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const fromSource = resolveServerConfig(patch, SOURCE_ENTRY);
      process.chdir("/");
      const fromDist = resolveServerConfig(patch, DIST_ENTRY);
      expect(fromDist).toEqual(fromSource);
      expect(fromSource).toMatchObject({
        ompBin: join(REPO_ROOT, "agents", "omp"),
        ompStateDir: join(REPO_ROOT, "agents", "state"),
        ompIdleMs: MAX_IDLE_MS,
        sandboxRoot: "/srv/sandbox",
        modelUpstreamBaseUrl: "https://models.example",
        modelUpstreamApiKey: "sentinel-key",
        modelCatalog: { defaultModelId: "model-bytes" },
        repoRoot: REPO_ROOT,
      });
      for (const config of [fromSource, fromDist]) {
        expect(config.snapshotMaxFileBytes).toBe(4096);
        expect(config.snapshotMaxTotalBytes).toBe(65_536);
        expect(config.snapshotMaxEntries).toBe(12);
        expect(config.snapshotExcludeNames).toEqual(["target", ".cache"]);
        expect(config.modelCatalog).toStrictEqual({
          models: [
            { id: "plain-model", name: "plain-model", reasoning: false, vision: true },
            {
              id: "model-bytes",
              name: "Model Bytes",
              reasoning: true,
              vision: false,
              efforts: ["low", "high"],
            },
          ],
          defaultModelId: "model-bytes",
        });
        expect(config.approvalMaxMode).toBe("write");
        expect(config.uploadMaxBytes).toBe(1_048_576);
        expect(config.uploadMaxFiles).toBe(3);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("裸名 OMP_BIN 绑 repo root 成绝对路径，不随 cwd 分裂（#148）", () => {
    const expected = join(REPO_ROOT, "omp");
    const fromRepo = resolveServerConfig({ OMP_BIN: "omp" }, SOURCE_ENTRY).ompBin;
    expect(fromRepo).toBe(expected);
    expect(isAbsolute(fromRepo)).toBe(true);
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(resolveServerConfig({ OMP_BIN: "omp" }, SOURCE_ENTRY).ompBin).toBe(expected);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("resolveServerConfig — OMP_IDLE_MS", () => {
  it("接受 canonical 边界 1 与 2147483647", () => {
    expect(resolveServerConfig({ OMP_IDLE_MS: "1" }, SOURCE_ENTRY).ompIdleMs).toBe(1);
    expect(resolveServerConfig({ OMP_IDLE_MS: String(MAX_IDLE_MS) }, SOURCE_ENTRY).ompIdleMs).toBe(
      MAX_IDLE_MS,
    );
  });

  it("拒绝空、零、非 canonical、越界与 Node 会溢出成 1ms 的整数", () => {
    for (const bad of [
      "",
      "0",
      "abc",
      "-1",
      "1.5",
      "01",
      " 1",
      "1 ",
      "+1",
      "1e2",
      "2147483648",
      "999999999999",
    ]) {
      expectNamedInvalid("OMP_IDLE_MS", { OMP_IDLE_MS: bad });
    }
  });
});

describe("resolveServerConfig — 新路径与上游显式空值", () => {
  it("OMP_BIN、OMP_STATE_DIR、SANDBOX_ROOT 的显式空值在解析前命名拒绝", () => {
    expectNamedInvalid("OMP_BIN", { OMP_BIN: "" });
    expectNamedInvalid("OMP_STATE_DIR", { OMP_STATE_DIR: "" });
    expectNamedInvalid("SANDBOX_ROOT", { SANDBOX_ROOT: "" });
  });

  it("上游缺席或半对保持可用且不补造凭据；显式空值命名拒绝", () => {
    const missing = resolveServerConfig({}, SOURCE_ENTRY);
    expect(missing.modelUpstreamBaseUrl).toBeUndefined();
    expect(missing.modelUpstreamApiKey).toBeUndefined();

    const urlOnly = resolveServerConfig(
      { MODEL_UPSTREAM_BASE_URL: "http://half.example" },
      SOURCE_ENTRY,
    );
    expect(urlOnly.modelUpstreamBaseUrl).toBe("http://half.example");
    expect(urlOnly.modelUpstreamApiKey).toBeUndefined();

    const keyOnly = resolveServerConfig({ MODEL_UPSTREAM_API_KEY: "half-key" }, SOURCE_ENTRY);
    expect(keyOnly.modelUpstreamBaseUrl).toBeUndefined();
    expect(keyOnly.modelUpstreamApiKey).toBe("half-key");

    const explicitUndefined = resolveServerConfig(
      { MODEL_UPSTREAM_BASE_URL: undefined, MODEL_UPSTREAM_API_KEY: undefined },
      SOURCE_ENTRY,
    );
    expect(explicitUndefined.modelUpstreamBaseUrl).toBeUndefined();
    expect(explicitUndefined.modelUpstreamApiKey).toBeUndefined();

    expectNamedInvalid("MODEL_UPSTREAM_BASE_URL", { MODEL_UPSTREAM_BASE_URL: "" });
    expectNamedInvalid("MODEL_UPSTREAM_API_KEY", { MODEL_UPSTREAM_API_KEY: "" });
  });
});

describe("resolveServerConfig — OMP_USER", () => {
  useSetprivStub();
  it("缺席与显式 undefined 不增加用户，其余身份保持缺省", () => {
    const omitted = resolveServerConfig({}, SOURCE_ENTRY);
    const explicitUndefined = resolveServerConfig({ OMP_USER: undefined }, SOURCE_ENTRY);
    expect(omitted.ompUser).toBeUndefined();
    expect(explicitUndefined.ompUser).toBeUndefined();
    expect(sevenDefaults(explicitUndefined)).toEqual(sevenDefaults(omitted));
    expect(Object.hasOwn(omitted, "ompUser")).toBe(false);
    expect(Object.hasOwn(explicitUndefined, "ompUser")).toBe(false);
  });

  it("接受 1 与 32 的精确用户名，不裁剪也不改写", () => {
    const safe = { PATH: "/usr/bin:/opt/homebrew/bin" };
    expect(resolveServerConfig({ ...safe, OMP_USER: "_" }, SOURCE_ENTRY).ompUser).toBe("_");
    expect(resolveServerConfig({ ...safe, OMP_USER: "a" }, SOURCE_ENTRY).ompUser).toBe("a");
    const boundary = `_${"a".repeat(31)}`;
    expect(boundary).toHaveLength(32);
    expect(resolveServerConfig({ ...safe, OMP_USER: boundary }, SOURCE_ENTRY).ompUser).toBe(
      boundary,
    );
    expect(resolveServerConfig({ ...safe, OMP_USER: "omp-user_1" }, SOURCE_ENTRY).ompUser).toBe(
      "omp-user_1",
    );
  });

  it("拒绝空、大写、空格、分号、换行、非 ASCII 与 33 字符", () => {
    for (const bad of [
      "",
      "Omp",
      "omp user",
      "root;id",
      "omp\n",
      "omp\r",
      "omp用户",
      `_${"a".repeat(32)}`,
      " omp",
      "omp ",
      "1omp",
      "-omp",
    ]) {
      expectInvalid({ OMP_USER: bad });
    }
    expect("omp\n").toHaveLength(4);
    expect(`_${"a".repeat(32)}`).toHaveLength(33);
  });

  it("配置用户时拒绝缺失、空、空段、相对段与 NUL 的 PATH，绝对 PATH 原样保留", () => {
    const safe = `/usr/bin${delimiter}/opt/homebrew/bin`;
    expect(resolveServerConfig({ OMP_USER: "omp", PATH: safe }, SOURCE_ENTRY).ompUser).toBe("omp");
    expect(() => assertSafeSudoPath("/usr/bin\0/bin")).toThrow();
    for (const path of [
      undefined,
      "",
      delimiter,
      `/usr/bin${delimiter}`,
      `${delimiter}/usr/bin`,
      `/usr/bin${delimiter}${delimiter}/bin`,
      "bin",
      `/usr/bin${delimiter}bin`,
    ]) {
      expect(() =>
        resolveServerConfig(
          { OMP_USER: "omp", ...(path === undefined ? {} : { PATH: path }) },
          SOURCE_ENTRY,
        ),
      ).toThrow();
    }
    expect(resolveServerConfig({ PATH: "bin" }, SOURCE_ENTRY).ompUser).toBeUndefined();
  });
});

/** 配置层错误信息：恰为期望文本（故与输入无关），命名该键，且不含输入值。 */
function expectKeyOnlyMessage(key: string, value: string, message: string): void {
  let thrown: unknown;
  try {
    resolveServerConfig({ [key]: value }, SOURCE_ENTRY);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${key} 应当拒绝该取值`).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(message);
  expect((thrown as Error).message).toContain(key);
}

function thrownMessageOf(patch: Record<string, string>): string {
  try {
    resolveServerConfig(patch, SOURCE_ENTRY);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("resolver accepted an invalid setting");
}

describe("resolveServerConfig — APPROVAL_MAX_MODE（审批最高档）", () => {
  const KEY = "APPROVAL_MAX_MODE";
  const MESSAGE = "APPROVAL_MAX_MODE must be exactly always-ask, write or yolo";

  it("未设置与显式 undefined 时为 yolo（三档都开放）", () => {
    expect(resolveServerConfig({}, SOURCE_ENTRY).approvalMaxMode).toBe("yolo");
    expect(resolveServerConfig({ [KEY]: undefined }, SOURCE_ENTRY).approvalMaxMode).toBe("yolo");
  });

  it.each(["always-ask", "write", "yolo"])("接受精确字面量 %s 并原样保留", (mode) => {
    const config = resolveServerConfig({ [KEY]: mode }, SOURCE_ENTRY);
    expect(config.approvalMaxMode).toBe(mode);
    const { approvalMaxMode: _mode, ...rest } = config;
    const { approvalMaxMode: _default, ...base } = resolveServerConfig({}, SOURCE_ENTRY);
    expect(rest).toEqual(base);
  });

  it.each([
    ["empty", ""],
    ["大写", "YOLO"],
    ["前导空格", " write"],
    ["非档位字面量", "ask"],
    ["尾随空格", "yolo "],
    ["首字母大写", "Write"],
    ["下划线写法", "always_ask"],
  ])("拒绝 %s，错误只命名键", (_label, bad) => {
    expectKeyOnlyMessage(KEY, bad, MESSAGE);
  });

  it.each(["YOLO", "Write", "Sentinel-Tier-7", "always_ask"])("错误信息不回显输入值 %s", (bad) => {
    const message = thrownMessageOf({ [KEY]: bad });
    expect(message).toContain(KEY);
    expect(message).not.toContain(bad);
  });
});

describe("resolveServerConfig — UPLOAD_MAX_BYTES 与 UPLOAD_MAX_FILES（上传上限）", () => {
  const KEYS = [
    ["UPLOAD_MAX_BYTES", "uploadMaxBytes", 524_288_000],
    ["UPLOAD_MAX_FILES", "uploadMaxFiles", 10],
  ] as const;
  const INVALID = [
    ["", "canonical"],
    ["0", "range"],
    ["abc", "canonical"],
    ["-1", "canonical"],
    ["1.5", "canonical"],
    ["010", "canonical"],
    ["2147483648", "range"],
    [" 3", "canonical"],
    ["+3", "canonical"],
    ["1e3", "canonical"],
  ] as const;

  it("未设置时为 524288000 字节（500 MiB）与 10 个文件", () => {
    const config = resolveServerConfig({}, SOURCE_ENTRY);
    expect(config.uploadMaxBytes).toBe(524_288_000);
    expect(config.uploadMaxFiles).toBe(10);
  });

  it("三个标量键同时给出合法值时各自生效，互不串位", () => {
    expect(
      resolveServerConfig(
        { APPROVAL_MAX_MODE: "write", UPLOAD_MAX_BYTES: "1048576", UPLOAD_MAX_FILES: "3" },
        SOURCE_ENTRY,
      ),
    ).toMatchObject({ approvalMaxMode: "write", uploadMaxBytes: 1_048_576, uploadMaxFiles: 3 });
  });

  describe.each(KEYS)("%s", (key, field, fallback) => {
    it("显式 undefined 取缺省；接受 canonical 边界 1 与 2147483647", () => {
      expect(resolveServerConfig({ [key]: undefined }, SOURCE_ENTRY)[field]).toBe(fallback);
      expect(resolveServerConfig({ [key]: "1" }, SOURCE_ENTRY)[field]).toBe(1);
      expect(resolveServerConfig({ [key]: "2147483647" }, SOURCE_ENTRY)[field]).toBe(2_147_483_647);
    });

    it.each(INVALID)("拒绝 %j，错误只命名键", (bad, kind) => {
      expectKeyOnlyMessage(
        key,
        bad,
        kind === "range"
          ? `${key} must be within 1..2147483647`
          : `${key} must be a canonical ASCII decimal`,
      );
    });

    it.each(["abc", "-1", "1.5", "010", "2147483648", "98765x"])(
      "错误信息不回显输入值 %s",
      (bad) => {
        const message = thrownMessageOf({ [key]: bad });
        expect(message).toContain(key);
        expect(message).not.toContain(bad);
      },
    );
  });
});

describe("resolveServerConfig — SNAPSHOT_*（快照上限与排除名单）", () => {
  const NUMERIC = [
    ["SNAPSHOT_MAX_FILE_BYTES", "snapshotMaxFileBytes", 20_971_520],
    ["SNAPSHOT_MAX_TOTAL_BYTES", "snapshotMaxTotalBytes", 524_288_000],
    ["SNAPSHOT_MAX_ENTRIES", "snapshotMaxEntries", 50_000],
  ] as const;
  const NUMERIC_INVALID = [
    ["", "canonical"],
    ["0", "range"],
    ["abc", "canonical"],
    ["-1", "canonical"],
    ["1.5", "canonical"],
    ["016", "canonical"],
    ["+8", "canonical"],
    [" 8", "canonical"],
    ["2147483648", "range"],
  ] as const;
  const NAMES = "SNAPSHOT_EXCLUDE_NAMES";
  const NAMES_MESSAGE =
    "SNAPSHOT_EXCLUDE_NAMES must be comma-separated directory names without empty, '.', '..', '/' or NUL entries";
  const DEFAULT_NAMES = ["node_modules", ".venv", "__pycache__"];

  it("未设置与显式 undefined 时为规格缺省，默认名单不含 .git", () => {
    for (const env of [
      {},
      {
        SNAPSHOT_MAX_FILE_BYTES: undefined,
        SNAPSHOT_MAX_TOTAL_BYTES: undefined,
        SNAPSHOT_MAX_ENTRIES: undefined,
        SNAPSHOT_EXCLUDE_NAMES: undefined,
      },
    ]) {
      const config = resolveServerConfig(env, SOURCE_ENTRY);
      expect(config.snapshotMaxFileBytes).toBe(20_971_520);
      expect(config.snapshotMaxTotalBytes).toBe(524_288_000);
      expect(config.snapshotMaxEntries).toBe(50_000);
      expect(config.snapshotExcludeNames).toEqual(DEFAULT_NAMES);
      expect(config.snapshotExcludeNames).not.toContain(".git");
    }
  });

  it("四个键同时给出合法值时各自生效，互不串位，其余配置不变", () => {
    const config = resolveServerConfig(
      {
        SNAPSHOT_MAX_FILE_BYTES: "11",
        SNAPSHOT_MAX_TOTAL_BYTES: "22",
        SNAPSHOT_MAX_ENTRIES: "33",
        SNAPSHOT_EXCLUDE_NAMES: "target,.git",
      },
      SOURCE_ENTRY,
    );
    const {
      snapshotMaxFileBytes,
      snapshotMaxTotalBytes,
      snapshotMaxEntries,
      snapshotExcludeNames,
      ...rest
    } = config;
    expect(snapshotMaxFileBytes).toBe(11);
    expect(snapshotMaxTotalBytes).toBe(22);
    expect(snapshotMaxEntries).toBe(33);
    expect(snapshotExcludeNames).toEqual(["target", ".git"]);
    const {
      snapshotMaxFileBytes: _file,
      snapshotMaxTotalBytes: _total,
      snapshotMaxEntries: _entries,
      snapshotExcludeNames: _names,
      ...base
    } = resolveServerConfig({}, SOURCE_ENTRY);
    expect(rest).toEqual(base);
  });

  describe.each(NUMERIC)("%s", (key, field, fallback) => {
    it("只读自己的键：单独覆盖时另外三项保持缺省；接受边界 1 与 2147483647", () => {
      const config = resolveServerConfig({ [key]: "7" }, SOURCE_ENTRY);
      for (const [, other, otherDefault] of NUMERIC) {
        expect(config[other]).toBe(other === field ? 7 : otherDefault);
      }
      expect(config.snapshotExcludeNames).toEqual(DEFAULT_NAMES);
      expect(resolveServerConfig({ [key]: undefined }, SOURCE_ENTRY)[field]).toBe(fallback);
      expect(resolveServerConfig({ [key]: "1" }, SOURCE_ENTRY)[field]).toBe(1);
      expect(resolveServerConfig({ [key]: "2147483647" }, SOURCE_ENTRY)[field]).toBe(2_147_483_647);
    });

    it.each(NUMERIC_INVALID)("拒绝 %j，错误只命名键", (bad, kind) => {
      expectKeyOnlyMessage(
        key,
        bad,
        kind === "range"
          ? `${key} must be within 1..2147483647`
          : `${key} must be a canonical ASCII decimal`,
      );
    });

    it.each(["abc", "-1", "1.5", "016", "2147483648", "98765x"])(
      "错误信息不回显输入值 %s",
      (bad) => {
        const message = thrownMessageOf({ [key]: bad });
        expect(message).toContain(key);
        expect(message).not.toContain(bad);
      },
    );
  });

  it.each([
    ["空字符串表示不排除任何目录", "", []],
    ["单个名字", "dist", ["dist"]],
    ["多个名字按书写顺序", "node_modules,.git,build", ["node_modules", ".git", "build"]],
    ["不 trim、不去重、保留点前缀与多点名", " a ,a,...,.b", [" a ", "a", "...", ".b"]],
  ])("SNAPSHOT_EXCLUDE_NAMES：%s", (_label, raw, expected) => {
    const config = resolveServerConfig({ [NAMES]: raw }, SOURCE_ENTRY);
    expect(config.snapshotExcludeNames).toEqual(expected);
    expect(config.snapshotMaxFileBytes).toBe(20_971_520);
    expect(config.snapshotMaxTotalBytes).toBe(524_288_000);
    expect(config.snapshotMaxEntries).toBe(50_000);
  });

  it("缺省名单每次解析是独立数组，改动一份不影响下一次解析", () => {
    const first = resolveServerConfig({}, SOURCE_ENTRY).snapshotExcludeNames as string[];
    first.push(".git");
    expect(resolveServerConfig({}, SOURCE_ENTRY).snapshotExcludeNames).toEqual(DEFAULT_NAMES);
  });

  it.each([
    ["含斜杠的名字", "a/b"],
    ["父目录", ".."],
    ["当前目录", "."],
    ["中间空名段", "a,,b"],
    ["前导逗号", ",a"],
    ["尾随逗号", "a,"],
    ["只有逗号", ","],
    ["列表里的父目录", "node_modules,.."],
    ["列表里的当前目录", ".,dist"],
    ["列表里的斜杠名", "dist,src/gen"],
    ["绝对路径", "/abs"],
    ["含 NUL 的名字", "a\0b"],
  ])("SNAPSHOT_EXCLUDE_NAMES 拒绝%s，错误只命名键", (_label, bad) => {
    expectKeyOnlyMessage(NAMES, bad, NAMES_MESSAGE);
  });

  it.each(["sentinel/zeta9", "Sentinel-Name,,x", "zeta-7,..", "pre\0post"])(
    "SNAPSHOT_EXCLUDE_NAMES 错误信息不回显输入值 %j",
    (bad) => {
      const message = thrownMessageOf({ [NAMES]: bad });
      expect(message).toContain(NAMES);
      expect(message).not.toContain(bad);
      for (const part of bad.split(/[,/]/u).filter((piece) => piece.length > 2)) {
        expect(message).not.toContain(part);
      }
    },
  );
});
