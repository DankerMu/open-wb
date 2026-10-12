// UI walk steps for the workspace sidebar of the session page (workspace-sidebar「布局与开合」): what
// jsdom cannot show. `desktop-light`: the sidebar sits beside the conversation without horizontal
// overflow, the separator resizes both by keyboard and by dragging and stops before either side is
// gone, and the width survives a reload while the open state does not. `mobile-dark`: the sidebar is
// a modal dialog over the whole viewport, Tab stays inside it and Escape hands the focus back
// without scrolling the thread. No file is selected there: no preview token is issued and no request
// leaves the base origin.
//
// `walkViewDetails` is the 查看详情 of the file-changes card (workspace-sidebar「从卡片定位到文件」): it
// opens the sidebar on the written file without navigating, and the preview is an iframe on the
// preview origin this page was issued — the one request target outside the base origin the walk
// oracle admits (ui-walk-oracle.ts).
//
// `desktop-light` also walks the open action that collapses the shell sidebar (#1363): at 1200 the
// two minimum widths fit and nothing collapses, not even when the window is then narrowed to 800 with
// the sidebar open; at 800 the open click collapses the shell sidebar, both panels reach their minimum
// widths once the collapse transition has ended and the separator moves by keyboard; closing does not
// expand it again. The walk expands the shell sidebar before returning: later steps need the session
// list.

import { expect, type Frame, type Locator, type Page } from "@playwright/test";
import { type WalkProject, withViewport } from "./ui-walk-layout.js";

const NAME = "工作空间侧边栏";
const CLOSE = "关闭工作空间侧边栏";
const ONLY_CHANGES = "只看本会话改动";
const STORAGE_KEY = "workbuddy-workspace-sidebar";
/** The shell's own sidebar (spa-shell) and the key its collapse preference is stored under. */
const SHELL_SIDEBAR = "侧栏";
const SHELL_STORAGE_KEY = "workbuddy-sidebar";
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
  // The two minimum widths fit beside the expanded shell sidebar: the open action leaves it alone.
  await expect(shellSidebar(page)).toHaveAttribute("data-collapsed", "false");

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

function shellSidebar(page: Page): Locator {
  return page.getByRole("complementary", { name: SHELL_SIDEBAR, exact: true });
}

/** Resolves once two successive polls of the width agree (a transition has ended); returns it. */
async function settledWidth(target: Locator): Promise<number> {
  let last = Number.NaN;
  await expect
    .poll(async () => {
      const previous = last;
      last = await widthOf(target);
      return last === previous;
    })
    .toBe(true);
  return last;
}

/**
 * The open action and the shell sidebar (workspace-sidebar「放不下时折叠外壳侧栏」「只在打开的那一下
 * 判断」). Starts and ends with the workspace sidebar closed and the shell sidebar expanded.
 */
async function walkFit(page: Page, file: string): Promise<void> {
  const button = trigger(page);
  const region = page.getByRole("complementary", { name: NAME, exact: true });
  const group = page.locator('[data-slot="resizable-panel-group"]');
  const conversation = group.locator('[data-slot="resizable-panel"]').first();
  const separator = page.getByRole("separator");
  const shell = shellSidebar(page);
  const shellStored = () =>
    page.evaluate((key) => window.localStorage.getItem(key), SHELL_STORAGE_KEY);
  const height = page.viewportSize()?.height ?? 0;
  const open = async () => {
    await button.click();
    await expect(region.getByRole("button", { name: file, exact: true })).toBeVisible();
  };
  const close = async () => {
    await region.getByRole("button", { name: CLOSE, exact: true }).click();
    await expect(region).toHaveCount(0);
  };
  await expect(shell).toHaveAttribute("data-collapsed", "false");
  const before = await shellStored();

  // 1200: both minimum widths fit. Narrowing the window with the sidebar open does not collapse.
  await withViewport(page, { width: 1200, height }, async () => {
    await open();
    await expect(shell).toHaveAttribute("data-collapsed", "false");
    const wide = await settledWidth(group);
    await page.setViewportSize({ width: 800, height });
    await expect.poll(() => widthOf(group)).toBeLessThan(wide);
    await settledWidth(group);
    await expect(shell).toHaveAttribute("data-collapsed", "false");
    expect(await shellStored()).toBe(before);
    await close();
    await expect(shell).toHaveAttribute("data-collapsed", "false");
  });

  // 800: they do not fit beside the expanded shell sidebar, so the open click collapses it.
  await withViewport(page, { width: 800, height }, async () => {
    await expect(shell).toHaveAttribute("data-collapsed", "false");
    await open();
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    expect(await shellStored()).toBe("collapsed");
    await expect(button).toBeFocused();
    await expect(separator).toHaveCount(1);
    // Once the collapse transition has ended neither side is below its minimum width.
    await settledWidth(group);
    expect(await widthOf(conversation)).toBeGreaterThanOrEqual(MIN_WIDTH.conversation - TOLERANCE);
    const beside = await widthOf(region);
    expect(beside).toBeGreaterThanOrEqual(MIN_WIDTH.sidebar - TOLERANCE);
    // The separator moves: the earlier drag left the sidebar at its minimum, so widen it.
    await separator.focus();
    for (let presses = 0; presses < 3; presses += 1) await page.keyboard.press("ArrowLeft");
    await expect.poll(() => widthOf(region)).toBeGreaterThan(beside);
    expect(await widthOf(conversation)).toBeGreaterThanOrEqual(MIN_WIDTH.conversation - TOLERANCE);
    expect(await overflow(page)).toBe(0);
    // Closing does not bring the shell sidebar back.
    await close();
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    expect(await shellStored()).toBe("collapsed");
    // Nor does a reload: the collapse went through the stored preference.
    await page.reload();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(shell).toHaveAttribute("data-collapsed", "true");
  });

  // The collapse is persistent; later walk steps need the session list.
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(shell).toHaveAttribute("data-collapsed", "false");
  expect(await shellStored()).toBe("expanded");
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
 * turn). Leaves the sidebar closed and, on `desktop-light`, the shell sidebar expanded.
 */
