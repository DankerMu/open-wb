import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockBody,
  listRepoFiles,
  readRepoFile,
  ruleBody,
  stripComments,
  topLevelBlocks,
} from "./ui-support.js";

// ui-foundation「Tailwind 入口与层叠顺序」「主题映射」的静态守卫：入口结构不可缺失或重排，
// theme.css 做 shadcn 语义变量 → --wb-* token 的映射，外加一个按清单钉住的 `@layer base` 块（全局基础
// 规则与 `ui-*` 类）。层叠结果本身由 ui-walk 在真实浏览器里证明。

const ENTRY = "web/src/styles.css";
const LEGACY = "web/src/styles/legacy.css";
const THEME = "web/src/styles/theme.css";
const UI_BARREL = "web/src/ui/ui.css";

const LAYER_ORDER = "@layer theme, base, legacy, components, utilities;";
const ENTRY_IMPORTS = [
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/preflight.css" layer(base);',
  '@import "tailwindcss/utilities.css" layer(utilities) source("./");',
  '@import "tw-animate-css";',
  '@import "tw-shimmer";',
  '@import "./styles/tokens.css";',
  '@import "./styles/theme.css";',
  '@import "./styles/legacy.css" layer(legacy);',
];
const REDUCE_PRELUDE = "@media (prefers-reduced-motion: reduce)";

function importStatements(css: string): string[] {
  return [...stripComments(css).matchAll(/@import\s[^;]+;/g)].map(([statement]) =>
    statement.replace(/\s+/g, " "),
  );
}

/** 顶层块的 prelude；无块语句（`@layer a, b;`、`@import …;`）粘在下一块前，按最后一个 `;` 切掉。 */
function blockPreludes(css: string): string[] {
  return topLevelBlocks(stripComments(css)).map(({ prelude }) =>
    prelude
      .slice(prelude.lastIndexOf(";") + 1)
      .trim()
      .replace(/\s+/g, " "),
  );
}

function entryViolations(css: string): string[] {
  const violations: string[] = [];
  if (!stripComments(css).trimStart().startsWith(LAYER_ORDER)) {
    violations.push("第一条规则不是层声明");
  }
  if (importStatements(css).join("\n") !== ENTRY_IMPORTS.join("\n")) {
    violations.push("@import 集合或顺序不符");
  }
  if (blockPreludes(css).join("\n") !== REDUCE_PRELUDE) {
    violations.push("入口的规则块不是恰好一个未分层的全局 reduce 块");
  }
  return violations;
}

/** `importer`（仓库相对路径）里每条 `@import` 的目标，解析成仓库相对路径。 */
function importTargets(importer: string): string[] {
  return importStatements(readRepoFile(importer)).map((statement) => {
    const target = /^@import "(\.[^"]+)";$/.exec(statement)?.[1];
    if (target === undefined) throw new Error(`${importer}: 非预期的 ${statement}`);
    return posix.join(posix.dirname(importer), target);
  });
}

