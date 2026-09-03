import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveServerConfig, type ServerConfig } from "../src/server.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const DIST_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "dist", "server.js")).href;
const DEFAULT_DB_PATH = join(REPO_ROOT, "var", "dev.db");
const DEFAULT_STATIC_ROOT = join(REPO_ROOT, "web", "dist");

function expectInvalid(patch: Record<string, string>): void {
  expect(() => resolveServerConfig(patch, SOURCE_ENTRY)).toThrow();
}

describe("resolveServerConfig — 缺省身份", () => {
  it("source 与 compiled entry URL 形状得到同一组缺省", () => {
    const fromSource = resolveServerConfig({}, SOURCE_ENTRY);
    const fromDist = resolveServerConfig({}, DIST_ENTRY);

    expect(fromSource).toEqual({
      host: "127.0.0.1",
      port: 3000,
      dbPath: DEFAULT_DB_PATH,
      staticRoot: DEFAULT_STATIC_ROOT,
      repoRoot: REPO_ROOT,
    });
    expect(fromDist).toEqual(fromSource);
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
      { HOST: "127.0.0.1", PORT: "3000", DB_PATH: "var/dev.db", STATIC_ROOT: "web/dist" },
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

describe("配置 seam 只输出四个自有 key 的投影", () => {
  it("返回值恰好是 host/port/dbPath/staticRoot/repoRoot", () => {
    const config = resolveServerConfig({}, SOURCE_ENTRY);
    expect(Object.keys(config).sort()).toEqual(
      ["dbPath", "host", "port", "repoRoot", "staticRoot"].sort(),
    );
  });

  it("类型面：ServerConfig 形状可用于消费方", () => {
    const config: ServerConfig = resolveServerConfig({}, SOURCE_ENTRY);
    expect(config.port).toBeTypeOf("number");
    expect(config.host).toBeTypeOf("string");
  });
});
