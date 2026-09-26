import { randomUUID } from "node:crypto";
import {
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
  test,
} from "@playwright/test";
import { holdRoute } from "./route-hold.js";
import { armGate, controlOrigin, deleteGate, gatePhase, releaseGate } from "./ui-walk-gate.js";
import {
  clickRoute,
  createSessionFromSidebar,
  DEV_ACCOUNT,
  expectAuthenticatedRoute,
  expectDesktopLayout,
  expectPrePaintTheme,
  expectPrincipalFooter,
  expectReducedMotionToggle,
  expectRouteViewports,
  expectScrollableX,
  expectSelectedSessionStatus,
  expectSessionListInSidebar,
  expectTruncatedRow,
  expectWelcomeFirstScreen,
  openSidebar,
  pageBackground,
  selectFirstSessionInOverlay,
  switchTheme,
  type WalkProject,
  walkProject,
  walkSidebarCollapse,
  withViewport,
} from "./ui-walk-layout.js";
import { type AuthOracle, runWithBrowserErrorOracle } from "./ui-walk-oracle.js";

const DEV_PASSWORD = "demo";
const PRODUCTION_SERVICE_NAME = "workbuddy-app-server";
const PRODUCTION_SERVICE_VERSION = "0.0.0";
const SESSION_COOKIE = "workbuddy_session";
const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const FIRST_REPLY_PART = "你好，";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const SESSION_ID = /^[0-9a-f]{32}$/;
const SMOKE_FIXTURE = "smoke-fixture";
// 目录名按 project 区分，补齐到恰 64 字符（≥48）以触发树行省略。
const WALK_OUT_LENGTH = 64;

const ROUTES = [
  { path: "/", heading: "WorkBuddy，我帮你", label: "会话" },
  { path: "/files", heading: "工作空间", label: "工作空间" },
  { path: "/center", heading: "中心", label: "中心" },
  { path: "/settings", heading: "设置", label: "设置" },
] as const;

test.describe.configure({ mode: "serial" });

test("fresh browser journey logs in, walks four routes, persists theme, and logs out", async ({
  baseURL,
  page,
}, testInfo) => {
  const project = walkProject(testInfo.project.name);
  const options = { watchAssets: project === "desktop-light" };
  await runWithBrowserErrorOracle(page, baseURL, options, (oracle) =>
    walkProductionOrigin(page, oracle, project),
  );
});