describe("入口结构（ui-foundation「入口结构不可缺失或重排」）", () => {
  it("判定自证：层序重排、少 layer(legacy)、token 入层、多 @import、多规则块都判失败", () => {
    const entry = readRepoFile(ENTRY);
    const mutations: [string, string, string][] = [
      ["层序重排", LAYER_ORDER, "@layer theme, base, components, legacy, utilities;"],
      ["legacy 未入层", '"./styles/legacy.css" layer(legacy);', '"./styles/legacy.css";'],
      ["tokens 入层", '"./styles/tokens.css";', '"./styles/tokens.css" layer(legacy);'],
      ["类名扫描范围放开", ' source("./");', ";"],
      ["多一条 @import", LAYER_ORDER, `${LAYER_ORDER}\n@import "./ui/ui.css";`],
      ["reduce 块入层", REDUCE_PRELUDE, `@layer legacy { ${REDUCE_PRELUDE}`],
    ];
    for (const [label, from, to] of mutations) {
      expect(entry, label).toContain(from);
      expect(entryViolations(entry.replace(from, to)), label).not.toEqual([]);
    }
    expect(entryViolations(`body { margin: 0; }\n${entry}`)).not.toEqual([]);
  });

  it("styles.css：层声明在首，八条导入各归其层，只剩一个未分层的全局 reduce 块", () => {
    expect(entryViolations(readRepoFile(ENTRY))).toEqual([]);
  });

  it("其余既有 .css 只被 legacy.css 直接导入或经 ui/ui.css 传递导入，且各恰一次", () => {
    const wired = [ENTRY, "web/src/styles/tokens.css", THEME, LEGACY];
    const others = listRepoFiles("web/src", (path) => path.endsWith(".css")).filter(
      (path) => !wired.includes(path),
    );
    expect(others.length).toBeGreaterThan(0);

    const legacyTargets = importTargets(LEGACY);
    expect(legacyTargets).toContain(UI_BARREL);
    expect([...legacyTargets, ...importTargets(UI_BARREL)].sort()).toEqual(others);

    const importers = others.filter((path) => importStatements(readRepoFile(path)).length > 0);
    // Toast 删除（#1398）后 ui.css 不再汇总任何组件样式：既有样式文件里没有一个带 @import。
    expect(importers).toEqual([]);
    expect(importStatements(readRepoFile(THEME))).toEqual([]);
  });

  it("文件页样式已退出 legacy 层：legacy.css 不导入 features/files，该目录下没有 .css", () => {
    expect(readRepoFile(LEGACY)).not.toContain("features/files");
    expect(listRepoFiles("web/src/features/files", (path) => path.endsWith(".css"))).toEqual([]);
  });
});

const SEMANTIC_COLORS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-border",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
];
/** 规格钉住的七项（浅色；深色除 --primary 一对外由同名 token 自己换值）。 */
const PINNED: [string, string][] = [
  ["--background", "var(--wb-home-bg-secondary)"],
  ["--foreground", "var(--wb-text-primary)"],
  ["--primary", "var(--wb-palette-black-90)"],
  ["--primary-foreground", "var(--wb-text-white)"],
  ["--destructive", "var(--wb-status-error)"],
  ["--border", "var(--wb-border-default)"],
  ["--sidebar", "var(--wb-sidebar-bg)"],
];
const PINNED_DARK: [string, string][] = [
  ["--primary", "var(--wb-palette-white-90)"],
  ["--primary-foreground", "var(--wb-palette-black-90)"],
];
const COLOR_LITERALS = [/#[0-9a-fA-F]{3,8}(?![\w-])/, /rgba?\(/, /oklch\(/, /hsla?\(/];

function declarationMap(css: string, opener: RegExp): Map<string, string> {
  const entries = blockBody(css, opener)
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk): [string, string] => {
      const colon = chunk.indexOf(":");
      return [chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim()];
    });
  return new Map(entries);
}

function pinViolations(map: Map<string, string>, pins: [string, string][], block: string) {
  return pins
    .filter(([name, value]) => map.get(name) !== value)
    .map(([name, value]) => `${block} ${name} 应为 ${value}，实为 ${map.get(name)}`);
}

