// UI walk approval steps: the first-turn bash approval is a prompt card in the dock directly above
// the composer (never inside a message). Assert the dock layout while that one card is pending,
// answer it with `允许` while the final model turn is still behind the fake-upstream gate, then
// prove the settled record inside the message survives a reload.

import { expect, type Locator, type Page } from "@playwright/test";
import { holdRoute } from "./route-hold.js";
import { gatePhase } from "./ui-walk-gate.js";
import { expandToolGroup, toolGroup } from "./ui-walk-steps.js";

const PENDING = "需要你的确认";
const ALLOWED = "已允许执行";

export function generatingStatus(page: Page) {
  return page
    .locator("form")
    .getByRole("status")
    .filter({ hasText: /^生成中$/u });
}

function assistantArticle(page: Page) {
  return page.getByRole("article", { name: "助手" });
}

// 包围盒完整位于视口内（四边都不出界，且有面积）。
async function expectInsideViewport(target: Locator, what: string): Promise<void> {
  const viewport = target.page().viewportSize();
  const box = await target.boundingBox();
  if (!viewport || !box) throw new Error(`${what}: no viewport or bounding box`);
  expect(box.width, `${what} has a width`).toBeGreaterThan(0);
  expect(box.height, `${what} has a height`).toBeGreaterThan(0);
  expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${what} top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${what} bottom edge`).toBeLessThanOrEqual(viewport.height);
}

// 停靠区有内容时的布局（两个 project 的视口：1440×900 与 390×844）：停靠区在线程滚动容器之外、线程
// 之下、输入框正上方；输入框与它右下角的按钮 `action`（`停止` 或 `发送`）完整在视口内；线程可见高度不为
// 零；页面没有横向滚动。
export async function expectDockFrame(page: Page, action: "停止" | "发送"): Promise<void> {
  const dock = page.locator('[data-slot="composer-dock"]');
  const thread = page.locator('[data-slot="thread-viewport"]');
  const composer = page.locator('[data-slot="composer"]');
  await expect(dock).toHaveCount(1);
  await expect(thread.locator('[data-slot="composer-dock"]')).toHaveCount(0);

  await expectInsideViewport(page.getByLabel("给助手发消息"), "composer textarea");
  await expectInsideViewport(
    composer.getByRole("button", { name: action, exact: true }),
    `${action} button`,
  );

  const dockBox = await dock.boundingBox();
  const threadBox = await thread.boundingBox();
  const composerBox = await composer.boundingBox();
  const viewport = page.viewportSize();
  if (!dockBox || !threadBox || !composerBox || !viewport) throw new Error("dock layout: no box");
  // 线程的可见高度：滚动容器的包围盒与视口的交集。
  const visible =
    Math.min(threadBox.y + threadBox.height, viewport.height) - Math.max(threadBox.y, 0);
  expect(visible, "thread visible height").toBeGreaterThan(0);
  expect(threadBox.y + threadBox.height, "dock starts below the thread").toBeLessThanOrEqual(
    dockBox.y,
  );
  expect(dockBox.y + dockBox.height, "dock ends above the composer").toBeLessThanOrEqual(
    composerBox.y,
  );
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth, "document scrollWidth <= innerWidth").toBeLessThanOrEqual(innerWidth ?? 0);
}

// 一张待决提问卡时的停靠区布局：回合在跑（`停止`），卡的两个按钮也完整在视口内。
async function expectDockLayout(page: Page, card: Locator): Promise<void> {
  await expect(
    page.locator('[data-slot="composer-dock"]').getByRole("group", { name: PENDING }),
  ).toHaveCount(1);
  await expectDockFrame(page, "停止");
  await expectInsideViewport(
    card.getByRole("button", { name: "允许", exact: true }),
    "允许 button",
  );
  await expectInsideViewport(
    card.getByRole("button", { name: "拒绝", exact: true }),
    "拒绝 button",
  );
}

// 待决提问卡（停靠区）、运行中的 bash 步骤（展开工具调用组后）与 composer `生成中` 同时可见（不断言先后）；gate 仍为 armed 证明末轮被审批挡住。
// 作答 POST 被 holdRoute 挂起期间断言两按钮禁用：放行后 approval.resolved 约 20ms 内就会卸载提问卡。
export async function allowFirstApproval(
  page: Page,
  origin: string,
  gateId: string,
): Promise<void> {
  const assistant = assistantArticle(page);
  const pending = page.getByRole("group", { name: PENDING });
  await expect(pending).toHaveCount(1);
  await expect(pending).toBeVisible();
  // 提问卡不在任何消息内。
  await expect(page.getByRole("article").getByRole("group", { name: PENDING })).toHaveCount(0);
  await expectDockLayout(page, pending);
  // 组默认收起：只有一行摘要，步骤卡不在页面上。
  await expect(toolGroup(assistant).getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(toolGroup(assistant).getByRole("button")).toHaveText("1 个步骤 · bash 运行中");
  await expect(assistant.getByRole("region", { name: "bash" })).toHaveCount(0);
  await expandToolGroup(assistant);
  await expect(assistant.getByRole("status", { name: "bash 运行中" })).toBeVisible();
  await expect(generatingStatus(page)).toBeVisible();
  const allow = pending.getByRole("button", { name: "允许", exact: true });
  const deny = pending.getByRole("button", { name: "拒绝", exact: true });
  await expect(allow).toBeEnabled();
  await expect(deny).toBeEnabled();
  expect(await gatePhase(origin, gateId)).toBe("armed");

  const answer = await holdRoute(page, "**/api/sessions/*/approvals/*");
  try {
    await allow.click();
    await expect.poll(() => answer.held(), "approval answer held by route").toBe(true);
    await expect(allow).toBeDisabled();
    await expect(deny).toBeDisabled();
  } finally {
    await answer.release();
  }
  // 结算后提问卡收起，所属助手消息内出现已允许的记录。
  await expect(assistant.getByRole("group", { name: ALLOWED })).toBeVisible();
  await expect(pending).toHaveCount(0);
  await expect(page.locator('[data-slot="composer-dock"]')).toHaveCount(0);
  await expect(assistant.getByRole("status", { name: "bash 已完成" })).toBeVisible();
}

// 完成后 reload：快照恢复出恰一条已允许的记录（在助手消息内），整页没有待决提问卡。
export async function expectAllowedBar(page: Page): Promise<void> {
  const assistant = assistantArticle(page);
  await expect(assistant.getByRole("group", { name: ALLOWED })).toHaveCount(1);
  await expect(page.getByRole("group", { name: PENDING })).toHaveCount(0);
}