// #429：独立 test、独立 context，不进旅程的 oracle；只在 desktop-light 跑。
test("cold load writes the stored theme before the stylesheet and #root", async ({
  baseURL,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile-dark", "pre-paint theme runs on desktop-light only");
  await expectPrePaintTheme(browser, baseURL);
});

function walkOutName(project: WalkProject): string {
  return `walk-out-${project}-`.padEnd(WALK_OUT_LENGTH, "x");
}

async function walkProductionOrigin(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
): Promise<void> {
  await page.goto("/files");
  await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
  await page.getByLabel("账号").fill(DEV_ACCOUNT);
  await page.getByLabel("密码").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expectAuthenticatedRoute(page, project, "/files", "工作空间", "工作空间");
  await expectPrincipalFooter(page, project);
  oracle.phase = "authenticated";
  const initialBackground = await pageBackground(page);
  if (project === "desktop-light") await expectDesktopLayout(page);

  for (const route of ROUTES) {
    await clickRoute(page, project, route.label);
    await expectAuthenticatedRoute(page, project, route.path, route.heading, route.label);
    await expectPrincipalFooter(page, project);
    await expectRouteViewports(page, project, route.path);
  }

  await clickRoute(page, project, "工作空间");
  await expectAuthenticatedRoute(page, project, "/files", "工作空间", "工作空间");
  await walkFiles(page, project);

  await clickRoute(page, project, "会话");
  await expectAuthenticatedRoute(page, project, "/", ROUTES[0].heading, "会话");
  await walkHeldDialogue(page, project);
  // 放在建会话之后：列表非空时仍须满足首屏约束（#424）。
  await clickRoute(page, project, "会话");
  await expectAuthenticatedRoute(page, project, "/", ROUTES[0].heading, "会话");
  await test.step("session list in sidebar and welcome first screen (#424)", async () => {
    await expectSessionListInSidebar(page, project);
    await expectWelcomeFirstScreen(page, project);
    if (project === "mobile-dark") {
      await selectFirstSessionInOverlay(page);
      await expect(page.getByRole("article", { name: "助手" }).first()).toBeVisible();
    }
  });
  await clickRoute(page, project, "设置");
  await expectAuthenticatedRoute(page, project, "/settings", "设置", "设置");

  await expect(page.getByText(PRODUCTION_SERVICE_NAME, { exact: true })).toBeVisible();
  await expect(page.getByText(`版本 ${PRODUCTION_SERVICE_VERSION}`, { exact: true })).toBeVisible();

  // 覆盖层变体无折叠按钮，折叠只在 desktop 走查。
  if (project === "desktop-light") await walkSidebarCollapse(page);
  await switchTheme(page, project, initialBackground);

  const sidebar = await openSidebar(page, project);
  await sidebar.locator("footer").getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "退出登录？" })).toBeVisible();
  await expect(
    dialog.getByText("退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeVisible();
  await confirmLogoutByKeyboardWhileHeld(page, dialog);
  await expectLoggedOutOnSettings(page);
  oracle.phase = "post-logout-reload";
  await page.reload();
  await expectLoggedOutOnSettings(page);
}

// 键盘确认退出，并在 POST /api/auth/logout 挂起期间证明：确认按钮被原生禁用引发 focus fixup 后，
// 焦点仍被救回到模态内的 `关闭`，Tab/Shift+Tab 不逃到背景、路由不变。放行后由调用方断言登出。
async function confirmLogoutByKeyboardWhileHeld(page: Page, dialog: Locator): Promise<void> {
  const logout = await holdRoute(page, "**/api/auth/logout");
  try {
    await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "退出" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "关闭" })).toBeFocused();
    for (const key of ["Tab", "Shift+Tab", "Tab"]) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement)), key).toBe(true);
    }
    expect(new URL(page.url()).pathname).toBe("/settings");
    await expect.poll(() => logout.held(), "logout request held by route").toBe(true);
  } finally {
    await logout.release();
  }
}

async function expectLoggedOutOnSettings(page: Page) {
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
  await expectSessionCookieAbsent(page);
}

async function expectSessionCookieAbsent(page: Page) {
  const sessionCookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === SESSION_COOKIE,
  );
  expect(sessionCookies).toEqual([]);
}