export async function walkWorkspaceSidebar(
  page: Page,
  file: string,
  project: WalkProject,
): Promise<void> {
  if (project === "mobile-dark") return walkOverlay(page, file);
  await walkBeside(page, file);
  await walkFit(page, file);
}

type Written = {
  /** The file the turn wrote, at the workspace root. */
  file: string;
  /** Its logical path `<account>/<dir>/<file>`: what the card row shows and names its button after. */
  logicalPath: string;
  workspaceId: string;
};

function previewBase(body: unknown): string {
  if (body === null || typeof body !== "object" || !("base" in body)) {
    throw new Error("preview-token 200 body has no base");
  }
  if (typeof body.base !== "string") throw new Error("preview-token base is not a string");
  return body.base;
}

/**
 * 查看详情 of the card row of `written` (chat-harness「UI 走查会话元数据」step 5): the sidebar opens with
 * the file selected and marked, the URL stays and the main frame does not navigate; the preview is
 * an iframe on the issued preview origin with the three-token `sandbox`, and the written page's
 * heading shows inside it; 只看本会话改动 leaves exactly that file. `desktop-light`: the focus stays
 * on the clicked button. `mobile-dark`: it goes to 关闭 and Escape hands it back to the clicked
 * button without scrolling the thread. Leaves the sidebar closed.
 */
export async function walkViewDetails(
  page: Page,
  project: WalkProject,
  { file, logicalPath, workspaceId }: Written,
): Promise<void> {
  const wide = project === "desktop-light";
  const opener = page
    .getByRole("article", { name: "助手" })
    .getByRole("button", { name: `查看详情 ${logicalPath}`, exact: true });
  const sidebar = wide
    ? page.getByRole("complementary", { name: NAME, exact: true })
    : page.getByRole("dialog", { name: NAME, exact: true });
  const close = sidebar.getByRole("button", { name: CLOSE, exact: true });
  const tree = sidebar.getByRole("navigation", { name: "工作空间目录树" });
  const row = tree.getByRole("button", { name: file, exact: true });
  const thread = page.locator('[data-slot="thread-viewport"]');
  const tokenPath = `/api/workspaces/${workspaceId}/preview-token`;
  const address = page.url();
  let navigations = 0;
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  };
  page.on("framenavigated", onNavigated);

  // `base` comes from the token response this click causes (the preview port is assigned by the system).
  const [issued] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === tokenPath,
    ),
    opener.click(),
  ]);
  await expect(row, "查看详情: the file is selected").toHaveAttribute("aria-current", "true");
  await expect(row, "查看详情: the file is marked").toHaveAccessibleDescription("本会话已改动");
  if (wide) {
    await expect(page.getByRole("dialog", { name: NAME, exact: true })).toHaveCount(0);
    await expect(opener, "查看详情: focus stays on the clicked button").toBeFocused();
  } else {
    await expect(sidebar).toHaveAttribute("aria-modal", "true");
    await expect(close, "查看详情: focus enters the layer at 关闭").toBeFocused();
  }

  expect(issued.status(), "preview-token status").toBe(200);
  const base = previewBase(await issued.json());
  expect(new URL(base).origin, "preview origin is not the page origin").not.toBe(
    new URL(address).origin,
  );
  const frame = sidebar.getByRole("region", { name: "文件预览" }).locator("iframe");
  await expect(frame, "查看详情: one preview frame").toHaveCount(1);
  await expect(frame, "preview frame src").toHaveAttribute("src", `${base}${file}`);
  await expect(frame, "preview frame sandbox").toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-modals",
  );
  await expect(
    frame.contentFrame().getByRole("heading", { name: "WorkBuddy", exact: true }),
    "the written page renders inside the frame",
  ).toBeVisible();
  // The loaded frame did not take the focus.
  await expect(wide ? opener : close, "focus after the frame loaded").toBeFocused();

  // 只看本会话改动: the workspace row and that one file, still selected; then back off.
  const only = sidebar.getByRole("button", { name: ONLY_CHANGES, exact: true });
  await only.click();
  await expect(only).toHaveAttribute("aria-pressed", "true");
  await expect(tree.locator('[data-slot="tree-name"]')).toHaveCount(2);
  await expect(row).toHaveAttribute("aria-current", "true");
  await only.click();
  await expect(only).toHaveAttribute("aria-pressed", "false");

  if (wide) {
    await close.click();
    await expect(sidebar).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  } else {
    // Read with the layer open: the click itself may have scrolled the card into view. The card is
    // in view here, so this does not catch a focus handed back without `preventScroll` (measured:
    // that mutation leaves the walk green); chat-workspace-sidebar-reveal.test.tsx pins the argument.
    const scrolled = await thread.evaluate((el) => el.scrollTop);
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveCount(0);
    await expect(opener, "查看详情: focus returns to the clicked button").toBeFocused();
    expect(await thread.evaluate((el) => el.scrollTop), "thread scrollTop after closing").toBe(
      scrolled,
    );
  }
  page.off("framenavigated", onNavigated);
  expect(navigations, "查看详情: main-frame navigations").toBe(0);
  expect(page.url(), "查看详情: the address").toBe(address);
}
