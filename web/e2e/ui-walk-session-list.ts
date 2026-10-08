// UI walk：会话列表区的选择器与第 6 步（chat-harness「UI 走查会话元数据」）。分组、折叠、搜索与
// `分组方式` 的定位都集中在这里；`ui-walk-sessions.spec.ts` 的第 7、8、11 步经 `sections` 取分组，
// 第 11 步的「删除无提示」断言（`expectDeletedWithoutToast`）也在这里。
// 文件后半是第二个旅程的六步（chat-harness「UI 走查临时空间、撤回与归档」，入口 `walkTemporarySpace`）：
// 未选空间的首次发送得到临时空间会话，随后在同一个会话上撤回、再发、fork 验证、归档与恢复、删除。
// 从它开头的一次导航到第 6 步结束，页面不再导航或刷新：侧栏的变化都来自那一条列表事件连接。
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, type Request } from "@playwright/test";
import { deleteCreatedSession, watchCreatedSessions } from "./ui-walk-cleanup.js";
import { inspectSidebar, sessionList, type WalkProject } from "./ui-walk-layout.js";
import { walkArtifactPreview } from "./ui-walk-steps.js";

export const CURRENT_SESSION = 'button[aria-current="true"]';
const NAV_OVERLAY = { name: "导航", exact: true } as const;
const EMPTY = "没有匹配的任务";
const APPROVAL_BARS = ["需要你的确认", "已允许执行", "已拒绝执行", "超时自动允许"];
// 真 omp 的两轮回合（write 工具轮 + 回复轮）；只有等回合完成的那条断言（`expectTurnDone`）带显式超时。
const TURN_DONE_TIMEOUT_MS = 10_000;
const HEX_ID = /^[0-9a-f]{32}$/;
const LIST_EVENTS_PATH = "/api/sessions/events";
const UNDO_PATH = /^\/api\/sessions\/[0-9a-f]{32}\/undo$/;

export function welcomeHeading(page: Page): Locator {
  return page.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你", exact: true });
}

// 选中条目所在 `li` 里的行菜单触发按钮（`更多操作：<标题>`）；菜单本身经 portal 渲染在页面层。
export function rowMenu(sidebar: Locator): Locator {
  return sidebar
    .locator("li")
    .filter({ has: sidebar.page().locator(CURRENT_SESSION) })
    .getByRole("button", { name: /^更多操作：/u });
}

export function menuItem(page: Page, name: string): Locator {
  return page.getByRole("menuitem", { name, exact: true });
}

// mobile 上 `inspectSidebar` 回调结束后紧接着按 `Escape` 关覆盖层。菜单、对话框关闭后 Radix 在下一个
// 宏任务才把焦点还回来：按键早于它时目标是 `body`，而 Toast 在场时覆盖层只靠目标在自身子树内的兜底
// 关闭，于是关不掉。回调的最后一句等焦点回到覆盖层内（它自己或其后代）；desktop 没有覆盖层。
export async function expectFocusInNavOverlay(page: Page, project: WalkProject): Promise<void> {
  if (project === "desktop-light") return;
  const overlay = page.getByRole("dialog", NAV_OVERLAY);
  await expect(overlay.and(page.locator(":focus-within"))).toHaveCount(1);
}

// 回合完成：该助手消息的正文恰为 `reply`（带显式超时），整页没有提问卡与审批记录。
export async function expectTurnDone(assistant: Locator, reply: string): Promise<void> {
  await expect(assistant.locator('[data-slot="message-body"]')).toHaveText(reply, {
    timeout: TURN_DONE_TIMEOUT_MS,
  });
  for (const name of APPROVAL_BARS) {
    await expect(assistant.page().getByRole("group", { name })).toHaveCount(0);
  }
}

type Sections = { list: Locator; pinned: Locator; temporary: Locator; workspace: Locator };

// 默认视图（按工作空间）下与走查会话有关的三个分组；`workspace` 是名为 `name` 的工作空间分组。
export function sections(sidebar: Locator, name: string): Sections {
  const list = sessionList(sidebar);
  const named = (label: string) => list.getByRole("group", { name: label, exact: true });
  return {
    list,
    pinned: named("置顶任务"),
    temporary: named("临时空间"),
    workspace: named(name),
  };
}

