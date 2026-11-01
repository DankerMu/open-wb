/**
 * s2a-kb-ragflow tasks 4.3（#1839）：四个知识库键经纯配置 seam `resolveServerConfig` 的解析（http-service-skeleton
 * 「服务启动与装配」的知识库键，design D3）。期望值是规格的字面量，不从 `src/` 导入。错误 message 只点名键：
 * 每个非法值都带哨兵，断言 message 含键名、不含哨兵。入口层的失败记录在 `server-startup-kb.test.ts`。
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveServerConfig } from "../src/server.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const SENTINEL = "kbsentinel1839";
const BASE_URL = "http://kb.intra:9380";
const KEY_FILE = "/etc/open-wb/ragflow.key";

function configOf(env: Record<string, string | undefined>) {
  return resolveServerConfig(env, SOURCE_ENTRY);
}

function failureOf(env: Record<string, string | undefined>): string {
  try {
    configOf(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected resolveServerConfig to throw");
}

describe("defaults", () => {
  it("nothing set: the knowledge base is off and the two upload limits take their defaults", () => {
    const config = configOf({});
    expect(config).not.toHaveProperty("ragflowBaseUrl");
    expect(config).not.toHaveProperty("ragflowApiKeyFile");
    expect(config.kbUploadMaxBytes).toBe(104_857_600);
    expect(config.kbUploadMaxFiles).toBe(10);
  });

  it("the workspace upload limits do not move the knowledge base limits", () => {
    const config = configOf({ UPLOAD_MAX_BYTES: "1", UPLOAD_MAX_FILES: "2" });
    expect(config.kbUploadMaxBytes).toBe(104_857_600);
    expect(config.kbUploadMaxFiles).toBe(10);
    expect(config.uploadMaxBytes).toBe(1);
    expect(config.uploadMaxFiles).toBe(2);
  });
});

describe("pairing of RAGFLOW_BASE_URL and RAGFLOW_API_KEY_FILE", () => {
  it("both set: both are taken as written, and the file is not read while parsing", () => {
    const missing = "/nonexistent/open-wb/ragflow.key";
    const config = configOf({ RAGFLOW_BASE_URL: BASE_URL, RAGFLOW_API_KEY_FILE: missing });
    expect(config.ragflowBaseUrl).toBe(BASE_URL);
    expect(config.ragflowApiKeyFile).toBe(missing);
  });

  it("the address without the key file names the key file", () => {
    expect(failureOf({ RAGFLOW_BASE_URL: `http://${SENTINEL}:9380` })).toBe(
      "RAGFLOW_API_KEY_FILE must be set together with RAGFLOW_BASE_URL",
    );
  });

  it("the key file without the address names the address", () => {
    expect(failureOf({ RAGFLOW_API_KEY_FILE: `/etc/${SENTINEL}` })).toBe(
      "RAGFLOW_BASE_URL must be set together with RAGFLOW_API_KEY_FILE",
    );
  });
});

describe("RAGFLOW_BASE_URL", () => {
  it.each([
    "http://h",
    "https://h",
    "http://127.0.0.1:9380",
    "http://[::1]:9380",
    "https://kb.intra:443",
  ])("accepts %s", (url) => {
    const env = { RAGFLOW_BASE_URL: url, RAGFLOW_API_KEY_FILE: KEY_FILE };
    expect(configOf(env).ragflowBaseUrl).toBe(url);
  });

  it.each([
    ["a path", `https://h/${SENTINEL}`],
    ["a trailing slash", `https://${SENTINEL}/`],
    ["a query", `https://h?${SENTINEL}`],
    ["a fragment", `https://h#${SENTINEL}`],
    ["whitespace", `https://${SENTINEL} h`],
    ["a trailing newline", `https://${SENTINEL}\n`],
    ["another scheme", `ftp://${SENTINEL}`],
    ["no scheme", SENTINEL],
  ])("refuses %s, naming only the key", (_label, url) => {
    const message = failureOf({ RAGFLOW_BASE_URL: url, RAGFLOW_API_KEY_FILE: KEY_FILE });
    expect(message).toContain("RAGFLOW_BASE_URL");
    expect(message).not.toContain(SENTINEL);
  });

  it("refuses an explicit empty value, also with the key file set", () => {
    const message = failureOf({ RAGFLOW_BASE_URL: "", RAGFLOW_API_KEY_FILE: KEY_FILE });
    expect(message).toContain("RAGFLOW_BASE_URL");
  });

  it.each(["https://u:p@h", "https://h@i:9380"])(
    "refuses the userinfo in %s, naming only the key (http-service-skeleton)",
    (url) => {
      const message = failureOf({ RAGFLOW_BASE_URL: url, RAGFLOW_API_KEY_FILE: KEY_FILE });
      expect(message).toContain("RAGFLOW_BASE_URL");
      expect(message).not.toContain(url);
      expect(message).not.toContain("@");
    },
  );

  it("PREVIEW_ORIGIN keeps its own rule: the same address stays legal there", () => {
    expect(configOf({ PREVIEW_ORIGIN: "https://u:p@h" }).previewOrigin).toBe("https://u:p@h");
  });
});

describe("RAGFLOW_API_KEY_FILE", () => {
  it.each([
    ["a relative path", `relative/${SENTINEL}`],
    ["a dot path", `./${SENTINEL}`],
    ["an explicit empty value", ""],
  ])("refuses %s, naming only the key", (_label, file) => {
    const message = failureOf({ RAGFLOW_BASE_URL: BASE_URL, RAGFLOW_API_KEY_FILE: file });
    expect(message).toBe("RAGFLOW_API_KEY_FILE must be an absolute path");
  });

  it("an explicit empty value without the address is refused too", () => {
    expect(failureOf({ RAGFLOW_API_KEY_FILE: "" })).toContain("RAGFLOW_API_KEY_FILE");
  });
});

describe.each([
  ["KB_UPLOAD_MAX_BYTES", "kbUploadMaxBytes"],
  ["KB_UPLOAD_MAX_FILES", "kbUploadMaxFiles"],
] as const)("%s", (key, field) => {
  it.each([
    ["1", 1],
    ["2147483647", 2_147_483_647],
  ])("takes %s", (raw, expected) => {
    expect(configOf({ [key]: raw })[field]).toBe(expected);
  });

  it.each([
    ["zero", "0"],
    ["a sign", "+5"],
    ["a negative", "-5"],
    ["a leading zero", "05"],
    ["a fraction", "1.5"],
    ["an exponent", "1e3"],
    ["surrounding space", " 5"],
    ["an explicit empty value", ""],
    ["above the upper bound", "2147483648"],
  ])("refuses %s, naming the key", (_label, raw) => {
    expect(failureOf({ [key]: raw })).toContain(key);
  });

  it("does not echo the value", () => {
    const message = failureOf({ [key]: SENTINEL });
    expect(message).toContain(key);
    expect(message).not.toContain(SENTINEL);
  });
});
