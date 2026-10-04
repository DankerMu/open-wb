// Shell layout, navigation and theme helpers for the UI walk.
// Project branches live here so the journey in ui-walk.spec.ts stays a single path.

import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { isExpectedUnauthorizedNetworkLog } from "./ui-walk-oracle.js";

export const DEV_ACCOUNT = "zhangsan";
const DEV_ROLE = "成员";
const THEME_STORAGE_KEY = "workbuddy-theme";
const SIDEBAR = { name: "侧栏", exact: true } as const;
const NAV_OVERLAY = { name: "导航", exact: true } as const;
const WIDE_DESKTOP = { width: 1440, height: 900 } as const;
const NARROW_DESKTOP = { width: 1024, height: 768 } as const;
const MEDIUM_DESKTOP = { width: 880, height: 800 } as const;

export type WalkProject = "desktop-light" | "mobile-dark";

// textPrimary：该主题的 --wb-text-primary 计算值（web/src/styles/tokens.css）。
type ThemeChoice = { label: "深色" | "浅色"; value: "dark" | "light"; textPrimary: string };

// 每个 project 选与 colorScheme 相反的主题，保证选择后背景确实变化。
const THEME_CHOICE: Record<WalkProject, ThemeChoice> = {
  "desktop-light": { label: "深色", value: "dark", textPrimary: "rgb(255, 255, 255)" },
  "mobile-dark": { label: "浅色", value: "light", textPrimary: "rgb(0, 0, 0)" },
};

// body 的计算底色（--background → --wb-home-bg-secondary）与文字色（--foreground → --wb-text-primary）。
const BODY_COLORS = {
  light: { background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)" },
  dark: { background: "rgb(20, 20, 20)", color: "rgb(255, 255, 255)" },
} as const;

export function walkProject(name: string): WalkProject {
  if (name === "desktop-light" || name === "mobile-dark") return name;
  throw new Error(`unknown ui-walk project: ${name}`);
}

// 仍在 authenticated 阶段：reload 只产生 200 的 /api/auth/me，oracle 放行。
export async function walkSidebarCollapse(page: Page): Promise<void> {
  const sidebar = page.getByRole("complementary", SIDEBAR);
  const width = async () => (await sidebar.boundingBox())?.width ?? Number.NaN;
  const expanded = await width();
  await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.reload();
  await expectAuthenticatedRoute(page, "desktop-light", "/settings", "设置", "设置");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  // 相对几何：reload 后折叠态直接渲染（无宽度过渡），此时的宽度须小于展开宽度；展开后重新变宽。
  const collapsed = await width();
  expect(collapsed, "collapsed sidebar is narrower than expanded").toBeLessThan(expanded);
  await sidebar.getByRole("button", { name: "展开侧栏" }).click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await expect.poll(width, "expanded sidebar is wider than collapsed").toBeGreaterThan(collapsed);
  await expectPrincipalFooter(page, "desktop-light");
}

const LOGOUT_ROUTE = "**/api/auth/logout";
// web/src/lib/api.ts 的 REQUEST_FAILED_MESSAGE。
const LOGOUT_FAILURE = "请求失败，请稍后重试";