// 会话按选中项定位（建会话后的标题每次运行都相同）：在 `home` 里，全列表恰一条，不在 `others` 的
// 任何一个里；不存在的分组计数自然为 0。先断言 `home`：条目迁移之前的 DOM 也满足全列表恰一条。
export async function expectSelectedIn(
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

// 第 11 步确认删除之后：选中的条目与标题为 `title` 的条目都从列表消失，且删除没有轻提示——条目
// 消失后页面任何位置都没有 `任务已删除`，也没有任何 Toast 元素。先断言列表本身还在（否则两条
// 计数 0 是空断言）。
export async function expectDeletedWithoutToast(
  page: Page,
  list: Locator,
  title: string,
): Promise<void> {
  await expect(list).toBeVisible();
  await expect(list.locator(CURRENT_SESSION)).toHaveCount(0);
  await expect(list.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  await expect(page.getByText("任务已删除")).toHaveCount(0);
  await expect(page.locator(".ui-toast")).toHaveCount(0);
}

// 第 6 步：会话恰一次出现在 `workspaceName` 分组里，没有 `筛选任务`；随后在同一侧栏里（mobile 的覆盖层
// 一直开着）折叠再展开该分组、按标题搜索、切换 `分组方式`。点击都是真实指针点击（无 `force`）：
// `分组方式` 的菜单 portal 到 `body`，画在覆盖层遮罩之下时会被 Playwright 的命中测试拦下。
// 结尾等焦点回到 `分组方式` 按钮（在覆盖层内）：`inspectSidebar` 随后按的 `Escape` 才关得掉覆盖层。
export async function step6Sidebar(
  page: Page,
  project: WalkProject,
  workspaceName: string,
  title: string,
): Promise<void> {
  const overlayStaysOpen = async () => {
    if (project === "mobile-dark")
      await expect(page.getByRole("dialog", NAV_OVERLAY)).toHaveCount(1);
  };
  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, temporary, workspace } = sections(sidebar, workspaceName);
    const current = list.locator(CURRENT_SESSION);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await expect(current).toHaveAccessibleName(title);
    await expect(page.getByRole("button", { name: "筛选任务" })).toHaveCount(0);
    await expect(page.getByText("筛选任务")).toHaveCount(0);

    const header = workspace.getByRole("button", { name: workspaceName, exact: true });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(current).toHaveCount(0);
    await expect(workspace.getByRole("listitem")).toHaveCount(0);
    await overlayStaysOpen();
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expectSelectedIn(list, workspace, [pinned, temporary]);

    const entries = list.getByRole("listitem");
    const total = await entries.count();
    const search = list.getByRole("searchbox", { name: "搜索任务", exact: true });
    await search.fill(title);
    await expect(entries).toHaveCount(1);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await search.fill(randomUUID());
    await expect(list.getByText(EMPTY, { exact: true })).toBeVisible();
    await expect(entries).toHaveCount(0);
    await expect(list.getByRole("group")).toHaveCount(0);
    await search.fill("");
    await expect(list.getByText(EMPTY, { exact: true })).toHaveCount(0);
    await expect(entries).toHaveCount(total);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await overlayStaysOpen();

    const grouping = list.getByRole("button", { name: "分组方式", exact: true });
    const choose = async (name: string) => {
      await grouping.click();
      const item = page.getByRole("menuitemradio", { name, exact: true });
      await item.click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await overlayStaysOpen();
    };
    await choose("按时间");
    const today = list.getByRole("group", { name: "今天", exact: true });
    await expectSelectedIn(list, today, [pinned, workspace, temporary]);
    await expect(workspace).toHaveCount(0);
    await choose("按工作空间");
    await expect(today).toHaveCount(0);
    await expectSelectedIn(list, workspace, [pinned, temporary]);
    await expect(grouping).toBeFocused();
  });
}

