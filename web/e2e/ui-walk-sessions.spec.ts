// UI walk, session metadata (chat-harness「UI 走查会话元数据」steps 1–9 and 11): one serial journey
// per project against the real stack — compiled app, real omp, controlled upstream driven by the
// prompt markers WORKBUDDY_THINK / WORKBUDDY_WRITE. Nothing is fulfilled, faked or slept on.
// Step 11 deletes the session through the UI; `finally` deletes it again over REST (404 by then,
// 204 when a step failed first). The journey ends with a UI logout, which the error oracle needs
// for its second expected /api/auth/me 401.

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
const HEX_ID = /^[0-9a-f]{32}$/;
const SPACES_SECTION = /^空间 \(\d+\)$/u;
const TASKS_SECTION = /^任务 \(\d+\)$/u;
const CURRENT_SESSION = 'button[aria-current="true"]';
const CURRENT_MATCH = 'article[aria-current="true"]';
// 建会话后的标题：提示词的前 18 个码点，每次运行都相同。
const INITIAL_TITLE = "WORKBUDDY_THINK WO";
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
  const uuid = randomUUID();
  const prompt = `WORKBUDDY_THINK WORKBUDDY_WRITE 会话走查 ${uuid}`;
  // 每个 project 唯一：第 11 步凭它断言条目从所有分区消失。
  const renamed = `走查重命名 ${uuid.slice(0, 8)}`;

  await step1Login(page, oracle, project);
  // 会话页只在挂载与建会话后读空间列表：先确保空间存在，再进入 `/`。
  const { id: workspaceId, ensured } = await step1EnsureWorkspace(page);
  mark(`step 1 (POST /api/workspaces ${ensured})`);
  try {
    await page.goto("/");
    await expect(welcomeHeading(page)).toBeVisible();
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
    await step7Pin(page, project);
    mark("step 7");
    await step8Rename(page, project, sessionId, renamed);
    mark("step 8");
    await step9Search(page, uuid, mark);
    mark("step 9");
    await step11Delete(page, project, sessionId, renamed);
    mark("step 11");
  } finally {
    await deleteCreatedSession(page, created.id);
  }
  mark("cleanup");
  await logout(page, oracle, project);
  mark("logout");
}

function welcomeHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你", exact: true });
}

// 转录就绪：助手消息的固定回复可见（真实导航或 reload 之后历史从 REST 恢复）。
async function expectTranscriptReady(page: Page): Promise<void> {
  await expect(page.getByRole("article", { name: "助手" }).locator(".chat-md")).toHaveText(
    EXPECTED_REPLY,
  );
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

// 201（全新状态）或 409（已存在），状态码随 step 1 的日志行输出；id 与 dir 从列表读，dir 等于名字是
// 逻辑路径的前提。
async function step1EnsureWorkspace(page: Page): Promise<{ id: string; ensured: number }> {
  const ensured = await page.request.post("/api/workspaces", { data: { name: WORKSPACE_NAME } });
  expect([201, 409], "POST /api/workspaces status").toContain(ensured.status());
  const listed = await page.request.get("/api/workspaces");
  expect(listed.status(), "GET /api/workspaces status").toBe(200);
  const body = (await listed.json()) as { workspaces: { id: string; name: string; dir: string }[] };
  const named = body.workspaces.filter((workspace) => workspace.name === WORKSPACE_NAME);
  expect(named.map((workspace) => workspace.dir)).toEqual([WORKSPACE_NAME]);
  const id = named[0]?.id ?? "";
  expect(id).toMatch(HEX_ID);
  return { id, ensured: ensured.status() };
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

// 只观测 `POST /api/sessions`；返回会话 id。
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

// 文件页只认 `ws`（没有 path 参数），落到空间；随后以真实导航回到会话。`ws` 缺失或未知时文件页自己
// 把 URL 改写成第一个空间（全新状态下正是本空间），落定后的 URL 证明不了按钮的目标：断言点击后的
// 第一次导航，URL 在事件回调里同步读（之后再读可能已是改写后的地址）。等导航与 click 并成一个
// `Promise.all`：click 自己失败时，先 reject 的 `waitForEvent` 也有 handler，`finally` 照常清理。
async function step5ViewDetails(page: Page, workspaceId: string, sessionId: string): Promise<void> {
  let target = "";
  const navigated = page.waitForEvent("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return false;
    target = frame.url();
    return true;
  });
  await Promise.all([
    navigated,
    fileChangesCard(page)
      .getByRole("button", { name: `查看详情 ${LOGICAL_PATH}`, exact: true })
      .click(),
  ]);
  const first = new URL(target);
  expect(
    `${first.pathname}${first.search}${first.hash}`,
    "查看详情: first navigation after the click",
  ).toBe(`/files?ws=${workspaceId}`);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/files");
  await expect.poll(() => new URL(page.url()).searchParams.get("ws")).toBe(workspaceId);
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "选择工作空间" })
      .getByText(WORKSPACE_NAME, { exact: true }),
  ).toBeVisible();
  await page.goto(`/?session=${sessionId}`);
  await expectTranscriptReady(page);
}