// 折叠浮出的退出失败提示（spa-shell「退出失败提示可关闭」）：折叠态侧栏 overflow:hidden 且只有图标列宽，
// 提示须脱离裁剪浮到侧栏右侧、可点。POST /api/auth/logout 由 route 应答、不到服务器，会话不受影响；
// 结束前 unroute 并展开侧栏，后续旅程（含最后的真实退出）照常。
// 失败用「2xx 但不是 204」触发（客户端按请求失败处理）：4xx/5xx 或 abort 会让 Chromium 记一条
// console error，而 oracle 只放行 /api/auth/me 的 401。403 + 错误信封的文案路径由 jsdom 用例覆盖。
export async function walkCollapsedLogoutFailure(page: Page): Promise<void> {
  const sidebar = page.getByRole("complementary", SIDEBAR);
  const trigger = sidebar.getByRole("button", { name: "用户菜单" });
  let answered = 0;
  await page.route(LOGOUT_ROUTE, (route) => {
    answered += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  try {
    await sidebar.getByRole("button", { name: "折叠侧栏" }).click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await trigger.click();
    await page.getByRole("menuitem", { name: "退出登录" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "退出" }).click();

    const alert = sidebar.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(LOGOUT_FAILURE);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(answered, "logout answered by the route exactly once").toBe(1);
    const dismiss = alert.getByRole("button", { name: "关闭提示" });
    await expectFloatsOutOfSidebar(sidebar, alert, dismiss);

    await dismiss.click();
    await expect(alert).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(answered, "dismissing sends no logout request").toBe(1);
  } finally {
    await page.unroute(LOGOUT_ROUTE);
  }
  await sidebar.getByRole("button", { name: "展开侧栏" }).click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  // 仍是已登录外壳：路由、标题、导航与用户区都在。
  await expectAuthenticatedRoute(page, "desktop-light", "/settings", "设置", "设置");
  await expectPrincipalFooter(page, "desktop-light");
}

// 布局盒不反映祖先裁剪（被 overflow:hidden 裁掉的提示，其盒同样越过侧栏右缘），所以除右缘比较外，
// 再用命中测试证明越出侧栏的部分确实画了出来：`关闭提示` 中心点整个在侧栏之外，且命中的就是它。
async function expectFloatsOutOfSidebar(
  sidebar: Locator,
  alert: Locator,
  dismiss: Locator,
): Promise<void> {
  // 折叠的宽度过渡结束后侧栏右缘才稳定，轮询到条件成立。
  await expect
    .poll(async () => {
      const aside = await sidebar.boundingBox();
      const note = await alert.boundingBox();
      const button = await dismiss.boundingBox();
      if (!aside || !note || !button) return "not laid out";
      const asideRight = aside.x + aside.width;
      if (note.x + note.width <= asideRight) return "alert right edge within sidebar";
      return button.x >= asideRight ? "floats" : "dismiss button overlaps sidebar";
    }, "alert floats to the right of the collapsed sidebar")
    .toBe("floats");
  const hit = await dismiss.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && button.contains(top);
  });
  expect(hit, "关闭提示 is the hit target at its own centre (not clipped by the sidebar)").toBe(
    true,
  );
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

/** Page background: `body` is its only source; the shell and `main` paint nothing (#420). */
export function pageBackground(page: Page): Promise<string> {
  return page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, viewportWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    innerWidth,
  ]);
  expect(scrollWidth, "document scrollWidth <= innerWidth").toBeLessThanOrEqual(viewportWidth);
  // >760px 时 body/外壳根/main 均 overflow:hidden，文档宽度恒不溢出；路由内容须在 main 上复核。
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

export async function withViewport(
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
  if (path === "/files") {
    await expectFilesColumns(page, project);
    await expectLegacyOverPreflight(page);
  }
  if (project !== "desktop-light") return;
  await withViewport(page, NARROW_DESKTOP, () => expectRouteLayout(page, project));
}

// #424 欢迎态首屏：≥761px 五张最佳实践卡同一行（offsetTop 相同）；免责声明底边不超出视口，
// 也不被 .chat-main 裁掉。desktop 在 1440×900 与 1024×768 各测一次，mobile 即 390×844。
export async function expectWelcomeFirstScreen(page: Page, project: WalkProject): Promise<void> {
  if (project === "mobile-dark") {
    await expectDisclaimerInView(page, viewportLabel(page));
    return;
  }
  for (const size of [WIDE_DESKTOP, NARROW_DESKTOP]) {
    await withViewport(page, size, async () => {
      await expectPlaybooksOneRow(page, viewportLabel(page));
      await expectDisclaimerInView(page, viewportLabel(page));
    });
  }
}

function viewportLabel(page: Page): string {
  const size = page.viewportSize();
  return size ? `${size.width}x${size.height}` : "unknown viewport";
}

async function expectPlaybooksOneRow(page: Page, label: string): Promise<void> {
  const cards = page
    .getByRole("region", { name: "最佳实践案例" })
    .locator(".chat-playbooks-row > li");
  await expect(cards).toHaveCount(5);
  // 各卡 offsetTop 相对首卡的差值；全 0 即单行，失败时直接显示换行形态（如 [0,0,x,x,y]）。
  await expect
    .poll(
      () =>
        cards.evaluateAll((items) => {
          const tops = items.map((li) => (li as HTMLElement).offsetTop);
          return tops.map((top) => top - (tops[0] ?? 0));
        }),
      `${label}: five playbook cards share one offsetTop`,
    )
    .toEqual([0, 0, 0, 0, 0]);
}

