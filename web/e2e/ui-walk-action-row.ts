// UI walk message action rows (chat-harness「UI 走查消息操作行显隐」): the row of every message is
// hidden on a hover-capable pointer and shown by hovering its message, by focus inside the row and
// by an inline `复制失败`; on a `(hover: none)` context it is always shown. Visibility is measured
// as the computed `opacity` only — Playwright treats `opacity: 0` as visible, clickable and
// focusable, so `toBeVisible()` proves nothing here.
// `revealActions` is the hover precondition of the existing steps that click a row button;
// `walkActionRow` is the visibility step on the completed held-dialogue session.

import { expect, type Locator, type Page } from "@playwright/test";
import type { WalkProject } from "./ui-walk-layout.js";
import type { AuthOracle } from "./ui-walk-oracle.js";

const ROW = '[data-slot="message-actions"]';
const COMPOSER = "给助手发消息";
// 显隐一步从输入框按 Shift+Tab 到达末条用户消息的 `从此处分叉` 的次数上界：中间是末条助手的 `复制` 与
// `重新生成`，以及可能出现的 `回到最新` 与输入卡里的附件标签（这一会话没有附件）。
// 实测两个 project 都是 3 次（`重新生成`、`复制`、`从此处分叉`）；取 6 留余量，超过即判红。
const SHIFT_TAB_LIMIT = 6;
const COLOR_SCHEME: Record<WalkProject, "light" | "dark"> = {
  "desktop-light": "light",
  "mobile-dark": "dark",
};

function actionRow(message: Locator): Locator {
  return message.locator(ROW);
}

// 行的计算 `opacity`，且须在它自己的过渡结束之后：过渡刚开始时读到的仍是起点值，`toHaveCSS` 的第一次
// 读取就会把「正在从 1 渐隐到 0」当成「仍为 1」放过（实测：去掉 `复制失败` 的显现类时走查仍绿）。
async function expectRowOpacity(row: Locator, value: "0" | "1"): Promise<void> {
  await expect
    .poll(() =>
      row.evaluate((element) =>
        element.getAnimations().length > 0 ? "transitioning" : getComputedStyle(element).opacity,
      ),
    )
    .toBe(value);
}

// 鼠标移到所有消息之外（视口左上角是侧栏或顶栏），焦点交给输入框：行内既无悬停也无焦点。
async function leaveMessages(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.getByLabel(COMPOSER).focus();
  await expect(page.getByLabel(COMPOSER)).toBeFocused();
}

/** 点击行内按钮之前：移开鼠标与焦点时该行 `opacity` 为 0，悬停这条消息后为 1。 */
export async function revealActions(page: Page, message: Locator): Promise<void> {
  await leaveMessages(page);
  await expectRowOpacity(actionRow(message), "0");
  await message.hover();
  await expectRowOpacity(actionRow(message), "1");
}

type Box = { x: number; y: number; width: number; height: number };

// 根元素在滚动内容里的位置与尺寸（加回滚动容器的 scrollTop）：悬停若触发滚动，视口坐标会变而布局没变。
function layoutBox(message: Locator): Promise<Box> {
  return message.evaluate((element) => {
    const viewport = element.closest('[data-slot="thread-viewport"]');
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y + (viewport?.scrollTop ?? 0),
      width: rect.width,
      height: rect.height,
    };
  });
}

async function expectOpacity(
  rows: { user: Locator; assistant: Locator },
  user: "0" | "1",
  other: "0" | "1",
) {
  await expectRowOpacity(rows.user, user);
  await expectRowOpacity(rows.assistant, other);
}

// 把 `navigator.clipboard.writeText` 换成必定 reject / resolve 的桩（实例上的自有属性遮住原型上的
// 原方法）；`restore` 删掉自有属性，原方法回来。
function stubClipboard(page: Page, outcome: "reject" | "resolve" | "restore"): Promise<void> {
  return page.evaluate((mode) => {
    const clipboard = navigator.clipboard;
    if (mode === "restore") {
      Reflect.deleteProperty(clipboard, "writeText");
      return;
    }
    const writeText =
      mode === "reject"
        ? () => Promise.reject(new DOMException("denied", "NotAllowedError"))
        : () => Promise.resolve();
    Object.defineProperty(clipboard, "writeText", { configurable: true, value: writeText });
  }, outcome);
}

type Transcript = { id: string | null; label: string | null; body: string | null }[];

// 消息的 id、角色与正文（不取整条文本：`复制` 成功后的 `已复制` 会在约 2 秒后自己消失）。
function transcriptOf(page: Page): Promise<Transcript> {
  return page.getByRole("article").evaluateAll((articles) =>
    articles.map((article) => ({
      id: article.getAttribute("data-message-id"),
      label: article.getAttribute("aria-label"),
      body: article.querySelector('[data-slot="message-body"]')?.textContent ?? null,
    })),
  );
}

function oracleCounts(oracle: AuthOracle) {
  return {
    unexpectedMe: oracle.unexpectedMe.length,
    unexpectedConsole: oracle.unexpectedConsole.length,
    pageErrors: oracle.pageErrors.length,
    failedAssets: oracle.failedAssets.length,
  };
}

/**
 * 显隐一步：会话已完成，末条用户消息文本非空、末条助手消息正文非空。依次量鼠标移开、悬停两条消息、
 * 经真实 Shift+Tab 聚焦、`复制失败` 后移开与清除、短渐变与减少动态效果，最后在 `hasTouch` 上下文里量常显。
 */
