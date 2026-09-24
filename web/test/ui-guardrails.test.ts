import { describe, expect, it } from "vitest";
import { blockBody, listRepoFiles, readRepoFile, stripComments } from "./ui-support.js";

/** 字面颜色与调色板引用；`(?![\w-])` 让 `#root`、`#fade-in` 这类 id 选择器不误中。 */
const COLOR_PATTERNS = [/#[0-9a-fA-F]{3,8}(?![\w-])/, /rgba?\(/, /--wb-palette-/];

function colorHits(text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => COLOR_PATTERNS.some((pattern) => pattern.test(line)))
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}

function hitsIn(paths: string[], find: (text: string) => string[]): string[] {
  return paths.flatMap((path) => find(readRepoFile(path)).map((hit) => `${path}:${hit}`));
}

describe("颜色 grep 守卫", () => {
  it("正则命中字面颜色与调色板，不误中 id 选择器", () => {
    expect(colorHits("#root { color: var(--wb-text-primary); }")).toEqual([]);
    expect(colorHits("#fade-in, #app-shell {}")).toEqual([]);
    expect(colorHits("color: #123456;")).toHaveLength(1);
    expect(colorHits("color: #FFF;")).toHaveLength(1);
    expect(colorHits("background: rgba(0,0,0,.5);")).toHaveLength(1);
    expect(colorHits("color: rgb(1 2 3);")).toHaveLength(1);
    expect(colorHits("color: var(--wb-palette-gray-3);")).toHaveLength(1);
  });

  it("features css/tsx 与 routes 无字面颜色与 --wb-palette-", () => {
    const features = listRepoFiles("web/src/features", (path) => /\.(css|tsx)$/.test(path));
    const routes = listRepoFiles("web/src/routes", () => true);
    expect(features.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(0);
    expect(hitsIn([...features, ...routes], colorHits)).toEqual([]);
  });

  it("web/src/ui/**/*.tsx 无内联 style={", () => {
    const ui = listRepoFiles("web/src/ui", (path) => path.endsWith(".tsx"));
    expect(ui.length).toBeGreaterThan(0);
    const inline = (text: string) =>
      text.split("\n").flatMap((line, index) => (line.includes("style={") ? [`${index + 1}`] : []));
    expect(hitsIn(ui, inline)).toEqual([]);
  });
});

describe("motion.css", () => {
  const UTILITIES = ["ui-fadein", "ui-pop", "ui-pulse", "ui-caret", "ui-spin"];
  const KEYFRAMES = ["wb-fadein", "wb-pop", "wb-pulse", "wb-caret", "wb-spin", "wb-drawer-in"];

  it("提供六组关键帧与五个工具类", () => {
    const motion = stripComments(readRepoFile("web/src/ui/motion.css"));
    for (const name of KEYFRAMES) expect(motion).toMatch(new RegExp(`@keyframes ${name}\\s*\\{`));
    for (const name of UTILITIES) {
      expect(motion).toMatch(
        new RegExp(`\\.${name}\\s*\\{[^}]*animation:\\s*wb-${name.slice(3)}\\b`),
      );
    }
    expect(motion).not.toMatch(/wb-float|wb-shimmer/);
  });

  it("reduced-motion 块把每个工具类置为 animation: none 与 transition: none", () => {
    const motion = stripComments(readRepoFile("web/src/ui/motion.css"));
    const reduced = blockBody(motion, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    const rules = [...reduced.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
      ([, selectors = "", body = ""]) => ({
        selectors: selectors.split(",").map((selector) => selector.trim()),
        body,
      }),
    );
    for (const name of UTILITIES) {
      const covering = rules.filter(
        (rule) =>
          rule.selectors.includes(`.${name}`) &&
          /animation:\s*none/.test(rule.body) &&
          /transition:\s*none/.test(rule.body),
      );
      expect(covering, name).not.toHaveLength(0);
    }
  });
});

describe("ATTRIBUTION.md", () => {
  it("登记 lucide（ISC）与 Radix UI Primitives（MIT）", () => {
    // 条目标题行（`- **名称** —— 许可`）须同时写明项目名与许可。
    const entries = readRepoFile("ATTRIBUTION.md")
      .split("\n")
      .filter((line) => line.startsWith("- **"));
    expect(entries.some((line) => /\*\*[^*]*lucide[^*]*\*\*.*\bISC\b/i.test(line))).toBe(true);
    expect(entries.some((line) => /\*\*[^*]*Radix[^*]*\*\*.*\bMIT\b/.test(line))).toBe(true);
  });
});
