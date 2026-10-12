// UI walk steps for the workspace sidebar of the session page (workspace-sidebar「布局与开合」): what
// jsdom cannot show. `desktop-light`: the sidebar sits beside the conversation without horizontal
// overflow, the separator resizes both by keyboard and by dragging and stops before either side is
// gone, and the width survives a reload while the open state does not. `mobile-dark`: the sidebar is
// a modal dialog over the whole viewport, Tab stays inside it and Escape hands the focus back
// without scrolling the thread. No file is selected: no preview token is issued and no request
// leaves the base origin.

import { expect, type Locator, type Page } from "@playwright/test";
import type { WalkProject } from "./ui-walk-layout.js";

const NAME = "工作空间侧边栏";
const CLOSE = "关闭工作空间侧边栏";
const STORAGE_KEY = "workbuddy-workspace-sidebar";
/**
 * The minimum widths in pixels (design D26): the conversation panel and the sidebar cannot be
 * dragged below them. The conversation is measured on its panel, not on the chat column inside it,
 * which is narrower by the panel's padding.
 */
const MIN_WIDTH = { conversation: 320, sidebar: 240 };
/** Sub-pixel rounding of the split. */
const TOLERANCE = 1;

async function widthOf(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  if (!box) throw new Error("expected a rendered box");
  return box.width;
}

function trigger(page: Page): Locator {
  return page.getByRole("banner").getByRole("button", { name: NAME, exact: true });
}

function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Drags the separator horizontally to viewport x `to` and releases it there. */
async function dragSeparator(page: Page, separator: Locator, to: number): Promise<void> {
  const box = await separator.boundingBox();
  if (!box) throw new Error("expected the separator to be rendered");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(to, y, { steps: 12 });
  await page.mouse.up();
}

async function walkBeside(page: Page, file: string): Promise<void> {
  const button = trigger(page);
  const region = page.getByRole("complementary", { name: NAME, exact: true });
  const column = page.locator('[data-slot="chat-column"]');
  const group = page.locator('[data-slot="resizable-panel-group"]');
  const conversation = group.locator('[data-slot="resizable-panel"]').first();
  const separator = page.getByRole("separator");
  const stored = () => page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const alone = await widthOf(column);

  await button.click();
  await expect(region.getByRole("button", { name: file, exact: true })).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: NAME, exact: true })).toHaveCount(0);
  await expect(separator).toHaveCount(1);

  // Side by side: the conversation got narrower and ends where the sidebar starts.
  const columnBox = await column.boundingBox();
  const regionBox = await region.boundingBox();
  if (!columnBox || !regionBox) throw new Error("expected both columns to be rendered");
  expect(columnBox.width).toBeLessThan(alone);
  expect(regionBox.x).toBeGreaterThanOrEqual(columnBox.x + columnBox.width);
  expect(await overflow(page)).toBe(0);
  // The default width: 40% of the main area.
  const total = await widthOf(group);
  expect(Math.abs(regionBox.width / total - 0.4)).toBeLessThan(0.01);
  // Not modal: the composer still takes input.
  const composer = page.getByRole("textbox", { name: "给助手发消息" });
  await composer.fill("侧边栏开着也能输入");
  await expect(composer).toHaveValue("侧边栏开着也能输入");
  await composer.fill("");

  // Opening lays the panels out but stores nothing: only a resize by the user is remembered.
  expect(await stored()).toBeNull();

  // Keyboard: the separator is focusable and the arrow keys move it both ways.
  await separator.focus();
  await expect(separator).toBeFocused();
  for (let presses = 0; presses < 3; presses += 1) await page.keyboard.press("ArrowLeft");
  await expect.poll(() => widthOf(region)).toBeGreaterThan(regionBox.width);
  expect(await widthOf(column)).toBeLessThan(columnBox.width);
  const widened = await widthOf(region);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => widthOf(region)).toBeLessThan(widened);
  await expect.poll(stored).toMatch(/^\d+(\.\d+)?$/);

  // Dragging to either end stops at that side's minimum width.
  await dragSeparator(page, separator, 0);
  const widest = await widthOf(region);
  const floor = await widthOf(conversation);
  expect(Math.abs(floor - MIN_WIDTH.conversation)).toBeLessThanOrEqual(TOLERANCE);
  await dragSeparator(page, separator, page.viewportSize()?.width ?? 0);
  const narrowest = await widthOf(region);
  expect(Math.abs(narrowest - MIN_WIDTH.sidebar)).toBeLessThanOrEqual(TOLERANCE);
  expect(widest).toBeGreaterThan(narrowest);
  // Neither end is the default width, so the reload below cannot pass by falling back to it.
  expect(Math.abs(narrowest - regionBox.width)).toBeGreaterThan(40);
  expect(await overflow(page)).toBe(0);

  // Reload with the separator left at an end: closed at first, the same width once reopened.
  await page.reload();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(region).toHaveCount(0);
  await button.click();
  await expect(region.getByRole("button", { name: file, exact: true })).toBeVisible();
  expect(Math.abs((await widthOf(region)) - narrowest)).toBeLessThan(1);

  await region.getByRole("button", { name: CLOSE, exact: true }).click();
  await expect(region).toHaveCount(0);
  await expect(separator).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
}

async function walkOverlay(page: Page, file: string): Promise<void> {
  const button = trigger(page);
  const layer = page.getByRole("dialog", { name: NAME, exact: true });
  const thread = page.locator('[data-slot="thread-viewport"]');
  const scrolled = await thread.evaluate((el) => el.scrollTop);

  await button.click();
  await expect(layer.getByRole("button", { name: file, exact: true })).toBeVisible();
  await expect(layer).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("complementary", { name: NAME, exact: true })).toHaveCount(0);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect(layer.getByRole("button", { name: CLOSE, exact: true })).toBeFocused();
  // The layer covers the viewport once its slide-in has ended.
  const viewport = page.viewportSize();
  await expect
    .poll(async () => {
      const box = await layer.boundingBox();
      return box && [box.x, box.y, box.width, box.height].map(Math.round);
    })
    .toEqual([0, 0, viewport?.width, viewport?.height]);

  for (let presses = 0; presses < 12; presses += 1) {
    await page.keyboard.press("Tab");
    const inside = await layer.evaluate((el) => el.contains(document.activeElement));
    expect(inside, `focus after Tab ${presses + 1} stays in the layer`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(layer).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  expect(await thread.evaluate((el) => el.scrollTop)).toBe(scrolled);
}

/**
 * Opens the sidebar of the current session from the top bar; its tree lists `file` (written by the
 * turn). Leaves the sidebar closed with the focus on the top-bar button.
 */
export async function walkWorkspaceSidebar(
  page: Page,
  file: string,
  project: WalkProject,
): Promise<void> {
  await (project === "desktop-light" ? walkBeside(page, file) : walkOverlay(page, file));
}
