// UI walk：输入框能力（chat-harness「输入框能力的冒烟与走查」的五个步骤），真栈：编译后的应用、官方 omp、
// 受控上游，缺省配置。一个旅程自带登录与退出（error oracle 要恰两次 /api/auth/me 401）。
// 第 1 步的能力行几何在欢迎态与已选会话各量一次；第 2–4 步在同一个绑定 `smoke-fixture` 的会话里：档位
// 确认框、模型与强度菜单、经「+」菜单上传并随消息发出的附件。次序有讲究：欢迎态的三个控件只在新加载的页面上
// 读一次，会话建出之后不再回欢迎态读它们（#1269：欢迎态缺省值要到下次加载才更新）。
// 第一条 prompt 带 WORKBUDDY_WRITE：`只问命令` 下 write 工具不问，缺省的 bash 轮会弹审批卡；第二条因历史
// 已有 tool result 是纯文本轮。`finally` 先把账号的最近选择改回 `只问命令`（两个 project 共用一个库，第 2
// 步中途失败会把 `全部自动` 留给下一个 project 的审批走查），再删除会话。上传的文件留在 `smoke-fixture/uploads/`。
// 删除之前页面先回到 `/`：服务端删会话时结束它的事件流，还停在该会话上的页面会在 EventSource 的缺省延迟后
// 重连并拿到 404，error oracle 把它记成意外的 console error。

import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, type Request } from "@playwright/test";
import { deleteCreatedSession } from "./ui-walk-cleanup.js";
import {
  DEV_ACCOUNT,
  expectAuthenticatedRoute,
  openSidebar,
  type WalkProject,
} from "./ui-walk-layout.js";
import { resolvedColor } from "./ui-walk-login.js";
import type { AuthOracle } from "./ui-walk-oracle.js";
import { expectTurnDone, welcomeHeading } from "./ui-walk-session-list.js";

const DEV_PASSWORD = "demo";
// 同文件第一个 test 的 `walkFiles` 建出的空间；这里先确保它存在，本旅程单独跑也成立。
const WORKSPACE_NAME = "smoke-fixture";
const HEX_ID = /^[0-9a-f]{32}$/;
// 缺省配置（`MODEL_CATALOG` 未设置）：单模型，可选强度是 `off` 加全部六档。
const MODEL_BUTTON = "模型：deepseek-v4.1-flash";
const EFFORT_BUTTON = "推理强度：高";
const EFFORT_LABELS = ["关闭", "极低", "低", "中", "高", "很高", "最高"];
const WARNING_TOKEN = "--wb-status-warning-text";
// 包围盒的亚像素取整容差。
const EDGE_TOLERANCE = 0.5;

type Box = { name: string; left: number; top: number; right: number; bottom: number };
type CreatedSession = { id: string | null };
type PatchCount = { count(): number; stop(): void };