async function walkFiles(page: Page, project: WalkProject): Promise<void> {
  const walkOut = walkOutName(project);
  const files = page.locator("main");
  await files.getByRole("button", { name: "选择工作空间" }).click();
  const switcher = page.getByRole("dialog", { name: "工作空间切换器" });
  await expect(switcher.getByRole("button", { name: "＋ 新建工作空间" })).toBeVisible();
  const existing = switcher.getByRole("button").filter({
    has: page.getByText(SMOKE_FIXTURE, { exact: true }),
  });
  if ((await existing.count()) === 0) {
    await switcher.getByRole("button", { name: "＋ 新建工作空间" }).click();
    const createDialog = page.getByRole("dialog", { name: "新建工作空间" });
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel("工作空间名称").fill(SMOKE_FIXTURE);
    await createDialog.getByRole("button", { name: "创建" }).click();
  } else {
    await existing.click();
  }

  const tree = files.getByRole("navigation", { name: "工作空间目录树" });
  await expectRootFileButtons(tree);
  for (const name of [walkOut, `展开 ${walkOut}`, `折叠 ${walkOut}`]) {
    await expect(tree.getByRole("button", { name, exact: true })).toHaveCount(0);
  }

  const preview = files.getByRole("region", { name: "文件预览" });
  await tree.getByRole("button", { name: "readme.md", exact: true }).click();
  await expect(
    preview.getByRole("heading", { level: 1, name: SMOKE_FIXTURE, exact: true }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "查看源码" }).click();
  const sourceRow = preview.getByRole("row").first();
  await expect(sourceRow.getByRole("cell").nth(0)).toHaveText("1");
  await expect(sourceRow.getByRole("cell").nth(1)).toHaveText(`# ${SMOKE_FIXTURE}`);
  await expectScrollableX(preview.locator(".files-code"));

  await tree.getByRole("button", { name: "notes.csv", exact: true }).click();
  await expect(preview.getByRole("columnheader", { name: "name", exact: true })).toBeVisible();
  await expect(preview.getByRole("columnheader", { name: "value", exact: true })).toBeVisible();
  await expect(preview.getByRole("row")).toHaveCount(5);
  await expect(preview.getByRole("row", { name: "alpha 1" })).toBeVisible();
  await expect(preview.getByRole("row", { name: "beta 2" })).toBeVisible();
  await expect(preview.getByText("共 4 行 · 大文件仅预览前若干行", { exact: true })).toBeVisible();
  await expectScrollableX(preview.locator(".files-table"));

  await tree.getByRole("button", { name: "logo.png", exact: true }).click();
  const logo = preview.getByRole("img", { name: "logo.png", exact: true });
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([256, 256]);

  await files.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建文件夹" }).click();
  await createWalkOutWhileHeld(page, walkOut);
  const walkOutRow = tree.getByRole("button", { name: `展开 ${walkOut}`, exact: true });
  await expect(walkOutRow).toBeVisible();
  await expectTruncatedRow(page, project, walkOutRow, walkOut);

  await expect.poll(() => workspaceIdFromUrl(page.url())).toMatch(SESSION_ID);
  const workspaceId = workspaceIdFromUrl(page.url());
  await page.reload();
  await expectAuthenticatedRoute(page, project, "/files", "工作空间", "工作空间");
  await expect.poll(() => workspaceIdFromUrl(page.url())).toBe(workspaceId);
  await expect(
    files.getByRole("button", { name: "选择工作空间" }).getByText(SMOKE_FIXTURE, { exact: true }),
  ).toBeVisible();
  const restored = files.getByRole("navigation", { name: "工作空间目录树" });
  await expectRootFileButtons(restored);
  await expect(
    restored.getByRole("button", { name: `展开 ${walkOut}`, exact: true }),
  ).toBeVisible();
}

// 键盘提交 walk-out，并在 POST …/dirs 挂起期间证明：`创建` 被原生禁用引发 focus fixup 后，
// 焦点被救回到模态内的 `关闭`，Tab/Shift+Tab 不逃出对话框。先断言请求确被挂起，再断言焦点。
async function createWalkOutWhileHeld(page: Page, walkOut: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "新建文件夹" });
  await dialog.getByLabel("位置").selectOption({ label: `根目录　${SMOKE_FIXTURE}` });
  await dialog.getByLabel("文件夹名称").fill(walkOut);
  const create = await holdRoute(page, "**/api/workspaces/*/dirs");
  try {
    await dialog.getByRole("button", { name: "创建" }).press("Enter");
    await expect.poll(() => create.held(), "walk-out creation held by route").toBe(true);
    await expect(dialog.getByRole("button", { name: "关闭" })).toBeFocused();
    for (const key of ["Tab", "Shift+Tab", "Tab"]) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate((el) => el.contains(document.activeElement)), key).toBe(true);
    }
  } finally {
    await create.release();
  }
}

async function expectRootFileButtons(tree: Locator) {
  await expect(tree.getByRole("button", { name: "readme.md", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "notes.csv", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "logo.png", exact: true })).toBeVisible();
}