type Sections = { list: Locator; pinned: Locator; tasks: Locator; spaces: Locator };

function sections(sidebar: Locator): Sections {
  const list = sidebar.getByRole("navigation", { name: "会话列表" });
  return {
    list,
    pinned: list.getByRole("group", { name: "置顶任务", exact: true }),
    tasks: list.getByRole("group", { name: TASKS_SECTION }),
    spaces: list.getByRole("group", { name: SPACES_SECTION }),
  };
}

// 会话按选中项定位（建会话后的标题每次运行都相同）：在 `home` 里，全列表恰一条，不在 `others` 的
// 任何一个里；不存在的分区计数自然为 0。先断言 `home`：条目迁移之前的 DOM 也满足全列表恰一条。
async function expectSelectedIn(
  list: Locator,
  home: Locator,
  others: readonly Locator[],
): Promise<void> {
  await expect(home.locator(CURRENT_SESSION)).toHaveCount(1);
  await expect(list.locator(CURRENT_SESSION)).toHaveCount(1);
  for (const section of others) {
    await expect(section.locator(CURRENT_SESSION)).toHaveCount(0);
  }
}

// 选中条目所在 `li` 里的行菜单触发按钮（`更多操作：<标题>`）；菜单本身经 portal 渲染在页面层。
function rowMenu(sidebar: Locator): Locator {
  return sidebar
    .locator("li")
    .filter({ has: sidebar.page().locator(CURRENT_SESSION) })
    .getByRole("button", { name: /^更多操作：/u });
}

function menuItem(page: Page, name: string): Locator {
  return page.getByRole("menuitem", { name, exact: true });
}

async function step6Sidebar(page: Page, project: WalkProject): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, tasks, spaces } = sections(sidebar);
    const workspace = spaces.getByRole("group", { name: WORKSPACE_NAME, exact: true });
    await expectSelectedIn(list, workspace, [tasks, pinned]);
  });
}

// 置顶不是乐观更新：PATCH 成功后条目换到 `置顶任务` 分区（DOM 节点重挂）。菜单在覆盖层的 DOM
// 子树之外，`Escape` 只收起菜单并把焦点还给触发按钮；mobile 的覆盖层由 `inspectSidebar` 关闭。
async function step7Pin(page: Page, project: WalkProject): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, tasks, spaces } = sections(sidebar);
    await rowMenu(sidebar).click();
    await menuItem(page, "置顶任务").click();
    await expectSelectedIn(list, pinned, [spaces, tasks]);
    await rowMenu(sidebar).click();
    await expect(menuItem(page, "取消置顶")).toBeVisible();
    await expect(menuItem(page, "置顶任务")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
}

// 重命名对话框渲染在页面层；侧栏条目与顶栏标题更新，reload 后标题与置顶分区从 REST 恢复。
async function step8Rename(
  page: Page,
  project: WalkProject,
  sessionId: string,
  title: string,
): Promise<void> {
  const topbarTitle = page
    .getByRole("banner")
    .getByRole("heading", { level: 1, name: `我的工作 / ${title}`, exact: true });
  const expectPinnedAs = async (sidebar: Locator) => {
    const { list, pinned, tasks, spaces } = sections(sidebar);
    await expectSelectedIn(list, pinned, [spaces, tasks]);
    await expect(list.locator(CURRENT_SESSION)).toHaveAccessibleName(title);
    await expect(rowMenu(sidebar)).toHaveAccessibleName(`更多操作：${title}`);
  };
  await inspectSidebar(page, project, async (sidebar) => {
    await rowMenu(sidebar).click();
    await menuItem(page, "重命名").click();
    const dialog = page.getByRole("dialog", { name: "重命名任务", exact: true });
    const field = dialog.getByLabel("任务名称");
    await expect(field).toHaveValue(INITIAL_TITLE);
    await field.fill(title);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expectPinnedAs(sidebar);
  });
  await expect(topbarTitle).toBeVisible();

  await page.reload();
  // 搜索只在输入那一刻取匹配：历史装载完再继续。
  await expectTranscriptReady(page);
  await expect(topbarTitle).toBeVisible();
  await inspectSidebar(page, project, expectPinnedAs);

  const listed = await page.request.get("/api/sessions");
  expect(listed.status(), "GET /api/sessions status").toBe(200);
  const body = (await listed.json()) as {
    sessions: { id: string; title: string | null; pinnedAt: number | null }[];
  };
  const stored = body.sessions.filter((session) => session.id === sessionId);
  expect(stored.map((session) => session.title)).toEqual([title]);
  expect(Number.isInteger(stored[0]?.pinnedAt), "GET /api/sessions pinnedAt is an integer").toBe(
    true,
  );
}

