// UI walk step helpers: an assistant message keeps its steps in one tool-call group that is
// collapsed by default, and a collapsed group has no step cards in the DOM. Every step assertion
// expands the group first.

import { expect, type Locator, type Page } from "@playwright/test";

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
    // 之前的焦点在 `body`（没有元素持有焦点）时还原为 blur：对 `body` 调 focus 不是同一个状态。
    if (before instanceof HTMLElement && before !== document.body)
      before.focus({ preventScroll: true });
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

/**
 * html 产物卡的预览：卡内有两个同名动作按钮（头部图标、底部文字），点带文字的那个。预览打开后焦点在
 * 对话框的 `关闭` 按钮上而不在 iframe 里——焦点进了 sandbox iframe，父文档就收不到按键，Escape 关不掉
 * 对话框（jsdom 看不到这一点）。随后用 Escape 关闭，焦点回到打开它的按钮。
 */
export async function walkArtifactPreview(page: Page, file: string): Promise<void> {
  const card = page
    .getByRole("article", { name: "助手" })
    .getByRole("group", { name: file, exact: true });
  await expect(card.getByText("HTML", { exact: true })).toBeVisible();
  const opener = card
    .getByRole("button", { name: `打开网页预览 ${file}`, exact: true })
    .filter({ hasText: "打开网页预览" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: file, exact: true });
  const frame = dialog.locator(`iframe[title="${file}"]`);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(
    frame.contentFrame().getByRole("heading", { name: "WorkBuddy", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
}

/**
 * Whether the element painted on top at the centre of `target` is inside `layer`. Radix makes a
 * modal layer below the top one `pointer-events: none` (inline, as it does `body`), and a hit test
 * skips such elements whatever the paint order: the inline values on `target`'s ancestors are
 * lifted for the one synchronous hit test and put back, so the answer is the paint order.
 */
function paintedWithin(target: Locator, layer: string): Promise<boolean> {
  return target.evaluate((el, selector) => {
    const lifted: HTMLElement[] = [];
    for (let at: Element | null = el; at; at = at.parentElement) {
      if (at instanceof HTMLElement && at.style.pointerEvents === "none") {
        at.style.pointerEvents = "auto";
        lifted.push(at);
      }
    }
    try {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      // Nothing hit (the centre is outside the viewport) is not "inside the layer".
      return top !== null && top.closest(selector) !== null;
    } finally {
      for (const at of lifted) at.style.pointerEvents = "none";
    }
  }, layer);
}

/**
 * 产物面板（拷入层 sheet）：顶栏按钮打开，恰一行 `logicalPath`。从该行打开 html 预览——预览是面板之上的
 * 第二层：面板行按钮所在的点画在最上面的是预览的遮罩，预览中心画在最上面的是预览自己（jsdom 不做布局，
 * 只有这里能证明叠放次序）；焦点在预览的 `关闭` 上而不在 iframe 里，所以 Escape 先只关预览，面板仍开、焦点回到
 * 该行按钮。面板有两个 `关闭`（右上图标、底部按钮），点底部那个；面板消失后焦点回到顶栏按钮。
 */
export async function walkArtifactsPanel(
  page: Page,
  file: string,
  logicalPath: string,
): Promise<void> {
  const trigger = page.getByRole("banner").getByRole("button", { name: "产物面板", exact: true });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "产物面板", exact: true });
  const row = panel.locator('[data-slot="file-change-row"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-slot="file-change-path"]')).toHaveText(logicalPath);
  await expect(panel.getByText("当前任务暂无产物")).toHaveCount(0);
  const opener = row.getByRole("button", { name: `打开网页预览 ${file}`, exact: true });
  await expect.poll(() => paintedWithin(opener, '[data-slot="sheet-content"]')).toBe(true);
  await opener.click();

  const preview = page.getByRole("dialog", { name: file, exact: true });
  const close = preview.getByRole("button", { name: "关闭", exact: true });
  await expect(preview.locator(`iframe[title="${file}"]`)).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await expect(close).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME");
  await expect.poll(() => paintedWithin(preview, '[data-slot="dialog-content"]')).toBe(true);
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toBeVisible();
  const rowButton = sheet.locator(`button[aria-label="打开网页预览 ${file}"]`);
  await expect.poll(() => paintedWithin(rowButton, '[data-slot="dialog-overlay"]')).toBe(true);

  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(opener).toBeFocused();

  await panel
    .locator('[data-slot="sheet-footer"]')
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
