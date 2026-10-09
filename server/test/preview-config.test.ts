/**
 * Issue #1054：十二个预览与文件键经同一纯配置 seam 解析（http-service-skeleton「服务启动与装配」，
 * 场景「预览与文件键的缺省与覆盖」的解析部分、「预览与文件键的非法值」、
 * 「Pure source and compiled configuration identity」的十二键部分）。
 * 期望值取自规格与实施注记的字面量，不引用源码常量；编译入口的同一张非法值表在
 * `omp-max-processes-config.test.ts`。
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveServerConfig, type ServerConfig } from "../src/server.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const DIST_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "dist", "server.js")).href;

/** 八个数值键：键、字段、规格缺省值、覆盖用例取的非缺省值。 */
const NUMERIC = [
  ["OFFICE_CONVERT_TIMEOUT_MS", "officeConvertTimeoutMs", 60_000, 1_500],
  ["OFFICE_CONVERT_CONCURRENCY", "officeConvertConcurrency", 2, 5],
  ["PREVIEW_TEXT_MAX_BYTES", "previewTextMaxBytes", 1_048_576, 4_096],
  ["PREVIEW_IMAGE_MAX_BYTES", "previewImageMaxBytes", 20_971_520, 8_192],
  ["PREVIEW_DOCUMENT_MAX_BYTES", "previewDocumentMaxBytes", 104_857_600, 16_384],
  ["PREVIEW_NOTEBOOK_MAX_BYTES", "previewNotebookMaxBytes", 10_485_760, 32_768],
  ["PREVIEW_ARCHIVE_MAX_ENTRIES", "previewArchiveMaxEntries", 1_000, 7],
  ["TRASH_RETENTION_DAYS", "trashRetentionDays", 30, 3],
] as const;
const NUMERIC_KEYS = NUMERIC.map(([key]) => key);

/** 十二个键各自的非缺省取值与它在 `ServerConfig` 上的字段、解析结果。 */
const OVERRIDES: readonly (readonly [string, string, string, string | number])[] = [
  ["PREVIEW_PORT", "18123", "previewPort", 18_123],
  [
    "PREVIEW_ORIGIN",
    "https://preview.example.test",
    "previewOrigin",
    "https://preview.example.test",
  ],
  ["PREVIEW_CACHE_DIR", "cache/p", "previewCacheDir", join(REPO_ROOT, "cache", "p")],
  // 绝对路径原样保留：不绑 repo root，也不规范化。
  ["OFFICE_BIN", "/opt/x/../soffice", "officeBin", "/opt/x/../soffice"],
  ...NUMERIC.map(([key, field, , value]) => [key, String(value), field, value] as const),
];
const FIELDS = OVERRIDES.map(([, , field]) => field);
const OVERRIDE_ENV = Object.fromEntries(OVERRIDES.map(([key, raw]) => [key, raw]));
const OVERRIDE_FIELDS = Object.fromEntries(OVERRIDES.map(([, , field, value]) => [field, value]));

const DEFAULT_FIELDS = {
  previewPort: 0,
  previewCacheDir: join(REPO_ROOT, "var", "preview-cache"),
  officeConvertTimeoutMs: 60_000,
  officeConvertConcurrency: 2,
  previewTextMaxBytes: 1_048_576,
  previewImageMaxBytes: 20_971_520,
  previewDocumentMaxBytes: 104_857_600,
  previewNotebookMaxBytes: 10_485_760,
  previewArchiveMaxEntries: 1_000,
  trashRetentionDays: 30,
};

const CANONICAL = "must be a canonical ASCII decimal";
const POSITIVE_RANGE = "must be within 1..2147483647";
const PORT_RANGE = "must be within 0..65535";
const ORIGIN_RULE = "must be a scheme and authority only";
const NOT_EMPTY = "must not be empty";
const ABSOLUTE = "must be an absolute path";