function themeViolations(source: string): string[] {
  const css = stripComments(source);
  const light = declarationMap(css, /^:root\s*\{/m);
  const dark = declarationMap(css, /^\[data-theme="dark"\]\s*\{/m);
  const violations = [
    ...pinViolations(light, PINNED, ":root"),
    ...pinViolations(dark, PINNED_DARK, "[data-theme=dark]"),
  ];
  for (const name of SEMANTIC_COLORS) {
    if (!/^var\(--wb-[a-z0-9-]+\)$/.test(light.get(name) ?? "")) {
      violations.push(`${name} 未定义为单个 --wb-* token 引用`);
    }
  }
  if ([...dark.keys()].join(" ") !== PINNED_DARK.map(([name]) => name).join(" ")) {
    violations.push("[data-theme=dark] 块不是恰好 --primary 与 --primary-foreground 两项");
  }
  if (light.get("--radius") !== "0.5rem") violations.push("--radius 不是 0.5rem");
  for (const pattern of COLOR_LITERALS) {
    if (pattern.test(css)) violations.push(`出现颜色字面量 ${pattern}`);
  }
  const variants = [...css.matchAll(/@custom-variant\s+dark\s[^;]*;/g)].map(([rule]) => rule);
  if (variants.length !== 1 || !variants[0]?.includes('[data-theme="dark"]')) {
    violations.push('缺少把 dark 变体绑定到 [data-theme="dark"] 的 @custom-variant');
  }
  if (/\.dark\b/.test(css)) violations.push("出现 .dark 类");
  violations.push(...baseLayerViolations(css));
  return violations;
}

const BASE_OPENER = /^@layer base\s*\{/m;
const BORDER_BASELINE = "*, ::before, ::after { border-color: var(--border); }";
const NARROW_PRELUDE = "@media (max-width: 760px)";
/** `theme.css` 里 `base` 块之外的顶层规则块（无花括号的 `@custom-variant` 声明不是规则块）。 */
const UNLAYERED_BLOCKS = [":root", '[data-theme="dark"]', "@theme inline", "body", REDUCE_PRELUDE];
/**
 * `base` 块里排在边框色基线之后的选择器，按源码次序：先是原 `ui.css` 的图标与品牌标记规则，再是原
 * `legacy.css` 的全局基础规则（s1f-legacy-layer-removal design D7 与「逐规则去向」两张表）。
 * 这份清单只减不增：块内多出一个选择器就判失败。
 */
const BASE_SELECTORS = [
  ".ui-icon",
  ".ui-icon-12",
  ".ui-icon-14",
  ".ui-icon-16",
  ".ui-icon-18",
  ".ui-icon-20",
  ".ui-brand",
  ".ui-brand-mark",
  ".ui-brand-mark-bg",
  ".ui-brand-mark-check",
  ".ui-brand-wordmark",
  "*, *::before, *::after",
  "html, body, #root",
  "html",
  'html[data-theme="dark"]',
  "body",
  "button, input, textarea, select",
  "button",
  "button:disabled, input:disabled, textarea:disabled, select:disabled",
  "input, textarea, select",
  "a",
  ":focus-visible",
  "::selection",
  "::-webkit-scrollbar",
  "::-webkit-scrollbar-thumb",
  "::-webkit-scrollbar-track",
  ".ui-alert",
  ".ui-muted",
  ".ui-empty",
];

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** `base` 块内的规则块，按源码次序；prelude 与块体都压成单行。 */
function baseBlocks(css: string): { prelude: string; body: string }[] {
  return topLevelBlocks(blockBody(css, BASE_OPENER)).map(({ prelude, body }) => ({
    prelude: squash(prelude),
    body: squash(body),
  }));
}

/**
 * `theme.css` 唯一的入层块（s1f-legacy-layer-removal design D7、D11 的 G2）。五条判定按下面的次序
 * 逐条短路，一处结构变动只报一条：
 * 1. `@layer` 块恰为一个 `base`；
 * 2. 块外的顶层规则块恰为既有的五项——全局基础规则挪到块外就成了未分层规则，会压过 utilities；
 * 3. 块内第一条是边框色基线 `*, ::before, ::after { border-color: var(--border); }`；
 * 4. 块内恰有一个嵌套的 at-rule 块：排在最后的 `@media (max-width: 760px) { body { overflow: auto; } }`；
 * 5. 其余规则的选择器按次序等于 `BASE_SELECTORS`。
 */
function baseLayerViolations(css: string): string[] {
  const layers = [...css.matchAll(/@layer\b[^{;]*/g)].map(([prelude]) => prelude.trim());
  if (layers.join("|") !== "@layer base") {
    return [`base 块：@layer 应恰为一个 base 块，实为 ${JSON.stringify(layers)}`];
  }
  const outside = blockPreludes(css).filter((prelude) => prelude !== "@layer base");
  if (outside.join("|") !== UNLAYERED_BLOCKS.join("|")) {
    return [`base 块：块外的顶层规则块应恰为既有的五项，实为 ${JSON.stringify(outside)}`];
  }
  const [first, ...rest] = baseBlocks(css);
  const baseline = first ? `${first.prelude} { ${first.body} }` : "";
  if (baseline !== BORDER_BASELINE) {
    return [`base 块：第一条应为边框色基线 ${BORDER_BASELINE}，实为 ${baseline}`];
  }
  const nested = rest.filter(({ prelude }) => prelude.startsWith("@"));
  const last = rest.at(-1);
  if (
    nested.length !== 1 ||
    last?.prelude !== NARROW_PRELUDE ||
    last.body !== "body { overflow: auto; }"
  ) {
    return [
      `base 块：嵌套的 at-rule 块应恰为排在最后的 ${NARROW_PRELUDE} { body { overflow: auto; } }，实为 ${JSON.stringify(nested)}`,
    ];
  }
  const selectors = rest.filter(({ prelude }) => !prelude.startsWith("@")).map((b) => b.prelude);
  return selectors.join("|") === BASE_SELECTORS.join("|")
    ? []
    : [`base 块：选择器（按次序）与清单不符，实为 ${JSON.stringify(selectors)}`];
}

/** 块内的 `button { … }` reset 整条挪到块外，成为排在未分层 `body` 之前的未分层规则。 */
function moveButtonResetOut(theme: string): string {
  const reset = /^ {2}button \{\n(?: {4}[^\n]*\n)+ {2}\}\n\n/m.exec(theme)?.[0] ?? "";
  const unlayered = reset.replace(/^ {2}/gm, "");
  return theme.replace(reset, "").replace(/^body \{/m, `${unlayered}body {`);
}

describe("theme.css 结构（ui-foundation「映射文件结构」）", () => {
  it("判定自证：每种变异恰好只触发它对应的那一条判定", () => {
    const theme = readRepoFile(THEME);
    const darkOpen = '[data-theme="dark"] {';
    const mutations: [string, string | RegExp, string, string][] = [
      ["缺 --ring", /^\s*--ring:[^;]*;/m, "", "--ring 未定义"],
      [
        "改 --background",
        "var(--wb-home-bg-secondary)",
        "var(--wb-bg-primary)",
        ":root --background",
      ],
      [
        "深色 --primary",
        "var(--wb-palette-white-90)",
        "var(--wb-palette-white-70)",
        "[data-theme=dark]",
      ],
      ["深色块多一项", darkOpen, `${darkOpen}\n  --border: var(--wb-border-default);`, "恰好"],
      // 字面量注入在不受其它判定约束的 body 规则里，单独证明字面量扫描。
      ["hex 字面量", "background: var(--background);", "background: #ffffff;", "颜色字面量"],
      ["oklch 字面量", "color: var(--foreground);", "color: oklch(0.2 0 0);", "颜色字面量"],
      ["--radius", "--radius: 0.5rem", "--radius: 0.625rem", "--radius"],
      [
        "dark 变体改绑",
        '(&:where([data-theme="dark"], [data-theme="dark"] *))',
        "(&:where(.night *))",
        "@custom-variant",
      ],
      // 两条以块外的 `body` 为锚点的变异都用行首匹配：`base` 块里那条 `body` 是缩进的，不会被命中。
      // `.dark` 写成嵌套在 `body` 里的规则：顶层 prelude 不变，所以只触发 `.dark` 一条判定。
      [".dark 类", /^body \{/m, "body {\n  .dark & {\n    top: 0;\n  }", ".dark 类"],
      [
        "缺边框色基线",
        /^ {2}\*,\n {2}::before,\n {2}::after \{\n[^}]*\}\n\n/m,
        "",
        "第一条应为边框色基线",
      ],
      ["基线换层", "@layer base {", "@layer legacy {", "@layer 应恰为一个 base 块"],
      [
        "基线改色",
        "border-color: var(--border);",
        "border-color: var(--input);",
        "第一条应为边框色基线",
      ],
      [
        "多一个入层块",
        /^body \{/m,
        "@layer utilities {\n  a {\n    top: 0;\n  }\n}\n\nbody {",
        "@layer 应恰为一个 base 块",
      ],
      [
        "块内多一个选择器",
        "  .ui-alert {",
        "  .ui-new {\n    margin: 0;\n  }\n\n  .ui-alert {",
        "与清单不符",
      ],
      [
        "嵌套媒体块多一条规则",
        "      overflow: auto;\n    }",
        "      overflow: auto;\n    }\n\n    a {\n      top: 0;\n    }",
        "嵌套的 at-rule 块",
      ],
    ];
    for (const [label, from, to, expected] of mutations) {
      const mutated = theme.replace(from, to);
      expect(mutated, label).not.toBe(theme);
      expect(themeViolations(mutated), label).toEqual([expect.stringContaining(expected)]);
    }
    const moved = moveButtonResetOut(theme);
    expect(moved).toMatch(/^button \{\n {2}background: none;\n[^}]*\}\n\nbody \{/m);
    expect(moved).not.toMatch(/^ {2}button \{/m);
    expect(themeViolations(moved), "button 的 reset 挪到块外").toEqual([
      expect.stringContaining("块外的顶层规则块应恰为既有的五项"),
    ]);
  });

  it("语义变量全集有定义且只引用 --wb-* token，七项钉死的对应与 dark 变体绑定成立", () => {
    expect(themeViolations(readRepoFile(THEME))).toEqual([]);
  });

  it("@theme inline 把每个语义变量暴露成 Tailwind 颜色，圆角刻度派生自 --radius", () => {
    const exposed = declarationMap(stripComments(readRepoFile(THEME)), /^@theme inline\s*\{/m);
    for (const name of SEMANTIC_COLORS) {
      expect(exposed.get(`--color-${name.slice(2)}`), name).toBe(`var(${name})`);
    }
    expect(exposed.get("--radius-lg")).toBe("var(--radius)");
  });

  it("body：底色与文字色在块外（未分层，只这两项），字号、行高等在 base 块内且不声明颜色", () => {
    const theme = stripComments(readRepoFile(THEME));
    const unlayered = topLevelBlocks(theme).filter(({ prelude }) => /(^|;)\s*body$/.test(prelude));
    expect(unlayered.map(({ body }) => squash(body))).toEqual([
      "background: var(--background); color: var(--foreground);",
    ]);
    // 取 prelude 恰为 `body` 的那条：`html, body, #root` 与嵌套媒体块里的 `body` 不算。
    const layered = baseBlocks(theme).filter(({ prelude }) => prelude === "body");
    expect(layered).toHaveLength(1);
    const layeredBody = layered[0]?.body ?? "";
    expect(layeredBody).not.toMatch(/(?<![\w-])(background[\w-]*|color)\s*:/);
    expect(layeredBody).toContain("font-size: 14px;");
    expect(layeredBody).toContain("line-height: 22px;");
  });

  it('reduce 下 [class*="transition"] 统一置 transition: none（未分层、只有覆盖）', () => {
    const theme = stripComments(readRepoFile(THEME));
    const reduce = blockBody(theme, /^@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/m);
    expect(ruleBody(reduce, '[class*="transition"]').trim()).toBe("transition: none;");
    // 这条覆盖规则不在任何层里：它是文件的顶层块（恰一个），而唯一的入层块 base 里没有 reduce 查询。
    // `@custom-variant narrow (@media …)` 是无花括号的声明，不是规则块。
    expect(blockPreludes(theme).filter((prelude) => prelude === REDUCE_PRELUDE)).toHaveLength(1);
    expect(blockBody(theme, BASE_OPENER)).not.toContain("prefers-reduced-motion");
    expect(baseLayerViolations(theme)).toEqual([]);
  });

  it("应用层只用外壳的 narrow: 断点变体：web/src 的 .tsx 不含 max-[760px]:（它编译为小于 760）", () => {
    const stale = listRepoFiles("web/src", (path) => path.endsWith(".tsx")).filter((path) =>
      readRepoFile(path).includes("max-[760px]:"),
    );
    expect(stale).toEqual([]);
  });
});