async function walkHeldDialogue(page: Page, project: WalkProject): Promise<void> {
  const gateId = randomUUID();
  const prompt = `${WALK_MARKER}${gateId}`;
  const origin = controlOrigin();
  try {
    await armGate(origin, gateId);
    await createSessionFromSidebar(page, project);
    await expect.poll(() => sessionIdFromUrl(page.url())).toMatch(SESSION_ID);
    const crumb = page.getByRole("banner").getByRole("heading", { level: 1 });
    await expect(crumb).toHaveAccessibleName(/^我的工作 \/ /);
    const sessionUrl = page.url();
    const sessionId = sessionIdFromUrl(sessionUrl);
    await page.getByLabel("给助手发消息").fill(prompt);
    const promptAccepted = page.waitForResponse(
      (response) =>
        isSessionPath(response.url(), sessionId, "prompt") &&
        response.request().method() === "POST" &&
        response.status() === 202,
    );
    await page.getByLabel("给助手发消息").press("Enter");
    const accepted = await promptAccepted;
    const promptIds = parsePromptIds(await accepted.json());
    await expect.poll(() => gatePhase(origin, gateId)).toBe("held");
    // held 先于首块入库翻转；supervisor 先 persistEvent 再 #publish，UI 见首块即证明快照已含它。
    await expectRunningPrefix(page, project, sessionId, prompt);
    const preReload = await fetchSessionSnapshot(page, sessionId);
    expectRunningSnapshot(preReload, prompt, sessionId, promptIds);
    if (project === "desktop-light") await expectReducedMotionToggle(page);

    const postReload = watchSessionTraffic(page, sessionId);
    try {
      await page.reload();
      await expect.poll(() => page.url()).toBe(sessionUrl);
      await postReload.waitForNativeOpen();
      const recovery = await postReload.waitForRecoveryAfterNative();
      expectRunningSnapshot(await recovery.json(), prompt, sessionId, promptIds);
      postReload.assertNoMessagesGetInFlight();
      await expectRunningPrefix(page, project, sessionId, prompt);
      postReload.forbidFurtherMessagesGet();
      await releaseGate(origin, gateId);
      await expectCompletedPair(page, project, sessionId, prompt);
      postReload.assertNoForbiddenMessagesGet();
    } finally {
      postReload.detach();
    }

    await page.reload();
    await expect.poll(() => page.url()).toBe(sessionUrl);
    await expectCompletedPair(page, project, sessionId, prompt);
    await walkScrollFollow(page, project);
  } finally {
    await deleteGate(origin, gateId);
  }
}

// W-scroll 的量纲：强制溢出的余量、Step 3 再压低的高度、断言可信所需的最小可视高度。
const SCROLL_OVERFLOW_PX = 80;
const SCROLL_STEP3_SHRINK_PX = 40;
const SCROLL_MIN_CLIENT_PX = 80;
const SCROLL_MIN_OVERFLOW_PX = 60;
const PIN_TOLERANCE_PX = 4;

interface TranscriptMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  distance: number;
  threadHeight: number;
  pageScrollHeight: number;
  innerHeight: number;
}

function transcriptMetrics(transcript: Locator): Promise<TranscriptMetrics> {
  return transcript.evaluate((el) => {
    const thread = el.firstElementChild;
    if (!(thread instanceof HTMLElement) || !thread.matches("section.chat-thread")) {
      throw new Error("transcript content root is not section.chat-thread");
    }
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      distance: el.scrollHeight - el.scrollTop - el.clientHeight,
      threadHeight: thread.offsetHeight,
      pageScrollHeight: document.scrollingElement?.scrollHeight ?? 0,
      innerHeight: window.innerHeight,
    };
  });
}

// 距底断言前的前提：转录确实溢出、可视区不至于过矮、页面自身不滚动。
function expectForcedOverflow(metrics: TranscriptMetrics, step: string): void {
  expect(
    metrics.scrollHeight - metrics.clientHeight,
    `${step}: transcript overflow`,
  ).toBeGreaterThanOrEqual(SCROLL_MIN_OVERFLOW_PX);
  expect(metrics.clientHeight, `${step}: transcript clientHeight`).toBeGreaterThanOrEqual(
    SCROLL_MIN_CLIENT_PX,
  );
  expect(metrics.pageScrollHeight, `${step}: page does not scroll`).toBeLessThanOrEqual(
    metrics.innerHeight + 1,
  );
}

async function expectClientHeight(transcript: Locator, height: number, step: string) {
  await expect
    .poll(async () => (await transcriptMetrics(transcript)).clientHeight, `${step}: clientHeight`)
    .toBe(height);
}

function expectPinnedDistance(transcript: Locator, step: string) {
  return expect
    .poll(async () => (await transcriptMetrics(transcript)).distance, `${step}: distance`)
    .toBeLessThanOrEqual(PIN_TOLERANCE_PX);
}

