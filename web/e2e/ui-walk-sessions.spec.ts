// UI walk, session metadata (chat-harness「UI 走查会话元数据」steps 1–6): one serial journey per
// project against the real stack — compiled app, real omp, controlled upstream driven by the
// prompt markers WORKBUDDY_THINK / WORKBUDDY_WRITE. Nothing is fulfilled, faked or slept on.
// The journey deletes the session it created in `finally` and ends with a UI logout, which the
// error oracle needs for its second expected /api/auth/me 401.

import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  DEV_ACCOUNT,
  expectAuthenticatedRoute,
  expectSelectedSessionStatus,
  inspectSidebar,
  openSidebar,
  type WalkProject,
  walkProject,
} from "./ui-walk-layout.js";
import { type AuthOracle, runWithBrowserErrorOracle } from "./ui-walk-oracle.js";

const DEV_PASSWORD = "demo";
const WORKSPACE_NAME = "ui-walk-sessions";
const REPORT_FILE = "workbuddy-report.html";
// ADR-0011 逻辑路径 `<account>/<dir>/<path>`，不含沙箱根。
const LOGICAL_PATH = "zhangsan/ui-walk-sessions/workbuddy-report.html";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const EXPECTED_THINKING = "先读需求，再列要点，最后作答。";
const EXPECTED_CHANGES = [{ path: REPORT_FILE, added: null, removed: null, kind: "write" }];
const SCENE_PILLS = ["日常办公", "代码开发", "创意设计"];
const CODE_CHIPS = ["日常开发", "网站开发", "Agent 应用", "Skill 开发", "CI/CD"];
const SCENE_TOAST = "已切换到「代码开发」场景";
const HEX_ID = /^[0-9a-f]{32}$/;
const SPACES_SECTION = /^空间 \(\d+\)$/u;
const TASKS_SECTION = /^任务 \(\d+\)$/u;
const CURRENT_SESSION = 'button[aria-current="true"]';
// 真 omp 的两轮回合（write 工具轮 + 思考与回复轮）；只有等回合完成的那条断言带显式超时。
const TURN_DONE_TIMEOUT_MS = 10_000;

/** 建会话的 201 一到就记下 id，`finally` 凭它删除——先于对该请求的任何断言。 */
type CreatedSession = { id: string | null };

type SessionSnapshot = {
  session: { id: string; scene: string | null; workspaceId: string | null; status: string };
  messages: {
    role: string;
    thinking: string | null;
    steps: { name: string; changes: unknown }[];
  }[];
};

test.describe.configure({ mode: "serial" });

test("session metadata journey binds a code session to a workspace and shows its thinking, changes and artifact", async ({
  baseURL,
  page,
}, testInfo) => {
  const project = walkProject(testInfo.project.name);
  await runWithBrowserErrorOracle(
    page,
    baseURL,
    { watchAssets: project === "desktop-light" },
    (oracle) => walkSessionMeta(page, oracle, project),
  );
});

