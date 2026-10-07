// UI walk：会话列表区的选择器与第 6 步（chat-harness「UI 走查会话元数据」）。分组、折叠、搜索与
// `分组方式` 的定位都集中在这里；`ui-walk-sessions.spec.ts` 的第 7、8、11 步经 `sections` 取分组，
// 第 11 步的「删除无提示」断言（`expectDeletedWithoutToast`）也在这里。
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { inspectSidebar, sessionList, type WalkProject } from "./ui-walk-layout.js";

export const CURRENT_SESSION = 'button[aria-current="true"]';
const NAV_OVERLAY = { name: "导航", exact: true } as const;
const EMPTY = "没有匹配的任务";

type Sections = { list: Locator; pinned: Locator; temporary: Locator; workspace: Locator };

// 默认视图（按工作空间）下与走查会话有关的三个分组；`workspace` 是名为 `name` 的工作空间分组。
export function sections(sidebar: Locator, name: string): Sections {
  const list = sessionList(sidebar);
  const named = (label: string) => list.getByRole("group", { name: label, exact: true });
  return {
    list,
    pinned: named("置顶任务"),
    temporary: named("临时空间"),
    workspace: named(name),
  };
}

// 会话按选中项定位（建会话后的标题每次运行都相同）：在 `home` 里，全列表恰一条，不在 `others` 的
// 任何一个里；不存在的分组计数自然为 0。先断言 `home`：条目迁移之前的 DOM 也满足全列表恰一条。
export async function expectSelectedIn(
  list: Locator,
  home: Locator,
  others: readonly Locator[],
): Promise<void> {
  await expect(home.locator(CURRENT_SESSION)).toHaveCount(1);
  await expect(list.locator(CURRENT_SESSION)).toHaveCount(1);
  for (const section of others) {
    await expect(section.locator(CURRENT_SESSION)).toHaveCount(0);
  }
}

// 第 11 步确认删除之后：选中的条目与标题为 `title` 的条目都从列表消失，且删除没有轻提示——条目
// 消失后页面任何位置都没有 `任务已删除`，也没有任何 Toast 元素。先断言列表本身还在（否则两条
// 计数 0 是空断言）。
export async function expectDeletedWithoutToast(
  page: Page,
  list: Locator,
  title: string,
): Promise<void> {
  await expect(list).toBeVisible();
  await expect(list.locator(CURRENT_SESSION)).toHaveCount(0);
  await expect(list.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  await expect(page.getByText("任务已删除")).toHaveCount(0);
  await expect(page.locator(".ui-toast")).toHaveCount(0);
}

// 第 6 步：会话恰一次出现在 `workspaceName` 分组里，没有 `筛选任务`；随后在同一侧栏里（mobile 的覆盖层
// 一直开着）折叠再展开该分组、按标题搜索、切换 `分组方式`。点击都是真实指针点击（无 `force`）：
// `分组方式` 的菜单 portal 到 `body`，画在覆盖层遮罩之下时会被 Playwright 的命中测试拦下。
// 结尾等焦点回到 `分组方式` 按钮（在覆盖层内）：`inspectSidebar` 随后按的 `Escape` 才关得掉覆盖层。
export async function step6Sidebar(
  page: Page,
  project: WalkProject,
  workspaceName: string,
  title: string,
): Promise<void> {
  const overlayStaysOpen = async () => {
    if (project === "mobile-dark")
      await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(1);
  };
  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, temporary, workspace } = sections(sidebar, workspaceName);
    const current = list.locator(CURRENT_SESSION);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await expect(current).toHaveAccessibleName(title);
    await expect(page.getByRole("button", { name: "筛选任务" })).toHaveCount(0);
    await expect(page.getByText("筛选任务")).toHaveCount(0);

    const header = workspace.getByRole("button", { name: workspaceName, exact: true });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(current).toHaveCount(0);
    await expect(workspace.getByRole("listitem")).toHaveCount(0);
    await overlayStaysOpen();
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expectSelectedIn(list, workspace, [pinned, temporary]);

    const entries = list.getByRole("listitem");
    const total = await entries.count();
    const search = list.getByRole("searchbox", { name: "搜索任务", exact: true });
    await search.fill(title);
    await expect(entries).toHaveCount(1);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await search.fill(randomUUID());
    await expect(list.getByText(EMPTY, { exact: true })).toBeVisible();
    await expect(entries).toHaveCount(0);
    await expect(list.getByRole("group")).toHaveCount(0);
    await search.fill("");
    await expect(list.getByText(EMPTY, { exact: true })).toHaveCount(0);
    await expect(entries).toHaveCount(total);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await overlayStaysOpen();

    const grouping = list.getByRole("button", { name: "分组方式", exact: true });
    const choose = async (name: string) => {
      await grouping.click();
      const item = page.getByRole("menuitemradio", { name, exact: true });
      await item.click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await overlayStaysOpen();
    };
    await choose("按时间");
    const today = list.getByRole("group", { name: "今天", exact: true });
    await expectSelectedIn(list, today, [pinned, workspace, temporary]);
    await expect(workspace).toHaveCount(0);
    await choose("按工作空间");
    await expect(today).toHaveCount(0);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await expect(grouping).toBeFocused();
  });
}
