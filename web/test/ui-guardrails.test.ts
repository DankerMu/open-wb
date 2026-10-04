import { describe, expect, it } from "vitest";
import {
  blockBody,
  COLOR_LITERAL_PATTERNS,
  listRepoFiles,
  readRepoFile,
  stripComments,
  stripTsComments,
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

  it("去注释自证：行注释与块注释被剥掉且行号不变，字符串里的 // 与颜色保留", () => {
    const hits = (text: string) => literalHits(stripTsComments(text));
    const line44 = readRepoFile("web/src/features/chat/stream-steps.ts").split("\n")[43] ?? "";
    expect(line44).toContain("（#367）");
    expect(literalHits(line44)).toHaveLength(1);
    expect(hits(line44)).toEqual([]);
    expect(hits("const a = 1; // 见 #1234\n/* #abc\n rgba(0,0,0,.5) */")).toEqual([]);
    expect(hits('/* 注释 */\n// 注释\nconst c = "#abcdef";')).toEqual(['3: const c = "#abcdef";']);
    expect(hits('const u = "https://example.test/#fff";')).toHaveLength(1);
    expect(hits("const u = 'a//b'; const c = 'rgb(1 2 3)';")).toHaveLength(1);
    expect(hits("const t = `bg-[#123456] // 不是注释`;")).toHaveLength(1);
    expect(paletteHits(stripTsComments("// var(--wb-palette-gray-3)"))).toEqual([]);
    expect(paletteHits(stripTsComments('const v = "var(--wb-palette-gray-3)";'))).toHaveLength(1);
  });

  it("features/routes 去注释后的 .ts 无 hex/rgba 字面颜色与 --wb-palette-", () => {
    const paths = [
      ...listRepoFiles("web/src/features", (path) => path.endsWith(".ts")),
      ...listRepoFiles("web/src/routes", (path) => path.endsWith(".ts")),
    ];
    expect(paths).toContain("web/src/features/chat/stream-steps.ts");
    const find = (text: string) => {
      const code = stripTsComments(text);
      return [...literalHits(code), ...paletteHits(code)];
    };
    expect(hitsIn(paths, find)).toEqual([]);
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
  /** 静态 `from "…"`、副作用 `import "…"` 与动态 `import("…")`，目标为 `@radix-ui/…` 单包或 `radix-ui` 合包。 */
  const RADIX_IMPORT_PATTERNS = [/(?:from|import)\s*\(?\s*["'](?:@radix-ui\/|radix-ui["'/])/];
  const radixHits = (text: string) => lineHits(text, RADIX_IMPORT_PATTERNS);
  /** 只有拷入层与冻结区可以导入 Radix；其余 `web/src` 都是应用层。 */
  const RADIX_ALLOWED_DIRS = [
    "web/src/components/ui/",
    "web/src/components/assistant-ui/",
    "web/src/ui/",
  ];
  const isApplicationLayer = (path: string) =>
    /\.tsx?$/.test(path) && !RADIX_ALLOWED_DIRS.some((dir) => path.startsWith(dir));

  it("正则命中静态与动态 @radix-ui import，不命中基元出口", () => {
    expect(radixHits('import * as X from "@radix-ui/react-toast";')).toHaveLength(1);
    expect(radixHits("import { Root } from '@radix-ui/react-dialog';")).toHaveLength(1);
    expect(radixHits('const X = await import("@radix-ui/react-toast");')).toHaveLength(1);
    expect(radixHits('import { X } from "../../ui/index.js";')).toEqual([]);
  });

  it("正则命中 radix-ui 合包的静态、子路径、副作用与动态导入，不命中同名后缀的包", () => {
    expect(radixHits('import { Slot } from "radix-ui";')).toHaveLength(1);
    expect(radixHits("import { Dialog } from 'radix-ui';")).toHaveLength(1);
    expect(radixHits('import { X } from "radix-ui/internal";')).toHaveLength(1);
    expect(radixHits('import "radix-ui";')).toHaveLength(1);
    expect(radixHits('const X = await import("radix-ui");')).toHaveLength(1);
    expect(radixHits('import { X } from "not-radix-ui";')).toEqual([]);
    expect(radixHits('import { X } from "radix-ui-themes";')).toEqual([]);
    expect(radixHits('import { Button } from "@/components/ui/button";')).toEqual([]);
  });

  it("应用层判定：只有两个拷入目录与 web/src/ui 之下的文件不算应用层", () => {
    expect(isApplicationLayer("web/src/main.tsx")).toBe(true);
    expect(isApplicationLayer("web/src/lib/utils.ts")).toBe(true);
    expect(isApplicationLayer("web/src/features/auth/footer.tsx")).toBe(true);
    expect(isApplicationLayer("web/src/components/shell.tsx")).toBe(true);
    expect(isApplicationLayer("web/src/components/ui-extra/a.tsx")).toBe(true);
    expect(isApplicationLayer("web/src/uix/a.ts")).toBe(true);
    expect(isApplicationLayer("web/src/components/ui/button.tsx")).toBe(false);
    expect(isApplicationLayer("web/src/components/assistant-ui/thread.tsx")).toBe(false);
    expect(isApplicationLayer("web/src/ui/dialog.tsx")).toBe(false);
    expect(isApplicationLayer("web/src/styles.css")).toBe(false);
  });

  it("应用层（web/src 除拷入层与 web/src/ui 外的全部 .ts/.tsx）不直接 import Radix", () => {
    const paths = listRepoFiles("web/src", isApplicationLayer);
    for (const dir of ["web/src/features/", "web/src/routes/", "web/src/lib/"]) {
      expect(paths.some((path) => path.startsWith(dir))).toBe(true);
    }
    expect(paths).toContain("web/src/main.tsx");
    expect(paths.some((path) => RADIX_ALLOWED_DIRS.some((dir) => path.startsWith(dir)))).toBe(
      false,
    );
    expect(hitsIn(paths, radixHits)).toEqual([]);
    // 对照：同一正则在拷入层的真实文件上命中，上面的空结果不是正则失效。
    expect(radixHits(readRepoFile("web/src/components/ui/button.tsx"))).toHaveLength(1);
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

  /** 条目标题行 `- **<名称>** —— <许可>`：名称全等，且同一行写明许可。 */
  const hasEntry = (text: string, name: string, licence: RegExp) =>
    text
      .split("\n")
      .some((line) => line.startsWith(`- **${name}** `) && licence.test(line.slice(name.length)));

  it("登记 Tailwind CSS（tailwindcss）、shadcn/ui 与 radix-ui 合包，各带许可", () => {
    const attribution = readRepoFile("ATTRIBUTION.md");
    expect(hasEntry(attribution, "Tailwind CSS", /\bMIT\b/)).toBe(true);
    expect(attribution).toContain("`tailwindcss`");
    expect(hasEntry(attribution, "shadcn/ui", /\bMIT\b/)).toBe(true);
    expect(hasEntry(attribution, "radix-ui", /\bMIT\b/)).toBe(true);
  });

  it("登记判定自证：缺许可、名称只出现在正文、名称不全等都不算登记", () => {
    expect(hasEntry("- **radix-ui** —— `MIT License`,版权归 WorkOS", "radix-ui", /\bMIT\b/)).toBe(
      true,
    );
    expect(hasEntry("- **radix-ui** —— 版权归 WorkOS", "radix-ui", /\bMIT\b/)).toBe(false);
    expect(hasEntry("  - 用途：`radix-ui` 合包（MIT）", "radix-ui", /\bMIT\b/)).toBe(false);
    expect(hasEntry("- **Radix UI Primitives** —— `MIT License`", "radix-ui", /\bMIT\b/)).toBe(
      false,
    );
    expect(hasEntry("- **shadcn/ui-extras** —— `MIT License`", "shadcn/ui", /\bMIT\b/)).toBe(false);
  });
});
