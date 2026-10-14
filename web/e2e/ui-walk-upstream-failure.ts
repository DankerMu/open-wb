// UI walk：上游失败一步（chat-harness「上游失败的冒烟与走查」，issue 909）。真栈：编译后的应用、官方 omp、
// 受控上游。欢迎态首次发送一条带 401 标记与 `secret` 正文的消息：受控上游答 401，正文逐字含它的密钥（走查
// 用法下恒为 `fake`）、一个 bearer 令牌与一个 `sk-` 串。回合结束后助手消息显示分类句子与 `（HTTP 401）`，
// `查看原文` 展开的原文不含密钥与令牌，输入框已解锁；随后同一会话发一条普通消息：历史里没有 tool result，
// 受控上游发 bash，点 `允许` 后回合完成。会话 id 取自被观察的 `POST /api/sessions` 201 响应，`finally`
// 里先回欢迎态再删除（停在该会话上删除，事件流重连拿到 404，error oracle 会记一条意外的 console error）。

import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { deleteCreatedSession } from "./ui-walk-cleanup.js";
import { login, logout } from "./ui-walk-composer.js";
import type { WalkProject } from "./ui-walk-layout.js";
import type { AuthOracle } from "./ui-walk-oracle.js";
import { welcomeHeading } from "./ui-walk-session-list.js";

const FAILURE_LINE = "鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）";
const UPSTREAM_KEY = "fake";
const LEAKS = [UPSTREAM_KEY, "leak-token-0123456789", "sk-leakleakleakleakleak"];
// 真 omp 的回合（上游 401 的回合与 bash 加回复两轮的回合）；只有等回合结束的断言带显式超时。
const TURN_TIMEOUT_MS = 10_000;

/** 上游失败一步：登录、401 回合、普通回合、清理、退出。`reply` 是受控上游的固定回复。 */
export async function walkUpstreamFailure(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
  reply: string,
): Promise<void> {
  const created: { id: string | null } = { id: null };
  await login(page, oracle, project);
  try {
    await page.goto("/");
    await expect(welcomeHeading(page)).toBeVisible();
    await failedTurn(page, created);
    await recoveredTurn(page, reply);
  } finally {
    await leaveAndDelete(page, created.id);
  }
  await logout(page, oracle, project);
}

async function failedTurn(page: Page, created: { id: string | null }): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  await composer.fill(`WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_BODY=secret ${randomUUID()}`);
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sessions",
  );
  await composer.press("Enter");
  const response = await creation;
  const body = (await response.json()) as { id?: unknown };
  created.id = typeof body.id === "string" ? body.id : null;
  expect(response.status(), "POST /api/sessions status").toBe(201);

  const assistant = page.getByRole("article", { name: "助手" });
  await expect(assistant).toHaveCount(1);
  const failure = assistant.locator('[data-slot="message-error"]');
  await expect(failure.getByRole("alert")).toHaveText(FAILURE_LINE, { timeout: TURN_TIMEOUT_MS });
  // 原文默认收起；展开后是非空的纯文本，不含受控上游的密钥、bearer 令牌与 `sk-` 串。
  const toggle = failure.getByRole("button", { name: "查看原文", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(failure.locator('[data-slot="message-error-detail"]')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const detail = failure.locator('[data-slot="message-error-detail"]');
  await expect(detail).toBeVisible();
  const raw = await detail.innerText();
  expect(raw.trim(), "upstream text is shown").not.toBe("");
  for (const leak of LEAKS) {
    expect(raw, `upstream text without ${leak}`).not.toContain(leak);
  }
  await expect(composer).toBeEnabled();
}

async function recoveredTurn(page: Page, reply: string): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  await composer.fill("你好");
  const send = page.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  const assistant = page.getByRole("article", { name: "助手" });
  await expect(assistant).toHaveCount(2);
  const pending = page.getByRole("group", { name: "需要你的确认" });
  await expect(pending).toBeVisible({ timeout: TURN_TIMEOUT_MS });
  await pending.getByRole("button", { name: "允许", exact: true }).click();
  const latest = assistant.last();
  await expect(latest.locator('[data-slot="message-body"]')).toHaveText(reply, {
    timeout: TURN_TIMEOUT_MS,
  });
  await expect(latest.getByRole("group", { name: "已允许执行" })).toBeVisible();
  await expect(pending).toHaveCount(0);
  await expect(latest.locator('[data-slot="message-error"]')).toHaveCount(0);
  // 失败的那条仍在原处显示同一句话。
  await expect(
    assistant.first().locator('[data-slot="message-error"]').getByRole("alert"),
  ).toHaveText(FAILURE_LINE);
}

// `finally` 里调用：只产生 soft 失败，不盖掉 try 里的原始失败。
async function leaveAndDelete(page: Page, sessionId: string | null): Promise<void> {
  if (sessionId === null) return;
  try {
    await page.goto("/");
    await expect(welcomeHeading(page)).toBeVisible();
  } catch (error) {
    expect.soft(String(error), "cleanup: return to the welcome page failed").toBe("");
  }
  await deleteCreatedSession(page, sessionId);
}
