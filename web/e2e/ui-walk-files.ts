// /files probes for the UI walk that need a real browser's computed styles.

import { expect, type Page, type Response } from "@playwright/test";

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const BUILT_SCRIPT = /^\/assets\/[^/]+\.js$/;

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

// ui-foundation「构建产物确有按需块」：`select()`（选中第一个文件）使页面新取回至少一个同源
// `assets/` 下的 200 `.js`，且它不在选中之前已加载的脚本里。只对构建产物成立——对 dev server 必红。
// 「选中之前没有预览器块」没有直接断言，只由这个集合差间接保证。
export async function expectOnDemandChunk(page: Page, select: () => Promise<void>): Promise<void> {
  const origin = new URL(page.url()).origin;
  const builtScript = (address: string) => {
    const url = new URL(address);
    return url.origin === origin && BUILT_SCRIPT.test(url.pathname);
  };
  const loadedBefore = new Set(
    (
      await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name))
    ).filter(builtScript),
  );
  // 快照为空说明页面不是构建产物（或资源计时被清空），其后的「新增」断言就是空转。
  expect(loadedBefore.size, "built scripts loaded before selecting a file").toBeGreaterThan(0);

  const fetched: string[] = [];
  const onResponse = (response: Response) => {
    const address = response.url();
    if (response.status() === 200 && builtScript(address) && !loadedBefore.has(address)) {
      fetched.push(address);
    }
  };
  page.on("response", onResponse);
  try {
    await select();
    await expect
      .poll(() => fetched.length, "selecting a file fetches an on-demand previewer chunk")
      .toBeGreaterThan(0);
  } finally {
    page.off("response", onResponse);
  }
}