async function walkSessionMeta(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
): Promise<void> {
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk sessions ${project}: ${point} +${Date.now() - started}ms`);
  const created: CreatedSession = { id: null };
  const prompt = `WORKBUDDY_THINK WORKBUDDY_WRITE 会话走查 ${randomUUID()}`;

  await step1Login(page, oracle, project);
  // 会话页只在挂载与建会话后读空间列表：先确保空间存在，再进入 `/`。
  const workspaceId = await step1EnsureWorkspace(page);
  mark("step 1");
  try {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你", exact: true }),
    ).toBeVisible();
    await step2PickScene(page);
    await step2PickWorkspace(page);
    mark("step 2");
    const sessionId = await step3SendPrompt(page, project, workspaceId, prompt, created);
    mark("step 3");
    await step4ThinkingFold(page);
    await expectServerSnapshot(page, sessionId, workspaceId);
    mark("step 4");
    await step5FileChanges(page);
    await step5ArtifactPreview(page);
    await step5ArtifactsDrawer(page);
    await step5ViewDetails(page, workspaceId, sessionId);
    mark("step 5");
    await step6Sidebar(page, project);
    mark("step 6");
    // 先离开会话页再删：仍订阅着已删会话的页面会把事件流重连进 404。
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "设置", exact: true })).toBeVisible();
  } finally {
    await deleteCreatedSession(page, created.id);
  }
  mark("cleanup");
  await logout(page, oracle, project);
  mark("logout");
}

async function step1Login(page: Page, oracle: AuthOracle, project: WalkProject): Promise<void> {
  await page.goto("/files");
  await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
  await page.getByLabel("账号").fill(DEV_ACCOUNT);
  await page.getByLabel("密码").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expectAuthenticatedRoute(page, project, "/files", "工作空间", "工作空间");
  oracle.phase = "authenticated";
}

// 201（全新状态）或 409（已存在）；id 与 dir 从列表读，dir 等于名字是逻辑路径的前提。
async function step1EnsureWorkspace(page: Page): Promise<string> {
  const ensured = await page.request.post("/api/workspaces", { data: { name: WORKSPACE_NAME } });
  expect([201, 409], "POST /api/workspaces status").toContain(ensured.status());
  const listed = await page.request.get("/api/workspaces");
  expect(listed.status(), "GET /api/workspaces status").toBe(200);
  const body = (await listed.json()) as { workspaces: { id: string; name: string; dir: string }[] };
  const named = body.workspaces.filter((workspace) => workspace.name === WORKSPACE_NAME);
  expect(named.map((workspace) => workspace.dir)).toEqual([WORKSPACE_NAME]);
  const id = named[0]?.id ?? "";
  expect(id).toMatch(HEX_ID);
  return id;
}

async function expectPressed(pills: Locator, pressed: readonly string[]): Promise<void> {
  await expect(pills).toHaveText(SCENE_PILLS);
  for (const [index, value] of pressed.entries()) {
    await expect(pills.nth(index)).toHaveAttribute("aria-pressed", value);
  }
}

async function step2PickScene(page: Page): Promise<void> {
  const pills = page.getByRole("group", { name: "场景", exact: true }).getByRole("button");
  await expectPressed(pills, ["true", "false", "false"]);
  await pills.filter({ hasText: "代码开发" }).click();
  await expectPressed(pills, ["false", "true", "false"]);
  await expect(
    page.getByRole("group", { name: "快捷任务", exact: true }).getByRole("button"),
  ).toHaveText(CODE_CHIPS);
}

async function step2PickWorkspace(page: Page): Promise<void> {
  await page.getByRole("button", { name: "任务启动于 未选择", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "选择工作空间", exact: true });
  await popover.getByLabel("搜索工作空间").fill(WORKSPACE_NAME);
  await popover
    .getByRole("button")
    .filter({ has: page.getByText(WORKSPACE_NAME, { exact: true }) })
    .click();
  await expect(popover).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `任务启动于 ${WORKSPACE_NAME}`, exact: true }),
  ).toBeVisible();
}

// 只观测 `POST /api/sessions`；返回会话 id。场景 Toast 显示期间 mobile 导航覆盖层按 Escape 关不掉
// （#643），所以先等它消失再经侧栏读状态。
async function step3SendPrompt(
  page: Page,
  project: WalkProject,
  workspaceId: string,
  prompt: string,
  created: CreatedSession,
): Promise<string> {
  const composer = page.getByLabel("给助手发消息");
  await composer.fill(prompt);
  const creation = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/sessions",
  );
  await composer.press("Enter");
  const request = await creation;
  const response = await request.response();
  if (response === null) throw new Error("POST /api/sessions produced no response");
  expect(response.status(), "POST /api/sessions status").toBe(201);
  const sessionId = ((await response.json()) as { id: string }).id;
  created.id = sessionId;
  expect(sessionId).toMatch(HEX_ID);
  expect(request.postDataJSON()).toStrictEqual({ workspaceId, scene: "code" });
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(sessionId);

  const user = page.getByRole("article", { name: "用户" });
  const assistant = page.getByRole("article", { name: "助手" });
  await expect(assistant.locator(".chat-md")).toHaveText(EXPECTED_REPLY, {
    timeout: TURN_DONE_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("region", { name: /通知/u }).getByText(SCENE_TOAST, { exact: true }),
  ).toHaveCount(0);
  await expectSelectedSessionStatus(page, project, "已完成");
  await expect(
    assistant.getByRole("region", { name: "write" }).getByRole("status", { name: "write 已完成" }),
  ).toBeVisible();
  for (const name of ["需要你的确认", "已允许执行", "已拒绝执行"]) {
    await expect(assistant.getByRole("group", { name })).toHaveCount(0);
  }
  await expect(user).toHaveCount(1);
  await expect(assistant).toHaveCount(1);
  await expect(user.locator(".chat-msg-body")).toHaveText(prompt);
  return sessionId;
}

async function step4ThinkingFold(page: Page): Promise<void> {
  const assistant = page.getByRole("article", { name: "助手" });
  const fold = assistant.locator("details.thinking-block");
  await expect(fold).toHaveCount(1);
  // 同一父元素内先于回答正文。
  await expect(assistant.locator("details.thinking-block ~ .chat-md")).toHaveCount(1);
  await expect(fold).not.toHaveAttribute("open", "");
  const summary = fold.locator("summary");
  await expect(summary).toHaveText("深度思考过程");
  await summary.click();
  await expect(fold).toHaveAttribute("open", "");
  await expect(fold.locator(".thinking-body")).toBeVisible();
  await expect(fold.locator(".thinking-body")).toHaveText(EXPECTED_THINKING);
}

// 第 4、5 步在 DOM 上看到的值，经页面的请求上下文从服务端回读。
async function expectServerSnapshot(
  page: Page,
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  const response = await page.request.get(`/api/sessions/${sessionId}/messages`);
  expect(response.status(), "GET messages status").toBe(200);
  const snapshot = (await response.json()) as SessionSnapshot;
  expect(snapshot.session).toMatchObject({
    id: sessionId,
    scene: "code",
    workspaceId,
    status: "done",
  });
  const assistants = snapshot.messages.filter((message) => message.role === "assistant");
  expect(assistants).toHaveLength(1);
  expect(assistants[0]?.thinking).toBe(EXPECTED_THINKING);
  expect(assistants[0]?.steps.map((step) => step.name)).toEqual(["write"]);
  expect(assistants[0]?.steps[0]?.changes).toStrictEqual(EXPECTED_CHANGES);
}

function fileChangesCard(page: Page): Locator {
  return page
    .getByRole("article", { name: "助手" })
    .getByRole("group", { name: "文件变更（1 个）", exact: true });
}

async function step5FileChanges(page: Page): Promise<void> {
  const row = fileChangesCard(page).locator(".file-change-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".file-change-path")).toHaveText(LOGICAL_PATH);
  await expect(row.locator(".file-change-kind")).toHaveText("写入");
  await expect(row.locator(".file-change-add")).toHaveCount(0);
  await expect(row.locator(".file-change-del")).toHaveCount(0);
}

// 卡内有两个同名动作按钮（头部图标、底部文字），点带文字的那个。
async function step5ArtifactPreview(page: Page): Promise<void> {
  const card = page
    .getByRole("article", { name: "助手" })
    .getByRole("group", { name: REPORT_FILE, exact: true });
  await expect(card.locator(".artifact-lang")).toHaveText("HTML");
  await card
    .getByRole("button", { name: `打开网页预览 ${REPORT_FILE}`, exact: true })
    .filter({ hasText: "打开网页预览" })
    .click();
  const dialog = page.getByRole("dialog", { name: REPORT_FILE, exact: true });
  const frame = dialog.locator("iframe.artifact-preview-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(
    frame.contentFrame().getByRole("heading", { name: "WorkBuddy", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

// 抽屉里有两个 `关闭`（头部图标、底部按钮），点带文字的那个；抽屉消失后再继续。
async function step5ArtifactsDrawer(page: Page): Promise<void> {
  await page.getByRole("banner").getByRole("button", { name: "产物面板", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "产物面板", exact: true });
  const row = drawer.locator(".file-change-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".file-change-path")).toHaveText(LOGICAL_PATH);
  await drawer
    .getByRole("button", { name: "关闭", exact: true })
    .filter({ hasText: "关闭" })
    .click();
  await expect(drawer).toHaveCount(0);
}

// 文件页只认 `ws`（没有 path 参数），落到空间；随后以真实导航回到会话。
async function step5ViewDetails(page: Page, workspaceId: string, sessionId: string): Promise<void> {
  await fileChangesCard(page)
    .getByRole("button", { name: `查看详情 ${LOGICAL_PATH}`, exact: true })
    .click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/files");
  await expect.poll(() => new URL(page.url()).searchParams.get("ws")).toBe(workspaceId);
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "选择工作空间" })
      .getByText(WORKSPACE_NAME, { exact: true }),
  ).toBeVisible();
  await page.goto(`/?session=${sessionId}`);
  await expect(page.getByRole("article", { name: "助手" }).locator(".chat-md")).toHaveText(
    EXPECTED_REPLY,
  );
}

// 会话按选中项定位（标题每次运行都相同）；不存在的分区计数自然为 0。
async function step6Sidebar(page: Page, project: WalkProject): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const list = sidebar.getByRole("navigation", { name: "会话列表" });
    await expect(list.locator(CURRENT_SESSION)).toHaveCount(1);
    const section = list.getByRole("group", { name: SPACES_SECTION });
    await expect(
      section.getByRole("group", { name: WORKSPACE_NAME, exact: true }).locator(CURRENT_SESSION),
    ).toHaveCount(1);
    await expect(
      list.getByRole("group", { name: TASKS_SECTION }).locator(CURRENT_SESSION),
    ).toHaveCount(0);
    await expect(
      list.getByRole("group", { name: "置顶任务", exact: true }).locator(CURRENT_SESSION),
    ).toHaveCount(0);
  });
}

// `finally` 里调用：只产生 soft 失败，不盖掉 try 里的原始失败。204 或 404；409 判失败。
async function deleteCreatedSession(page: Page, sessionId: string | null): Promise<void> {
  if (sessionId === null) return;
  try {
    const deleted = await page.request.delete(`/api/sessions/${sessionId}`);
    expect.soft([204, 404], "cleanup: DELETE session status").toContain(deleted.status());
    const listed = await page.request.get("/api/sessions");
    const body = (await listed.json()) as { sessions: { id: string }[] };
    expect
      .soft(
        body.sessions.map((session) => session.id),
        "cleanup: session list",
      )
      .not.toContain(sessionId);
  } catch (error) {
    expect.soft(String(error), "cleanup: request failed").toBe("");
  }
}

async function logout(page: Page, oracle: AuthOracle, project: WalkProject): Promise<void> {
  const loginHeading = page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" });
  const sidebar = await openSidebar(page, project);
  await sidebar.locator("footer").getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "退出", exact: true }).click();
  await expect(loginHeading).toBeVisible();
  oracle.phase = "post-logout-reload";
  await page.reload();
  await expect(loginHeading).toBeVisible();
}
