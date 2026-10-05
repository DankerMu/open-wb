// UI walk, session metadata (chat-harness「UI 走查会话元数据」steps 1–11): one serial journey
// per project against the real stack — compiled app, real omp, controlled upstream driven by the
// prompt markers WORKBUDDY_THINK / WORKBUDDY_WRITE. Nothing is fulfilled, faked or slept on.
// Step 10 sends two more turns in the same session: `/todo` (answered by omp itself) and an escaped
// `/session WORKBUDDY_THINK …` (answered by the model: its `thinking` is the marker's reasoning, so
// the escaped text reached the upstream; no tool round, the session already holds a tool result).
// Step 2 also reads the catalogue of a second workspace, `ui-walk-skills`, whose tracked fixture
// (smoke/fixtures/sandbox) holds one project skill: the panel lists it with the `项目` tag, and
// step 10, in the session bound to `ui-walk-sessions`, still lists the two builtins only.
// Step 11 deletes the session through the UI; `finally` deletes it again over REST (404 by then,
// 204 when a step failed first). Step 12 (ui-walk-project-config.ts) opens a session bound to
// `ui-walk-skills`, whose fixture also holds an `AGENTS.md`: its header has `项目配置 1` and the
// read-only list; step 9 first asserts the three header buttons of the session whose workspace
// holds no such file. The journey ends with a UI logout, which the error oracle needs
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
import { expectNoProjectConfig, walkProjectConfig } from "./ui-walk-project-config.js";
import { expandToolGroup, toolGroup } from "./ui-walk-steps.js";

const DEV_PASSWORD = "demo";
const WORKSPACE_NAME = "ui-walk-sessions";
// 夹具 smoke/fixtures/sandbox/u1/ui-walk-skills/.omp/skills/walk-brief/SKILL.md 的空间、名字与描述。
const SKILLS_WORKSPACE = "ui-walk-skills";
const SKILL_LABEL = "walk-brief";
const SKILL_DESCRIPTION = "走查用的项目技能：按本项目的格式写简报";
const REPORT_FILE = "workbuddy-report.html";
// ADR-0011 逻辑路径 `<account>/<dir>/<path>`，不含沙箱根。
const LOGICAL_PATH = "zhangsan/ui-walk-sessions/workbuddy-report.html";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const EXPECTED_THINKING = "先读需求，再列要点，最后作答。";
// 真 omp 对无参数 `/todo` 的原文（新会话没有 todo）；`<task>` 在页面上是转义后的文本。
const TODO_REPLY = "No todos. Use /todo append <task> to start one.";
const SLASH_LABELS = ["整理上下文", "任务清单"];
const APPROVAL_BARS = ["需要你的确认", "已允许执行", "已拒绝执行", "超时自动允许"];
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
// 真 omp 的两轮回合（write 工具轮 + 思考与回复轮）；只有等回合完成的那条断言（`expectTurnDone`）带显式超时。
const TURN_DONE_TIMEOUT_MS = 10_000;

/** 建会话的 201 一到就记下 id，`finally` 凭它删除——先于对该请求的任何断言。 */
type CreatedSession = { id: string | null };