async function login(page: Page, oracle: AuthOracle, project: WalkProject): Promise<void> {
  await page.goto("/files");
  await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
  await page.getByLabel("账号").fill(DEV_ACCOUNT);
  await page.getByLabel("密码").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expectAuthenticatedRoute(page, project, "/files", "工作空间", "工作空间");
  oracle.phase = "authenticated";
  const ensured = await page.request.post("/api/workspaces", { data: { name: WORKSPACE_NAME } });
  expect([201, 409], "POST /api/workspaces status").toContain(ensured.status());
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

function tierButton(page: Page, label: string): Locator {
  return page.getByRole("button", { name: `权限：${label}`, exact: true });
}

// 能力行的六个控件，按界面次序。工作空间位在欢迎态是选择器的外层、会话态是只读的 `<p>`，同一个 slot。
function rowControls(page: Page): [string, Locator][] {
  return [
    ["添加文件或命令", page.getByRole("button", { name: "添加文件或命令", exact: true })],
    ["工作空间位", page.locator('[data-slot="composer-workspace"]')],
    ["权限", page.getByRole("button", { name: /^权限：/u })],
    ["模型", page.getByRole("button", { name: /^模型：/u })],
    ["推理强度", page.getByRole("button", { name: /^推理强度：/u })],
    ["发送", page.getByRole("button", { name: "发送", exact: true })],
  ];
}

async function boxOf(name: string, target: Locator): Promise<Box> {
  await expect(target, `${name} is visible`).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error(`capability row: ${name} has no bounding box`);
  return { name, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

const describeBox = (box: Box) =>
  `${box.name} x ${box.left.toFixed(1)}..${box.right.toFixed(1)} y ${box.top.toFixed(1)}..${box.bottom.toFixed(1)}`;

// 几个控件的纵向区间的公共部分的高度；为正即它们在同一行。
function sharedRowHeight(boxes: Box[]): number {
  return Math.min(...boxes.map((box) => box.bottom)) - Math.max(...boxes.map((box) => box.top));
}

// 行关系：desktop 六者同一行；mobile 模型所在行在权限所在行之下或同一行（允许换行），右组三者同一行。
function expectRows(project: WalkProject, boxes: Box[], measured: string): void {
  if (project === "desktop-light") {
    expect(sharedRowHeight(boxes), `six controls share one row — ${measured}`).toBeGreaterThan(0);
    return;
  }
  const [, , permission, model, effort, send] = boxes;
  if (!permission || !model || !effort || !send) throw new Error("capability row: missing box");
  expect(
    (model.top + model.bottom) / 2,
    `模型 is on the row of 权限 or below it — ${measured}`,
  ).toBeGreaterThanOrEqual(permission.top);
  expect(
    sharedRowHeight([model, effort, send]),
    `模型, 推理强度 and 发送 share one row — ${measured}`,
  ).toBeGreaterThan(0);
}

/**
 * chat-web「真实浏览器下能力行不挤出发送键」：`发送` 与五个能力行控件各自完整位于输入卡之内、两两不重叠，
 * 文档没有横向滚动，行关系见 `expectRows`。只断言关系——不断言任何宽度、截断、`title`，也不断言右组一定换行。
 */
async function expectCapabilityRow(page: Page, project: WalkProject, state: string): Promise<void> {
  const boxes: Box[] = [];
  for (const [name, target] of rowControls(page)) boxes.push(await boxOf(name, target));
  const card = await boxOf("输入卡", page.locator('[data-slot="composer-card"]'));
  const measured = `${state}: ${[card, ...boxes].map(describeBox).join("; ")}`;
  console.log(`ui-walk composer ${project}: capability row ${measured}`);

  for (const box of boxes) {
    const outside = Math.max(
      card.left - box.left,
      card.top - box.top,
      box.right - card.right,
      box.bottom - card.bottom,
    );
    expect(outside, `${box.name} is inside the composer card — ${measured}`).toBeLessThanOrEqual(
      EDGE_TOLERANCE,
    );
  }
  for (const [index, first] of boxes.entries()) {
    for (const second of boxes.slice(index + 1)) {
      const overlap = Math.min(
        Math.min(first.right, second.right) - Math.max(first.left, second.left),
        sharedRowHeight([first, second]),
      );
      expect(
        overlap,
        `${first.name} and ${second.name} do not overlap — ${measured}`,
      ).toBeLessThanOrEqual(EDGE_TOLERANCE);
    }
  }
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth, `document scrollWidth <= innerWidth — ${measured}`).toBeLessThanOrEqual(
    innerWidth ?? 0,
  );
  expectRows(project, boxes, measured);
}

// 第 1 步的欢迎态一半：新加载的页面，权限缺省是 `只问命令`（之后各步的前置）。
async function stepRowOnWelcome(page: Page, project: WalkProject): Promise<void> {
  await page.goto("/");
  await expect(welcomeHeading(page)).toBeVisible();
  await expect(tierButton(page, "只问命令")).toBeVisible();
  await expectCapabilityRow(page, project, "welcome");
}

// 欢迎态选中 `smoke-fixture` 并发出第一条消息：建出的会话绑定该空间、档位是 `只问命令`。id 在 201 一到
// 就记进 `created`（先于对响应的任何断言），调用方的 `finally` 凭它清理。
async function startSession(
  page: Page,
  prompt: string,
  reply: string,
  created: CreatedSession,
): Promise<string> {
  await page.getByRole("button", { name: /^任务启动于 /u }).click();
  const popover = page.getByRole("dialog", { name: "选择工作空间", exact: true });
  await popover
    .getByRole("button")
    .filter({ has: page.getByText(WORKSPACE_NAME, { exact: true }) })
    .click();
  await expect(
    page.getByRole("button", { name: `任务启动于 ${WORKSPACE_NAME}`, exact: true }),
  ).toBeVisible();

  const composer = page.getByLabel("给助手发消息");
  await composer.fill(prompt);
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sessions",
  );
  await composer.press("Enter");
  const response = await creation;
  const body = (await response.json()) as Record<string, unknown>;
  created.id = typeof body.id === "string" ? body.id : null;
  expect(response.status(), "POST /api/sessions status").toBe(201);
  expect(body.id).toMatch(HEX_ID);
  expect(body.approvalMode, "the new session starts at 只问命令").toBe("write");
  expect(body.temporaryWorkspace, "the session is bound to a workspace").toBe(false);
  await expectTurnDone(page.getByRole("article", { name: "助手" }), reply);
  return String(body.id);
}

// 本会话的 `PATCH /api/sessions/:id` 次数（档位、模型、强度的每次提交都是一次）。
function countPatches(page: Page, sessionId: string): PatchCount {
  let seen = 0;
  const onRequest = (request: Request) => {
    if (request.method() !== "PATCH") return;
    if (new URL(request.url()).pathname === `/api/sessions/${sessionId}`) seen += 1;
  };
  page.on("request", onRequest);
  return { count: () => seen, stop: () => page.off("request", onRequest) };
}

// 权限菜单里选一档。单选项的可访问名是界面名加说明，`to` 按界面名开头匹配。
async function pickTier(page: Page, from: string, to: RegExp): Promise<void> {
  await tierButton(page, from).click();
  await page.getByRole("menuitemradio", { name: to }).click();
}

// 第 2 步：`全部自动` 先确认——`取消` 不提交，`确认切换` 才提交，按钮转为警示色；选回 `只问命令` 不经确认。
// 结束时账号的最近选择是 `只问命令`。
async function stepTier(page: Page, patches: PatchCount): Promise<void> {
  const dialog = page.getByRole("alertdialog");
  const title = dialog.getByRole("heading", { name: "切换到全部自动？", exact: true });

  await pickTier(page, "只问命令", /^全部自动/u);
  await expect(title).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tierButton(page, "只问命令")).toBeVisible();
  expect(patches.count(), "取消 sends no PATCH").toBe(0);

  await pickTier(page, "只问命令", /^全部自动/u);
  await expect(title).toBeVisible();
  await dialog.getByRole("button", { name: "确认切换", exact: true }).click();
  const warned = tierButton(page, "全部自动");
  await expect(warned).toBeVisible();
  // 指针移开：ghost 按钮悬停时换文字色。按钮带颜色过渡，轮询到落定；两种主题的取值不同，运行时解析。
  await page.mouse.move(0, 0);
  const warning = await resolvedColor(page, WARNING_TOKEN);
  await expect
    .poll(() => warned.evaluate((el) => getComputedStyle(el).color), "全部自动 text colour")
    .toBe(warning);

  await pickTier(page, "全部自动", /^只问命令/u);
  await expect(tierButton(page, "只问命令")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(patches.count(), "one PATCH to 全部自动, one back to 只问命令").toBe(2);
  const options = await page.request.get("/api/composer/options");
  expect(options.status(), "GET /api/composer/options status").toBe(200);
  const { defaults } = (await options.json()) as { defaults: { approvalMode: string } };
  expect(defaults.approvalMode, "the account's last choice is 只问命令 again").toBe("write");
}

// 第 3 步：模型菜单恰一项，强度菜单恰七项；只看不选，Escape 关闭，不发 PATCH。
async function stepModel(page: Page, patches: PatchCount): Promise<void> {
  const items = page.getByRole("menuitemradio");
  const before = patches.count();
  await page.getByRole("button", { name: MODEL_BUTTON, exact: true }).click();
  await expect(items).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: EFFORT_BUTTON, exact: true }).click();
  await expect(items).toHaveText(EFFORT_LABELS);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(patches.count(), "the two menus send no PATCH").toBe(before);
}

