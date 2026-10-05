// UI walk step helpers: an assistant message keeps its steps in one tool-call group that is
// collapsed by default, and a collapsed group has no step cards in the DOM. Every step assertion
// expands the group first.

import { expect, type Locator } from "@playwright/test";

export function toolGroup(message: Locator): Locator {
  return message.getByRole("group", { name: "工具调用" });
}

// 展开 `message` 的工具调用组并返回它；已展开则不动。点击在页面内直接触发：Playwright 的 click 会先把
// 控件滚进视口，那次滚动会解除转录的贴底。同一次求值里读拷入组件滚动锁的落点——它把被锁元素的
// 行内 `scrollbar-width` 置为 `none`：必须落在组自身，转录滚动容器不被碰（否则贴底跟随会被它解除）。
export async function expandToolGroup(message: Locator): Promise<Locator> {
  const group = toolGroup(message);
  const trigger = group.getByRole("button", { name: /个步骤/u });
  await expect(trigger).toBeVisible();
  const locked = await trigger.evaluate((el) => {
    if (!(el instanceof HTMLElement) || el.getAttribute("aria-expanded") === "true") return null;
    el.click();
    return ['[data-slot="tool-group-root"]', '[data-slot="thread-viewport"]'].map((selector) => {
      const target = el.closest(selector);
      return target instanceof HTMLElement ? target.style.scrollbarWidth : "missing";
    });
  });
  if (locked)
    expect(locked, "scroll lock lands on the group, not the transcript").toEqual(["none", ""]);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // 展开动画结束后再返回：调用方随后读转录高度。
  const content = group.locator('[data-slot="tool-group-content"]');
  await expect.poll(() => content.evaluate((el) => el.getAnimations().length)).toBe(0);
  return group;
}
