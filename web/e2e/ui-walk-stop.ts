// UI walk stop step: a second gated prompt on the same session is stopped while the fake-upstream
// gate is `held`; the abort destroys the held response, and finally only deletes the gate.

import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { generatingStatus } from "./ui-walk-approval.js";
import { armGate, controlOrigin, deleteGate, gatePhase } from "./ui-walk-gate.js";
import { inspectSidebar, type WalkProject } from "./ui-walk-layout.js";

const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const FIRST_REPLY_PART = "你好，";
const STOPPED_TOAST = "已停止生成";
const TOAST_GONE_TIMEOUT_MS = 10_000;

function sessionPost(page: Page, sessionId: string, endpoint: "prompt" | "stop") {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/sessions/${sessionId}/${endpoint}` &&
      response.request().method() === "POST",
  );
}

// 点击只在 gate `held` + 第二条助手已呈现前缀 + form 内 `生成中` 同时成立时发生（`停止` 可用不足以证明 running）。
// 末尾先等 Toast 消失再查侧栏：Toast 显示期间 mobile 导航覆盖层按 Escape 关不掉（#643）。
export async function walkStop(page: Page, project: WalkProject, sessionId: string): Promise<void> {
  const origin = controlOrigin();
  const gateId = randomUUID();
  const form = page.locator("form");
  const composer = page.getByLabel("给助手发消息");
  const users = page.getByRole("article", { name: "用户" });
  const assistants = page.getByRole("article", { name: "助手" });
  const second = assistants.nth(1);
  const stoppedBadge = second.getByRole("status", { name: "助手消息 已停止", exact: true });
  const stop = form.getByRole("button", { name: "停止", exact: true });
  const send = form.getByRole("button", { name: "发送", exact: true });
  const toast = page
    .getByRole("region", { name: /通知/u })
    .getByText(STOPPED_TOAST, { exact: true });
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk stop ${project}: ${point} +${Date.now() - started}ms`);
  try {
    await armGate(origin, gateId);
    await composer.fill(`${WALK_MARKER}${gateId}`);
    const accepted = sessionPost(page, sessionId, "prompt");
    await composer.press("Enter");
    expect((await accepted).status()).toBe(202);

    await expect.poll(() => gatePhase(origin, gateId)).toBe("held");
    mark("held");
    await expect(users).toHaveCount(2);
    await expect(assistants).toHaveCount(2);
    await expect(second.locator(".chat-md")).toHaveText(FIRST_REPLY_PART);
    await expect(generatingStatus(page)).toBeVisible();
    await expect(stop).toBeEnabled();
    await expect(send).toHaveCount(0);
    expect(await gatePhase(origin, gateId)).toBe("held");

    const stopped = sessionPost(page, sessionId, "stop");
    await stop.click();
    expect((await stopped).status()).toBe(202);
    mark("stop 202");
    await expect(toast).toBeVisible();
    await expect(stoppedBadge).toBeVisible();
    await expect(second.getByRole("alert")).toHaveCount(0);
    await expect(second.locator(".chat-md")).toHaveText(FIRST_REPLY_PART);
    await expect(users).toHaveCount(2);
    await expect(assistants).toHaveCount(2);
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(generatingStatus(page)).toHaveCount(0);

    await expect.poll(() => gatePhase(origin, gateId)).toBe("status:404");
    mark("gate 404");
    await expect(toast).toHaveCount(0, { timeout: TOAST_GONE_TIMEOUT_MS });
    mark("toast gone");
    await inspectSidebar(page, project, async (sidebar) => {
      const current = sidebar
        .getByRole("navigation", { name: "会话列表" })
        .locator('button[aria-current="true"]');
      await expect(current).toHaveCount(1);
      const title = await current.getAttribute("aria-label");
      await expect(current.getByRole("status")).toHaveAccessibleName(`${title} 已停止`);
    });
  } finally {
    await deleteGate(origin, gateId);
  }
}
