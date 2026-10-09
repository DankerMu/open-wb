import { expect, type Locator, type Page } from "@playwright/test";
import type { WalkProject } from "./ui-walk-layout.js";

// 浅色下 --primary → --wb-palette-black-90 的计算值（web/src/styles/tokens.css）；「配色不换」。
const LIGHT_PRIMARY = "rgba(0, 0, 0, 0.9)";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

/**
 * 自定义属性的计算颜色：`getPropertyValue("--x")` 给的是未归一的原文，所以挂一个探针元素，
 * 把 `var(--x)` 设成它的 `color` 再读计算值，得到与其它计算颜色同格式的串。
 */
export function resolvedColor(page: Page, variable: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const { color } = getComputedStyle(probe);
    probe.remove();
    return color;
  }, variable);
}

const computed = (target: Locator, property: "backgroundColor" | "borderTopColor") =>
  target.evaluate((el, name) => getComputedStyle(el)[name], property);

/**
 * 登录页的层叠取证（ui-foundation「utilities 压过旧全局规则」「亮暗两种主题的底色与主按钮」与
 * design D3 的边框色基线）。两个 project 各跑一种主题：desktop-light 为浅色，mobile-dark 为深色。
 */
export async function expectLoginCascade(page: Page, project: WalkProject): Promise<void> {
  const theme = project === "desktop-light" ? "light" : "dark";
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

  // 主按钮底色等于 --primary：`bg-primary`（utilities 层）压过 legacy 层的 `button { background: none }`。
  const primary = await resolvedColor(page, "--primary");
  expect(primary, `--primary resolves to a colour under ${theme}`).not.toBe(TRANSPARENT);
  if (theme === "light")
    expect(primary, "light --primary keeps the old palette").toBe(LIGHT_PRIMARY);
  const submit = page.getByRole("button", { name: "登录", exact: true });
  await expect
    .poll(() => computed(submit, "backgroundColor"), `登录 background under ${theme}`)
    .toBe(primary);

  // 边框色基线：拷入组件里裸的 `border-t`（快捷登录所在的卡片底栏，自身不带颜色类）取 --border，
  // 不是 currentColor（该元素的文字色）。
  const quick = page.getByRole("list", { name: "快捷登录" });
  await expect(quick).toBeVisible();
  const footer = page.locator('[data-slot="card-footer"]').filter({ has: quick });
  await expect(footer).toHaveCount(1);
  const borderClasses = ((await footer.getAttribute("class")) ?? "")
    .split(/\s+/)
    .filter((name) => name.startsWith("border"));
  expect(borderClasses, "the footer border carries no colour class").toEqual(["border-t"]);
  const border = await resolvedColor(page, "--border");
  const text = await footer.evaluate((el) => getComputedStyle(el).color);
  expect(border, `--border differs from the footer text colour under ${theme}`).not.toBe(text);
  expect(await footer.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
  await expect
    .poll(() => computed(footer, "borderTopColor"), `card footer border under ${theme}`)
    .toBe(border);
}
