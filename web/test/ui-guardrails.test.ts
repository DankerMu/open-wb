import { describe, expect, it } from "vitest";
import {
  blockBody,
  COLOR_LITERAL_PATTERNS,
  listRepoFiles,
  readRepoFile,
  stripComments,
} from "./ui-support.js";

const PALETTE_PATTERN = /--wb-palette-/;

/** 按原始行扫描（不剥注释）：命中任一模式的行以 `行号: 内容` 返回。 */
function lineHits(text: string, patterns: RegExp[]): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => patterns.some((pattern) => pattern.test(line)))
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}

const literalHits = (text: string) => lineHits(text, COLOR_LITERAL_PATTERNS);
const paletteHits = (text: string) => lineHits(text, [PALETTE_PATTERN]);

function hitsIn(paths: string[], find: (text: string) => string[]): string[] {
  return paths.flatMap((path) => find(readRepoFile(path)).map((hit) => `${path}:${hit}`));
}

describe("颜色 grep 守卫", () => {
  it("正则命中字面颜色与调色板，不误中 id 选择器", () => {
    expect(literalHits("#root { color: var(--wb-text-primary); }")).toEqual([]);
    expect(literalHits("#fade-in, #app-shell {}")).toEqual([]);
    expect(literalHits("color: #123456;")).toHaveLength(1);
    expect(literalHits("color: #FFF;")).toHaveLength(1);
    expect(literalHits("background: rgba(0,0,0,.5);")).toHaveLength(1);
    expect(literalHits("color: rgb(1 2 3);")).toHaveLength(1);
    expect(literalHits("color: var(--wb-palette-gray-3);")).toEqual([]);
    expect(paletteHits("color: var(--wb-palette-gray-3);")).toHaveLength(1);
    expect(paletteHits("color: var(--wb-text-primary);")).toEqual([]);
  });

  const features = () => listRepoFiles("web/src/features", (path) => /\.(css|tsx)$/.test(path));
  const routes = () => listRepoFiles("web/src/routes", () => true);
  const uiCss = () => listRepoFiles("web/src/ui", (path) => path.endsWith(".css"));
  const uiTsx = () => listRepoFiles("web/src/ui", (path) => path.endsWith(".tsx"));

  it("features/routes 与 web/src/ui 的 css/tsx 无 hex/rgba 字面颜色（含注释行）", () => {
    const groups = [features(), routes(), uiCss(), uiTsx()];
    for (const group of groups) expect(group.length).toBeGreaterThan(0);
    expect(hitsIn(groups.flat(), literalHits)).toEqual([]);
  });

  it("features/routes 与 web/src/ui/**/*.tsx 无 --wb-palette-（仅 ui css 豁免）", () => {
    // web/src/ui/**/*.css 是调色板 → 组件的唯一映射边界（demo 组件规则直接引用调色板），
    // 故只有它可引用 --wb-palette-*；feature/routes 只用语义 token，ui tsx 只写类名。
    const paths = [...features(), ...routes(), ...uiTsx()];
    expect(hitsIn(paths, paletteHits)).toEqual([]);
  });

  it("web/src/ui/**/*.tsx 无内联 style={", () => {
    const ui = listRepoFiles("web/src/ui", (path) => path.endsWith(".tsx"));
    expect(ui.length).toBeGreaterThan(0);
    const inline = (text: string) =>
      text.split("\n").flatMap((line, index) => (line.includes("style={") ? [`${index + 1}`] : []));
    expect(hitsIn(ui, inline)).toEqual([]);
  });
});

describe("依赖方向 grep 守卫", () => {
  /** 静态 `from "@radix-ui/…"` 与动态 `import("@radix-ui/…")`。 */
  const RADIX_IMPORT_PATTERNS = [/from\s+["']@radix-ui\//, /import\(\s*["']@radix-ui\//];
  const radixHits = (text: string) => lineHits(text, RADIX_IMPORT_PATTERNS);

  it("正则命中静态与动态 @radix-ui import，不命中基元出口", () => {
    expect(radixHits('import * as X from "@radix-ui/react-toast";')).toHaveLength(1);
    expect(radixHits("import { Root } from '@radix-ui/react-dialog';")).toHaveLength(1);
    expect(radixHits('const X = await import("@radix-ui/react-toast");')).toHaveLength(1);
    expect(radixHits('import { X } from "../../ui/index.js";')).toEqual([]);
  });

  it("features/routes 的 .ts/.tsx 不直接 import @radix-ui（仅 web/src/ui 可以）", () => {
    const source = (path: string) => /\.tsx?$/.test(path);
    const paths = [
      ...listRepoFiles("web/src/features", source),
      ...listRepoFiles("web/src/routes", source),
    ];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((path) => path.startsWith("web/src/ui/"))).toBe(false);
    expect(hitsIn(paths, radixHits)).toEqual([]);
  });
});

describe("旧按钮类 grep 守卫", () => {
  /** 词边界：`ui-button`、`ui-button-primary` 命中，`ui-btn*` 不命中。 */
  const legacyButtonHits = (text: string) => lineHits(text, [/\bui-button\b/]);

  it("正则命中注入的 ui-button 行，不命中 ui-btn 行", () => {
    const sample = ['<button className="ui-button">', '<button className="ui-btn ui-btn--md">'];
    expect(legacyButtonHits(sample.join("\n"))).toEqual(['1: <button className="ui-button">']);
    expect(legacyButtonHits(sample[1] ?? "")).toEqual([]);
  });

  it("web/src 的 .ts/.tsx/.css 不再出现 ui-button（按钮只经 Button 基元）", () => {
    const paths = listRepoFiles("web/src", (path) => /\.(tsx?|css)$/.test(path));
    expect(paths.length).toBeGreaterThan(0);
    expect(hitsIn(paths, legacyButtonHits)).toEqual([]);
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

  it("Radix 条目列出 web 已安装的每个 @radix-ui/* 包", () => {
    const { dependencies } = JSON.parse(readRepoFile("web/package.json")) as {
      dependencies: Record<string, string>;
    };
    const radix = Object.keys(dependencies).filter((name) => name.startsWith("@radix-ui/"));
    expect(radix.length).toBeGreaterThan(0);
    const attribution = readRepoFile("ATTRIBUTION.md");
    for (const name of radix) expect(attribution).toContain(`\`${name}\``);
  });
});
