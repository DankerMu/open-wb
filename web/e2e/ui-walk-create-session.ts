// ui-walk：首次发送建会话（#826）。
import { expect, type Locator, type Page, type Request, type Response } from "@playwright/test";
import { inspectSidebar, openSidebar, sessionList, type WalkProject } from "./ui-walk-layout.js";

const NAV_OVERLAY = { name: "导航", exact: true } as const;

function sessionEntries(sidebar: Locator): Locator {
  return sessionList(sidebar).getByRole("listitem");
}

const WELCOME_HERO = "WorkBuddy，我帮你";
const PROMPT_PATH = /^\/api\/sessions\/[0-9a-f]{32}\/prompt$/;

// 首次发送建会话（#826）。侧栏 新建会话 只回欢迎态：零 POST、URL 无会话 id、列表条数不变（mobile 先开
// 覆盖层，点击后覆盖层随即关闭）。随后在欢迎态输入 `prompt` 并回车：恰一次创建、恰一次 prompt（202），
// URL 选中返回的 id，列表多出恰一条且它是当前项。返回 prompt 的 202 响应。
export async function createSessionFromSidebar(
  page: Page,
  project: WalkProject,
  prompt: string,
): Promise<Response> {
  const posts: string[] = [];
  const onRequest = (request: Request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && pathname.startsWith("/api/sessions")) posts.push(pathname);
  };
  page.on("request", onRequest);
  try {
    const sidebar = await openSidebar(page, project);
    const before = await sessionEntries(sidebar).count();
    await sessionList(sidebar).getByRole("button", { name: "新建会话" }).click();
    if (project === "mobile-dark") {
      await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { level: 1, name: WELCOME_HERO })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("session"), "新建会话 后 URL 无会话 id").toBeNull();
    await inspectSidebar(page, project, async (current) => {
      await expect(sessionEntries(current), "新建会话 后会话数不变").toHaveCount(before);
    });
    expect(posts, "新建会话 不发请求").toEqual([]);

    const composer = page.getByLabel("给助手发消息");
    await composer.fill(prompt);
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        PROMPT_PATH.test(new URL(response.url()).pathname) &&
        response.status() === 202,
    );
    await composer.press("Enter");
    const response = await accepted;
    const sessionId = new URL(page.url()).searchParams.get("session");
    expect(posts, "首次发送：恰一次创建加恰一次 prompt").toEqual([
      "/api/sessions",
      `/api/sessions/${sessionId}/prompt`,
    ]);
    await inspectSidebar(page, project, async (current) => {
      await expect(sessionEntries(current)).toHaveCount(before + 1);
      await expect(sessionList(current).locator('button[aria-current="true"]')).toHaveCount(1);
    });
    return response;
  } finally {
    page.off("request", onRequest);
  }
}
