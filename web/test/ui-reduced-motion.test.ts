import { describe, expect, it } from "vitest";
import { listRepoFiles, readRepoFile, stripComments, topLevelBlocks } from "./ui-support.js";

// ui-primitives「全局 reduced-motion 规则」（#423）：全局 `*` reduce 块只设 animation-* 与
// scroll-behavior，不新建过渡；组件自己声明的过渡由同文件、源码顺序在后的顶层 reduce 块置 none。

const REDUCE_PRELUDE = /^@media\s*\(prefers-reduced-motion:\s*reduce\)/;
const TRANSITION_DECL = /(?<![\w-])(transition(?:-[\w-]+)?)\s*:\s*([^;]+)/g;

type CssSource = { path: string; css: string };
type Report = { declaring: string[]; violations: string[] };

function transitionDecls(body: string) {
  return [...body.matchAll(TRANSITION_DECL)].map(([, property = "", value = ""]) => ({
    property,
    value: value.trim(),
  }));
}

const isNone = (decl: { value: string }) => decl.value === "none";
const isOverride = (decl: { property: string; value: string }) =>
  decl.property === "transition" && isNone(decl);

function selectorsOf(prelude: string): string[] {
  return prelude.split(",").map((part) => part.trim().replace(/\s+/g, " "));
}

type Blocks = ReturnType<typeof topLevelBlocks>;

/** 顶层块；`@import …;` 这类无块语句会粘在下一块 prelude 前，按最后一个 `;` 切掉。 */
function blocksOf(css: string): Blocks {
  return topLevelBlocks(css).map(({ prelude, body }) => ({
    prelude: prelude.slice(prelude.lastIndexOf(";") + 1).trim(),
    body,
  }));
}

/** reduce 块内每条规则：只许 `transition: none` 覆盖；覆盖的选择器记到 `index`（多处取最大）。 */
function collectReduceBlock(
  path: string,
  body: string,
  index: number,
  overrides: Map<string, number>,
  violations: string[],
) {
  for (const rule of topLevelBlocks(body)) {
    const decls = transitionDecls(rule.body);
    for (const decl of decls.filter((candidate) => !isOverride(candidate))) {
      violations.push(`${path}: reduce 块 ${rule.prelude} 声明了 ${decl.property}: ${decl.value}`);
    }
    if (!decls.some(isOverride)) continue;
    for (const selector of selectorsOf(rule.prelude)) {
      overrides.set(selector, Math.max(index, overrides.get(selector) ?? -1));
    }
  }
}

/** 顶层 reduce 块内 `transition: none` 覆盖：选择器 → 所在顶层块序号；其它 @ 块不许出现过渡。 */
function reduceOverrides(path: string, blocks: Blocks, violations: string[]) {
  const overrides = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (!block.prelude.startsWith("@")) return;
    if (REDUCE_PRELUDE.test(block.prelude)) {
      collectReduceBlock(path, block.body, index, overrides, violations);
    } else if (transitionDecls(block.body).length > 0) {
      violations.push(`${path}: ${block.prelude} 块内声明了 transition`);
    }
  });
  return overrides;
}

function checkFile({ path, css }: CssSource, report: Report) {
  const blocks = blocksOf(stripComments(css));
  const overrides = reduceOverrides(path, blocks, report.violations);
  blocks.forEach((block, index) => {
    if (block.prelude.startsWith("@")) return;
    if (transitionDecls(block.body).every(isNone)) return;
    report.declaring.push(`${path}: ${block.prelude}`);
    for (const selector of selectorsOf(block.prelude)) {
      if ((overrides.get(selector) ?? -1) <= index) {
        report.violations.push(`${path}: ${selector} 缺少位于其后的 reduce transition: none`);
      }
    }
  });
}

function checkReducedMotion(sources: CssSource[]): Report {
  const report: Report = { declaring: [], violations: [] };
  for (const source of sources) checkFile(source, report);
  return report;
}

/** styles.css 里选择器含 `*` 的顶层 reduce 规则体（即全局块）。 */
function globalReduceBodies(css: string): string[] {
  return blocksOf(stripComments(css))
    .filter((block) => REDUCE_PRELUDE.test(block.prelude))
    .flatMap((block) => topLevelBlocks(block.body))
    .filter((rule) => selectorsOf(rule.prelude).includes("*"))
    .map((rule) => rule.body);
}

const sample = (css: string) => checkReducedMotion([{ path: "sample.css", css }]);
const REDUCE_OPEN = "@media (prefers-reduced-motion: reduce) {";

describe("reduced-motion 过渡守卫（#423）", () => {
  it("判定自证：缺覆盖与覆盖在前判失败，分组选择器覆盖在后判通过", () => {
    const missing = sample('@import "./x.css";\n.a { color: red; transition: color 0.1s; }');
    expect(missing.declaring).toEqual(["sample.css: .a"]);
    expect(missing.violations).toEqual(["sample.css: .a 缺少位于其后的 reduce transition: none"]);

    const before = sample(
      `${REDUCE_OPEN} .a { transition: none; } }\n.a { transition: color 0.1s; }`,
    );
    expect(before.violations).toEqual(["sample.css: .a 缺少位于其后的 reduce transition: none"]);

    const grouped = sample(
      `.a,\n.b { transition:\n    color 0.1s,\n    opacity 0.1s; }\n${REDUCE_OPEN} .b, .a { transition: none; } }`,
    );
    expect(grouped).toEqual({ declaring: ["sample.css: .a,\n.b"], violations: [] });
  });

  it("判定自证：非 reduce 的 @ 块与 reduce 块内的非 none 过渡判失败，只有覆盖的规则放行", () => {
    const other = sample("@media (max-width: 760px) { .a { transition-duration: 1s; } }");
    expect(other.violations).toHaveLength(1);
    const inReduce = sample(`${REDUCE_OPEN} * { transition-duration: 0.01ms; } }`);
    expect(inReduce.violations).toEqual([
      "sample.css: reduce 块 * 声明了 transition-duration: 0.01ms",
    ]);
    expect(sample(`${REDUCE_OPEN} .a { transition: none; } }\n.b { transition: none; }`)).toEqual({
      declaring: [],
      violations: [],
    });
  });

  it("全局 * reduce 块不含 transition 声明，保留 animation-* 与 scroll-behavior", () => {
    const bodies = globalReduceBodies(readRepoFile("web/src/styles.css"));
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? "";
    expect(body).not.toMatch(/(?<![\w-])transition[\w-]*\s*:/);
    expect(body).toMatch(/animation-duration\s*:/);
    expect(body).toMatch(/animation-iteration-count\s*:/);
    expect(body).toMatch(/scroll-behavior\s*:/);
  });

  it("web/src/**/*.css 每条非 none 过渡都有同文件、在后的 reduce 覆盖", () => {
    const paths = listRepoFiles("web/src", (path) => path.endsWith(".css"));
    const report = checkReducedMotion(paths.map((path) => ({ path, css: readRepoFile(path) })));
    expect(report.declaring.length).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });
});
