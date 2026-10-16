// UI walk：分段呈现三步（chat-harness「分段呈现的冒烟与走查」，issue 1477）。真栈：编译后的应用、官方 omp、
// 受控上游。宿主是主旅程的受闸会话：既有步骤全部走完之后、清理之前。返回该会话的导航已由等待指示一步
// 做过（ui-walk-waiting.ts 的 `page.goto(sessionUrl)`），思考预览一步之后页面仍停在它上面（读代码推出；
// 下面的 URL 与四问四答断言两个 project 实测通过）：这里只断言，不再导航。
// 1. 工具段在正文之前：第一条助手消息（bash 工具轮在答复轮之前）的分段区为工具段、正文段；工具段收起、
//    摘要 `执行 1 条命令`，消息内没有确认记录，展开后 bash 步骤卡没有确认标记（正常允许不标）。
// 2. 交错：同一会话发一条带 `WORKBUDDY_INTERLEAVE` 的消息（不带闸门标记：带已武装闸门时受控上游忽略本标记；
//    此后的回合没有工具轮），回合结束后为正文段、收起的 `已思考 N 秒` 折叠块、正文段，`复制` 写入两段正文拼接。
// 3. 刷新一致：重新加载后两条消息的分段区逐项相同（块的种类、次序、正文文本、折叠块标题与工具段摘要）；
//    展开工具段后 bash 步骤卡仍没有确认标记；经页面请求上下文读到的快照里交错消息恰一段思考，其
//    `bodyOffset` 等于第一部分正文的长度。

import { expect, type Locator, type Page } from "@playwright/test";
import { revealActions } from "./ui-walk-action-row.js";
import { generatingStatus } from "./ui-walk-approval.js";
import type { WalkProject } from "./ui-walk-layout.js";
import { expandToolGroup, toolGroup } from "./ui-walk-steps.js";

const INTERLEAVE = "WORKBUDDY_INTERLEAVE";
/** omp-test-harness「受控上游交错标记」：思考片之前的两片正文与之后的一片，照抄。 */
const LEAD = "先说一句，再补一句。";
const TAIL = "然后作答。";
const TOOL_SUMMARY = "执行 1 条命令";
const THOUGHT_TITLE = /^已思考 \d+ 秒$/u;
const SETTLED_RECORD = /^(已允许执行|已拒绝执行|超时自动允许)$/u;

/** 分段区的一块：种类与可见文本（正文全文、折叠块标题、工具段摘要），以及折叠块 / 工具段是否展开。 */
type Block = { kind: "text" | "thinking" | "tool"; text: string; expanded?: string | null };

// 分段区没有包裹元素（message-segments-view.tsx）：各块是消息内容容器的直接子元素。按文档顺序读出正文、
// 折叠块与工具段，其余子元素（兜底记录、错误、文件变更、操作行等）不计。
function blocksOf(message: Locator): Promise<Block[]> {
  return message.locator('[data-slot="message-content"]').evaluate((content) =>
    [...content.children].flatMap((el): Block[] => {
      const slot = el.getAttribute("data-slot");
      const text = (selector: string) => el.querySelector(selector)?.textContent ?? "";
      const expanded = (selector: string) =>
        el.querySelector(selector)?.getAttribute("aria-expanded") ?? null;
      if (slot === "message-body") return [{ kind: "text", text: el.textContent ?? "" }];
      if (slot === "reasoning-root") {
        const label = '[data-slot="reasoning-trigger-label"]';
        return [
          {
            kind: "thinking",
            text: text(label),
            expanded: expanded('[data-slot="reasoning-trigger"]'),
          },
        ];
      }
      if (slot === "tool-group-root") {
        const trigger = '[data-slot="tool-group-trigger"]';
        return [
          { kind: "tool", text: text('[data-slot="tool-summary"]'), expanded: expanded(trigger) },
        ];
      }
      return [];
    }),
  );
}

// 刷新前后逐项比较的部分：种类、次序与文本（展开态另行断言：工具段在第 1 步被展开过，刷新后回到收起）。
const comparable = (blocks: Block[]) => blocks.map(({ kind, text }) => ({ kind, text }));

/** 展开第一条助手消息的工具段：bash 步骤卡没有确认标记，消息内没有确认记录。 */
async function expectUnmarkedBash(first: Locator): Promise<void> {
  await expandToolGroup(first);
  const bash = toolGroup(first).getByRole("region", { name: "bash" });
  await expect(bash.getByRole("status", { name: "bash 已完成" })).toBeVisible();
  await expect(bash.locator('[data-slot="step-approval-mark"]')).toHaveCount(0);
  await expect(first.getByRole("group", { name: SETTLED_RECORD })).toHaveCount(0);
}

// `navigator.clipboard.writeText` 换成记下参数并 resolve 的桩（实例自有属性遮住原型方法）；`restore` 删掉它。
function stubClipboard(page: Page, mode: "record" | "restore"): Promise<void> {
  return page.evaluate((stub) => {
    const clipboard = navigator.clipboard;
    if (stub === "restore") {
      Reflect.deleteProperty(clipboard, "writeText");
      return;
    }
    const writeText = (text: string) => {
      document.documentElement.dataset.walkCopied = text;
      return Promise.resolve();
    };
    Object.defineProperty(clipboard, "writeText", { configurable: true, value: writeText });
  }, mode);
}

