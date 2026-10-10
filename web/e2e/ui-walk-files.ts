// /files probes for the UI walk that need a real browser's computed styles.

import { expect, type Page } from "@playwright/test";

const TRANSPARENT = "rgba(0, 0, 0, 0)";

// ui-foundation「旧页面规则压过 preflight」：ui.css 的 `.ui-icon { display: inline-block }` 在 legacy 层，
// 压过 base 层 preflight 给 svg 的 `display: block`。探针是临时插入 body 的 svg，读完即移除。
// 随 legacy 层整体移除（change s1f-files-page 收尾）删除。
export async function expectLegacyOverPreflight(page: Page): Promise<void> {
  const display = await page.evaluate(() => {
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    probe.setAttribute("class", "ui-icon");
    document.body.append(probe);
    const value = getComputedStyle(probe).display;
    probe.remove();
    return value;
  });
  expect(display, "svg.ui-icon display under the legacy layer").toBe("inline-block");
}

// files-web「文件页不自涂底色」（issue 420）：分栏容器与预览区的计算底色都是透明，页面底色只来自 body。
export async function expectFilesUnpainted(page: Page): Promise<void> {
  for (const slot of ["files-layout", "files-preview"]) {
    const container = page.locator(`main [data-slot="${slot}"]`);
    await expect(container, slot).toHaveCount(1);
    expect(
      await container.evaluate((el) => getComputedStyle(el).backgroundColor),
      `${slot} paints no background`,
    ).toBe(TRANSPARENT);
  }
}
