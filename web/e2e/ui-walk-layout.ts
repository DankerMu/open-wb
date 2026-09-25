// Shell layout, navigation and theme helpers for the UI walk.
// Project branches live here so the journey in ui-walk.spec.ts stays a single path.

import { expect, type Locator, type Page } from "@playwright/test";

export const DEV_ACCOUNT = "zhangsan";
const DEV_ROLE = "成员";
const THEME_STORAGE_KEY = "workbuddy-theme";
const SIDEBAR = { name: "侧栏", exact: true } as const;
const NAV_OVERLAY = { name: "导航", exact: true } as const;
const NARROW_DESKTOP = { width: 1024, height: 768 } as const;
const MEDIUM_DESKTOP = { width: 880, height: 800 } as const;

export type WalkProject = "desktop-light" | "mobile-dark";

type ThemeChoice = { label: "深色" | "浅色"; value: "dark" | "light" };

// 每个 project 选与 colorScheme 相反的主题，保证选择后背景确实变化。
const THEME_CHOICE: Record<WalkProject, ThemeChoice> = {
  "desktop-light": { label: "深色", value: "dark" },
  "mobile-dark": { label: "浅色", value: "light" },
};

export function walkProject(name: string): WalkProject {
  if (name === "desktop-light" || name === "mobile-dark") return name;
  throw new Error(`unknown ui-walk project: ${name}`);
}

// 仍在 authenticated 阶段：reload 只产生 200 的 /api/auth/me，oracle 放行。
export async function walkSidebarCollapse(page: Page): Promise<void> {
  const sidebar = page.getByRole("complementary", SIDEBAR);
  await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(48);
  await page.reload();
  await expectAuthenticatedRoute(page, "desktop-light", "/settings", "设置", "设置");
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(48);
  await sidebar.getByRole("button", { name: "展开侧栏" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(288);
  await expectPrincipalFooter(page, "desktop-light");
}

export async function expectDesktopLayout(page: Page): Promise<void> {
  const sidebar = await page.getByRole("complementary", SIDEBAR).boundingBox();
  const main = await page.getByRole("main").boundingBox();
  const viewportWidth = await page.evaluate(() => innerWidth);
  expect(sidebar).not.toBeNull();
  expect(main).not.toBeNull();
  if (!sidebar || !main) throw new Error("Application layout is not visible");
  expect(sidebar.width).toBeGreaterThanOrEqual(160);
  expect(sidebar.width).toBeLessThan(viewportWidth / 3);
  expect(main.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width - 1);
  await expectNoHorizontalOverflow(page);
}

export function mainBackground(page: Page): Promise<string> {
  return page.getByRole("main").evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, viewportWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    innerWidth,
  ]);
  expect(scrollWidth, "document scrollWidth <= innerWidth").toBeLessThanOrEqual(viewportWidth);
  // >760px 时 body/.app-shell/main 均 overflow:hidden，文档宽度恒不溢出；路由内容须在 main 上复核。
  const [mainScroll, mainClient] = await page
    .getByRole("main")
    .evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(mainScroll, "main scrollWidth <= clientWidth").toBeLessThanOrEqual(mainClient ?? 0);
}

// 每路由的外壳断言：无横向溢出、主区可见；窄屏另断 `打开导航` 可见且覆盖层默认关闭。
async function expectRouteLayout(page: Page, project: WalkProject): Promise<void> {
  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole("main")).toBeVisible();
  if (project === "mobile-dark") {
    await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
    await expect(page.getByRole("banner").getByRole("button", { name: "打开导航" })).toBeVisible();
  }
}

async function withViewport(
  page: Page,
  size: { width: number; height: number },
  check: () => Promise<void>,
): Promise<void> {
  const original = page.viewportSize();
  if (!original) throw new Error("ui-walk requires a fixed viewport");
  await page.setViewportSize(size);
  try {
    await check();
  } finally {
    await page.setViewportSize(original);
  }
}

// desktop 逐路由临时缩到 1024×768 断无溢出；/files 另断树栏宽度档位（mobile 为纵向堆叠）。
export async function expectRouteViewports(
  page: Page,
  project: WalkProject,
  path: string,
): Promise<void> {
  if (path === "/files") await expectFilesColumns(page, project);
  if (project !== "desktop-light") return;
  await withViewport(page, NARROW_DESKTOP, () => expectRouteLayout(page, project));
}

async function expectFilesColumns(page: Page, project: WalkProject): Promise<void> {
  const tree = page.getByRole("complementary", { name: "工作空间文件" });
  const preview = page.getByRole("region", { name: "文件预览" });
  if (project === "mobile-dark") {
    const [treeBox, previewBox] = await boxes(tree, preview);
    expect(treeBox.y + treeBox.height, "tree stacked above preview").toBeLessThanOrEqual(
      previewBox.y + 1,
    );
    return;
  }
  await expectTreeBesidePreview(tree, preview, 280);
  await withViewport(page, MEDIUM_DESKTOP, async () => {
    await expectTreeBesidePreview(tree, preview, 210);
    await expectNoHorizontalOverflow(page);
  });
}

async function expectTreeBesidePreview(
  tree: Locator,
  preview: Locator,
  width: number,
): Promise<void> {
  const treeWidth = async () => (await tree.boundingBox())?.width ?? 0;
  await expect.poll(treeWidth, `tree column ${width}px`).toBeGreaterThanOrEqual(width - 1);
  await expect.poll(treeWidth, `tree column ${width}px`).toBeLessThanOrEqual(width + 1);
  const [treeBox, previewBox] = await boxes(tree, preview);
  expect(previewBox.x, "preview right of tree").toBeGreaterThanOrEqual(
    treeBox.x + treeBox.width - 1,
  );
}

