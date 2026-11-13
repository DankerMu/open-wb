// UI walk：会话知识库引用与检索卡（chat-harness「UI 走查会话知识库引用与检索卡」，s2c-kb-session 任务 10.2）。
// CI 的 ui-walk 不配 RAGFlow，写法同 ui-walk-center-kb.ts：`/api/kb/status`、`/api/kb/bases`（只应答 GET）、
// 会话的 prompt（只拦 POST，202 不起真实回合）与第 3 步的消息快照由 route 应答，应答体严格按 web 解析器的键集；
// 会话、工作空间与其余接口走真实服务。顺序是 `login()` → 建会话 → 装桩 → `goto`：会话页的 `useKbEnabled` 每个
// client 只读一次，桩必须在页面挂载前装好。route handler 只记录与 fulfill，断言一律在 handler 之外（handler 里
// 抛错请求就永远不会被 fulfill）。四步：经「+」引用一个库、发送后 body 带库 id 且标签清空、刷新后气泡的引用
// 与两轮的「知识库检索」卡、欢迎态暂存的引用随首发交给新会话（spec 之外的加固，来自 PR 1998）。`finally` 先回
// 欢迎态（停在会话上删除，事件流重连会拿到 404），再逆序撤桩、删两个会话，然后退出。不走失败路径：oracle 只放行
// /api/auth/me 的 401，桩里不出现 4xx/5xx。设了 UI_WALK_SHOT_DIR 才截图（文件名带 project 名）。

import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { BASE, json, STATUS, shot } from "./ui-walk-center-kb.js";
import { deleteCreatedSession } from "./ui-walk-cleanup.js";
import { login, logout } from "./ui-walk-composer.js";
import { expectNoHorizontalOverflow, type WalkProject } from "./ui-walk-layout.js";
import type { AuthOracle } from "./ui-walk-oracle.js";
import { welcomeHeading } from "./ui-walk-session-list.js";

const KB_A = "kb-walk-product";
const KB_B = "kb-walk-support";
const NAME_A = "产品文档";
const NAME_B = "客服问答";
const WORKSPACE_NAME = "smoke-fixture";
const SESSION_TEXT = "退款多久到账";
const WELCOME_TEXT = "超时工单升级给谁";
const QUESTIONS = ["退款到账时限", "退款超时 升级处理"];
const REPLY = "退款在 7 个工作日内到账。";
const TAGS = "引用的知识库";

const STATUS_ROUTE = "**/api/kb/status";
const BASES_ROUTE = "**/api/kb/bases";
const PROMPT_ROUTE = "**/api/sessions/*/prompt";
const BASES = [
  { ...BASE, id: KB_A, name: NAME_A, state: "ready" },
  { ...BASE, id: KB_B, name: NAME_B, state: "rebuilding", stateMessage: "正在重建索引" },
];

type PromptRecord = { pathname: string; body: unknown };
type Created = { session: string | null; welcome: string | null; snapshotRoute: string | null };

/** 会话知识库分支：登录、建会话、装桩、四步、回欢迎态、撤桩、删会话、退出。 */
export async function walkChatKbRefs(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
): Promise<void> {
  await login(page, oracle, project);
  const created: Created = { session: null, welcome: null, snapshotRoute: null };
  const prompts: PromptRecord[] = [];
  try {
    const sessionId = await createSession(page, created);
    await page.route(STATUS_ROUTE, (route) => json(route, STATUS));
    await page.route(BASES_ROUTE, (route) =>
      route.request().method() === "GET" ? json(route, { bases: BASES }) : route.fallback(),
    );
    await page.route(PROMPT_ROUTE, (route) => recordPrompt(route, prompts));
    const loaded = messagesResponse(page, sessionId);
    await page.goto(`/?session=${sessionId}`);
    expect((await loaded).status(), "initial GET …/messages status").toBe(200);

    await stepRefs(page, project);
    await stepSend(page, sessionId, prompts);
    await stepReload(page, sessionId, project, created);
    await stepWelcome(page, prompts, created);
  } finally {
    await leaveAndUnroute(page, created);
    await deleteCreatedSession(page, created.welcome);
    await deleteCreatedSession(page, created.session);
  }
  await logout(page, oracle, project);
}