// #373：转录区尺寸变化（视口变矮、展开 `原始输出`）也要重算贴底；只改高度，不跨 760px 断点。
async function walkScrollFollow(page: Page, project: WalkProject): Promise<void> {
  const original = page.viewportSize();
  if (!original) throw new Error("ui-walk requires a fixed viewport");
  const transcript = page.locator(".chat-transcript");
  const initial = await transcriptMetrics(transcript);
  expect(initial.distance, "W-scroll: pinned before resizing").toBeLessThanOrEqual(
    PIN_TOLERANCE_PX,
  );
  const target = Math.min(
    initial.threadHeight - SCROLL_OVERFLOW_PX,
    initial.clientHeight - SCROLL_STEP3_SHRINK_PX,
  );
  expect(target, "W-scroll: content tall enough for steps 1–3").toBeGreaterThanOrEqual(
    SCROLL_MIN_CLIENT_PX + SCROLL_STEP3_SHRINK_PX,
  );
  const step1Height = original.height - (initial.clientHeight - target);
  const step3Height = step1Height - SCROLL_STEP3_SHRINK_PX;
  console.log(
    `ui-walk W-scroll ${project}: viewport ${original.width}x${original.height}, ` +
      `clientHeight ${initial.clientHeight}, thread ${initial.threadHeight} -> ` +
      `step1 viewport height ${step1Height} (clientHeight ${target}), ` +
      `step3 viewport height ${step3Height} (clientHeight ${target - SCROLL_STEP3_SHRINK_PX})`,
  );
  await withViewport(page, { width: original.width, height: step1Height }, async () => {
    await test.step("W-scroll 1: pinned transcript re-sticks when its container shrinks", async () => {
      await expectClientHeight(transcript, target, "W-scroll 1");
      expectForcedOverflow(await transcriptMetrics(transcript), "W-scroll 1");
      await expectPinnedDistance(transcript, "W-scroll 1");
    });

    await test.step("W-scroll 2: expanding 原始输出 while pinned keeps following", async () => {
      const summary = page
        .getByRole("article", { name: "助手" })
        .getByRole("region", { name: "bash" })
        .locator("summary.chat-step-summary");
      await expect(summary).toHaveText("原始输出");
      const before = await transcriptMetrics(transcript);
      expectForcedOverflow(before, "W-scroll 2");
      expect(before.distance, "W-scroll 2: pinned before expanding").toBeLessThanOrEqual(
        PIN_TOLERANCE_PX,
      );
      const [summaryBox, transcriptBox] = await boxesOf(summary, transcript);
      const fullyVisible =
        summaryBox.y >= transcriptBox.y &&
        summaryBox.y + summaryBox.height <= transcriptBox.y + transcriptBox.height;
      // 点击前的 scroll-into-view 会触发 scroll 并解除贴底；不完全可见时改为直接展开。
      if (fullyVisible) await summary.click();
      else {
        await summary.evaluate((el) => {
          if (el.parentElement instanceof HTMLDetailsElement) el.parentElement.open = true;
        });
      }
      await expect(summary.locator("xpath=..")).toHaveAttribute("open", "");
      await expect(summary.locator("xpath=..").locator("pre.chat-step-output")).toBeVisible();
      await expect
        .poll(async () => (await transcriptMetrics(transcript)).threadHeight, "W-scroll 2: grew")
        .toBeGreaterThan(before.threadHeight);
      expectForcedOverflow(await transcriptMetrics(transcript), "W-scroll 2");
      await expectPinnedDistance(transcript, "W-scroll 2");
      console.log(
        `ui-walk W-scroll ${project}: 原始输出 ${fullyVisible ? "clicked" : "opened via evaluate"}, ` +
          `thread ${before.threadHeight} -> ${(await transcriptMetrics(transcript)).threadHeight}`,
      );
    });

    await test.step("W-scroll 3: a scrolled-up transcript is not yanked by a resize", async () => {
      await transcript.evaluate(
        (el) =>
          new Promise<void>((resolve) => {
            el.addEventListener("scroll", () => resolve(), { once: true });
            el.scrollTop = 0;
          }),
      );
      const unpinned = await transcriptMetrics(transcript);
      expect(unpinned.scrollTop, "W-scroll 3: scrolled to top").toBe(0);
      expect(unpinned.distance, "W-scroll 3: unpinned").toBeGreaterThan(PIN_TOLERANCE_PX);
      await page.setViewportSize({ width: original.width, height: step3Height });
      const shrunk = target - SCROLL_STEP3_SHRINK_PX;
      await expectClientHeight(transcript, shrunk, "W-scroll 3");
      // 两帧后读取：保证本次尺寸变化的 ResizeObserver 回调已投递。
      await transcript.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const after = await transcriptMetrics(transcript);
      expectForcedOverflow(after, "W-scroll 3");
      expect(after.scrollTop, "W-scroll 3: position kept").toBe(unpinned.scrollTop);
      const jump = page.getByRole("button", { name: "回到最新" });
      if (after.distance > after.clientHeight) await expect(jump).toBeVisible();
      else await expect(jump).toHaveCount(0);
      console.log(
        `ui-walk W-scroll ${project}: step3 distance ${after.distance}, ` +
          `clientHeight ${after.clientHeight}, 回到最新 ${after.distance > after.clientHeight ? "visible" : "absent"}`,
      );
    });

    await test.step("W-scroll 4: a taller viewport that reaches the bottom hides 回到最新", async () => {
      const jump = page.getByRole("button", { name: "回到最新" });
      let height = step3Height;
      const start = await transcriptMetrics(transcript);
      expect(start.scrollTop, "W-scroll 4: still scrolled to top").toBe(0);
      if (start.distance <= start.clientHeight) {
        // 距底 > clientHeight 需要 clientHeight < scrollHeight / 2（scrollTop 为 0）。
        const client = Math.ceil(start.scrollHeight / 2) - 1;
        expect(client, "W-scroll 4: shrunk clientHeight").toBeGreaterThanOrEqual(
          SCROLL_MIN_CLIENT_PX,
        );
        height -= start.clientHeight - client;
        await page.setViewportSize({ width: original.width, height });
        await expect
          .poll(async () => {
            const m = await transcriptMetrics(transcript);
            return m.distance > m.clientHeight;
          }, "W-scroll 4: scrolled up more than a viewport")
          .toBe(true);
      }
      await expect(jump).toBeVisible();
      const before = await transcriptMetrics(transcript);
      const grown = height + before.scrollHeight - before.clientHeight;
      expect(grown, "W-scroll 4: taller viewport height").toBeLessThanOrEqual(2000);
      await transcript.evaluate((el) => {
        const counter = globalThis as unknown as { walkScrollEvents?: number };
        counter.walkScrollEvents = 0;
        el.addEventListener("scroll", () => {
          counter.walkScrollEvents = (counter.walkScrollEvents ?? 0) + 1;
        });
      });
      await page.setViewportSize({ width: original.width, height: grown });
      await expect
        .poll(async () => {
          const m = await transcriptMetrics(transcript);
          return m.scrollHeight <= m.clientHeight;
        }, "W-scroll 4: transcript no longer overflows")
        .toBe(true);
      // 两帧后读取：保证本次尺寸变化的 ResizeObserver 回调已投递。
      await transcript.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const after = await transcriptMetrics(transcript);
      const scrolls = await page.evaluate(
        () => (globalThis as unknown as { walkScrollEvents?: number }).walkScrollEvents ?? 0,
      );
      expect(after.scrollTop, "W-scroll 4: position kept").toBe(0);
      expect(scrolls, "W-scroll 4: no scroll event").toBe(0);
      await expect(jump).toHaveCount(0);
      console.log(
        `ui-walk W-scroll ${project}: step4 viewport height ${step3Height} -> ${height} ` +
          `(clientHeight ${before.clientHeight}, scrollHeight ${before.scrollHeight}, ` +
          `distance ${before.distance}) -> ${grown} (clientHeight ${after.clientHeight}, ` +
          `scrollHeight ${after.scrollHeight}), 回到最新 absent`,
      );
    });
  });
}

