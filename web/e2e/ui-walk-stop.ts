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
import { toolGroup } from "./ui-walk-steps.js";

const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const FIRST_REPLY_PART = "你好，";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const STOPPED_TOAST = "已停止生成";
const REGENERATING_TOAST = "正在重新生成…";
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
// 停止不弹提示：`已停止生成` 的断言放在 `已停止` 徽章出现之后（此时 stop 的 202 早已处理完），并在本步末尾再查一次。
// 两处都是即时计数、不重试：会重试的「数量为 0」等得到提示自己消失，对弹提示的实现不判红。
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
  // 整页范围：既不在通知区，也不在别处出现这句文本（空正文的占位是带括号的另一句）。
  const toast = page.getByText(STOPPED_TOAST, { exact: true });
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
    await expect(second.locator('[data-slot="message-body"]')).toHaveText(FIRST_REPLY_PART);
    await expect(generatingStatus(page)).toBeVisible();
    await expect(stop).toBeEnabled();
    await expect(send).toHaveCount(0);
    expect(await gatePhase(origin, gateId)).toBe("held");

    const stopped = sessionPost(page, sessionId, "stop");
    await stop.click();
    expect((await stopped).status()).toBe(202);
    mark("stop 202");
    await expect(stoppedBadge).toBeVisible();
    expect(await toast.count(), "no stopped toast").toBe(0);
    await expect(second.getByRole("alert")).toHaveCount(0);
    await expect(second.locator('[data-slot="message-body"]')).toHaveText(FIRST_REPLY_PART);
    await expect(users).toHaveCount(2);
    await expect(assistants).toHaveCount(2);
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(generatingStatus(page)).toHaveCount(0);

    await expect.poll(() => gatePhase(origin, gateId)).toBe("status:404");
    mark("gate 404");
    await inspectSidebar(page, project, async (sidebar) => {
      const current = sidebar
        .getByRole("navigation", { name: "会话列表" })
        .locator('button[aria-current="true"]');
      await expect(current).toHaveCount(1);
      const title = await current.getAttribute("aria-label");
      await expect(current.getByRole("status")).toHaveAccessibleName(`${title} 已停止`);
    });
    expect(await toast.count(), "no stopped toast after the round").toBe(0);
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
  // 整页范围：重新生成不弹任何提示，这句文本哪里都不出现；通知区里也没有任何一条提示。
  const toast = page.getByText(REGENERATING_TOAST, { exact: true });
  const anyToast = page.getByRole("region", { name: /通知/u }).getByRole("status");
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
  await expect(stoppedBadge).toHaveCount(0);
  // 徽章消失在 202 回调的下游：回调里弹出的提示此刻已挂载且还没到自动消失的时间。即时计数、不重试——
  // 会重试的「数量为 0」会等到提示自己消失后通过。
  expect(await toast.count(), "no regenerating toast").toBe(0);
  expect(await anyToast.count(), "no toast at all").toBe(0);
  mark("badge gone");
  await expect(second.locator('[data-slot="message-body"]')).toHaveText(EXPECTED_REPLY);
  mark("original reply");
  await expect(page.getByRole("group", { name: "需要你的确认" })).toHaveCount(0);
  await expect(toolGroup(second)).toHaveCount(0);
  await expect(second.getByRole("alert")).toHaveCount(0);
  await expect(users).toHaveCount(2);
  await expect(assistants).toHaveCount(2);

  await expect(page.getByLabel("给助手发消息")).toBeEnabled();
  await expect(form.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(generatingStatus(page)).toHaveCount(0);
  await expect(regenerate).toBeEnabled();
  // 回合结束、输入框解锁之后再数一次（即时计数）：完成时才弹出的提示此刻也还挂着。
  expect(await toast.count(), "no regenerating toast after the round").toBe(0);
  expect(await anyToast.count(), "no toast at all after the round").toBe(0);

  await inspectSidebar(page, project, async (sidebar) => {
    const current = sidebar
      .getByRole("navigation", { name: "会话列表" })
      .locator('button[aria-current="true"]');
    await expect(current).toHaveCount(1);
    const title = await current.getAttribute("aria-label");
    await expect(current.getByRole("status")).toHaveAccessibleName(`${title} 已完成`);
  });
}

// 首条用户消息 `从此处分叉` → 201 → URL 选中新会话（与 201 体一致）→ 历史已装载且为空、显示零消息空态 → 侧栏 `未开始` → 草稿恰为首条 prompt。
// 无 prompt POST：监听在点击前挂上、覆盖任何会话；窗口止于侧栏断言——setDraft/refreshList/selectSession 同在一个回调里，
// 空转录与侧栏新项都在其下游，回调里任何同步自动发送此时已发出。分叉不弹 Toast（message-action-row.tsx UserActions）。
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

  const bubble = first.locator('[data-slot="message-body"]');
  await expect(bubble).toHaveText(prompt);
  // 用户气泡保留空白、靠右：计算样式只有真实浏览器给得出。
  await expect(bubble).toHaveCSS("white-space", "pre-wrap");
  await expect(first).toHaveCSS("align-self", "flex-end");
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

    const transcript = main
      .getByRole("region", { name: "消息" })
      .filter({ hasNot: page.getByRole("article") });
    await expect(transcript).toBeVisible();
    await expect(transcript.getByRole("button", { name: "重新生成", exact: true })).toHaveCount(0);
    // 零消息空态（#825）：一行提示在线程区里；欢迎态的场景分组、快捷任务与最佳实践卡不出现，也没有 hero。
    await expect(transcript.getByText("还没有消息，发一条开始吧", { exact: true })).toBeVisible();
    for (const role of ["group", "region", "heading"] as const) {
      const name = {
        group: /^(场景|快捷任务)$/,
        region: "最佳实践案例",
        heading: "WorkBuddy，我帮你",
      };
      await expect(main.getByRole(role, { name: name[role] })).toHaveCount(0);
    }
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
