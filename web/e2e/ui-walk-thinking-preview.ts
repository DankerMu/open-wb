// UI walk：思考进行中与预览一步（chat-harness「等待与思考呈现的冒烟与走查」第 3 步，issue 1448）。真栈：编译后
// 的应用、官方 omp、受控上游。宿主同第 2 步：主旅程的受闸会话，紧接在等待指示一步之后再发一条（design D10
// 「ui-walk 的宿主」）。prompt 同带闸门标记、`WORKBUDDY_THINK_LONG` 与 `WORKBUDDY_HOLD_AT:thinking`：held 时受控
// 上游已放出 120 行思考、还没有正文，第四条助手消息的折叠块正在预览。
// 断言（held 期间）：折叠块展开、带 `data-running`，控件文本与可访问名为 `正在思考…`；主体计算 `max-height` 为
// 192px、内容溢出且盒内贴到最新一行（容差 1px）；两个渐隐层都不显示；转录距底 ≤4px。放行后：标题为
// `已思考 N 秒`，回合结束后折叠块收起、不带 `data-running`。「闭段即切标题」的时刻由 jsdom 证明，这里不量。

import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { generatingStatus } from "./ui-walk-approval.js";
import { armGate, controlOrigin, deleteGate, gatePhase, releaseGate } from "./ui-walk-gate.js";
import type { WalkProject } from "./ui-walk-layout.js";

const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const THINK_LONG = "WORKBUDDY_THINK_LONG";
const HOLD_AT_THINKING = "WORKBUDDY_HOLD_AT:thinking";
const LAST_LINE = "思考第 120 行";
const THOUGHT_TITLE = /^已思考 [1-9]\d* 秒$/;
const PIN_TOLERANCE_PX = 4;

/** 主体盒内的滚动量：离最新一行的距离与是否溢出。 */
const boxOf = (body: Locator) =>
  body.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    gap: Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight),
  }));

/** 转录滚动容器距底，及其是否溢出（只记进日志：不溢出时距底恒为 0）。 */
const transcriptOf = (page: Page) =>
  page.locator('[data-slot="thread-viewport"]').evaluate((el) => ({
    distance: el.scrollHeight - el.scrollTop - el.clientHeight,
    overflow: el.scrollHeight - el.clientHeight,
  }));

/** 第 3 步。`sessionId` 是受闸会话；`reply` 是受控上游的固定回复。 */
export async function walkThinkingPreview(
  page: Page,
  project: WalkProject,
  sessionId: string,
  reply: string,
): Promise<void> {
  const origin = controlOrigin();
  const gateId = randomUUID();
  const users = page.getByRole("article", { name: "用户" });
  const assistants = page.getByRole("article", { name: "助手" });
  const fourth = assistants.nth(3);
  const fold = fourth.locator('[data-slot="reasoning-root"]');
  const body = fold.locator('[data-slot="reasoning-text"]');
  const composer = page.getByLabel("给助手发消息");
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk thinking-preview ${project}: ${point} +${Date.now() - started}ms`);

  // 紧接第 2 步：仍在受闸会话上，此前三问三答都在。
  await expect(users).toHaveCount(3);
  await expect(assistants).toHaveCount(3);
  await expect(composer).toBeEnabled();
  try {
    await armGate(origin, gateId);
    await composer.fill(`${WALK_MARKER}${gateId} ${THINK_LONG} ${HOLD_AT_THINKING}`);
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/sessions/${sessionId}/prompt` &&
        response.request().method() === "POST",
    );
    await composer.press("Enter");
    expect((await accepted).status()).toBe(202);
    await expect.poll(() => gatePhase(origin, gateId)).toBe("held");
    mark("held");

    await expect(assistants).toHaveCount(4);
    const control = fold.getByRole("button", { name: "正在思考…", exact: true });
    await expect(control).toHaveAttribute("aria-expanded", "true");
    await expect(control).toHaveText("正在思考…");
    await expect(fold).toHaveAttribute("data-running", "");
    // 120 行思考都已到达（服务端合并器至多 250ms 冲刷一次）：最后一行在主体里。
    await expect(body).toContainText(LAST_LINE);
    await expect(body).toHaveCSS("max-height", "192px");
    await expect(body).toHaveCSS("overflow-y", "auto");
    await expect
      .poll(async () => (await boxOf(body)).gap, "box pinned to the latest line")
      .toBeLessThanOrEqual(1);
    const held = await boxOf(body);
    expect(held.scrollHeight, "the preview overflows its 12rem box").toBeGreaterThan(
      held.clientHeight,
    );
    const fades = fold.locator('[data-slot="reasoning-fade"]');
    await expect(fades).toHaveCount(2);
    expect(await fades.evaluateAll((els) => els.map((el) => getComputedStyle(el).display))).toEqual(
      ["none", "none"],
    );
    await expect
      .poll(async () => (await transcriptOf(page)).distance, "transcript stays pinned")
      .toBeLessThanOrEqual(PIN_TOLERANCE_PX);
    const pane = await transcriptOf(page);
    console.log(
      `ui-walk thinking-preview ${project}: box scrollHeight ${held.scrollHeight}, clientHeight ` +
        `${held.clientHeight}, gap ${held.gap}; transcript distance ${pane.distance}, ` +
        `overflow ${pane.overflow}`,
    );
    // 以上都在 held 期间成立：闸门仍未放行。
    expect(await gatePhase(origin, gateId)).toBe("held");

    await releaseGate(origin, gateId);
    mark("released");
    await expect(fourth.locator('[data-slot="message-body"]')).toHaveText(reply);
    await expect(generatingStatus(page)).toHaveCount(0);
    const settled = fold.getByRole("button", { name: THOUGHT_TITLE });
    await expect(settled).toHaveText(THOUGHT_TITLE);
    await expect(settled).toHaveAttribute("aria-expanded", "false");
    await expect(fold).not.toHaveAttribute("data-running");
    await expect(users).toHaveCount(4);
    mark("done");
  } finally {
    await deleteGate(origin, gateId);
  }
}
