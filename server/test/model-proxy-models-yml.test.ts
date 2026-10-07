import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { deriveProxyBaseUrl, writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { plainYaml, reasoningYaml } from "./models-yml-helpers.js";

const PROXY_BASE_URL = "http://127.0.0.1:18016/v1";
const MODEL_ID = "deepseek-v4.1-flash";
const OPTIONS = singleModel(PROXY_BASE_URL, MODEL_ID);
const YAML_SENSITIVE_MODEL_ID = 'flash: "quoted"\nproviders:\n  injected: true # 中文';
const NEXT_PROXY_BASE_URL = "http://[::1]:18016/v1";
const SENTINELS = {
  MODEL_UPSTREAM_BASE_URL: "https://vendor-upstream.invalid/secret-path",
  MODEL_UPSTREAM_API_KEY: "parent-upstream-key-SENTINEL-89",
  WORKBUDDY_MODEL_TOKEN: "session-bearer-SENTINEL-89-token",
} as const;

/** A whitelist of an installation without MODEL_CATALOG: name equals id, no efforts, no vision. */
function singleModel(proxyBaseUrl: string, modelId: string) {
  return {
    proxyBaseUrl,
    models: [{ id: modelId, name: modelId, reasoning: false, vision: false }],
  };
}

/** model-proxy「托管 models.yml」scenario "Several models in whitelist order", verbatim. */
const M2 = { id: "m2", name: "m2", reasoning: false, vision: false } as const;
const THREE_MODELS = [
  {
    id: "m1",
    name: "通用",
    reasoning: true,
    vision: false,
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  M2,
  { id: "m3", name: "深度", reasoning: true, vision: true, efforts: ["low", "high"] },
] as const;

const THREE_MODELS_YAML = `providers:
  workbuddy:
    api: openai-completions
    baseUrl: "http://127.0.0.1:18016/v1"
    apiKey: WORKBUDDY_MODEL_TOKEN
    models:
      - id: "m1"
        name: "通用"
        contextWindow: 128000
        maxTokens: 8192
        reasoning: true
        compat:
          reasoningContentField: reasoning_content
        thinking:
          mode: effort
          efforts:
            - "minimal"
            - "low"
            - "medium"
            - "high"
            - "xhigh"
            - "max"
      - id: "m2"
        name: "m2"
        contextWindow: 128000
        maxTokens: 8192
      - id: "m3"
        name: "深度"
        contextWindow: 128000
        maxTokens: 8192
        reasoning: true
        compat:
          reasoningContentField: reasoning_content
        thinking:
          mode: effort
          efforts:
            - "low"
            - "high"
        input:
          - text
          - image
`;

const LIMITS = { contextWindow: 128000, maxTokens: 8192 };
const REASONING_KEYS = {
  reasoning: true,
  compat: { reasoningContentField: "reasoning_content" },
};
const THREE_MODELS_DOCUMENT = {
  providers: {
    workbuddy: {
      api: "openai-completions",
      baseUrl: PROXY_BASE_URL,
      apiKey: "WORKBUDDY_MODEL_TOKEN",
      models: [
        {
          id: "m1",
          name: "通用",
          ...LIMITS,
          ...REASONING_KEYS,
          thinking: {
            mode: "effort",
            efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
          },
        },
        { id: "m2", name: "m2", ...LIMITS },
        {
          id: "m3",
          name: "深度",
          ...LIMITS,
          ...REASONING_KEYS,
          thinking: { mode: "effort", efforts: ["low", "high"] },
          input: ["text", "image"],
        },
      ],
    },
  },
};

const tmpDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("deriveProxyBaseUrl", () => {
  it("maps wildcard and explicit IPv4/IPv6 AddressInfo to connectable http /v1 URLs", () => {
    const cases: ReadonlyArray<{ info: AddressInfo; url: string }> = [
      {
        info: { address: "0.0.0.0", family: "IPv4", port: 18016 },
        url: "http://127.0.0.1:18016/v1",
      },
      {
        info: { address: "::", family: "IPv6", port: 18016 },
        url: "http://[::1]:18016/v1",
      },
      {
        info: { address: "127.0.0.1", family: "IPv4", port: 3001 },
        url: "http://127.0.0.1:3001/v1",
      },
      {
        info: { address: "192.0.2.10", family: "IPv4", port: 8080 },
        url: "http://192.0.2.10:8080/v1",
      },
      {
        info: { address: "::1", family: "IPv6", port: 18017 },
        url: "http://[::1]:18017/v1",
      },
      {
        info: { address: "2001:db8::42", family: "IPv6", port: 54321 },
        url: "http://[2001:db8::42]:54321/v1",
      },
    ];
    for (const row of cases) {
      expect(deriveProxyBaseUrl(row.info)).toBe(row.url);
    }
  });
});

describe("writeManagedModelsYml", () => {
  it("writes the credential-safe workbuddy schema into an existing agentDir", async () => {
    const root = tempRoot();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const keepPath = join(root, "keep.txt");
    writeFileSync(keepPath, "unrelated-keep");

    for (const [key, value] of Object.entries(SENTINELS)) {
      vi.stubEnv(key, value);
    }
    try {
      await writeManagedModelsYml(agentDir, OPTIONS);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(readdirSync(agentDir)).toEqual(["models.yml"]);
    expect(readFileSync(keepPath, "utf8")).toBe("unrelated-keep");

    const bytes = readFileSync(join(agentDir, "models.yml"));
    const text = bytes.toString("utf8");
    expect(parse(text)).toEqual(expectedDocument(PROXY_BASE_URL, MODEL_ID));
    expect(text).toMatch(/^providers:\s*$/m);
    expect(text).toMatch(/^ {2}workbuddy:\s*$/m);
    expect(text).not.toMatch(/^providers:\s*[[{]/m);
    expect(bytes.includes(Buffer.from("authHeader"))).toBe(false);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
    }
  });

  it("rejects a missing or file-occupied agentDir without creating any directory", async () => {
    const root = tempRoot();
    const agentDir = join(root, "absent", "nested", "agent");
    await expect(writeManagedModelsYml(agentDir, OPTIONS)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(writeManagedModelsYml(join(root, "absent"), OPTIONS)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(readdirSync(root)).toEqual([]);

    const occupied = join(root, "occupied");
    writeFileSync(occupied, "not-a-directory");
    await expect(writeManagedModelsYml(occupied, OPTIONS)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(readFileSync(occupied, "utf8")).toBe("not-a-directory");
    expect(readdirSync(root)).toEqual(["occupied"]);
  });

  it("identical options produce identical models.yml bytes", async () => {
    const agentDir = makeAgentDir();
    await writeManagedModelsYml(agentDir, OPTIONS);
    const first = readFileSync(join(agentDir, "models.yml"));
    await writeManagedModelsYml(agentDir, OPTIONS);
    expect(readFileSync(join(agentDir, "models.yml"))).toEqual(first);
    expect(parse(first.toString("utf8"))).toEqual(expectedDocument(PROXY_BASE_URL, MODEL_ID));
  });

  it("changed options replace stale content and preserve YAML-sensitive model identity", async () => {
    const agentDir = makeAgentDir();
    await writeManagedModelsYml(agentDir, OPTIONS);
    writeFileSync(join(agentDir, "models.yml"), "providers:\n  obsolete: true\n");
    writeFileSync(join(agentDir, "keep.txt"), "unrelated-keep");

    await writeManagedModelsYml(agentDir, singleModel(PROXY_BASE_URL, YAML_SENSITIVE_MODEL_ID));
    expect(parse(readFileSync(join(agentDir, "models.yml"), "utf8"))).toEqual(
      expectedDocument(PROXY_BASE_URL, YAML_SENSITIVE_MODEL_ID),
    );
    expect(readdirSync(agentDir).toSorted()).toEqual(["keep.txt", "models.yml"]);

    await writeManagedModelsYml(
      agentDir,
      singleModel(NEXT_PROXY_BASE_URL, YAML_SENSITIVE_MODEL_ID),
    );
    expect(parse(readFileSync(join(agentDir, "models.yml"), "utf8"))).toEqual(
      expectedDocument(NEXT_PROXY_BASE_URL, YAML_SENSITIVE_MODEL_ID),
    );
    expect(readFileSync(join(agentDir, "keep.txt"), "utf8")).toBe("unrelated-keep");
  });

  it("leaves a pre-existing 0755 agent directory unchanged while writing models.yml", async () => {
    const root = tempRoot();
    const agentDir = join(root, "existing", "agent");
    mkdirSync(agentDir, { recursive: true });
    chmodSync(join(root, "existing"), 0o755);
    chmodSync(agentDir, 0o755);
    const umaskBefore = process.umask();
    await writeManagedModelsYml(agentDir, OPTIONS);
    expect(lstatSync(join(root, "existing")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(agentDir).mode & 0o7777).toBe(0o755);
    expect(process.umask()).toBe(umaskBefore);
    expect(parse(readFileSync(join(agentDir, "models.yml"), "utf8"))).toEqual(
      expectedDocument(PROXY_BASE_URL, MODEL_ID),
    );
  });

  it("rejects when a regular file occupies a needed directory path and leaves unrelated files unchanged", async () => {
    const root = tempRoot();
    const blocked = join(root, "blocked");
    const keepPath = join(root, "keep.txt");
    writeFileSync(blocked, "untouched-ancestor");
    writeFileSync(keepPath, "unrelated-keep");

    await expect(writeManagedModelsYml(join(blocked, "agent"), OPTIONS)).rejects.toThrow();

    expect(readFileSync(blocked, "utf8")).toBe("untouched-ancestor");
    expect(statSync(blocked).isFile()).toBe(true);
    expect(readFileSync(keepPath, "utf8")).toBe("unrelated-keep");
    expect(readdirSync(root).toSorted()).toEqual(["blocked", "keep.txt"]);
  });

  it("rejects when models.yml is a directory and leaves unrelated files unchanged", async () => {
    const agentDir = join(tempRoot(), "agent");
    mkdirSync(join(agentDir, "models.yml"), { recursive: true });
    const keepPath = join(agentDir, "keep.txt");
    writeFileSync(keepPath, "unrelated-keep");

    await expect(writeManagedModelsYml(agentDir, OPTIONS)).rejects.toThrow();

    expect(statSync(join(agentDir, "models.yml")).isDirectory()).toBe(true);
    expect(readFileSync(keepPath, "utf8")).toBe("unrelated-keep");
    expect(readdirSync(agentDir).toSorted()).toEqual(["keep.txt", "models.yml"]);
  });

  it.each([0o000, 0o077])(
    "replaces a planted symlink with a 0640 regular file under umask %o",
    async (umask) => {
      const root = tempRoot();
      const agentDir = join(root, "agent");
      const outside = join(root, "outside.yml");
      mkdirSync(agentDir);
      writeFileSync(outside, "outside-untouched");
      symlinkSync(outside, join(agentDir, "models.yml"));

      const previousUmask = process.umask(umask);
      try {
        await writeManagedModelsYml(agentDir, OPTIONS);
      } finally {
        process.umask(previousUmask);
      }

      const stat = lstatSync(join(agentDir, "models.yml"));
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o7777).toBe(0o640);
      expect(parse(readFileSync(join(agentDir, "models.yml"), "utf8"))).toEqual(
        expectedDocument(PROXY_BASE_URL, MODEL_ID),
      );
      expect(readFileSync(outside, "utf8")).toBe("outside-untouched");
      expect(readdirSync(agentDir)).toEqual(["models.yml"]);
    },
  );

  it.each([0o000, 0o077])(
    "writes models.yml with mode 0640 under umask %o, fresh and over a 0666 file",
    async (umask) => {
      const agentDir = makeAgentDir();
      const target = join(agentDir, "models.yml");

      const previousUmask = process.umask(umask);
      try {
        await writeManagedModelsYml(agentDir, OPTIONS);
        expect(lstatSync(target).mode & 0o7777).toBe(0o640);
        chmodSync(target, 0o666);
        await writeManagedModelsYml(agentDir, OPTIONS);
      } finally {
        process.umask(previousUmask);
      }

      expect(lstatSync(target).mode & 0o7777).toBe(0o640);
      expect(readdirSync(agentDir)).toEqual(["models.yml"]);
    },
  );

  it("rejects and leaves no temporary file when the rename over models.yml fails", async () => {
    const agentDir = join(tempRoot(), "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.yml"), "previous-content");
    const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const rename = vi.spyOn(fsp, "rename").mockRejectedValue(failure);
    syncBuiltinESMExports();
    try {
      await expect(writeManagedModelsYml(agentDir, OPTIONS)).rejects.toBe(failure);

      expect(rename).toHaveBeenCalledTimes(1);
      const [source, target] = rename.mock.calls[0] ?? [];
      expect(target).toBe(join(agentDir, "models.yml"));
      expect(dirname(String(source))).toBe(agentDir);
      expect(basename(String(source)).startsWith(".")).toBe(true);
      expect(basename(String(source))).toContain(String(process.pid));
    } finally {
      rename.mockRestore();
      syncBuiltinESMExports();
    }
    expect(readdirSync(agentDir)).toEqual(["models.yml"]);
    expect(readFileSync(join(agentDir, "models.yml"), "utf8")).toBe("previous-content");
  });

  it("several models are written one entry each in whitelist order, thinking before input", async () => {
    const agentDir = makeAgentDir();
    const target = join(agentDir, "models.yml");
    const several = { proxyBaseUrl: PROXY_BASE_URL, models: THREE_MODELS };

    await writeManagedModelsYml(agentDir, several);
    const first = readFileSync(target);
    expect(first.toString("utf8")).toBe(THREE_MODELS_YAML);
    expect(parse(first.toString("utf8"))).toEqual(THREE_MODELS_DOCUMENT);
    await writeManagedModelsYml(agentDir, several);
    expect(readFileSync(target).equals(first)).toBe(true);

    await writeManagedModelsYml(agentDir, { proxyBaseUrl: PROXY_BASE_URL, models: [M2] });
    const text = readFileSync(target, "utf8");
    expect(text).toBe(plainYaml(PROXY_BASE_URL, "m2"));
    for (const stale of ["m1", "m3", "通用", "深度", "thinking", "input", "reasoning"]) {
      expect(text).not.toContain(stale);
    }
    expect(readdirSync(agentDir)).toEqual(["models.yml"]);
  });

  it.each([
    [true, reasoningYaml(PROXY_BASE_URL, MODEL_ID)],
    [false, plainYaml(PROXY_BASE_URL, MODEL_ID)],
  ])(
    "single-model output without MODEL_CATALOG is byte-identical to the pre-change file (reasoning %s)",
    async (reasoning, before) => {
      const agentDir = makeAgentDir();
      await writeManagedModelsYml(agentDir, {
        proxyBaseUrl: PROXY_BASE_URL,
        models: [{ id: MODEL_ID, name: MODEL_ID, reasoning, vision: false }],
      });
      expect(readFileSync(join(agentDir, "models.yml")).equals(Buffer.from(before, "utf8"))).toBe(
        true,
      );
    },
  );

  it("rejects an empty whitelist and leaves the existing models.yml and agentDir untouched", async () => {
    const agentDir = makeAgentDir();
    const target = join(agentDir, "models.yml");
    await writeManagedModelsYml(agentDir, OPTIONS);
    const before = readFileSync(target);
    const statBefore = lstatSync(target);

    await expect(
      writeManagedModelsYml(agentDir, { proxyBaseUrl: NEXT_PROXY_BASE_URL, models: [] }),
    ).rejects.toThrow();

    expect(readFileSync(target).equals(before)).toBe(true);
    expect(lstatSync(target).ino).toBe(statBefore.ino);
    expect(readdirSync(agentDir)).toEqual(["models.yml"]);

    const empty = makeAgentDir();
    await expect(
      writeManagedModelsYml(empty, { proxyBaseUrl: PROXY_BASE_URL, models: [] }),
    ).rejects.toThrow();
    expect(readdirSync(empty)).toEqual([]);
  });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "models-yml-"));
  tmpDirs.push(dir);
  return dir;
}

/** The writer never creates agentDir (the managed omp state layout does). */
function makeAgentDir(): string {
  const agentDir = join(tempRoot(), "agent");
  mkdirSync(agentDir);
  return agentDir;
}

function expectedDocument(proxyBaseUrl: string, modelId: string): unknown {
  return {
    providers: {
      workbuddy: {
        api: "openai-completions",
        baseUrl: proxyBaseUrl,
        apiKey: "WORKBUDDY_MODEL_TOKEN",
        models: [
          {
            id: modelId,
            name: modelId,
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  };
}
