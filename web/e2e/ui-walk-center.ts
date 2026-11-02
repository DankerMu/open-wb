// `/center` branch of the UI walk (member account): default tab, built-in expert card, and the tab bar
// with the knowledge base off (CI default).

import { expect, type Page } from "@playwright/test";

// 成员可见、不依赖知识库的 tab，按 web/src/features/center/tabs.ts 的次序。
const MEMBER_TABS_WITHOUT_KB = ["专家", "技能", "连接器"];

export async function expectCenterRoute(page: Page): Promise<void> {
  // 成员账号：落到「专家」tab，内置专家卡可见，不再是空态。
  await expect.poll(() => new URL(page.url()).search).toBe("?tab=experts");
  const main = page.locator("main");
  await expect(main.getByRole("tab", { name: "专家", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const card = main.getByRole("listitem", { name: "前端架构师", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText("内置", { exact: true })).toBeVisible();
  await expect(main.getByText("中心暂无可用内容", { exact: true })).toHaveCount(0);
  await expectKbTabAbsent(page);
}

// knowledge-bases「中心「知识库」tab」：知识库关闭时 tab 条不含「知识库」。状态在途时 tab 条同样没有它，
// 所以先拿状态已读到作信号：深链到 ?tab=knowledge-bases，在途时地址不改，读到关闭才 replace 到 ?tab=experts，
// 读到开启则停在原地。同一轮里先读地址再读 tab 条，地址已翻转时读到的就是终态。
async function expectKbTabAbsent(page: Page): Promise<void> {
  await page.goto("/center?tab=knowledge-bases");
  const tabs = page.locator("main").getByRole("tab");
  await expect
    .poll(
      async () => ({
        search: new URL(page.url()).search,
        tabs: await tabs.allTextContents(),
      }),
      "kb off: the 知识库 deep link falls back to 专家 and the tab bar has no 知识库",
    )
    .toEqual({ search: "?tab=experts", tabs: MEMBER_TABS_WITHOUT_KB });
}