async function expectDisclaimerInView(page: Page, label: string): Promise<void> {
  const disclaimer = page.getByText("内容由 AI 生成，请核实重要信息", { exact: true });
  await expect(disclaimer).toBeVisible();
  await expect
    .poll(
      () =>
        disclaimer.evaluate((el) => {
          const clip = el.closest(".chat-main")?.getBoundingClientRect().bottom ?? innerHeight;
          return Math.ceil(el.getBoundingClientRect().bottom - Math.min(innerHeight, clip));
        }),
      `${label}: disclaimer bottom - min(innerHeight, .chat-main bottom) <= 0`,
    )
    .toBeLessThanOrEqual(0);
}

// ui-foundation「旧页面规则压过 preflight」：button.css 在 legacy 层，压过 base 层 preflight 的
// `padding: 0`。限定在 main 内：外壳已不用旧按钮，.ui-btn 只由尚未迁移的页面渲染在 main 里。
// 随 legacy 层整体移除（change s1f-files-page 收尾）删除。
async function expectLegacyOverPreflight(page: Page): Promise<void> {
  const padding = await page
    .getByRole("main")
    .locator(".ui-btn")
    .first()
    .evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(padding, "first .ui-btn padding-left in main on /files").not.toBe("0px");
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
export async function inspectSidebar(
  page: Page,
  project: WalkProject,
  inspect: (sidebar: Locator) => Promise<void>,
): Promise<void> {
  await inspect(await openSidebar(page, project));
  if (project === "desktop-light") return;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
}

function sessionList(sidebar: Locator): Locator {
  return sidebar.getByRole("navigation", { name: "会话列表" });
}

// #424：会话列表区在侧栏内 主导航 → 列表 → 用户区，main 内没有；mobile 关闭覆盖层后列表不在 DOM。
export async function expectSessionListInSidebar(page: Page, project: WalkProject): Promise<void> {
  const main = page.getByRole("main");
  await expect(main.getByRole("navigation", { name: "会话列表" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "新建会话" })).toHaveCount(0);
  await inspectSidebar(page, project, async (sidebar) => {
    await expect(sessionList(sidebar).getByRole("button", { name: "新建会话" })).toBeVisible();
    const ordered = await sidebar.evaluate((aside) => {
      const nav = aside.querySelector('nav[aria-label="主导航"]');
      const list = aside.querySelector('nav[aria-label="会话列表"]');
      const footer = aside.querySelector("footer");
      if (!nav || !list || !footer) return false;
      const after = (a: Node, b: Node) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return after(nav, list) && after(list, footer);
    });
    expect(ordered, "sidebar order: 主导航 → 会话列表 → footer").toBe(true);
  });
  if (project === "mobile-dark") {
    await expect(page.locator('nav[aria-label="会话列表"]')).toHaveCount(0);
  }
}

// 经侧栏 新建会话：mobile 先开覆盖层，点击后覆盖层随即关闭（列表经 onNavigate 关闭它）。
export async function createSessionFromSidebar(page: Page, project: WalkProject): Promise<void> {
  const sidebar = await openSidebar(page, project);
  await sessionList(sidebar).getByRole("button", { name: "新建会话" }).click();
  if (project === "mobile-dark") {
    await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
  }
}

// mobile 在覆盖层里选中列表首个有消息的会话：覆盖层关闭、URL 写入 ?session=。跳过 `未开始`——
// 列表按 updated_at 倒序，分叉出的空会话排在最前（#492）。
export async function selectFirstSessionInOverlay(page: Page): Promise<void> {
  const sidebar = await openSidebar(page, "mobile-dark");
  const idle = page.getByRole("status", { name: / 未开始$/u });
  await sessionList(sidebar)
    .locator("button.chat-session-button")
    .filter({ hasNot: idle })
    .first()
    .click();
  await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("session") ?? "").not.toBe("");
}

// 当前会话项的状态：侧栏里恰一项 aria-current，其 status 文本为 `text`（mobile 经覆盖层查看）。
export async function expectSelectedSessionStatus(
  page: Page,
  project: WalkProject,
  text: string,
): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const current = sessionList(sidebar).locator('button[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current.getByRole("status")).toHaveText(text);
  });
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

