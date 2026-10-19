/**
 * Issue #1261（change s1-followups-batch 任务 4.1）：`MODEL_ID` 的取值规则，纯配置 seam。
 * 期望值逐条取自 http-service-skeleton「服务启动与装配」的条文与场景「MODEL_ID 的取值规则」，
 * 不引用源码常量。编译入口上的一例在 `server-startup-model-id.test.ts`。
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveServerConfig } from "../src/server.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SOURCE_ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const CATALOG = '[{"id":"m1"},{"id":"m2","reasoning":true,"efforts":["low","high"]}]';

/** 每个字 3 个 UTF-8 字节：上限按字节数而不是按字符数时，下面两个值才分居两侧。 */
const WIDE = "模";
/** 42 × 3 + 2 = 128 字节，44 个 UTF-16 码元。 */
const BYTES_128 = `${WIDE.repeat(42)}ab`;
/** 43 × 3 = 129 字节，43 个 UTF-16 码元——比上一个还少一个字符。 */
const BYTES_129 = WIDE.repeat(43);

/** 规格场景点名的四个非法取值：标签 → 取值。 */
const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  ["含换行 U+000A", "a\nb"],
  ["含 U+007F", "a\u007fb"],
  ["129 个 UTF-8 字节", BYTES_129],
];

function messageOf(env: Record<string, string>): string {
  try {
    resolveServerConfig(env, SOURCE_ENTRY);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected the configuration to be rejected");
}

function expectNamesModelIdOnly(message: string, raw: string): void {
  expect(message).toContain("MODEL_ID");
  expect(message).not.toContain("MODEL_CATALOG");
  // 空串是任何字符串的子串，这一行的「不含取值」无从断言。
  if (raw !== "") {
    expect(message).not.toContain(raw);
  }
}

describe("resolveServerConfig — MODEL_ID 的取值规则（#1261）", () => {
  it("夹具的字节数与规格的边界一致", () => {
    expect(Buffer.byteLength(BYTES_128, "utf8")).toBe(128);
    expect(Buffer.byteLength(BYTES_129, "utf8")).toBe(129);
    expect(BYTES_129.length).toBeLessThan(BYTES_128.length);
  });

  it.each(REJECTED)(
    "未设 MODEL_CATALOG：%s 是配置错误，点名 MODEL_ID 且不回显取值",
    (_label, raw) => {
      expectNamesModelIdOnly(messageOf({ MODEL_ID: raw }), raw);
    },
  );

  it.each(REJECTED)(
    "配置了合法 MODEL_CATALOG：%s 仍是配置错误，点名 MODEL_ID 且不回显取值",
    (_label, raw) => {
      expectNamesModelIdOnly(messageOf({ MODEL_CATALOG: CATALOG, MODEL_ID: raw }), raw);
    },
  );

  it("message 只由键与规则决定：四个非法取值、有无白名单，都是同一句", () => {
    const messages = REJECTED.flatMap(([, raw]) => [
      messageOf({ MODEL_ID: raw }),
      messageOf({ MODEL_CATALOG: CATALOG, MODEL_ID: raw }),
    ]);
    expect(new Set(messages).size).toBe(1);
  });

  it.each([
    ["恰 128 个 UTF-8 字节", BYTES_128],
    ["首尾各一个空格", " custom-model "],
    // design D14-2：裁决只列空串、控制字符、超长，纯空白不拒。
    ["只有一个空格", " "],
  ])("%s 的取值通过，白名单唯一一项的 id 与 name 逐字节等于它", (_label, raw) => {
    expect(resolveServerConfig({ MODEL_ID: raw }, SOURCE_ENTRY).modelCatalog).toStrictEqual({
      models: [{ id: raw, name: raw, reasoning: true, vision: false, maxTokens: 32768 }],
      defaultModelId: raw,
    });
  });

  it("未设置时仍取缺省，不受这条规则影响", () => {
    expect(resolveServerConfig({}, SOURCE_ENTRY).modelCatalog.defaultModelId).toBe(
      "deepseek-v4.1-flash",
    );
  });
});