type SessionSnapshot = {
  session: { id: string; scene: string | null; workspaceId: string | null; status: string };
  messages: {
    role: string;
    content: string;
    status: string;
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
  const configSession: CreatedSession = { id: null };
  const uuid = randomUUID();
  const prompt = `WORKBUDDY_THINK WORKBUDDY_WRITE 会话走查 ${uuid}`;
  // 每个 project 唯一：第 11 步凭它断言条目从所有分区消失。
  const renamed = `走查重命名 ${uuid.slice(0, 8)}`;

  await step1Login(page, oracle, project);
  // 会话页只在挂载与建会话后读空间列表：先确保空间存在，再进入 `/`。
  const { id: workspaceId, ensured } = await step1EnsureWorkspace(page, WORKSPACE_NAME);
  const skills = await step1EnsureWorkspace(page, SKILLS_WORKSPACE);
  mark(`step 1 (POST /api/workspaces ${ensured}, ${skills.ensured})`);
  try {
    await page.goto("/");
    await expect(welcomeHeading(page)).toBeVisible();
    await step2PickScene(page);
    await step2ProjectSkill(page, skills.id);
    await step2PickWorkspace(page, SKILLS_WORKSPACE, WORKSPACE_NAME);
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
    await expectNoProjectConfig(page, workspaceId);
    await step9Search(page, uuid, mark);
    mark("step 9");
    await step10Slash(page, sessionId);
    await step10PlusMenu(page);
    mark("step 10");
    await step11Delete(page, project, sessionId, renamed);
    mark("step 11");
    await walkProjectConfig(page, skills.id, configSession);
    mark("step 12");
  } finally {
    await deleteCreatedSession(page, created.id);
    await deleteCreatedSession(page, configSession.id);
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
  await expect(
    page.getByRole("article", { name: "助手" }).locator('[data-slot="message-body"]'),
  ).toHaveText(EXPECTED_REPLY);
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
async function step1EnsureWorkspace(
  page: Page,
  name: string,
): Promise<{ id: string; ensured: number }> {
  const ensured = await page.request.post("/api/workspaces", { data: { name } });
  expect([201, 409], "POST /api/workspaces status").toContain(ensured.status());
  const listed = await page.request.get("/api/workspaces");
  expect(listed.status(), "GET /api/workspaces status").toBe(200);
  const body = (await listed.json()) as { workspaces: { id: string; name: string; dir: string }[] };
  const named = body.workspaces.filter((workspace) => workspace.name === name);
  expect(named.map((workspace) => workspace.dir)).toEqual([name]);
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

// 页脚按钮当前显示 `current`（`未选择` 或一个空间名），选成空间 `name`。
async function step2PickWorkspace(page: Page, current: string, name: string): Promise<void> {
  await page.getByRole("button", { name: `任务启动于 ${current}`, exact: true }).click();
  const popover = page.getByRole("dialog", { name: "选择工作空间", exact: true });
  await popover.getByLabel("搜索工作空间").fill(name);
  await popover
    .getByRole("button")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await expect(popover).toHaveCount(0);
  await expect(page.getByRole("button", { name: `任务启动于 ${name}`, exact: true })).toBeVisible();
}

// 带项目 skill 的工作空间：欢迎态在页脚选中它后输入 `/`，目录按该空间的 id 取（请求的查询串），
// 面板恰三项，只有项目 skill 那一项带 `项目` 标记。清空草稿后面板消失，页脚留在该空间。
async function step2ProjectSkill(page: Page, workspaceId: string): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  const listbox = page.getByRole("listbox", { name: "命令候选", exact: true });
  const options = listbox.getByRole("option");

  await step2PickWorkspace(page, "未选择", SKILLS_WORKSPACE);
  const catalogue = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/commands",
  );
  await composer.fill("/");
  const request = await catalogue;
  expect(request.method()).toBe("GET");
  expect(new URL(request.url()).search).toBe(`?workspaceId=${workspaceId}`);
  await expect(listbox).toBeVisible();
  await expect(options).toHaveCount(3);
  await expect(listbox.locator('[data-slot="slash-label"]')).toHaveText([
    ...SLASH_LABELS,
    SKILL_LABEL,
  ]);
  await expect(listbox.locator('[data-slot="slash-tag"]')).toHaveText(["项目"]);
  const skill = options.nth(2);
  await expect(skill.locator('[data-slot="slash-tag"]')).toHaveText("项目");
  await expect(skill.locator('[data-slot="slash-desc"]')).toHaveText(SKILL_DESCRIPTION);
  await composer.fill(`/${SKILL_LABEL}`);
  await expect(options).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveValue(`/skill:${SKILL_LABEL} `);
  await expect(listbox).toHaveCount(0);
  await composer.fill("");
}

// 回合完成：该助手消息的正文恰为 `reply`（文件里唯一带显式超时的断言），整页没有提问卡与审批记录。
async function expectTurnDone(assistant: Locator, reply: string): Promise<void> {
  await expect(assistant.locator('[data-slot="message-body"]')).toHaveText(reply, {
    timeout: TURN_DONE_TIMEOUT_MS,
  });
  for (const name of APPROVAL_BARS) {
    await expect(assistant.page().getByRole("group", { name })).toHaveCount(0);
  }
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
  await expectTurnDone(assistant, EXPECTED_REPLY);
  await expectSelectedSessionStatus(page, project, "已完成");
  const steps = await expandToolGroup(assistant);
  await expect(steps.getByRole("status", { name: "write 已完成" })).toBeVisible();
  await expect(user).toHaveCount(1);
  await expect(assistant).toHaveCount(1);
  await expect(user.locator('[data-slot="message-body"]')).toHaveText(prompt);
  return sessionId;
}

async function step4ThinkingFold(page: Page): Promise<void> {
  const assistant = page.getByRole("article", { name: "助手" });
  const fold = assistant.locator('[data-slot="reasoning-root"]');
  await expect(fold).toHaveCount(1);
  // 同一父元素内先于回答正文。
  await expect(fold.locator(':scope ~ [data-slot="message-body"]')).toHaveCount(1);
  const summary = fold.getByRole("button", { name: "深度思考过程", exact: true });
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(summary).toHaveText("深度思考过程");
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  const body = fold.locator('[data-slot="reasoning-text"]');
  await expect(body).toBeVisible();
  await expect(body).toHaveText(EXPECTED_THINKING);
  await expect(fold.locator('[data-slot="reasoning-fade"]')).toHaveCSS("display", "none");
  // 终态消息：不带 data-running，主体限高 12rem 并在盒内滚动（#725）。
  await expect(fold).not.toHaveAttribute("data-running");
  await expect(body).toHaveCSS("max-height", "192px");
  await expect(body).toHaveCSS("overflow-y", "auto");
}

async function readSnapshot(page: Page, sessionId: string): Promise<SessionSnapshot> {
  const response = await page.request.get(`/api/sessions/${sessionId}/messages`);
  expect(response.status(), "GET messages status").toBe(200);
  return (await response.json()) as SessionSnapshot;
}

// 第 4、5 步在 DOM 上看到的值，经页面的请求上下文从服务端回读。
async function expectServerSnapshot(
  page: Page,
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  const snapshot = await readSnapshot(page, sessionId);
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
  const row = fileChangesCard(page).locator('[data-slot="file-change-row"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-slot="file-change-path"]')).toHaveText(LOGICAL_PATH);
  await expect(row.locator('[data-slot="file-change-kind"]')).toHaveText("写入");
  await expect(row.locator('[data-slot="file-change-add"]')).toHaveCount(0);
  await expect(row.locator('[data-slot="file-change-del"]')).toHaveCount(0);
}

// 卡内有两个同名动作按钮（头部图标、底部文字），点带文字的那个。
async function step5ArtifactPreview(page: Page): Promise<void> {
  const card = page
    .getByRole("article", { name: "助手" })
    .getByRole("group", { name: REPORT_FILE, exact: true });
  await expect(card.getByText("HTML", { exact: true })).toBeVisible();
  await card
    .getByRole("button", { name: `打开网页预览 ${REPORT_FILE}`, exact: true })
    .filter({ hasText: "打开网页预览" })
    .click();
  const dialog = page.getByRole("dialog", { name: REPORT_FILE, exact: true });
  const frame = dialog.locator(`iframe[title="${REPORT_FILE}"]`);
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
  const row = drawer.locator('[data-slot="file-change-row"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-slot="file-change-path"]')).toHaveText(LOGICAL_PATH);
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

// mobile 上 `inspectSidebar` 回调结束后紧接着按 `Escape` 关覆盖层。菜单、对话框关闭后 Radix 在下一个
// 宏任务才把焦点还回来：按键早于它时目标是 `body`，而 Toast 在场时覆盖层只靠目标在自身子树内的兜底
// 关闭，于是关不掉。回调的最后一句等焦点回到覆盖层内（它自己或其后代）；desktop 没有覆盖层。
async function expectFocusInNavOverlay(page: Page, project: WalkProject): Promise<void> {
  if (project === "desktop-light") return;
  const overlay = page.getByRole("dialog", { name: "导航", exact: true });
  await expect(overlay.and(page.locator(":focus-within"))).toHaveCount(1);
}

// 筛选弹层 portal 到 `body`，在 `导航` 覆盖层的 DOM 子树之外：弹层与单选项从 `page` 定位。真实点击（无
// `force`）经 Playwright 的命中测试，弹层画在覆盖层遮罩之下时点击被拦截（#715）。`全部` 在 `状态` 组内
// exact 匹配（否则同时命中 `全部时间`）。`全部时间` 是默认选中项，Radix 只在未选中时回调，点它只做命中
// 测试、无需复位。Escape 只关弹层、焦点回 `筛选任务`，覆盖层由 `inspectSidebar` 关闭。
async function step6Sidebar(page: Page, project: WalkProject): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, tasks, spaces } = sections(sidebar);
    const workspace = spaces.getByRole("group", { name: WORKSPACE_NAME, exact: true });
    await expectSelectedIn(list, workspace, [tasks, pinned]);
    const trigger = list.getByRole("button", { name: "筛选任务", exact: true });
    await trigger.click();
    const filter = page.getByRole("dialog", { name: "筛选任务", exact: true });
    const status = filter.getByRole("radiogroup", { name: "状态", exact: true });
    const finished = status.getByRole("radio", { name: "已完成", exact: true });
    await finished.click();
    await expect(finished).toHaveAttribute("aria-checked", "true");
    await expectSelectedIn(list, workspace, [tasks, pinned]);
    const all = status.getByRole("radio", { name: "全部", exact: true });
    await all.click();
    await expect(all).toHaveAttribute("aria-checked", "true");
    const time = filter.getByRole("radiogroup", { name: "时间", exact: true });
    const anyTime = time.getByRole("radio", { name: "全部时间", exact: true });
    await anyTime.click();
    await expect(anyTime).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(filter).toHaveCount(0);
    if (project === "mobile-dark") {
      await expect(page.getByRole("dialog", { name: "导航", exact: true })).toHaveCount(1);
    }
    await expect(trigger).toBeFocused();
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
    await expectFocusInNavOverlay(page, project);
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
    await expectFocusInNavOverlay(page, project);
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
  const frame = await page.locator('[data-slot="thread-viewport"]').boundingBox();
  if (!box || !frame) return "not rendered";
  const [top, bottom] = [box.y, box.y + box.height];
  const [frameTop, frameBottom] = [frame.y, frame.y + frame.height];
  const shown = Math.max(0, Math.min(bottom, frameBottom) - Math.max(top, frameTop));
  const range = (from: number, to: number) => `${Math.round(from)}..${Math.round(to)}`;
  return `${Math.round(shown)}/${Math.round(box.height)}px in viewport (message y ${range(top, bottom)}, transcript y ${range(frameTop, frameBottom)})`;
}