function assistantIdOf(body: unknown): number {
  const id =
    body !== null && typeof body === "object" && "assistantMessageId" in body
      ? body.assistantMessageId
      : undefined;
  if (typeof id !== "number") throw new Error("prompt 202 body has no assistantMessageId");
  return id;
}

/** 快照里该消息的 `thinkingSegments`（经页面的请求上下文读，带页面的登录 cookie）。 */
async function snapshotSegments(page: Page, sessionId: string, messageId: number) {
  const response = await page.request.get(`/api/sessions/${sessionId}/messages`);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const messages =
    body !== null && typeof body === "object" && "messages" in body && Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];
  const message = messages.find((entry) => entry?.id === messageId);
  if (message === undefined) throw new Error(`snapshot has no message ${String(messageId)}`);
  return message.thinkingSegments;
}

/** 三步。`sessionId` / `sessionUrl` 是受闸会话；`reply` 是受控上游的固定回复（第一条助手消息的正文）。 */
export async function walkSegments(
  page: Page,
  project: WalkProject,
  sessionId: string,
  sessionUrl: string,
  reply: string,
): Promise<void> {
  const users = page.getByRole("article", { name: "用户" });
  const assistants = page.getByRole("article", { name: "助手" });
  const first = assistants.first();
  const fifth = assistants.nth(4);
  const composer = page.getByLabel("给助手发消息");
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk segments ${project}: ${point} +${Date.now() - started}ms`);

  // 紧接思考预览一步：仍在受闸会话上，此前四问四答都在。
  expect(page.url()).toBe(sessionUrl);
  expect(new URL(page.url()).searchParams.get("session")).toBe(sessionId);
  await expect(users).toHaveCount(4);
  await expect(assistants).toHaveCount(4);

  // 第 1 步：先断言收起态与摘要（展开前），再展开看步骤卡。
  const tool = { kind: "tool", text: TOOL_SUMMARY, expanded: "false" };
  expect(await blocksOf(first), "first assistant: tool segment before text").toEqual([
    tool,
    { kind: "text", text: reply },
  ]);
  await expect(
    toolGroup(first).getByRole("button", { name: TOOL_SUMMARY, exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByRole("group", { name: SETTLED_RECORD })).toHaveCount(0);
  await expectUnmarkedBash(first);
  mark("tool before text");

  // 第 2 步：交错。
  await expect(composer).toBeEnabled();
  await composer.fill(`分段走查 ${INTERLEAVE}`);
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/sessions/${sessionId}/prompt` &&
      response.request().method() === "POST",
  );
  await composer.press("Enter");
  const response = await accepted;
  expect(response.status()).toBe(202);
  const messageId = assistantIdOf(await response.json());
  await expect(users).toHaveCount(5);
  await expect(assistants).toHaveCount(5);
  // 回合结束：操作行（`复制`）只在消息不在运行时渲染，输入框回到 `发送`。
  await expect(fifth.getByRole("button", { name: "复制", exact: true })).toHaveCount(1);
  await expect(generatingStatus(page)).toHaveCount(0);
  await expect(
    page.locator("form").getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  expect(await blocksOf(fifth), "interleaved assistant: text, folded thinking, text").toEqual([
    { kind: "text", text: LEAD },
    { kind: "thinking", text: expect.stringMatching(THOUGHT_TITLE), expanded: "false" },
    { kind: "text", text: TAIL },
  ]);
  await expect(fifth.locator('[data-slot="reasoning-root"]')).not.toHaveAttribute("data-running");
  try {
    await stubClipboard(page, "record");
    await revealActions(page, fifth);
    await fifth.getByRole("button", { name: "复制", exact: true }).click();
    await expect(fifth.getByRole("status").filter({ hasText: /^已复制$/u })).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.dataset.walkCopied),
      "复制 writes the two text segments joined",
    ).toBe(`${LEAD}${TAIL}`);
  } finally {
    await stubClipboard(page, "restore");
    await page.evaluate(() => delete document.documentElement.dataset.walkCopied);
  }
  mark("interleaved");

  // 第 3 步：刷新一致。
  const both = async () => [comparable(await blocksOf(first)), comparable(await blocksOf(fifth))];
  const before = await both();
  await page.reload();
  await expect.poll(() => page.url()).toBe(sessionUrl);
  await expect(assistants).toHaveCount(5);
  await expect.poll(both, "both messages' segments after reload").toEqual(before);
  expect((await blocksOf(first))[0], "tool segment collapsed after reload").toEqual(tool);
  expect((await blocksOf(fifth))[1]?.expanded, "fold collapsed after reload").toBe("false");
  await expectUnmarkedBash(first);
  const segments = await snapshotSegments(page, sessionId, messageId);
  expect(Array.isArray(segments) ? segments.length : segments, "one thinking segment").toBe(1);
  expect(
    (segments as Array<Record<string, unknown>>)[0]?.bodyOffset,
    "segment bodyOffset = length of the lead text",
  ).toBe(LEAD.length);
  mark("reload");
}