// 只观测、不拦截：记下页面发出的、方法为 `method` 且 pathname 满足 `matches` 的请求，以及其中已经
// 结束（完成或失败）的那些。挂在调用它的那一刻，`stop` 摘掉。
function watchRequests(page: Page, method: string, matches: (pathname: string) => boolean) {
  const requests: Request[] = [];
  const ended: string[] = [];
  const watched = (request: Request) =>
    request.method() === method && matches(new URL(request.url()).pathname);
  const onRequest = (request: Request) => {
    if (watched(request)) requests.push(request);
  };
  const onFinished = (request: Request) => {
    if (watched(request)) ended.push("finished");
  };
  const onFailed = (request: Request) => {
    if (watched(request)) ended.push(`failed: ${request.failure()?.errorText ?? ""}`);
  };
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  return {
    requests,
    ended,
    stop() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

type Watched = ReturnType<typeof watchRequests>;

// 恰一个这样的请求已发出；返回它与它的响应。
async function theOne(watch: Watched, what: string) {
  await expect.poll(() => watch.requests.length, `${what}: requests issued`).toBe(1);
  const request = watch.requests[0];
  const response = await request?.response();
  if (!request || !response) throw new Error(`${what} produced no response`);
  return { request, response };
}

// 第 2 步的连接：自旅程开头的导航起恰一条 `/api/sessions/events`，是事件流，此刻仍然打开。
async function expectOneOpenListStream(events: Watched): Promise<void> {
  const { response } = await theOne(events, "GET /api/sessions/events");
  expect(response.status(), "list events status").toBe(200);
  expect(response.headers()["content-type"] ?? "", "list events content-type").toMatch(
    /^text\/event-stream/u,
  );
  expect(events.ended, "list events connection still open").toEqual([]);
}

// 侧栏里选中条目的状态元素按可访问名读作 `<title> <text>`（mobile 经覆盖层）。
async function expectSelectedStatusName(
  page: Page,
  project: WalkProject,
  name: string,
): Promise<void> {
  await inspectSidebar(page, project, async (sidebar) => {
    const status = sessionList(sidebar).locator(CURRENT_SESSION).getByRole("status");
    await expect(status).toHaveAccessibleName(name);
  });
}

// 临时空间根目录的条目名；`status` 不是 200 时只断言状态码。
async function treeNames(page: Page, workspaceId: string, status = 200): Promise<string[]> {
  const tree = await page.request.get(`/api/workspaces/${workspaceId}/tree`);
  expect(tree.status(), "GET tree status").toBe(status);
  if (status !== 200) return [];
  return ((await tree.json()) as { entries: { name: string }[] }).entries.map(
    (entry) => entry.name,
  );
}

// 会话里唯一那条用户消息的 id。
async function onlyUserMessageId(page: Page, sessionId: string): Promise<number> {
  const snapshot = await page.request.get(`/api/sessions/${sessionId}/messages`);
  expect(snapshot.status(), "GET messages status").toBe(200);
  const { messages } = (await snapshot.json()) as { messages: { id: number; role: string }[] };
  const users = messages.filter((message) => message.role === "user");
  expect(users, "user messages in the session").toHaveLength(1);
  return users[0]?.id ?? Number.NaN;
}

type TempWalk = {
  page: Page;
  project: WalkProject;
  /** 第 1 步发送、第 3 步回到草稿、第 4 步再次发送的全文。 */
  prompt: string;
  /** 建会话后的标题：提示词的前 18 个码点。 */
  title: string;
  reply: string;
  file: string;
};

type TempSession = { sessionId: string; workspaceId: string };

// 第 1 步前半与第 2 步：欢迎态未选空间，发送；回车后立刻读侧栏的 `运行中`（中间不插别的断言——没有
// gate，回合只有两秒上下），之后才看建会话的请求与响应，等回合完成，再读 `已完成`。
async function sendFromWelcome(walk: TempWalk, events: Watched): Promise<TempSession> {
  const { page, project, prompt, title, reply } = walk;
  const composer = page.getByLabel("给助手发消息");
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "任务启动于 未选择", exact: true })).toBeVisible();
  await composer.fill(prompt);
  const creations = watchRequests(page, "POST", (pathname) => pathname === "/api/sessions");
  await composer.press("Enter");
  await expectSelectedStatusName(page, project, `${title} 运行中`);

  const { request, response } = await theOne(creations, "POST /api/sessions");
  creations.stop();
  expect(response.status(), "POST /api/sessions status").toBe(201);
  const body = (await response.json()) as {
    id: string;
    workspaceId: string;
    temporaryWorkspace: boolean;
  };
  expect(Object.keys(request.postDataJSON() ?? {}), "POST /api/sessions body keys").not.toContain(
    "workspaceId",
  );
  expect(body.temporaryWorkspace, "201 temporaryWorkspace").toBe(true);
  expect(body.id).toMatch(HEX_ID);
  expect(body.workspaceId).toMatch(HEX_ID);
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(body.id);

  await expectTurnDone(page.getByRole("article", { name: "助手" }), reply);
  await expectSelectedStatusName(page, project, `${title} 已完成`);
  await expectOneOpenListStream(events);
  return { sessionId: body.id, workspaceId: body.workspaceId };
}