// 第二条用户消息气泡里名为 `附件` 的列表：恰一项，文件名是 `name`。
async function expectBubbleAttachment(page: Page, name: string): Promise<void> {
  const list = page
    .getByRole("article", { name: "用户" })
    .nth(1)
    .getByRole("list", { name: "附件", exact: true });
  await expect(list).toHaveAttribute("data-slot", "message-attachments");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem").locator("span").first()).toHaveText(name);
}

// 第 4 步：经「+」菜单的 `上传文件` 选入一个小文件（名字每次唯一：标签名取服务端返回的名字，同名会被编号），
// 标签上传完成后只有文件名与大小；随消息发出后标签清空，气泡列出该文件，刷新后仍在。
async function stepAttachment(page: Page, project: WalkProject, reply: string): Promise<void> {
  const name = `walk-attach-${project}-${randomUUID().slice(0, 8)}.txt`;
  const buffer = Buffer.from(`ui-walk ${name}\n`);
  const chips = page.locator('[data-slot="composer-attachments"]').getByRole("listitem");
  const composer = page.getByLabel("给助手发消息");
  const assistant = page.getByRole("article", { name: "助手" });

  await page.getByRole("button", { name: "添加文件或命令", exact: true }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("menuitem", { name: "上传文件", exact: true }).click(),
  ]);
  await chooser.setFiles({ name, mimeType: "text/plain", buffer });
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute("data-status", "uploaded");
  // 恰两个 span：文件名与大小，没有状态字样。
  await expect(chips.locator(":scope > span")).toHaveText([name, `${buffer.length} B`]);

  await composer.fill("请看附件");
  await composer.press("Enter");
  await expect(chips).toHaveCount(0);
  await expect(assistant).toHaveCount(2);
  await expectTurnDone(assistant.nth(1), reply);
  await expectBubbleAttachment(page, name);

  await page.reload();
  await expect(assistant.nth(1).locator('[data-slot="message-body"]')).toHaveText(reply);
  await expectBubbleAttachment(page, name);
}