// 第 10 步的一个回合：`Enter` 发出草稿；第 `index` 条（从 0 数）用户消息的正文是 `sent`，同序号的助手消息
// 到达 `reply`，没有步骤卡、没有审批条；回合结束后输入框解锁并清空。
async function sendSlashTurn(
  page: Page,
  index: number,
  sent: string,
  reply: string,
): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  const user = page.getByRole("article", { name: "用户" });
  const assistant = page.getByRole("article", { name: "助手" });
  await composer.press("Enter");
  await expect(user).toHaveCount(index + 1);
  await expect(user.nth(index).locator('[data-slot="message-body"]')).toHaveText(sent);
  await expect(assistant).toHaveCount(index + 1);
  await expectTurnDone(assistant.nth(index), reply);
  // 斜杠回合没有步骤：不渲染工具调用组。
  await expect(toolGroup(assistant.nth(index))).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("");
}

// 能力栏「+」菜单（接在 step10Slash 之后，目录已由斜杠候选取回）：空白草稿下打开 `技能与命令`，列出同一份
// 目录；点选把草稿写成 `/<name> `、菜单关闭、焦点在输入框，没有发出 prompt；草稿非空白时按钮禁用。
async function step10PlusMenu(page: Page): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  const trigger = page.getByRole("button", { name: "技能与命令", exact: true });
  const menu = page.getByRole("menu");
  const requests: string[] = [];
  const record = (request: { method(): string; url(): string }) => {
    const { pathname } = new URL(request.url());
    if (pathname === "/api/commands" || request.method() === "POST") requests.push(pathname);
  };

  await expect(composer).toHaveValue("");
  page.on("request", record);
  await trigger.click();
  // 数组形式逐项对应且项数相等：恰两项，按目录顺序。
  await expect(menu.getByRole("menuitem")).toContainText(SLASH_LABELS);
  await page.evaluate(() => {
    const gap = () => document.querySelector("[role=menu]>p") && document.body.classList.add("gap");
    new MutationObserver(gap).observe(document.body, { childList: true, subtree: true });
  });
  await menu.getByRole("menuitem").nth(0).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator("body.gap"), "退场中的菜单出现 暂无可用项").toHaveCount(0);
  await expect(composer).toHaveValue("/compact ");
  await expect(composer).toBeFocused();
  await expect(trigger).toBeDisabled();
  await composer.fill("");
  await expect(trigger).toBeEnabled();
  page.off("request", record);
  // 没有 prompt（任何 POST），也没有第二次目录请求（与斜杠候选共用缓存）。
  expect(requests).toEqual([]);
}