// 第 1 步后半：能力栏的只读标签、侧栏分组、文件变更卡（空间内相对路径、没有 `查看详情`）、产物卡预览，
// 以及服务端的两处：空间列表不含它，它的 tree 恰有那一个文件。
async function expectTemporarySpace(walk: TempWalk, workspaceId: string): Promise<void> {
  const { page, project, file } = walk;
  await expect(page.locator('[data-slot="composer-workspace"]')).toHaveText("任务启动于 临时空间");
  await expect(page.getByRole("button", { name: /^任务启动于/u })).toHaveCount(0);
  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, temporary } = sections(sidebar, "");
    await expectSelectedIn(list, temporary, [pinned]);
  });

  const card = page
    .getByRole("article", { name: "助手" })
    .getByRole("group", { name: "文件变更（1 个）", exact: true });
  const row = card.locator('[data-slot="file-change-row"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-slot="file-change-path"]')).toHaveText(file);
  await expect(row.locator('[data-slot="file-change-kind"]')).toHaveText("写入");
  await expect(card.getByRole("button", { name: /查看详情/u })).toHaveCount(0);
  await walkArtifactPreview(page, file);

  const listed = await page.request.get("/api/workspaces");
  expect(listed.status(), "GET /api/workspaces status").toBe(200);
  const { workspaces } = (await listed.json()) as { workspaces: { id: string }[] };
  expect(
    workspaces.map((workspace) => workspace.id),
    "GET /api/workspaces ids",
  ).not.toContain(workspaceId);
  expect(await treeNames(page, workspaceId), "temporary workspace tree").toEqual([file]);
}

