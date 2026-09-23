import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { deriveProxyBaseUrl, writeManagedModelsYml } from "../src/model-proxy/models-yml.js";

const PROXY_BASE_URL = "http://127.0.0.1:18016/v1";
const MODEL_ID = "deepseek-v4.1-flash";
const OPTIONS = { proxyBaseUrl: PROXY_BASE_URL, modelId: MODEL_ID };
const YAML_SENSITIVE_MODEL_ID = 'flash: "quoted"\nproviders:\n  injected: true # 中文';
const NEXT_PROXY_BASE_URL = "http://[::1]:18016/v1";
const SENTINELS = {
  MODEL_UPSTREAM_BASE_URL: "https://vendor-upstream.invalid/secret-path",
  MODEL_UPSTREAM_API_KEY: "parent-upstream-key-SENTINEL-89",
  WORKBUDDY_MODEL_TOKEN: "session-bearer-SENTINEL-89-token",
} as const;

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
  it("creates missing agentDir parents and writes the credential-safe workbuddy schema", async () => {
    const root = tempRoot();
    const agentDir = join(root, "absent", "nested", "agent");
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

    expect(statSync(join(root, "absent")).isDirectory()).toBe(true);
    expect(lstatSync(join(root, "absent")).mode & 0o7777).toBe(0o2770);
    expect(statSync(join(root, "absent", "nested")).isDirectory()).toBe(true);
    expect(lstatSync(join(root, "absent", "nested")).mode & 0o7777).toBe(0o2770);
    expect(statSync(agentDir).isDirectory()).toBe(true);
    expect(lstatSync(agentDir).mode & 0o7777).toBe(0o2770);
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

  it("identical options produce identical models.yml bytes", async () => {
    const agentDir = join(tempRoot(), "agent");
    await writeManagedModelsYml(agentDir, OPTIONS);
    const first = readFileSync(join(agentDir, "models.yml"));
    await writeManagedModelsYml(agentDir, OPTIONS);
    expect(readFileSync(join(agentDir, "models.yml"))).toEqual(first);
    expect(parse(first.toString("utf8"))).toEqual(expectedDocument(PROXY_BASE_URL, MODEL_ID));
  });

  it("changed options replace stale content and preserve YAML-sensitive model identity", async () => {
    const agentDir = join(tempRoot(), "agent");
    await writeManagedModelsYml(agentDir, OPTIONS);
    writeFileSync(join(agentDir, "models.yml"), "providers:\n  obsolete: true\n");
    writeFileSync(join(agentDir, "keep.txt"), "unrelated-keep");

    await writeManagedModelsYml(agentDir, {
      proxyBaseUrl: PROXY_BASE_URL,
      modelId: YAML_SENSITIVE_MODEL_ID,
    });
    expect(parse(readFileSync(join(agentDir, "models.yml"), "utf8"))).toEqual(
      expectedDocument(PROXY_BASE_URL, YAML_SENSITIVE_MODEL_ID),
    );
    expect(readdirSync(agentDir).toSorted()).toEqual(["keep.txt", "models.yml"]);

    await writeManagedModelsYml(agentDir, {
      proxyBaseUrl: NEXT_PROXY_BASE_URL,
      modelId: YAML_SENSITIVE_MODEL_ID,
    });
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
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "models-yml-"));
  tmpDirs.push(dir);
  return dir;
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
