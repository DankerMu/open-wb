// UI walk approval steps: answer the first-turn bash approval with `允许` while the final model turn
// is still behind the fake-upstream gate, then prove the settled bar survives a reload.

import { expect, type Page } from "@playwright/test";
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

// 待决审批条、运行中的 bash 步骤（展开工具调用组后）与 composer `生成中` 同时可见（不断言先后）；gate 仍为 armed 证明末轮被审批挡住。
// 作答 POST 被 holdRoute 挂起期间断言两按钮禁用：放行后 approval.resolved 约 20ms 内就会卸载按钮。
export async function allowFirstApproval(
  page: Page,
  origin: string,
  gateId: string,
): Promise<void> {
  const assistant = assistantArticle(page);
  const pending = assistant.getByRole("group", { name: PENDING });
  await expect(pending).toBeVisible();
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
  await expect(assistant.getByRole("group", { name: ALLOWED })).toBeVisible();
  await expect(assistant.getByRole("status", { name: "bash 已完成" })).toBeVisible();
}

// 完成后 reload：快照恢复出恰一条已允许的审批条，没有待决条。
export async function expectAllowedBar(page: Page): Promise<void> {
  const assistant = assistantArticle(page);
  await expect(assistant.getByRole("group", { name: ALLOWED })).toHaveCount(1);
  await expect(assistant.getByRole("group", { name: PENDING })).toHaveCount(0);
}