// 第 3 步：点 `撤回`，没有确认框；请求体严格等于 `{messageId, files:"restore"}`，200；线程回到零消息
// 空态，草稿是原文，文件随之还原（tree 不再含它），没有未还原说明、轻提示与确认框。
async function undoFirstTurn(walk: TempWalk, { sessionId, workspaceId }: TempSession) {
  const { page, prompt, file } = walk;
  const user = page.getByRole("article", { name: "用户" });
  const undo = user.getByRole("button", { name: "撤回", exact: true });
  const messageId = await onlyUserMessageId(page, sessionId);
  await expect(undo).toBeEnabled();
  await expect(undo).not.toHaveAttribute("aria-disabled");

  const undos = watchRequests(page, "POST", (pathname) => UNDO_PATH.test(pathname));
  await undo.click();
  await expect(page.getByRole("alertdialog"), "撤回 asks no confirmation").toHaveCount(0);
  const { request, response } = await theOne(undos, "POST undo");
  undos.stop();
  expect(new URL(request.url()).pathname).toBe(`/api/sessions/${sessionId}/undo`);
  expect(request.postDataJSON()).toStrictEqual({ messageId, files: "restore" });
  expect(response.status(), "POST undo status").toBe(200);

  await expect(page.getByText("还没有消息，发一条开始吧", { exact: true })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByLabel("给助手发消息")).toHaveValue(prompt);
  expect(await treeNames(page, workspaceId), "tree after undo").not.toContain(file);
  await expect(page.getByText("已撤回，以下文件未还原")).toHaveCount(0);
  await expect(page.locator(".ui-toast")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

// 第 4 步：草稿已在聚焦的输入框里，直接回车；回合完成后文件回来。对新的用户消息 fork 得 201——分支
// 对位要求 omp 的历史里只有这一条用户条目，被撤回的那一轮不在其中。fork 出的会话经列表事件出现在
// 侧栏（同标题两条），删除后回到一条：第 6 步的确认框据此读作独占临时空间。
async function resendAndFork(
  walk: TempWalk,
  { sessionId, workspaceId }: TempSession,
  forked: { id: string | null },
): Promise<void> {
  const { page, project, prompt, title, reply, file } = walk;
  const composer = page.getByLabel("给助手发消息");
  const user = page.getByRole("article", { name: "用户" });
  await expect(composer).toBeFocused();
  await composer.press("Enter");
  await expect(user).toHaveCount(1);
  await expect(user.locator('[data-slot="message-body"]')).toHaveText(prompt);
  await expectTurnDone(page.getByRole("article", { name: "助手" }), reply);
  expect(await treeNames(page, workspaceId), "tree after the second send").toContain(file);

  const messageId = await onlyUserMessageId(page, sessionId);
  await inspectSidebar(page, project, async (sidebar) => {
    const entries = sessionList(sidebar).getByRole("button", { name: title, exact: true });
    await expect(entries).toHaveCount(1);
    const fork = await page.request.post(`/api/sessions/${sessionId}/fork`, {
      data: { messageId },
    });
    expect(fork.status(), "POST fork status").toBe(201);
    forked.id = ((await fork.json()) as { session: { id: string } }).session.id;
    await expect(entries).toHaveCount(2);
    const deleted = await page.request.delete(`/api/sessions/${forked.id}`);
    expect(deleted.status(), "DELETE forked session status").toBe(204);
    await expect(entries).toHaveCount(1);
  });
}

// 第 5 步：归档后条目离开默认视图，主区只读；`已归档` 视图恰这一条，`恢复` 后为空，返回后条目回到
// `临时空间` 分组，输入框回来。行菜单里的 `恢复` 是 menuitem（主区说明里另有同名 button）。
async function archiveAndRestore(walk: TempWalk): Promise<void> {
  const { page, project, title } = walk;
  const composer = page.getByLabel("给助手发消息");
  const notice = page.getByText("该会话已归档，恢复后才能继续对话", { exact: true });
  await inspectSidebar(page, project, async (sidebar) => {
    const list = sessionList(sidebar);
    await rowMenu(sidebar).click();
    await menuItem(page, "归档").click();
    await expect(list).toBeVisible();
    await expect(list.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    await expectFocusInNavOverlay(page, project);
  });
  await expect(notice).toBeVisible();
  await expect(composer).toHaveCount(0);

  await inspectSidebar(page, project, async (sidebar) => {
    const { list, pinned, temporary } = sections(sidebar, "");
    await list.getByRole("button", { name: "已归档", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list.getByRole("button", { name: title, exact: true })).toHaveCount(1);
    await rowMenu(sidebar).click();
    await menuItem(page, "恢复").click();
    await expect(list.getByText(EMPTY, { exact: true })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(0);
    await list.getByRole("button", { name: "返回会话列表", exact: true }).click();
    await expectSelectedIn(list, temporary, [pinned]);
    await expectFocusInNavOverlay(page, project);
  });
  await expect(composer).toBeVisible();
  await expect(notice).toHaveCount(0);
}

// 第 6 步：确认框说明临时空间的文件一并删除；确认后条目消失、没有轻提示、回到欢迎态，空间的 tree 404。
async function deleteLastSession(walk: TempWalk, workspaceId: string): Promise<void> {
  const { page, project, title } = walk;
  await inspectSidebar(page, project, async (sidebar) => {
    await rowMenu(sidebar).click();
    await menuItem(page, "删除").click();
    const confirm = page.getByRole("alertdialog", { name: "删除任务", exact: true });
    await expect(confirm).toContainText("临时空间里的文件会一并删除。");
    await confirm.getByRole("button", { name: "删除", exact: true }).click();
    await expectDeletedWithoutToast(page, sessionList(sidebar), title);
    await expectFocusInNavOverlay(page, project);
  });
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBeNull();
  await expect(welcomeHeading(page)).toBeVisible();
  await treeNames(page, workspaceId, 404);
}

// 第二个旅程的六步；调用方已登录，结束后由调用方退出。`finally` 删除经页面创建的会话与 fork 出的会话
// （204 或 404），成功与步骤失败时都执行：不留下会话与临时空间。
export async function walkTemporarySpace(
  page: Page,
  project: WalkProject,
  reply: string,
  file: string,
): Promise<void> {
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk temporary space ${project}: ${point} +${Date.now() - started}ms`);
  const prompt = `WORKBUDDY_WRITE 临时空间走查 ${randomUUID()}`;
  const walk = { page, project, prompt, title: [...prompt].slice(0, 18).join(""), reply, file };
  const forked: { id: string | null } = { id: null };
  const created = watchCreatedSessions(page);
  const events = watchRequests(page, "GET", (pathname) => pathname === LIST_EVENTS_PATH);
  try {
    await page.goto("/");
    const session = await sendFromWelcome(walk, events);
    mark("step 2 (running, done, one list stream)");
    await expectTemporarySpace(walk, session.workspaceId);
    mark("step 1");
    await undoFirstTurn(walk, session);
    mark("step 3");
    await resendAndFork(walk, session, forked);
    mark("step 4");
    await archiveAndRestore(walk);
    mark("step 5");
    await deleteLastSession(walk, session.workspaceId);
    await expectOneOpenListStream(events);
    mark("step 6");
  } finally {
    events.stop();
    await created.deleteAll();
    await deleteCreatedSession(page, forked.id);
  }
  mark("cleanup");
}
