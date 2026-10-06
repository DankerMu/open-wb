// UI walk task-list step (chat-harness「UI 走查会话元数据」step 13, s1f-chat-surface design D10): a
// turn whose prompt carries WORKBUDDY_TODO makes the controlled upstream issue one `todo` `init`
// tool call; real omp executes it without an approval and its result carries the list. The panel
// then sits at the top of the dock above the composer, and comes back from the snapshot after a
// reload (expanded again: the collapsed state lives in memory only).

import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { expectDockFrame } from "./ui-walk-approval.js";
import { toolGroup } from "./ui-walk-steps.js";

const TURN_DONE_TIMEOUT_MS = 10_000;
const APPROVAL_GROUPS = /^(需要你的确认|已允许执行|已拒绝执行|超时自动允许)$/u;
const PANEL_BUTTON = "任务清单 0/2";
// 受控上游 `init` 的两项任务；omp 把第一项置为进行中。
const EXPECTED_TODO = {
  phases: [
    {
      name: "走查",
      tasks: [
        { content: "整理需求", status: "in_progress" },
        { content: "输出结论", status: "pending" },
      ],
    },
  ],
};

// 面板展开：头部按钮在所有消息之外、输入框之上；恰两项，状态与正文按序；不显示唯一阶段的名字。
async function expectExpandedPanel(page: Page): Promise<Locator> {
  const dock = page.locator('[data-slot="composer-dock"]');
  const toggle = dock.getByRole("button", { name: PANEL_BUTTON, exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^任务清单/u })).toHaveCount(1);
  await expect(page.getByRole("article").getByRole("button", { name: /^任务清单/u })).toHaveCount(
    0,
  );
  const items = dock.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.locator('[data-slot="todo-status"]')).toHaveText(["进行中", "待办"]);
  await expect(items.locator('[data-slot="todo-content"]')).toHaveText(["整理需求", "输出结论"]);
  await expect(dock).not.toContainText("走查");
  const toggleBox = await toggle.boundingBox();
  const inputBox = await page.getByLabel("给助手发消息").boundingBox();
  if (!toggleBox || !inputBox) throw new Error("task list: no bounding box");
  expect(toggleBox.y + toggleBox.height, "panel header above the composer").toBeLessThanOrEqual(
    inputBox.y,
  );
  return toggle;
}

// 调用前页面在欢迎态。`created.id` 在 201 一到就记下，调用方的 `finally` 凭它删除。结束时页面回到
// 欢迎态（那里没有面板），会话留给调用方删除。
export async function walkTodoPanel(
  page: Page,
  reply: string,
  created: { id: string | null },
): Promise<void> {
  const prompt = `WORKBUDDY_TODO 任务清单走查 ${randomUUID()}`;
  const composer = page.getByLabel("给助手发消息");
  const user = page.getByRole("article", { name: "用户" });
  const assistant = page.getByRole("article", { name: "助手" });
  const posts: string[] = [];
  const record = (response: Response) => {
    if (response.request().method() === "POST")
      posts.push(`${response.status()} ${new URL(response.url()).pathname}`);
  };

  await composer.fill(prompt);
  page.on("response", record);
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sessions",
  );
  await composer.press("Enter");
  const response = await creation;
  expect(response.status(), "POST /api/sessions status").toBe(201);
  const sessionId = ((await response.json()) as { id: string }).id;
  created.id = sessionId;

  await expect(assistant.locator('[data-slot="message-body"]')).toHaveText(reply, {
    timeout: TURN_DONE_TIMEOUT_MS,
  });
  page.off("response", record);
  expect(posts, "首次发送：恰一次创建（201）加恰一次 prompt（202）").toEqual([
    "201 /api/sessions",
    `202 /api/sessions/${sessionId}/prompt`,
  ]);
  // 真 omp 执行了 `todo` 工具（一个步骤），没有为它发起审批：整页没有提问卡，也没有已结算的记录。
  await expect(toolGroup(assistant).getByRole("button")).toHaveText("1 个步骤 · todo 已完成");
  await expect(page.getByRole("group", { name: APPROVAL_GROUPS })).toHaveCount(0);
  await expect(composer).toBeEnabled();

  const toggle = await expectExpandedPanel(page);
  await expectDockFrame(page, "发送");

  const snapshot = await page.request.get(`/api/sessions/${sessionId}/messages`);
  expect(snapshot.status(), "GET messages status").toBe(200);
  const body = (await snapshot.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["messages", "session", "streamCursor", "todo"]);
  expect(body.todo).toStrictEqual(EXPECTED_TODO);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-slot="composer-dock"]').getByRole("listitem")).toHaveCount(0);

  await page.reload();
  await expect(assistant.locator('[data-slot="message-body"]')).toHaveText(reply);
  await expectExpandedPanel(page);
  await expect(user).toHaveCount(1);
  await expect(assistant).toHaveCount(1);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^任务清单/u })).toHaveCount(0);
}