/** 经真实服务建一个绑定 `smoke-fixture` 的空会话（`login()` 已确保该空间存在），id 一到就记下。 */
async function createSession(page: Page, created: Created): Promise<string> {
  const listed = await page.request.get("/api/workspaces");
  expect(listed.status(), "GET /api/workspaces status").toBe(200);
  const { workspaces } = (await listed.json()) as { workspaces: { id: string; name: string }[] };
  const workspaceId = workspaces.find((workspace) => workspace.name === WORKSPACE_NAME)?.id;
  expect(workspaceId, `${WORKSPACE_NAME} workspace id`).toBeDefined();
  const creation = await page.request.post("/api/sessions", { data: { workspaceId } });
  expect(creation.status(), "POST /api/sessions status").toBe(201);
  const { id } = (await creation.json()) as { id: string };
  created.session = id;
  return id;
}

/** prompt 桩：只拦 POST，记录路径与 body，应答 202 恰三键；不起真实回合。 */
function recordPrompt(route: Route, prompts: PromptRecord[]) {
  const request = route.request();
  if (request.method() !== "POST") return route.fallback();
  prompts.push({ pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
  return route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({ userMessageId: 1, assistantMessageId: 2, undo: "none" }),
  });
}

function messagesResponse(page: Page, sessionId: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/sessions/${sessionId}/messages`,
  );
}

/** 「+」→ `引用知识库…` → 点「产品文档」→ 关闭列表；`inspect` 在点选之前看一眼列表。 */
async function referProduct(page: Page, inspect?: (picker: Locator) => Promise<void>) {
  await page.getByRole("menuitem", { name: "引用知识库…", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "引用知识库", exact: true });
  const product = picker.getByRole("button", { name: NAME_A, exact: true });
  await expect(product).toHaveAttribute("aria-pressed", "false");
  await inspect?.(picker);
  await product.click();
  await expect(product).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
}

function openPlusMenu(page: Page) {
  return page.getByRole("button", { name: "添加文件或命令", exact: true }).click();
}

/** 第 1 步：菜单里 `上传文件` 之后紧跟 `引用知识库…`；重建中的库带状态字样；选中后输入卡出现标签。 */
async function stepRefs(page: Page, project: WalkProject): Promise<void> {
  await openPlusMenu(page);
  const items = page.getByRole("menuitem");
  await expect(items.nth(0)).toHaveAccessibleName("上传文件");
  await expect(items.nth(1)).toHaveAccessibleName("引用知识库…");
  await referProduct(page, async (picker) => {
    // 状态字样是相邻的 span，Chromium 拼可访问名时是否插空格没实测，只认正则。
    await expect(picker.getByRole("button", { name: NAME_B })).toHaveAccessibleName(/重建中/u);
  });
  const tags = page.locator('[data-slot="composer-kb-refs"]');
  await expect(tags).toHaveAccessibleName(TAGS);
  await expect(tags.getByRole("listitem")).toHaveText([NAME_A]);
  await expect(tags.getByRole("button", { name: `移除 ${NAME_A}`, exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await shot(page, tags, `chat-kb-${project}-refs`);
}

/** 第 2 步：回车发送；prompt body 恰为文本加所选库 id；受理后标签清空；等真实的消息快照回来。 */
async function stepSend(page: Page, sessionId: string, prompts: PromptRecord[]): Promise<void> {
  const composer = page.getByLabel("给助手发消息");
  await composer.fill(SESSION_TEXT);
  const reloaded = messagesResponse(page, sessionId);
  await composer.press("Enter");
  await expect.poll(() => prompts.length, "prompt requests").toBe(1);
  expect(prompts).toStrictEqual([
    {
      pathname: `/api/sessions/${sessionId}/prompt`,
      body: { message: SESSION_TEXT, knowledgeBases: [KB_A] },
    },
  ]);
  await expect(page.locator('[data-slot="composer-kb-refs"]')).toHaveCount(0);
  expect((await reloaded).status(), "accepted GET …/messages status").toBe(200);
}

/** 快照里的两条消息（十四键，按角色约束）：带引用的用户消息、两个 `kb_search` 步骤的 `done` 助手消息。 */
function snapshotMessages() {
  const message = {
    thinking: null,
    error: null,
    thinkingMs: null,
    thinkingSegments: [],
    approvals: [],
    attachments: [],
    status: "done",
  };
  const step = (id: number, question: string) => ({
    id,
    ordinal: id - 1,
    name: "kb_search",
    detail: JSON.stringify({ question }),
    output: "",
    changes: null,
    status: "done",
    bodyOffset: 0,
  });
  return [
    {
      ...message,
      id: 1,
      role: "user",
      content: SESSION_TEXT,
      createdAt: 1_760_000_000_000,
      steps: [],
      undo: "none",
      knowledgeBases: [{ id: KB_A, name: NAME_A }],
    },
    {
      ...message,
      id: 2,
      role: "assistant",
      content: REPLY,
      createdAt: 1_760_000_001_000,
      steps: QUESTIONS.map((question, index) => step(index + 1, question)),
      undo: null,
      knowledgeBases: [],
    },
  ];
}

/** 第 3 步：快照桩保留真实的 session、streamCursor、todo，只换 messages；刷新后气泡列出引用、助手消息有两轮的卡。 */
async function stepReload(
  page: Page,
  sessionId: string,
  project: WalkProject,
  created: Created,
): Promise<void> {
  const pattern = `**/api/sessions/${sessionId}/messages`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = (await (await route.fetch()).json()) as Record<string, unknown>;
    return json(route, { ...real, messages: snapshotMessages() });
  });
  created.snapshotRoute = pattern;
  await page.reload();

  const user = page.getByRole("article", { name: "用户" });
  await expect(user).toHaveCount(1);
  const refs = user.locator('[data-slot="message-kb-refs"]');
  await expect(refs).toHaveAccessibleName(TAGS);
  await expect(refs.getByRole("listitem")).toHaveText([NAME_A]);

  const assistant = page.getByRole("article", { name: "助手" });
  await expect(assistant).toHaveCount(1);
  const card = assistant.locator('section[aria-label="知识库检索"]');
  await expect(card.locator('[data-slot="kb-search-title"]')).toHaveText("知识库检索");
  await expect(card.locator('[data-slot="kb-search-rounds"]')).toHaveText("（2 轮）");
  const rows = card.locator('[data-slot="kb-search-row"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-slot="kb-search-intent"]')).toHaveText(QUESTIONS);
  await expect(rows.locator("button")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await shot(page, card, `chat-kb-${project}-card`);
}

/** 第 4 步：欢迎态引用「产品文档」后首发；新会话由真实服务创建，prompt 由通配桩接住，body 带库 id。 */
async function stepWelcome(page: Page, prompts: PromptRecord[], created: Created): Promise<void> {
  await page.goto("/");
  await expect(welcomeHeading(page)).toBeVisible();
  await openPlusMenu(page);
  await referProduct(page);
  await expect(page.locator('[data-slot="composer-kb-refs"]').getByRole("listitem")).toHaveText([
    NAME_A,
  ]);
  const composer = page.getByLabel("给助手发消息");
  await composer.fill(WELCOME_TEXT);
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sessions",
  );
  await composer.press("Enter");
  const response = await creation;
  const body = (await response.json()) as { id?: unknown };
  created.welcome = typeof body.id === "string" ? body.id : null;
  expect(response.status(), "welcome POST /api/sessions status").toBe(201);
  await expect.poll(() => prompts.length, "prompt requests").toBe(2);
  expect(prompts.slice(1)).toStrictEqual([
    {
      pathname: `/api/sessions/${created.welcome}/prompt`,
      body: { message: WELCOME_TEXT, knowledgeBases: [KB_A] },
    },
  ]);
  await expect(page.locator('[data-slot="composer-kb-refs"]')).toHaveCount(0);
}

// `finally` 里调用：只产生 soft 失败，不盖掉 try 里的原始失败。先回欢迎态，再逆序撤桩。
async function leaveAndUnroute(page: Page, created: Created): Promise<void> {
  try {
    await page.goto("/");
    await expect(welcomeHeading(page)).toBeVisible();
  } catch (error) {
    expect.soft(String(error), "cleanup: return to the welcome page failed").toBe("");
  }
  if (created.snapshotRoute !== null) await page.unroute(created.snapshotRoute);
  await page.unroute(PROMPT_ROUTE);
  await page.unroute(BASES_ROUTE);
  await page.unroute(STATUS_ROUTE);
}
