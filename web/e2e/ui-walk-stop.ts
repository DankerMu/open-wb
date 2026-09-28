// UI walk stop step: a second gated prompt on the same session is stopped while the fake-upstream
// gate is `held`; the abort destroys the held response, and finally only deletes the gate.
// UI walk regenerate step: with that gate gone, `重新生成` on the stopped last assistant replays the
// second prompt and replaces the stopped prefix with the complete fixed reply.
// UI walk fork step: `从此处分叉` on the first user message opens an empty forked session whose
// composer draft is exactly the first prompt, and the draft is never sent.

import { randomUUID } from "node:crypto";
import { expect, type Page, type Request } from "@playwright/test";
import { generatingStatus } from "./ui-walk-approval.js";
import { armGate, controlOrigin, deleteGate, gatePhase } from "./ui-walk-gate.js";
import { inspectSidebar, type WalkProject } from "./ui-walk-layout.js";

const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const FIRST_REPLY_PART = "你好，";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const STOPPED_TOAST = "已停止生成";
const REGENERATING_TOAST = "正在重新生成…";
const TOAST_GONE_TIMEOUT_MS = 10_000;
const SESSION_ID = /^[0-9a-f]{32}$/;
const PROMPT_PATH = /^\/api\/sessions\/[^/]+\/prompt$/;

function sessionPost(
  page: Page,
  sessionId: string,
  endpoint: "prompt" | "stop" | "regenerate" | "fork",
) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/sessions/${sessionId}/${endpoint}` &&
      response.request().method() === "POST",
  );
}

// 点击只在 gate `held` + 第二条助手已呈现前缀 + form 内 `生成中` 同时成立时发生（`停止` 可用不足以证明 running）。
// 末尾先等 Toast 消失再查侧栏：Toast 显示期间 mobile 导航覆盖层按 Escape 关不掉（#643）。
export async function walkStop(
  page: Page,
  project: WalkProject,
  sessionId: string,
): Promise<string> {
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
    return gateId;
  } finally {
    await deleteGate(origin, gateId);
  }
}

// 点击前先删第二个 gate 并确认 GET 为 404（deleteGate 吞状态码，404 断言才承重）：否则重放回合挂在 armed 或 409 于 held。
// 「已替换」= 徽章消失 + 精确全文 + 恰 2+2；徽章先于正文消失，不能单独作证。不断言重放回合的瞬时运行态。
export async function walkRegenerate(
  page: Page,
  project: WalkProject,
  sessionId: string,
  gateId: string,
): Promise<void> {
  const origin = controlOrigin();
  const form = page.locator("form");
  const users = page.getByRole("article", { name: "用户" });
  const assistants = page.getByRole("article", { name: "助手" });
  const second = assistants.nth(1);
  const stoppedBadge = second.getByRole("status", { name: "助手消息 已停止", exact: true });
  const regenerate = second.getByRole("button", { name: "重新生成", exact: true });
  const toast = page
    .getByRole("region", { name: /通知/u })
    .getByText(REGENERATING_TOAST, { exact: true });
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk regenerate ${project}: ${point} +${Date.now() - started}ms`);

  await deleteGate(origin, gateId);
  await expect.poll(() => gatePhase(origin, gateId)).toBe("status:404");
  await expect(stoppedBadge).toBeVisible();

  const accepted = sessionPost(page, sessionId, "regenerate");
  await regenerate.click();
  expect((await accepted).status()).toBe(202);
  mark("regenerate 202");
  await expect(toast).toBeVisible();
  mark("toast visible");
  await expect(stoppedBadge).toHaveCount(0);
  mark("badge gone");
  await expect(second.locator(".chat-md")).toHaveText(EXPECTED_REPLY);
  mark("original reply");
  await expect(second.getByRole("group", { name: "需要你的确认" })).toHaveCount(0);
  await expect(second.getByRole("region", { name: "bash" })).toHaveCount(0);
  await expect(second.getByRole("alert")).toHaveCount(0);
  await expect(users).toHaveCount(2);
  await expect(assistants).toHaveCount(2);

  await expect(page.getByLabel("给助手发消息")).toBeEnabled();
  await expect(form.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(generatingStatus(page)).toHaveCount(0);
  await expect(regenerate).toBeEnabled();

  await expect(toast).toHaveCount(0, { timeout: TOAST_GONE_TIMEOUT_MS });
  mark("toast gone");
  await inspectSidebar(page, project, async (sidebar) => {
    const current = sidebar
      .getByRole("navigation", { name: "会话列表" })
      .locator('button[aria-current="true"]');
    await expect(current).toHaveCount(1);
    const title = await current.getAttribute("aria-label");
    await expect(current.getByRole("status")).toHaveAccessibleName(`${title} 已完成`);
  });
}

// 首条用户消息 `从此处分叉` → 201 → URL 选中新会话（与 201 体一致）→ 历史已装载且为空 → 侧栏 `未开始` → 草稿恰为首条 prompt。
// 无 prompt POST：监听在点击前挂上、覆盖任何会话；窗口止于侧栏断言——setDraft/refreshList/selectSession 同在一个回调里，
// 空转录与侧栏新项都在其下游，回调里任何同步自动发送此时已发出。分叉不弹 Toast（message-actions.tsx ForkAction）。
export async function walkFork(
  page: Page,
  project: WalkProject,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const first = page.getByRole("article", { name: "用户" }).first();
  const fork = first.getByRole("button", { name: "从此处分叉", exact: true });
  const main = page.getByRole("main");
  const prompts: string[] = [];
  const onRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && PROMPT_PATH.test(path)) prompts.push(path);
  };
  const forkedId = () => new URL(page.url()).searchParams.get("session") ?? "";
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk fork ${project}: ${point} +${Date.now() - started}ms`);

  await expect(first.locator(".chat-msg-body")).toHaveText(prompt);
  await expect(fork).toBeEnabled();
  page.on("request", onRequest);
  try {
    const created = sessionPost(page, sessionId, "fork");
    await fork.click();
    const response = await created;
    expect(response.status()).toBe(201);
    mark("fork 201");
    const body = (await response.json()) as { session: { id: string } };
    await expect.poll(forkedId).toBe(body.session.id);
    expect(forkedId()).toMatch(SESSION_ID);
    expect(forkedId()).not.toBe(sessionId);
    mark("url");

    await expect(main.getByRole("region", { name: "消息" })).toBeVisible();
    await expect(main.getByRole("article")).toHaveCount(0);
    await expect(main.getByRole("button", { name: "重新生成", exact: true })).toHaveCount(0);
    mark("empty transcript");
    await expect(page.getByLabel("给助手发消息")).toHaveValue(prompt);
    await expect(
      page.locator("form").getByRole("button", { name: "发送", exact: true }),
    ).toBeEnabled();
    mark("draft");
    await inspectSidebar(page, project, async (sidebar) => {
      const current = sidebar
        .getByRole("navigation", { name: "会话列表" })
        .locator('button[aria-current="true"]');
      await expect(current).toHaveCount(1);
      const title = await current.getAttribute("aria-label");
      await expect(current.getByRole("status")).toHaveAccessibleName(`${title} 未开始`);
    });
    mark("sidebar");
    expect(prompts, "no prompt POST after fork").toEqual([]);
  } finally {
    page.off("request", onRequest);
  }
}
