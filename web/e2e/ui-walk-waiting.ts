// UI walk：等待指示一步（chat-harness「等待与思考呈现的冒烟与走查」第 2 步，issue 1446）。真栈：编译后的
// 应用、官方 omp、受控上游。宿主是主旅程的受闸会话：既有步骤（含 fork）都走完之后回到该会话再发一条——
// 历史里已有 tool 消息，受控上游把它当答复轮，闸门作用于它（design D10「ui-walk 的宿主」）。prompt 同带
// 闸门标记与 `WORKBUDDY_HOLD_AT:empty`：held 时受控上游只放出了角色帧，第三条助手消息还没有任何内容。
// 断言：held 期间消息内只有 `role="status"` 的 `正在思考…`（带流光，reduce 下暂停），没有小圆点与思考
// 折叠块；放行后它消失、正文出现，回合结束后小圆点也没有了。

import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { generatingStatus } from "./ui-walk-approval.js";
import { armGate, controlOrigin, deleteGate, gatePhase, releaseGate } from "./ui-walk-gate.js";
import type { WalkProject } from "./ui-walk-layout.js";

const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const HOLD_AT_EMPTY = "WORKBUDDY_HOLD_AT:empty";

/** tw-shimmer 的文字流光由 `::before` 承载：动画名与播放状态。 */
const shimmerOf = (target: Locator) =>
  target.evaluate((el) => {
    const { animationName, animationPlayState } = getComputedStyle(el, "::before");
    return `${animationName} ${animationPlayState}`;
  });

/** 第 2 步。`sessionUrl` 是受闸会话的地址；`reply` 是受控上游的固定回复。 */
export async function walkWaitingIndicator(
  page: Page,
  project: WalkProject,
  sessionId: string,
  sessionUrl: string,
  reply: string,
): Promise<void> {
  const origin = controlOrigin();
  const gateId = randomUUID();
  const users = page.getByRole("article", { name: "用户" });
  const assistants = page.getByRole("article", { name: "助手" });
  const third = assistants.nth(2);
  const waiting = third.locator('[data-slot="message-waiting"]');
  const caret = third.locator('[data-slot="message-caret"]');
  const composer = page.getByLabel("给助手发消息");
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk waiting ${project}: ${point} +${Date.now() - started}ms`);

  // fork 一步停在分叉出的空会话上：回到受闸会话，此前两问两答都在。
  await page.goto(sessionUrl);
  await expect(users).toHaveCount(2);
  await expect(assistants).toHaveCount(2);
  await expect(composer).toBeEnabled();
  try {
    await armGate(origin, gateId);
    await composer.fill(`${WALK_MARKER}${gateId} ${HOLD_AT_EMPTY}`);
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/sessions/${sessionId}/prompt` &&
        response.request().method() === "POST",
    );
    await composer.press("Enter");
    expect((await accepted).status()).toBe(202);
    await expect.poll(() => gatePhase(origin, gateId)).toBe("held");
    mark("held");

    await expect(assistants).toHaveCount(3);
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveAttribute("role", "status");
    await expect(waiting).toHaveText("正在思考…");
    await expect(third.getByRole("status")).toHaveCount(1);
    await expect(caret).toHaveCount(0);
    await expect(third.locator('[data-slot="reasoning-root"]')).toHaveCount(0);
    await expect(third.locator('[data-slot="message-body"]')).toHaveCount(0);
    expect(await shimmerOf(waiting), "the waiting line shimmers").toBe(
      "tw-shimmer-translate running",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await shimmerOf(waiting), "reduced motion pauses the waiting shimmer").toBe(
      "tw-shimmer-translate paused",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // 以上都在 held 期间成立：闸门仍未放行。
    expect(await gatePhase(origin, gateId)).toBe("held");

    await releaseGate(origin, gateId);
    mark("released");
    await expect(third.locator('[data-slot="message-body"]')).toHaveText(reply);
    await expect(waiting).toHaveCount(0);
    await expect(generatingStatus(page)).toHaveCount(0);
    await expect(caret).toHaveCount(0);
    await expect(users).toHaveCount(3);
    mark("done");
  } finally {
    await deleteGate(origin, gateId);
  }
}
