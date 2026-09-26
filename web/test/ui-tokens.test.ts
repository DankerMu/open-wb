import { describe, expect, it } from "vitest";
import { blockBody, listRepoFiles, readRepoFile, stripComments } from "./ui-support.js";

const DEMO = "resource/workbuddy-live-demo.html";
const TOKENS = "web/src/styles/tokens.css";
const LIGHT = /:root\s*\{/;
const DARK = /\[data-theme="dark"\]\s*\{/;

/** design.md 归一化：只消格式差异（空白/折行、分隔符两侧空格、hex 大小写、数字前导零与尾零）。 */
function normalizeValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([,():])\s*/g, "$1")
    .replace(/#[0-9a-fA-F]+/g, (hex) => hex.toLowerCase())
    .replace(/\d*\.\d+/g, (number) => String(Number(number)));
}

type Declaration = [name: string, value: string];

function declarations(css: string, opener: RegExp): Declaration[] {
  return blockBody(stripComments(css), opener)
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const colon = chunk.indexOf(":");
      return [chunk.slice(0, colon).trim(), normalizeValue(chunk.slice(colon + 1))];
    });
}

function tokenMap(css: string, opener: RegExp): Map<string, string> {
  const list = declarations(css, opener);
  const names = list.map(([name]) => name);
  expect(new Set(names).size, "块内变量名不得重复").toBe(names.length);
  return new Map(list);
}

/** demo 引用但未定义、本仓补定的六个变量（design.md "Must add/change"）。 */
const GAP_SHARED: Declaration[] = [
  ["--wb-palette-black-60", "rgba(0,0,0,.6)"],
  ["--wb-palette-white-10", "rgba(255,255,255,.1)"],
  ["--wb-palette-white-20", "rgba(255,255,255,.2)"],
  ["--wb-palette-white-60", "rgba(255,255,255,.6)"],
  ["--wb-text-white", "var(--wb-palette-white-100)"],
];
const GAP_LIGHT: Declaration[] = [
  ...GAP_SHARED,
  ["--wb-home-composer-chip-bg-hover", "var(--wb-palette-gray-3)"],
];
const GAP_DARK: Declaration[] = [
  ...GAP_SHARED,
  ["--wb-home-composer-chip-bg-hover", "var(--wb-bg-hover)"],
];

function expectedBlock(opener: RegExp, gaps: Declaration[]): Map<string, string> {
  const expected = tokenMap(readRepoFile(DEMO), opener);
  const heading = expected.get("--wb-font-heading");
  if (heading !== undefined) {
    expect(heading.startsWith("Poppins,")).toBe(true);
    expected.set("--wb-font-heading", heading.slice("Poppins,".length));
  }
  for (const [name, value] of gaps) {
    expect(expected.has(name), `${name} 不应已在 demo 定义`).toBe(false);
    expected.set(name, normalizeValue(value));
  }
  return expected;
}

function sorted(map: Map<string, string>): [string, string][] {
  return [...map].sort(([left], [right]) => left.localeCompare(right));
}

describe("normalizeValue", () => {
  it("只消格式差异", () => {
    expect(normalizeValue("rgba(0, 0, 0, 0.9)")).toBe(normalizeValue("rgba(0,0,0,.9)"));
    expect(normalizeValue("rgba(15, 23, 42, 0.1)")).toBe(normalizeValue("rgba(15,23,42,.10)"));
    expect(normalizeValue("#DFF7F2")).toBe(normalizeValue("#dff7f2"));
    expect(normalizeValue("\n    a, b,\n    c")).toBe(normalizeValue("a,b,c"));
  });

  it("不吞值差异", () => {
    expect(normalizeValue("#dff7f3")).not.toBe(normalizeValue("#DFF7F2"));
    expect(normalizeValue("rgba(0,0,0,.09)")).not.toBe(normalizeValue("rgba(0,0,0,.9)"));
    expect(normalizeValue("BlinkMacSystemFont")).not.toBe(normalizeValue("Poppins"));
  });
});

describe("tokens.css 对照 demo", () => {
  it.each([
    ["浅色 :root", LIGHT, GAP_LIGHT],
    ["深色 [data-theme=dark]", DARK, GAP_DARK],
  ])("%s 块逐名逐值相等（名集合 = demo ∪ 六个补定名）", (_label, opener, gaps) => {
    const expected = expectedBlock(opener, gaps);
    expect(expected.size).toBeGreaterThan(80);
    expect(sorted(tokenMap(readRepoFile(TOKENS), opener))).toEqual(sorted(expected));
  });

  it("六个补定变量为固定值", () => {
    const tokens = readRepoFile(TOKENS);
    const light = tokenMap(tokens, LIGHT);
    const dark = tokenMap(tokens, DARK);
    for (const [name, value] of GAP_LIGHT) expect(light.get(name)).toBe(normalizeValue(value));
    for (const [name, value] of GAP_DARK) expect(dark.get(name)).toBe(normalizeValue(value));
  });

  it("--wb-font-heading 不含公网字体", () => {
    const tokens = readRepoFile(TOKENS);
    expect(tokenMap(tokens, LIGHT).get("--wb-font-heading")).not.toMatch(/Poppins/);
    expect(tokens).not.toMatch(/@import|fonts\.googleapis/);
  });
});

describe("未定义引用守卫", () => {
  it("web/src/**/*.css 引用的每个 var(--wb-*) 都在 tokens.css 定义", () => {
    const tokens = readRepoFile(TOKENS);
    const defined = new Set([...tokenMap(tokens, LIGHT).keys(), ...tokenMap(tokens, DARK).keys()]);
    const undefinedRefs = listRepoFiles("web/src", (path) => path.endsWith(".css")).flatMap(
      (path) =>
        [...readRepoFile(path).matchAll(/var\(\s*(--wb-[a-z0-9-]+)/g)]
          .map(([, name = ""]) => name)
          .filter((name) => !defined.has(name))
          .map((name) => `${path}: ${name}`),
    );
    expect(undefinedRefs).toEqual([]);
  });
});

describe("外壳页面底色（#420）", () => {
  // 只锚顶层基础规则（行首选择器），@media 内缩进的同名规则不算。
  const styles = stripComments(readRepoFile("web/src/styles.css"));
  const files = stripComments(readRepoFile("web/src/features/files/files.css"));

  it("body 是唯一页面底色来源：var(--wb-home-bg-secondary)（demo:195）", () => {
    expect(blockBody(styles, /^body \{/m)).toContain("background: var(--wb-home-bg-secondary);");
  });

  it.each([
    [".app-shell", styles, /^\.app-shell \{/m],
    [".app-content > main", styles, /^\.app-content > main \{/m],
    [".files-layout", files, /^\.files-layout \{/m],
    [".files-preview", files, /^\.files-preview \{/m],
  ])("%s 不自涂底色（demo:210-213、666、702）", (_selector, css, opener) => {
    expect(blockBody(css, opener)).not.toMatch(/\bbackground[\w-]*\s*:/);
  });
});