// 次序有判别力：候选目录在第一次输入 `/` 时才取，`Enter` 之前先断言面板里恰一项——面板没出来时
// `Enter` 会把 `/t` 当普通消息发出去；「`/session` 没有候选」先对不含空白的草稿断言（仍是候选态、目录
// 已加载），含空白的草稿本来就不开面板。DOM 的文本断言会归一空白，逐字的正文从服务端回读。
async function step10Slash(page: Page, sessionId: string): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  const listbox = page.getByRole("listbox", { name: "命令候选", exact: true });
  const options = listbox.getByRole("option");
  // `option` 的可访问名是 label、描述与 hint 的拼接，按 label 的 `data-slot` 取文本。
  const labels = listbox.locator('[data-slot="slash-label"]');
  const user = page.getByRole("article", { name: "用户" });
  const assistant = page.getByRole("article", { name: "助手" });
  // `session` 是白名单外的真 omp 内建：不转义会被 omp 当命令执行。固定回复与输入无关，转义后的文本
  // 到了模型由标记证明：受控上游只对最新用户消息里的 WORKBUDDY_THINK 给出那段思考。
  const escaped = `/session WORKBUDDY_THINK ${randomUUID()}`;

  await composer.fill("/");
  await expect(listbox).toBeVisible();
  await expect(options).toHaveCount(2);
  await expect(labels).toHaveText(SLASH_LABELS);
  await expect(composer).toBeFocused();
  await composer.fill("/t");
  await expect(options).toHaveCount(1);
  await expect(labels).toHaveText(["任务清单"]);
  // 面板开着：`Enter` 选中而不发送。
  await composer.press("Enter");
  await expect(composer).toHaveValue("/todo ");
  await expect(listbox).toHaveCount(0);
  await expect(user).toHaveCount(1);
  await expect(assistant).toHaveCount(1);
  await expect(composer).toBeFocused();
  await sendSlashTurn(page, 1, "/todo", TODO_REPLY);

  await composer.fill("/session");
  await expect(listbox).toHaveCount(0);
  await composer.fill(escaped);
  await expect(listbox).toHaveCount(0);
  await sendSlashTurn(page, 2, escaped, EXPECTED_REPLY);

  const { messages } = await readSnapshot(page, sessionId);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  const [, , todoUser, todoReply, escapedUser, escapedReply] = messages;
  expect(todoUser?.content).toBe("/todo");
  expect(todoReply?.content).toBe(TODO_REPLY);
  expect(todoReply?.steps).toEqual([]);
  expect(todoReply?.status).toBe("done");
  expect(todoReply?.thinking).toBeNull();
  expect(escapedUser?.content).toBe(escaped);
  expect(escapedReply?.content).toBe(EXPECTED_REPLY);
  expect(escapedReply?.steps).toEqual([]);
  expect(escapedReply?.status).toBe("done");
  expect(escapedReply?.thinking).toBe(EXPECTED_THINKING);
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
    await expectFocusInNavOverlay(page, project);
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