export async function walkActionRow(
  page: Page,
  project: WalkProject,
  oracle: AuthOracle,
): Promise<void> {
  const user = page.getByRole("article", { name: "用户" }).last();
  const assistant = page.getByRole("article", { name: "助手" }).last();
  const rows = { user: actionRow(user), assistant: actionRow(assistant) };
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk action row ${project}: ${point} +${Date.now() - started}ms`);
  await expect(user.locator('[data-slot="message-body"]')).not.toHaveText("");
  await expect(assistant.locator('[data-slot="message-body"]')).not.toHaveText("");

  // 鼠标移开：两行都为 0，且仍占位（包围盒高度 > 0）。
  mark(`(hover: hover) ${await page.evaluate(() => matchMedia("(hover: hover)").matches)}`);
  await leaveMessages(page);
  await expectOpacity(rows, "0", "0");
  for (const row of [rows.user, rows.assistant]) {
    expect((await row.boundingBox())?.height ?? 0, "hidden row keeps its height").toBeGreaterThan(
      0,
    );
  }
  const boxes = [await layoutBox(user), await layoutBox(assistant)];

  // 悬停每条消息时只有该消息的行为 1；悬停前后两条根元素的包围盒不变。
  await user.hover();
  await expectOpacity(rows, "1", "0");
  expect([await layoutBox(user), await layoutBox(assistant)], "boxes while hovering 用户").toEqual(
    boxes,
  );
  await assistant.hover();
  await expectOpacity(rows, "0", "1");
  expect([await layoutBox(user), await layoutBox(assistant)], "boxes while hovering 助手").toEqual(
    boxes,
  );
  mark("hover");

  // 键盘：固定起点是输入框，每按一次 Shift+Tab 检查一次焦点，至多 SHIFT_TAB_LIMIT 次。
  await leaveMessages(page);
  await expectOpacity(rows, "0", "0");
  const target = rows.user.getByRole("button", { name: "从此处分叉", exact: true });
  const isTarget = () => target.evaluate((button) => button === document.activeElement);
  const path: string[] = [];
  for (let presses = 0; presses < SHIFT_TAB_LIMIT && !(await isTarget()); presses += 1) {
    await page.keyboard.press("Shift+Tab");
    path.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "?"));
  }
  mark(`shift+tab path ${JSON.stringify(path)}`);
  expect(await isTarget(), `从此处分叉 focused within ${SHIFT_TAB_LIMIT} Shift+Tab`).toBe(true);
  await expectOpacity(rows, "1", "0");

  // `复制失败`：末条用户消息（walkFork 用第一条），移开后该行仍为 1；resolve 桩上再点一次清除它。
  const copy = rows.user.getByRole("button", { name: "复制", exact: true });
  const failed = rows.user.getByRole("alert");
  try {
    await stubClipboard(page, "reject");
    await user.hover();
    await copy.click();
    await expect(failed).toHaveText("复制失败");
    await leaveMessages(page);
    await expectRowOpacity(rows.user, "1");
    await stubClipboard(page, "resolve");
    await user.hover();
    await copy.click();
    await expect(failed).toHaveCount(0);
  } finally {
    await stubClipboard(page, "restore");
  }
  await leaveMessages(page);
  await expectOpacity(rows, "0", "0");
  mark("copy failure");

  // 短渐变：不减少动态效果时 transition-duration 不为 0s，reduce 下为 0s；两种情况悬停后都为 1。
  const durations: string[] = [];
  try {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      await page.emulateMedia({ reducedMotion });
      for (const row of [rows.user, rows.assistant]) {
        const duration = await row.evaluate(
          (element) => getComputedStyle(element).transitionDuration,
        );
        durations.push(`${reducedMotion}=${duration}`);
        if (reducedMotion === "reduce") expect(duration, "reduce transition").toBe("0s");
        else expect(duration, "no-preference transition").not.toBe("0s");
      }
      await assistant.hover();
      await expectRowOpacity(rows.assistant, "1");
      await leaveMessages(page);
      await expectOpacity(rows, "0", "0");
    }
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  mark(`reduced motion ${durations.join(" ")}`);

  await expectTouchContext(page, project, oracle);
  mark("touch context");
}

// 触屏：另开 `hasTouch` 上下文（复制登录态），打开同一会话；`(hover: none)` 成立后不移动鼠标两行都为 1。
// 它打开期间主页面的 oracle 不增加、转录不变（同一会话被两个上下文同时打开）。
async function expectTouchContext(
  page: Page,
  project: WalkProject,
  oracle: AuthOracle,
): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error("touch context needs the page's browser");
  const transcript = await transcriptOf(page);
  const counts = oracleCounts(oracle);
  const viewport = page.viewportSize();
  const context = await browser.newContext({
    hasTouch: true,
    colorScheme: COLOR_SCHEME[project],
    storageState: await page.context().storageState(),
    ...(viewport ? { viewport } : {}),
  });
  const errors: string[] = [];
  try {
    const touch = await context.newPage();
    touch.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    touch.on("console", (message) => {
      if (message.type() === "error") errors.push(`${message.text()} @ ${message.location().url}`);
    });
    await touch.goto(page.url());
    expect(await touch.evaluate(() => matchMedia("(hover: none)").matches), "(hover: none)").toBe(
      true,
    );
    const user = touch.getByRole("article", { name: "用户" }).last();
    const assistant = touch.getByRole("article", { name: "助手" }).last();
    await expect(user).toBeVisible();
    await expect(assistant.locator('[data-slot="message-body"]')).not.toHaveText("");
    await expectOpacity({ user: actionRow(user), assistant: actionRow(assistant) }, "1", "1");
    expect(errors, "touch context console and page errors").toEqual([]);
  } finally {
    await context.close();
  }
  expect(oracleCounts(oracle), "main page oracle while the touch context was open").toEqual(counts);
  expect(await transcriptOf(page), "main page transcript").toEqual(transcript);
}
