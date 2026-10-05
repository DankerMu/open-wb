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
  await expectFocusRingInside(trigger);
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

// 键盘焦点环不被组裁掉：组为滚动锁带着 `overflow`，摘要按钮又占满整宽，画在按钮外的 outline 会被左右
// 裁掉。按一次 Shift 让焦点进入键盘可见态（不滚动、不触发按钮），用 `preventScroll` 聚焦后量 outline
// 外框（按钮框外扩 outline 宽度 + offset）是否四边都在组的 client 框内，再把焦点还回去。
async function expectFocusRingInside(trigger: Locator): Promise<void> {
  await trigger.page().keyboard.press("Shift");
  const ring = await trigger.evaluate((el) => {
    const root = el.closest('[data-slot="tool-group-root"]');
    if (!(el instanceof HTMLElement) || !(root instanceof HTMLElement)) return null;
    const before = document.activeElement;
    el.focus({ preventScroll: true });
    const style = getComputedStyle(el);
    const grow = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const box = el.getBoundingClientRect();
    const outer = root.getBoundingClientRect();
    const left = outer.left + root.clientLeft;
    const top = outer.top + root.clientTop;
    const result = {
      visible: el.matches(":focus-visible"),
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      overflow: [
        left - (box.left - grow),
        top - (box.top - grow),
        box.right + grow - (left + root.clientWidth),
        box.bottom + grow - (top + root.clientHeight),
      ].map((px) => Math.max(0, Math.round(px * 100) / 100)),
    };
    if (before instanceof HTMLElement) before.focus({ preventScroll: true });
    else el.blur();
    return result;
  });
  expect(ring, "focus ring [left, top, right, bottom] overflow of the group, px").toEqual({
    visible: true,
    style: "solid",
    width: 2,
    overflow: [0, 0, 0, 0],
  });
}
