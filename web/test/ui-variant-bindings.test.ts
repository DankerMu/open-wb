// #1706（s1d-model-registry 任务 10.0）：拷入层的裸 `data-*` 变体在 `theme.css` 按上游语义绑定。
// 这里用 Tailwind 自己的编译器编译 `theme.css` 里的 `@custom-variant` 行，证明拷入组件写的类
// 生成的选择器匹配 Radix 实际输出的 `data-state` / `data-orientation`（未绑定时编成 `[data-active]` 等
// 属性存在选择器，永远匹配不上）。逐字的绑定文本由 `ui-foundation-entry.test.ts` 钉住。

import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./ui-support.js";

const THEME = "web/src/styles/theme.css";

/** `theme.css` 的 `@custom-variant` 行（单行、无花括号）加 utilities 指令，交给 Tailwind 编译。 */
async function compileVariants() {
  const variants = readRepoFile(THEME)
    .split("\n")
    .filter((line) => line.startsWith("@custom-variant "));
  const compiler = await compile(`${variants.join("\n")}\n@tailwind utilities;`, {
    loadStylesheet: () => Promise.reject(new Error("no stylesheet may be loaded")),
  });
  return (candidates: string[]) => compiler.build(candidates);
}

/** 产物里以该类名开头的那条规则（选择器 + 块）。 */
function ruleFor(css: string, candidate: string): string {
  const escaped = `.${candidate.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`)}`;
  const start = css.indexOf(`${escaped}`);
  expect(start, candidate).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

describe("拷入层变体编译到 Radix 的输出（#1706）", () => {
  it("data-active / group-data-horizontal / not-data-checked 及其组合各自编到 data-state 与 data-orientation", async () => {
    const build = await compileVariants();
    const css = build([
      "data-active:flex-col",
      "group-data-horizontal/tabs:flex-col",
      "not-data-checked:flex-col",
      "dark:data-active:flex-col",
      "group-has-[:focus-visible]/field-label:not-data-checked:flex-col",
    ]);

    expect(ruleFor(css, "data-active:flex-col")).toContain('[data-state="active"]');
    expect(ruleFor(css, "group-data-horizontal/tabs:flex-col")).toContain(
      '[data-orientation="horizontal"]',
    );
    expect(ruleFor(css, "not-data-checked:flex-col")).toContain(
      ':not(:where([data-state="checked"]',
    );
    const dark = ruleFor(css, "dark:data-active:flex-col");
    expect(dark).toContain('[data-theme="dark"]');
    expect(dark).toContain('[data-state="active"]');
    expect(
      ruleFor(css, "group-has-[:focus-visible]/field-label:not-data-checked:flex-col"),
    ).toContain(':not(:where([data-state="checked"]');
  });

  it("组件自设的同名属性那一支仍在（扩展不替换），且 =false 不匹配", async () => {
    const build = await compileVariants();
    const css = build([
      "data-active:flex-col",
      "data-vertical:flex-col",
      "data-unchecked:flex-col",
    ]);

    expect(ruleFor(css, "data-active:flex-col")).toContain(
      '[data-active]:not([data-active="false"])',
    );
    expect(ruleFor(css, "data-vertical:flex-col")).toContain('[data-orientation="vertical"]');
    expect(ruleFor(css, "data-unchecked:flex-col")).toContain('[data-state="unchecked"]');
  });

  it("data-checked: 的规则排在无变体与 dark: 的同类规则之后（单层 :where，特异度相同时靠次序取胜）", async () => {
    const build = await compileVariants();
    const css = build(["data-checked:flex-col", "dark:flex-row", "flex-row"]);
    const checked = css.indexOf(".data-checked\\:flex-col");

    expect(checked).toBeGreaterThan(css.indexOf(".flex-row"));
    expect(checked).toBeGreaterThan(css.indexOf(".dark\\:flex-row"));
    expect(ruleFor(css, "data-checked:flex-col")).toMatch(/^\.data-checked\\:flex-col:where\(/);
  });
});