async function boxes(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) throw new Error("files columns are not visible");
  return [a, b] as const;
}

// 长名行：名称被省略、行本身不溢出、title 为全名；desktop 另在 880 宽下复核行与文档不溢出。
export async function expectTruncatedRow(
  page: Page,
  project: WalkProject,
  row: Locator,
  fullName: string,
): Promise<void> {
  await expect(row).toHaveAttribute("title", fullName);
  const [nameScroll, nameClient] = await row
    .locator(".files-tree-name")
    .evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(nameScroll, "tree row name is ellipsized").toBeGreaterThan(nameClient ?? 0);
  await expectRowFits(row);
  if (project !== "desktop-light") return;
  await withViewport(page, MEDIUM_DESKTOP, async () => {
    await expectRowFits(row);
    await expectNoHorizontalOverflow(page);
  });
}

async function expectRowFits(row: Locator): Promise<void> {
  const [scrollWidth, clientWidth] = await row.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scrollWidth, "tree row does not overflow").toBeLessThanOrEqual(clientWidth ?? 0);
}

export async function expectScrollableX(container: Locator): Promise<void> {
  await expect(container).toBeVisible();
  expect(await container.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
}

// 必须在受控回合 held 期间调用：运行中的会话项/步骤卡带 .ui-pulse。
export async function expectReducedMotionToggle(page: Page): Promise<void> {
  const pulse = page.locator(".ui-pulse:visible").first();
  await expect(pulse).toBeVisible();
  const animation = () => pulse.evaluate((el) => getComputedStyle(el).animationName);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(animation, "reduced motion disables .ui-pulse").toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(animation, "no-preference restores .ui-pulse").not.toBe("none");
}

async function openNav(page: Page): Promise<Locator> {
  const overlay = page.getByRole("dialog", NAV_OVERLAY);
  await expect(overlay).toHaveCount(0);
  const trigger = page.getByRole("banner").getByRole("button", { name: "打开导航" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(overlay).toBeVisible();
  return overlay;
}

// 返回侧栏：desktop 在文档流中；mobile 先打开覆盖层（调用方负责关闭或经路由点击关闭）。
export async function openSidebar(page: Page, project: WalkProject): Promise<Locator> {
  if (project === "desktop-light") return page.getByRole("complementary", SIDEBAR);
  return (await openNav(page)).getByRole("complementary", SIDEBAR);
}

// 只断言不点路由：mobile 断言后按 Escape 关闭覆盖层，避免 Radix aria-hidden 影响后续定位。
async function inspectSidebar(
  page: Page,
  project: WalkProject,
  inspect: (sidebar: Locator) => Promise<void>,
): Promise<void> {
  await inspect(await openSidebar(page, project));
  if (project === "desktop-light") return;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
}

export async function clickRoute(page: Page, project: WalkProject, label: string): Promise<void> {
  const sidebar = await openSidebar(page, project);
  await sidebarLink(sidebar.getByRole("navigation", { name: "主导航" }), label).click();
  if (project === "mobile-dark") {
    await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
  }
}

export async function expectAuthenticatedRoute(
  page: Page,
  project: WalkProject,
  path: string,
  heading: string,
  currentLabel: string,
) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  if (path === "/files") {
    const workspacePage = page.locator("main");
    await expect(workspacePage.getByRole("button", { name: "选择工作空间" })).toBeVisible();
    await expect(
      workspacePage.getByRole("heading", { level: 2, name: "工作空间目录", exact: true }),
    ).toBeVisible();
  }
  await expectRouteLayout(page, project);
  await inspectSidebar(page, project, async (sidebar) => {
    const navigation = sidebar.getByRole("navigation", { name: "主导航" });
    await expect(navigation.locator("[aria-current=page]")).toHaveCount(1);
    const currentLink = sidebarLink(navigation, currentLabel);
    await expect(currentLink).toHaveAttribute("href", path);
    await expect(currentLink).toHaveAttribute("aria-current", "page");
  });
}

function sidebarLink(navigation: Locator, label: string) {
  return navigation.getByRole("link", { name: label });
}

export async function expectPrincipalFooter(page: Page, project: WalkProject) {
  await inspectSidebar(page, project, async (sidebar) => {
    const footer = sidebar.locator("footer");
    await expect(footer.getByText(DEV_ACCOUNT, { exact: true })).toBeVisible();
    await expect(footer.getByText(DEV_ROLE, { exact: true })).toBeVisible();
  });
}

export async function switchTheme(
  page: Page,
  project: WalkProject,
  initialBackground: string,
): Promise<void> {
  const choice = THEME_CHOICE[project];
  await page.getByRole("radio", { name: choice.label, exact: true }).check();
  await expectTheme(page, choice, initialBackground);
  await page.reload();
  await expectAuthenticatedRoute(page, project, "/settings", "设置", "设置");
  await expectTheme(page, choice, initialBackground);
}

async function expectTheme(page: Page, choice: ThemeChoice, initialBackground: string) {
  await expect(page.getByRole("radio", { name: choice.label, exact: true })).toBeChecked();
  await expect(page.getByText(`当前生效：${choice.label}`, { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", choice.value);
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBe(
    choice.value,
  );
  await expect
    .poll(() => mainBackground(page), "main background differs from the initial theme")
    .not.toBe(initialBackground);
}