// 次序有判别力：搜索框一打开计数就是 `0/0`，所以无匹配排在 `1/1` 之后；`Esc` 之前重新命中，
// 「清除高亮」才有前后对比。
async function step9Search(page: Page, uuid: string, mark: (point: string) => void): Promise<void> {
  const toggle = page.getByRole("banner").getByRole("button", { name: "对话内搜索", exact: true });
  const search = page.getByRole("search", { name: "对话内搜索", exact: true });
  const field = search.getByRole("searchbox", { name: "搜索对话内容", exact: true });
  const counter = search.locator(".chat-search-count");
  const user = page.getByRole("article", { name: "用户" });
  const expectUuidMatch = async () => {
    await field.fill(uuid);
    await expect(counter).toHaveText("1/1");
    await expect(user).toHaveAttribute("aria-current", "true");
    await expect(user).toBeInViewport({ ratio: 1 });
    await expect(page.locator(CURRENT_MATCH)).toHaveCount(1);
  };

  await toggle.click();
  await expect(search).toBeVisible();
  await expect(field).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // 记录搜索前后的位置。`toBeInViewport({ ratio: 1 })` 在 mobile-dark 上有判别力（搜索前用户消息
  // 顶部被转录框裁掉，命中后完整可见）；desktop-light 上它前后都完整可见，分辨不出滚动。
  mark(`step 9 user message before search: ${await describePosition(page, user)}`);
  await expectUuidMatch();
  mark(`step 9 user message at 1/1: ${await describePosition(page, user)}`);
  await field.fill("WorkBuddy");
  await expect(counter).toHaveText("1/2");
  await field.fill(`无匹配 ${randomUUID()}`);
  await expect(counter).toHaveText("0/0");
  await expect(page.locator(CURRENT_MATCH)).toHaveCount(0);
  await expectUuidMatch();
  await field.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(page.locator(CURRENT_MATCH)).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

// 消息落在转录滚动容器内的高度，与两者的纵向范围（视口坐标）。
async function describePosition(page: Page, message: Locator): Promise<string> {
  const box = await message.boundingBox();
  const frame = await page.locator(".chat-transcript").boundingBox();
  if (!box || !frame) return "not rendered";
  const [top, bottom] = [box.y, box.y + box.height];
  const [frameTop, frameBottom] = [frame.y, frame.y + frame.height];
  const shown = Math.max(0, Math.min(bottom, frameBottom) - Math.max(top, frameTop));
  const range = (from: number, to: number) => `${Math.round(from)}..${Math.round(to)}`;
  return `${Math.round(shown)}/${Math.round(box.height)}px in viewport (message y ${range(top, bottom)}, transcript y ${range(frameTop, frameBottom)})`;
}

// 确认框渲染在页面层。204 之后：条目移除、Toast、URL 去掉 `session`、回到欢迎态。Toast 按类名与
// 文本定位：mobile 的覆盖层开着时通知区是 `aria-hidden`，按 role 找不到；覆盖层不随删除关闭，
// 欢迎态在它关闭之后断言。
async function step11Delete(
  page: Page,
  project: WalkProject,
  sessionId: string,
  title: string,
): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const { list } = sections(sidebar);
    await rowMenu(sidebar).click();
    await menuItem(page, "删除").click();
    const confirm = page.getByRole("alertdialog", { name: "删除任务", exact: true });
    await expect(
      confirm.getByText(`确定要删除「${title}」吗？删除后不可恢复。`, { exact: true }),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.locator(".ui-toast").filter({ hasText: "任务已删除" })).toBeVisible();
    // 列表本身还在（否则下面两条计数 0 是空断言）。
    await expect(list).toBeVisible();
    await expect(list.locator(CURRENT_SESSION)).toHaveCount(0);
    await expect(list.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  });
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBeNull();
  await expect(welcomeHeading(page)).toBeVisible();
  const gone = await page.request.get(`/api/sessions/${sessionId}/messages`);
  expect(gone.status(), "GET messages status after delete").toBe(404);
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