// `finally` 里调用：只产生 soft 失败。先离开会话页（只等欢迎态标题，不读欢迎态的三个控件——#1269），
// 再把最近选择改回 `只问命令`（200；会话已不在时 404），最后删除会话。离开失败不挡后两步：它们走
// `page.request`，不依赖页面。
async function resetTierAndDelete(page: Page, sessionId: string | null): Promise<void> {
  if (sessionId === null) return;
  try {
    await page.goto("/");
    await expect(welcomeHeading(page)).toBeVisible();
  } catch (error) {
    expect.soft(String(error), "cleanup: return to the welcome page failed").toBe("");
  }
  try {
    const reset = await page.request.patch(`/api/sessions/${sessionId}`, {
      data: { approvalMode: "write" },
    });
    expect.soft([200, 404], "cleanup: PATCH approvalMode status").toContain(reset.status());
  } catch (error) {
    expect.soft(String(error), "cleanup: PATCH request failed").toBe("");
  }
  await deleteCreatedSession(page, sessionId);
}

/** 输入框能力的旅程：登录、五个步骤、清理、退出。`reply` 是受控上游的固定回复。 */
export async function walkComposer(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
  reply: string,
): Promise<void> {
  const started = Date.now();
  const mark = (point: string) =>
    console.log(`ui-walk composer ${project}: ${point} +${Date.now() - started}ms`);
  const created: CreatedSession = { id: null };
  const prompt = `WORKBUDDY_WRITE 能力行走查 ${randomUUID().slice(0, 8)}`;

  await login(page, oracle, project);
  await stepRowOnWelcome(page, project);
  mark("step 1 (welcome)");
  try {
    const sessionId = await startSession(page, prompt, reply, created);
    await expectCapabilityRow(page, project, "session");
    mark("step 1 (session)");
    const patches = countPatches(page, sessionId);
    try {
      await stepTier(page, patches);
      mark("step 2");
      await stepModel(page, patches);
      mark("step 3");
    } finally {
      patches.stop();
    }
    await stepAttachment(page, project, reply);
    mark("step 4");
  } finally {
    await resetTierAndDelete(page, created.id);
  }
  mark("cleanup");
  await logout(page, oracle, project);
  mark("logout");
}