/** 规格场景「预览与文件键的非法值」逐键逐值：6 + 5 + 1 + 2 + 8×7 = 70 例，每例带完整的期望句尾。 */
const SPEC_INVALID: readonly (readonly [string, string, string])[] = [
  ["PREVIEW_PORT", "", CANONICAL],
  ["PREVIEW_PORT", "abc", CANONICAL],
  ["PREVIEW_PORT", "-1", CANONICAL],
  ["PREVIEW_PORT", "65536", PORT_RANGE],
  ["PREVIEW_PORT", "01", CANONICAL],
  ["PREVIEW_PORT", "1.5", CANONICAL],
  ["PREVIEW_ORIGIN", "", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "preview.example.test", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "https://a.test/", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "https://a.test/x", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "ftp://a.test", ORIGIN_RULE],
  ["PREVIEW_CACHE_DIR", "", NOT_EMPTY],
  ["OFFICE_BIN", "", ABSOLUTE],
  ["OFFICE_BIN", "soffice", ABSOLUTE],
  ...NUMERIC_KEYS.flatMap((key) =>
    (
      [
        ["", CANONICAL],
        ["0", POSITIVE_RANGE],
        ["abc", CANONICAL],
        ["-1", CANONICAL],
        ["1.5", CANONICAL],
        ["016", CANONICAL],
        ["2147483648", POSITIVE_RANGE],
      ] as const
    ).map(([raw, rule]) => [key, raw, rule] as const),
  ),
];

/** 规格之外补的取值：空白、符号、指数、大小写、查询串、片段、换行与相对路径的另两种写法。 */
const EXTRA_INVALID: readonly (readonly [string, string, string])[] = [
  ["PREVIEW_PORT", " 1", CANONICAL],
  ["PREVIEW_PORT", "+1", CANONICAL],
  ["PREVIEW_PORT", "1e2", CANONICAL],
  ["PREVIEW_PORT", "00", CANONICAL],
  ["PREVIEW_ORIGIN", "https://", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "HTTPS://a.test", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", " https://a.test", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "https://a.test?x", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "https://a.test#f", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "https://a.test\n", ORIGIN_RULE],
  ["PREVIEW_ORIGIN", "https://a b", ORIGIN_RULE],
  ["OFFICE_BIN", "./soffice", ABSOLUTE],
  ["OFFICE_BIN", "bin/soffice", ABSOLUTE],
];

function configOf(env: Record<string, string | undefined>, entry = SOURCE_ENTRY): ServerConfig {
  return resolveServerConfig(env, entry);
}

/** 只取十二个字段里对象自身带有的那些（缺席的可选键不出现）。 */
function previewFieldsOf(config: ServerConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([field]) => FIELDS.includes(field)));
}

function thrownMessage(key: string, raw: string): string {
  try {
    resolveServerConfig({ [key]: raw }, SOURCE_ENTRY);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`resolver accepted ${key}=${JSON.stringify(raw)}`);
}

/** 整句相等（与输入无关）、命名该键、不含输入值（空串无从断言）。 */
function expectKeyOnlyMessage(key: string, raw: string, rule: string): void {
  const message = thrownMessage(key, raw);
  expect(message).toBe(`${key} ${rule}`);
  expect(message).toContain(key);
  if (raw.length > 0) {
    expect(message).not.toContain(raw);
  }
}

describe("resolveServerConfig — 预览与文件键的缺省", () => {
  it("未设置时十二个字段逐个取规格缺省值，两个可选键不出现", () => {
    const config = configOf({});

    expect(config.previewPort).toBe(0);
    expect(config.previewOrigin).toBeUndefined();
    expect(config.previewCacheDir).toBe(join(REPO_ROOT, "var", "preview-cache"));
    expect(config.officeBin).toBeUndefined();
    expect(config.officeConvertTimeoutMs).toBe(60_000);
    expect(config.officeConvertConcurrency).toBe(2);
    expect(config.previewTextMaxBytes).toBe(1_048_576);
    expect(config.previewImageMaxBytes).toBe(20_971_520);
    expect(config.previewDocumentMaxBytes).toBe(104_857_600);
    expect(config.previewNotebookMaxBytes).toBe(10_485_760);
    expect(config.previewArchiveMaxEntries).toBe(1_000);
    expect(config.trashRetentionDays).toBe(30);
    expect(Object.hasOwn(config, "previewOrigin")).toBe(false);
    expect(Object.hasOwn(config, "officeBin")).toBe(false);
  });

  it("十二个键显式为 undefined 与未设置同一结果", () => {
    const explicit = configOf(Object.fromEntries(OVERRIDES.map(([key]) => [key, undefined])));

    expect(explicit).toEqual(configOf({}));
    expect(Object.hasOwn(explicit, "previewOrigin")).toBe(false);
    expect(Object.hasOwn(explicit, "officeBin")).toBe(false);
  });
});