// ui-primitives「reduce 下拷入组件无动画与过渡」：拷入组件的入场动画由 tw-animate-css 声明、时长被
// styles.css 的全局 reduce 块压到 0.01ms（未分层，压过 utilities）。先断言确有动画声明，免得空过。
async function expectNoEnterMotion(content: Locator, label: string): Promise<void> {
  const probe = await content.evaluate((el) => {
    const style = getComputedStyle(el);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(probe.name, `${label} declares an enter animation`).not.toBe("none");
  const seconds = probe.duration.split(",").map((value) => Number.parseFloat(value));
  for (const value of seconds) {
    expect(value, `${label} animation-duration ${probe.duration} <= 0.01ms`).toBeLessThanOrEqual(
      0.00001,
    );
  }
}

// 调用方已 emulateMedia reduce 并打开侧栏：窄屏断 导航 覆盖层无入场动画；两个 project 都断一个带
// Tailwind transition* 类的按钮（theme.css 的 reduce 规则）过渡被关掉。
export async function expectReducedMotionShell(page: Page, project: WalkProject): Promise<void> {
  const reduce = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  expect(reduce, "prefers-reduced-motion: reduce is emulated").toBe(true);
  if (project === "mobile-dark") {
    await expectNoEnterMotion(page.getByRole("dialog", NAV_OVERLAY), "导航 overlay");
  }
  const button = page.locator('button[class*="transition"]:visible').first();
  await expect(button).toBeVisible();
  expect(
    await button.evaluate((el) => getComputedStyle(el).transitionProperty),
    "a button carrying a transition* class has transition-property none under reduce",
  ).toBe("none");
}

// 调用方已 emulateMedia reduce 并打开 用户菜单。
export async function expectReducedMotionMenu(page: Page): Promise<void> {
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expectNoEnterMotion(menu, "用户菜单");
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
  await expectBodyColors(page, choice.value === "dark" ? "light" : "dark");
  await expectReducedMotionThemeSwitch(page, project, choice);
  await page.getByRole("radio", { name: choice.label, exact: true }).check();
  await expectTheme(page, choice, initialBackground);
  await page.reload();
  await expectAuthenticatedRoute(page, project, "/settings", "设置", "设置");
  await expectTheme(page, choice, initialBackground);
}

type TextProbe = { color: string; animations: number };
type SwitchProbe = {
  reduce: boolean;
  before: string | undefined;
  after: string | undefined;
  headings: TextProbe[];
  titles: TextProbe[];
  links: TextProbe[];
};

// #423：reduce 下点选主题后同一任务内同步读取——继承色文字须已是目标主题色、且无过渡在跑。
// 点击与读取在同一次 evaluate 里，中间不让出帧（locator.click 后再 evaluate 会漏掉过渡）。
async function expectReducedMotionThemeSwitch(
  page: Page,
  project: WalkProject,
  choice: ThemeChoice,
): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const radio = page.getByRole("radio", { name: choice.label, exact: true });
  const probe: SwitchProbe = await radio.evaluate((element) => {
    const read = (selector: string) =>
      [...document.querySelectorAll(selector)].map((el) => ({
        color: getComputedStyle(el).color,
        animations: el.getAnimations().length,
      }));
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const before = document.documentElement.dataset.theme;
    (element as HTMLElement).click();
    return {
      reduce,
      before,
      after: document.documentElement.dataset.theme,
      headings: read(".settings-sec-h"),
      titles: read(".settings-row-title"),
      links: read('nav[aria-label="主导航"] a'),
    };
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const detail = JSON.stringify(probe);
  expect(probe.reduce, "prefers-reduced-motion: reduce is emulated").toBe(true);
  expect(probe.before, `theme before the click is not the target: ${detail}`).not.toBe(
    choice.value,
  );
  expect(probe.after, `theme switches within the click task: ${detail}`).toBe(choice.value);
  expect(probe.headings, ".settings-sec-h count").toHaveLength(2);
  expect(probe.titles, ".settings-row-title count").toHaveLength(3);
  if (project === "desktop-light")
    expect(probe.links.length, "主导航 link count").toBeGreaterThan(0);
  const text = [...probe.headings, ...probe.titles];
  expect(
    text.map((entry) => entry.color),
    `inherited text colour is the target theme's --wb-text-primary: ${detail}`,
  ).toEqual(text.map(() => choice.textPrimary));
  expect(
    [...text, ...probe.links].map((entry) => entry.animations),
    `no transition runs after the reduced-motion theme switch: ${detail}`,
  ).toEqual([...text, ...probe.links].map(() => 0));
}

async function expectTheme(page: Page, choice: ThemeChoice, initialBackground: string) {
  await expect(page.getByRole("radio", { name: choice.label, exact: true })).toBeChecked();
  await expect(page.getByText(`当前生效：${choice.label}`, { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", choice.value);
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBe(
    choice.value,
  );
  await expect
    .poll(() => pageBackground(page), "page background differs from the initial theme")
    .not.toBe(initialBackground);
  await expectBodyColors(page, choice.value);
}

// ui-foundation「主题映射」：theme.css 的 body 规则未分层，亮/暗取值与迁移前一致。
async function expectBodyColors(page: Page, theme: "light" | "dark"): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const body = () =>
    page.locator("body").evaluate((el) => {
      const { backgroundColor, color } = getComputedStyle(el);
      return { background: backgroundColor, color };
    });
  await expect.poll(body, `body colours under data-theme=${theme}`).toEqual(BODY_COLORS[theme]);
}

// #429 首帧前主题：存储值 × 系统配色 → 首帧应写入的 data-theme。
const PRE_PAINT_CASES = [
  { stored: "dark", colorScheme: "light", expected: "dark" },
  { stored: "system", colorScheme: "dark", expected: "dark" },
  { stored: "light", colorScheme: "dark", expected: "light" },
] as const;

type PrePaintCase = (typeof PRE_PAINT_CASES)[number];
// 读取前先 takeRecords，未投递的记录也按序并入。
type PrePaintWindow = { __readPrePaint: () => string[] };

export async function expectPrePaintTheme(browser: Browser, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required for the pre-paint theme check");
  for (const entry of PRE_PAINT_CASES) {
    await test.step(`stored ${entry.stored} + ${entry.colorScheme} scheme`, () =>
      expectPrePaintCase(browser, new URL(baseURL).origin, entry));
  }
}

// 全新 context：从文档创建起用同一 MutationObserver 记录 data-theme 写入与 LINK/#root 插入的顺序。
async function expectPrePaintCase(browser: Browser, origin: string, entry: PrePaintCase) {
  const context = await browser.newContext({ colorScheme: entry.colorScheme });
  try {
    await context.addInitScript(
      ({ key, value }) => {
        if (location.protocol !== "about:") localStorage.setItem(key, value);
        const records: string[] = [];
        const label = (node: Node) => {
          if (!(node instanceof Element)) return null;
          if (node.tagName === "LINK" && node.getAttribute("rel") === "stylesheet") return "LINK";
          return node.id === "root" ? "#root" : null;
        };
        const record = (mutation: MutationRecord) => {
          if (mutation.type === "attributes") {
            const target = mutation.target as Element;
            records.push(`data-theme=${target.getAttribute("data-theme")}`);
          }
          for (const node of mutation.addedNodes) {
            const name = label(node);
            if (name) records.push(name);
          }
        };
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) record(mutation);
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        const read = () => {
          for (const mutation of observer.takeRecords()) record(mutation);
          return [...records];
        };
        Object.assign(window, { __readPrePaint: read });
      },
      { key: THEME_STORAGE_KEY, value: entry.stored },
    );
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: { text: string; allowed: boolean }[] = [];
    const binding = { productionOrigin: origin, page };
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = `${message.text()} @ ${message.location().url}`;
      consoleErrors.push({ text, allowed: isExpectedUnauthorizedNetworkLog(binding, message) });
    });
    await page.goto("/files");
    await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
    const records = await page.evaluate(() =>
      (window as unknown as PrePaintWindow).__readPrePaint(),
    );
    expectPrePaintRecords(records, entry.expected);
    expect(pageErrors, "no pageerror").toEqual([]);
    const consoleDetail = `console errors: ${JSON.stringify(consoleErrors)}`;
    expect(consoleErrors.length, consoleDetail).toBeLessThanOrEqual(1);
    expect(
      consoleErrors.filter((error) => !error.allowed),
      `only the /api/auth/me 401 network log is allowed; ${consoleDetail}`,
    ).toEqual([]);
  } finally {
    await context.close();
  }
}

function expectPrePaintRecords(records: string[], expected: string) {
  const detail = JSON.stringify(records);
  const themes = records.filter((record) => record.startsWith("data-theme="));
  const firstTheme = records.findIndex((record) => record.startsWith("data-theme="));
  const link = records.indexOf("LINK");
  const root = records.indexOf("#root");
  expect(link, `stylesheet LINK recorded: ${detail}`).toBeGreaterThanOrEqual(0);
  expect(root, `#root recorded: ${detail}`).toBeGreaterThanOrEqual(0);
  expect(firstTheme, `data-theme recorded: ${detail}`).toBeGreaterThanOrEqual(0);
  expect(firstTheme, `data-theme precedes the stylesheet LINK: ${detail}`).toBeLessThan(link);
  expect(firstTheme, `data-theme precedes #root: ${detail}`).toBeLessThan(root);
  expect(themes, `every data-theme record is ${expected}: ${detail}`).toEqual(
    themes.map(() => `data-theme=${expected}`),
  );
}
