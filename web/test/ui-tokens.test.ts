import { describe, expect, it } from "vitest";
import { blockBody, listRepoFiles, readRepoFile, stripComments } from "./ui-support.js";

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

describe("tokens.css", () => {
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

describe("文件页不自涂底色（#420）", () => {
  // 只锚顶层基础规则（行首选择器），@media 内缩进的同名规则不算。页面底色只来自 body
  // （theme.css 的 --background；计算值由 ui-walk 断言）。
  const files = stripComments(readRepoFile("web/src/features/files/files.css"));

  it.each([
    [".files-layout", /^\.files-layout \{/m],
    [".files-preview", /^\.files-preview \{/m],
  ])("%s 不自涂底色（demo:666、702）", (_selector, opener) => {
    expect(blockBody(files, opener)).not.toMatch(/\bbackground[\w-]*\s*:/);
  });
});