describe("resolveServerConfig — 预览与文件键的覆盖", () => {
  it("十二个键全给非缺省值：逐项原样生效，与缺省不同的字段恰为这十二个", () => {
    const base: Record<string, unknown> = { ...configOf({}) };
    const config: Record<string, unknown> = { ...configOf(OVERRIDE_ENV) };

    expect(previewFieldsOf(configOf(OVERRIDE_ENV))).toEqual(OVERRIDE_FIELDS);
    const changed = [...new Set([...Object.keys(base), ...Object.keys(config)])].filter(
      (field) => JSON.stringify(base[field]) !== JSON.stringify(config[field]),
    );
    expect(changed.sort()).toEqual([...FIELDS].sort());
    expect(FIELDS).toHaveLength(12);
  });

  it.each(OVERRIDES)("只给 %s=%j 时 %s 生效，其余十一项仍为缺省", (key, raw, field, value) => {
    expect(configOf({ [key]: raw })).toEqual({ ...configOf({}), [field]: value });
  });

  it.each([
    ["0", 0],
    ["1", 1],
    ["65535", 65_535],
  ])("PREVIEW_PORT 接受显式 %s", (raw, expected) => {
    expect(configOf({ PREVIEW_PORT: raw }).previewPort).toBe(expected);
  });

  it.each(NUMERIC)("%s 接受下界 1 与上界 2147483647", (key, field) => {
    expect(configOf({ [key]: "1" })[field]).toBe(1);
    expect(configOf({ [key]: "2147483647" })[field]).toBe(2_147_483_647);
  });

  it.each(["http://127.0.0.1:8080", "https://[::1]:9443"])("PREVIEW_ORIGIN 接受 %s", (raw) => {
    expect(configOf({ PREVIEW_ORIGIN: raw }).previewOrigin).toBe(raw);
  });

  it("PREVIEW_CACHE_DIR 的绝对路径原样保留", () => {
    const absolute = join(tmpdir(), "preview-cache-elsewhere");
    expect(configOf({ PREVIEW_CACHE_DIR: absolute }).previewCacheDir).toBe(absolute);
  });
});

describe("resolveServerConfig — 预览与文件键的非法值", () => {
  it("规格列出的非法取值共七十例", () => {
    expect(SPEC_INVALID).toHaveLength(70);
  });

  it.each(SPEC_INVALID)("拒绝 %s=%j，消息只命名键且不含输入值", (key, raw, rule) => {
    expectKeyOnlyMessage(key, raw, rule);
  });

  it.each(EXTRA_INVALID)("规格之外：拒绝 %s=%j，消息只命名键且不含输入值", (key, raw, rule) => {
    expectKeyOnlyMessage(key, raw, rule);
  });
});

describe("resolveServerConfig — 预览与文件键的 source / compiled 身份", () => {
  it("两种 entry URL 在别的 cwd 下得到同一组缺省与覆盖", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      for (const entry of [SOURCE_ENTRY, DIST_ENTRY]) {
        expect(previewFieldsOf(configOf({}, entry))).toEqual(DEFAULT_FIELDS);
        expect(previewFieldsOf(configOf(OVERRIDE_ENV, entry))).toEqual(OVERRIDE_FIELDS);
      }
      expect(configOf(OVERRIDE_ENV, DIST_ENTRY)).toEqual(configOf(OVERRIDE_ENV, SOURCE_ENTRY));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