async function boxesOf(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) throw new Error("expected both elements to have a bounding box");
  return [a, b] as const;
}

function sessionIdFromUrl(url: string): string {
  return new URL(url).searchParams.get("session") ?? "";
}

function workspaceIdFromUrl(url: string): string {
  return new URL(url).searchParams.get("ws") ?? "";
}

function isSessionPath(
  url: string,
  sessionId: string,
  endpoint: "messages" | "prompt" | "events",
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.pathname === `/api/sessions/${sessionId}/${endpoint}`;
}

function watchSessionTraffic(page: Page, sessionId: string) {
  const nativeOpens: Response[] = [];
  const recoveryRequests: Request[] = [];
  const pendingMessages = new Set<Request>();
  let nativeSeen = false;
  let forbidMessages = false;
  let forbiddenMessages = 0;
  const onRequest = (request: Request): void => {
    if (!isSessionPath(request.url(), sessionId, "messages") || request.method() !== "GET") {
      return;
    }
    pendingMessages.add(request);
    if (forbidMessages) {
      forbiddenMessages += 1;
      return;
    }
    if (nativeSeen) {
      recoveryRequests.push(request);
    }
  };
  const onRequestSettled = (request: Request): void => {
    pendingMessages.delete(request);
  };
  const onResponse = (response: Response): void => {
    if (
      response.request().method() === "GET" &&
      isSessionPath(response.url(), sessionId, "events") &&
      /event-stream/iu.test(response.headers()["content-type"] ?? "")
    ) {
      nativeOpens.push(response);
      nativeSeen = true;
    }
  };
  page.on("request", onRequest);
  page.on("requestfinished", onRequestSettled);
  page.on("requestfailed", onRequestSettled);
  page.on("response", onResponse);
  const detach = (): void => {
    page.off("request", onRequest);
    page.off("requestfinished", onRequestSettled);
    page.off("requestfailed", onRequestSettled);
    page.off("response", onResponse);
  };
  return {
    detach,
    async waitForNativeOpen(): Promise<Response> {
      await expect.poll(() => nativeOpens.length).toBeGreaterThan(0);
      const opened = nativeOpens[0];
      if (opened === undefined) {
        throw new Error("missing native event-stream after reload");
      }
      return opened;
    },
    async waitForRecoveryAfterNative(): Promise<Response> {
      await expect.poll(() => recoveryRequests.length).toBeGreaterThan(0);
      const started = recoveryRequests[0];
      if (started === undefined) {
        throw new Error("missing recovery messages GET after native SSE open");
      }
      await expect.poll(async () => (await started.response()) !== null).toBe(true);
      const recovered = await started.response();
      if (recovered === null) {
        throw new Error("recovery messages GET produced no response");
      }
      await recovered.finished();
      return recovered;
    },
    assertNoMessagesGetInFlight(): void {
      expect(pendingMessages.size).toBe(0);
    },
    forbidFurtherMessagesGet(): void {
      forbidMessages = true;
    },
    assertNoForbiddenMessagesGet(): void {
      expect(forbiddenMessages).toBe(0);
    },
  };
}

