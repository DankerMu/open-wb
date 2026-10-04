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
// theme.css 只做 shadcn 语义变量 → --wb-* token 的映射。层叠结果本身由 ui-walk 在真实浏览器里证明。

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

  it("styles.css：层声明在首，七条导入各归其层，只剩一个未分层的全局 reduce 块", () => {
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
    expect(importers).toEqual([UI_BARREL]);
    expect(importStatements(readRepoFile(THEME))).toEqual([]);
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
  violations.push(...borderBaselineViolations(css));
  return violations;
}

/**
 * 边框色基线（design D3）：`theme.css` 里唯一入层的规则，恰为 base 层的
 * `*, ::before, ::after { border-color: var(--border); }`。在 base 层才低于 legacy，
 * 旧页面自己声明的边框色不受影响；其余规则保持未分层。
 */
function borderBaselineViolations(css: string): string[] {
  const layers = [...css.matchAll(/@layer\b[^{;]*/g)].map(([prelude]) => prelude.trim());
  if (layers.join("|") !== "@layer base") {
    return [`边框色基线：@layer 应恰为一个 base 块，实为 ${JSON.stringify(layers)}`];
  }
  const block = blockBody(css, /^@layer base\s*\{/m);
  const rule = block.replace(/\s+/g, " ").trim();
  return rule === "*, ::before, ::after { border-color: var(--border); }"
    ? []
    : [
        `边框色基线：base 块应只含对 *, ::before, ::after 的 border-color: var(--border)，实为 ${rule}`,
      ];
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
      [".dark 类", "body {", ".dark body {", ".dark 类"],
      ["缺边框色基线", /@layer base \{[^}]*\}\s*\}\n/, "", "边框色基线"],
      ["基线换层", "@layer base {", "@layer legacy {", "边框色基线"],
      ["基线改色", "border-color: var(--border);", "border-color: var(--input);", "边框色基线"],
      [
        "多一个入层块",
        "body {",
        "@layer utilities {\n  a {\n    top: 0;\n  }\n}\n\nbody {",
        "边框色基线",
      ],
    ];
    for (const [label, from, to, expected] of mutations) {
      const mutated = theme.replace(from, to);
      expect(mutated, label).not.toBe(theme);
      expect(themeViolations(mutated), label).toEqual([expect.stringContaining(expected)]);
    }
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

  it("body 底色与文字色在 theme.css（未分层），legacy.css 的 body 不再声明", () => {
    const theme = stripComments(readRepoFile(THEME));
    const body = ruleBody(theme, "body");
    expect(body).toContain("background: var(--background);");
    expect(body).toContain("color: var(--foreground);");
    const legacyBody = blockBody(stripComments(readRepoFile(LEGACY)), /^body \{/m);
    expect(legacyBody).not.toMatch(/(?<![\w-])(background[\w-]*|color)\s*:/);
    expect(legacyBody).toContain("font-size: 14px;");
    expect(legacyBody).toContain("line-height: 22px;");
  });

  it('reduce 下 [class*="transition"] 统一置 transition: none（未分层、只有覆盖）', () => {
    const theme = stripComments(readRepoFile(THEME));
    const reduce = blockBody(theme, /^@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/m);
    expect(ruleBody(reduce, '[class*="transition"]').trim()).toBe("transition: none;");
    // 这条覆盖规则不在任何层里：文件唯一的 @layer 是 base 层的边框色基线，位于它之前。
    expect(theme.slice(theme.indexOf("@media")).includes("@layer")).toBe(false);
    expect(borderBaselineViolations(theme)).toEqual([]);
  });
});