async function fetchSessionSnapshot(page: Page, sessionId: string): Promise<unknown> {
  const origin = new URL(page.url()).origin;
  const cookie = (await page.context().cookies())
    .filter((entry) => entry.name === SESSION_COOKIE)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
  const response = await fetch(`${origin}/api/sessions/${sessionId}/messages`, {
    headers: cookie.length === 0 ? {} : { cookie },
  });
  if (!response.ok) {
    throw new Error(`pre-reload messages GET failed: ${response.status}`);
  }
  return response.json();
}

function parsePromptIds(body: unknown): { userMessageId: number; assistantMessageId: number } {
  if (body === null || typeof body !== "object") {
    throw new Error("prompt 202 body is not an object");
  }
  if (!("userMessageId" in body) || !("assistantMessageId" in body)) {
    throw new Error("prompt 202 body missing message ids");
  }
  const userMessageId = body.userMessageId;
  const assistantMessageId = body.assistantMessageId;
  if (typeof userMessageId !== "number" || typeof assistantMessageId !== "number") {
    throw new Error("prompt 202 ids are not numbers");
  }
  return { userMessageId, assistantMessageId };
}

function generatingStatus(page: Page) {
  return page
    .locator("form")
    .getByRole("status")
    .filter({ hasText: /^生成中$/u });
}

interface DialoguePair {
  user: Locator;
  assistant: Locator;
}

async function dialoguePair(page: Page, sessionId: string, prompt: string): Promise<DialoguePair> {
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(sessionId);
  const user = page.getByRole("article", { name: "用户" });
  const assistant = page.getByRole("article", { name: "助手" });
  await expect(user).toHaveCount(1);
  await expect(assistant).toHaveCount(1);
  await expect(user.locator("p").first()).toHaveText(prompt);
  return { user, assistant };
}

// 列表状态在侧栏里读：mobile 开覆盖层读完即关，再查 main（覆盖层开着时应用根被 aria-hidden）。
async function expectRunningPrefix(
  page: Page,
  project: WalkProject,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const pair = await dialoguePair(page, sessionId, prompt);
  await expectSelectedSessionStatus(page, project, "运行中");
  await expect(generatingStatus(page)).toBeVisible();
  await expect
    .poll(async () =>
      (await pair.assistant.locator(".chat-md").innerText()).startsWith(FIRST_REPLY_PART),
    )
    .toBe(true);
  await expect(pair.assistant.getByRole("region", { name: "bash" })).toBeVisible();
  await expect(
    page
      .getByRole("status", { name: "bash 运行中" })
      .or(page.getByRole("status", { name: "bash 已完成" })),
  ).toBeVisible();
}

function expectRunningSnapshot(
  body: unknown,
  prompt: string,
  sessionId: string,
  ids: { userMessageId: number; assistantMessageId: number },
): void {
  if (body === null || typeof body !== "object") {
    throw new Error("messages snapshot is not an object");
  }
  const session = "session" in body ? body.session : undefined;
  const rawMessages = "messages" in body ? body.messages : undefined;
  if (session === null || typeof session !== "object") {
    throw new Error("snapshot session missing");
  }
  expect("id" in session ? session.id : undefined).toBe(sessionId);
  expect("status" in session ? session.status : undefined).toBe("running");
  if (!Array.isArray(rawMessages)) {
    throw new Error("snapshot has no messages");
  }
  const messages = rawMessages.filter(
    (message): message is Record<string, unknown> =>
      message !== null && typeof message === "object",
  );
  const user = messages.find((message) => message.id === ids.userMessageId);
  const assistant = messages.find((message) => message.id === ids.assistantMessageId);
  expect(user?.role).toBe("user");
  expect(user?.content).toBe(prompt);
  expect(assistant?.role).toBe("assistant");
  expect(typeof assistant?.content).toBe("string");
  expect(String(assistant?.content).startsWith(FIRST_REPLY_PART)).toBe(true);
  expect(assistant?.status).toBe("running");
}

async function expectCompletedPair(
  page: Page,
  project: WalkProject,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const pair = await dialoguePair(page, sessionId, prompt);
  await expect(pair.assistant.locator(".chat-md")).toHaveText(EXPECTED_REPLY);
  await expect(page.getByRole("status", { name: "bash 已完成" })).toBeVisible();
  // #367：摘要仍由 args 派生；真实 omp 的 AgentToolResult 经 output 块呈现（未展开时断言文本即可，
  // 不点击以免改变 W-scroll 所需的贴底与折叠初态）。锚定行首证明已规范化为纯文本——
  // 若落入紧凑 JSON 兜底，文本会以 `{"content":` 开头。
  const bash = pair.assistant.getByRole("region", { name: "bash" });
  await expect(bash.locator("p.chat-step-line")).toHaveText("command: echo workbuddy-smoke");
  await expect(bash.locator("details.chat-step-disclosure")).not.toHaveAttribute("open", "");
  await expect(bash.locator("details.chat-step-disclosure pre.chat-step-output")).toHaveText(
    /^workbuddy-smoke/u,
  );
  await expectSelectedSessionStatus(page, project, "已完成");
  await expect(generatingStatus(page)).toHaveCount(0);
}
