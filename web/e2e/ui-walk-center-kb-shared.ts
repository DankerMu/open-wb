// UI walk：中心「知识库」tab 的共享知识库分支（knowledge-bases「UI 走查共享知识库」，s2c-kb-visibility 任务 13.2，#2039）。
// 由 ui-walk-center-kb.ts 的 `walkKbRetrieval` 在它撤桩之后、退出之前调用，沿用同一个登录（成员 `zhangsan`）。
// 两段，共用五个 route 桩（应答体严格按 web 解析器的键集）：
// 1. 只读呈现：列表为一个自有库与一个共享库（`owned:false`），断言计数行、`只读`、`来自 <账号> · <部门>`、共享行没有按钮；
//    进入共享库详情，断言只读提示、没有入库入口、文档表没有操作列、两个检索参数框只读。
// 2. 范围对话框：点自有行的范围按钮，`GET /api/accounts/me/scope` 由桩应答（一个部门、一个项目组）；选 `项目组可见`
//    与该组后保存，桩截获 `PUT …/scope` 并以 `documents:7` 的新视图应答，断言整行按应答替换、列表不重取。
// 桩只回 200：4xx/5xx 会让 Chromium 记一条 console error，oracle 只放行 /api/auth/me 的 401。未桩的写请求打到真实服务
// （知识库关闭，503 `kb_disabled`），同样由 oracle 抓住。
// import 环：本文件从 ui-walk-center-kb.js 导入、后者又导入本文件，本文件先求值；顶层读导入值（如 `{ ...BASE }`）会在
// 加载期抛 ReferenceError。顶层只放字面量，桩对象在函数里现造。设了 UI_WALK_SHOT_DIR 才截图（文件名带 project 名）。

import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { BASE, json, STATUS, shot } from "./ui-walk-center-kb.js";
import { expectNoHorizontalOverflow, type WalkProject } from "./ui-walk-layout.js";

const OWN_ID = "kb-walk-own";
const SHARED_ID = "kb-walk-shared";
const OWN_NAME = "我的库";
const OWNER_LINE = "来自 zhaoliu · 数据部";
const GROUP_TEXT = "内网落地专项（2 人）";
const READ_ONLY_NOTE =
  "共享给你的知识库只读：可检索、可在会话中引用，不能增删文档。需要补充内容请联系 zhaoliu。";
const AUDIT_HINT = "共享只给读权限：他人可检索与引用，不能增删文档或改设置。切换范围会记入审计。";
const SCOPE_LABELS = ["仅自己可见", "本部门可见", "项目组可见", "全员可见"];
const PARAMS = [
  ["相似度阈值", "0.2"],
  ["向量权重", "0.7"],
] as const;

const STATUS_ROUTE = "**/api/kb/status";
const BASES_ROUTE = "**/api/kb/bases";
const DOCUMENTS_ROUTE = `**/api/kb/bases/${SHARED_ID}/documents`;
const MY_SCOPE_ROUTE = "**/api/accounts/me/scope";
const SCOPE_ROUTE = `**/api/kb/bases/${OWN_ID}/scope`;

// `done`：不触发 3 秒刷新。共享库的工作空间来源路径由服务端置空。
const SHARED_DOCUMENT = {
  id: "doc-walk-shared",
  name: "spec.md",
  size: 2048,
  source: "workspace",
  workspaceId: null,
  path: null,
  status: "done",
  chunkCount: 3,
  message: null,
  sourceChanged: null,
  createdAt: 1_760_000_000_000,
};
const MY_SCOPE = {
  department: "平台研发部",
  groups: [{ id: "g1", name: "内网落地专项", memberCount: 2 }],
};

/** 桩应答过的一次请求；读次数由它现数（`listReads`、`scopeReads`），PUT 的 body 也从它取。 */
type Answered = { method: string; pathname: string; body: unknown; raw: string | null };
type Log = Answered[];
const LIST_PATH = "/api/kb/bases";
const MY_SCOPE_PATH = "/api/accounts/me/scope";
const reads = (log: Log, pathname: string) =>
  log.filter((item) => item.pathname === pathname).length;
/** 一次走查的上下文：定位器是惰性的，可以先造后用。 */
type Walk = {
  page: Page;
  main: Locator;
  ownRow: Locator;
  dialog: Locator;
  log: Log;
  project: WalkProject;
};

const ownBase = () => ({ ...BASE, id: OWN_ID, name: OWN_NAME });
const sharedBase = () => ({
  ...BASE,
  id: SHARED_ID,
  name: "规范库",
  raptor: true,
  compile: null,
  owned: false,
  owner: { id: "u2", account: "zhaoliu", department: "数据部" },
  scope: { scope: "all", group: null },
});
const savedBase = () => ({
  ...ownBase(),
  documents: 7,
  scope: { scope: "group", group: { id: "g1", name: "内网落地专项" } },
});

/** 共享知识库分支：装桩、只读呈现、范围对话框、逆序撤桩。登录与退出在调用方。 */
export async function walkKbShared(page: Page, project: WalkProject): Promise<void> {
  const log: Log = [];
  try {
    await installRoutes(page, log);
    await page.goto("/center?tab=knowledge-bases");
    const main = page.locator("main");
    const ownRow = main
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: OWN_NAME, exact: true }) });
    // 对话框打开时 `#root` 被设为 aria-hidden：对话框从 page 找。
    const dialog = page.getByRole("dialog", { name: `「${OWN_NAME}」可见范围`, exact: true });
    const walk: Walk = { page, main, ownRow, dialog, log, project };
    await expectList(walk);
    await expectSharedDetail(walk);
    await expectScopeDialog(walk);
    await expectSaved(walk);
  } finally {
    await page.unroute(SCOPE_ROUTE);
    await page.unroute(MY_SCOPE_ROUTE);
    await page.unroute(DOCUMENTS_ROUTE);
    await page.unroute(BASES_ROUTE);
    await page.unroute(STATUS_ROUTE);
  }
}

/** handler 只记录与 fulfill；每个桩只应答一种方法，其余 `fallback()` 到真实服务。 */
async function installRoutes(page: Page, log: Log): Promise<void> {
  const answer = (method: string, body: unknown) => (route: Route) => {
    const request = route.request();
    if (request.method() !== method) return route.fallback();
    const pathname = new URL(request.url()).pathname;
    log.push({ method, pathname, body: request.postDataJSON(), raw: request.postData() });
    return json(route, body);
  };
  await page.route(STATUS_ROUTE, (route) => json(route, STATUS));
  await page.route(BASES_ROUTE, answer("GET", { bases: [ownBase(), sharedBase()] }));
  await page.route(DOCUMENTS_ROUTE, answer("GET", { documents: [SHARED_DOCUMENT] }));
  await page.route(MY_SCOPE_ROUTE, answer("GET", MY_SCOPE));
  await page.route(SCOPE_ROUTE, answer("PUT", savedBase()));
}

/** 第 1 段之一：计数行、共享行的标签与格、自有行的两个按钮（阳性对照）。 */
async function expectList({ page, main, ownRow, log, project }: Walk): Promise<void> {
  const sharedRow = main
    .getByRole("row")
    .filter({ has: page.getByText(OWNER_LINE, { exact: true }) });
  await expect(main.getByText("我的 1 个 · 共享给我 1 个", { exact: true })).toBeVisible();
  await expect(sharedRow.getByText("只读", { exact: true })).toBeVisible();
  await expect(sharedRow.getByRole("cell").nth(2)).toHaveText("RAPTOR");
  await expect(sharedRow.getByRole("cell").nth(5)).toHaveText("全员可见");
  await expect(sharedRow.getByRole("button")).toHaveCount(0);
  await expect(ownRow.getByRole("button")).toHaveText(["仅自己可见", "删除知识库"]);
  await expect(main.getByText("状态未知")).toHaveCount(0);
  expect(reads(log, MY_SCOPE_PATH), "no scope read before the dialog opens").toBe(0);
  await expectNoHorizontalOverflow(page);
  await shot(page, sharedRow, `kb-shared-${project}-list`);
  await sharedRow.getByText(OWNER_LINE, { exact: true }).click();
}

/** 第 1 段之二：共享库详情只读——没有入库入口与操作列，范围是纯文本，两个参数框只读但可用。 */
async function expectSharedDetail({ page, main, project }: Walk): Promise<void> {
  const detail = main.getByRole("region", { name: "规范库 · 文档", exact: true });
  await expect(detail.getByRole("columnheader")).toHaveText(["名称", "来源", "大小", "状态"]);
  const docRow = detail
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "spec.md", exact: true }) });
  await expect(docRow.getByRole("cell").nth(1)).toHaveText("工作空间");
  await expect(detail.getByText(READ_ONLY_NOTE, { exact: true })).toBeVisible();
  await expect(detail.getByText("全员可见", { exact: true })).toBeVisible();
  await expect(main.getByText("从工作空间入库", { exact: true })).toHaveCount(0);
  await expect(main.getByText("上传文件", { exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button")).toHaveText(["检索"]);
  for (const [name, value] of PARAMS) {
    const field = detail.getByRole("spinbutton", { name, exact: true });
    await expect(field).not.toBeEditable();
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(value);
  }
  await expectNoHorizontalOverflow(page);
  const widths = await detail.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(widths[0], "detail scrollWidth <= clientWidth").toBeLessThanOrEqual(widths[1] ?? 0);
  await shot(page, detail, `kb-shared-${project}-detail`);
}

/** 第 2 段之一：打开自有库的范围对话框，四档与审计提示；选 `项目组可见` 与该组，查宽度。 */
async function expectScopeDialog({ page, ownRow, dialog, log, project }: Walk): Promise<void> {
  await ownRow.getByRole("button", { name: "仅自己可见", exact: true }).click();
  await expect.poll(() => reads(log, MY_SCOPE_PATH), "scope read once on open").toBe(1);
  const radios = dialog.getByRole("radio");
  await expect(radios).toHaveCount(SCOPE_LABELS.length);
  for (const [index, label] of SCOPE_LABELS.entries()) {
    await expect(radios.nth(index)).toHaveAccessibleName(label);
    await expect(radios.nth(index)).toBeEnabled();
  }
  await expect(dialog.getByRole("radio", { name: "仅自己可见", exact: true })).toBeChecked();
  await expect(dialog.getByText(AUDIT_HINT, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);

  const group = dialog.getByRole("radio", { name: "项目组可见", exact: true });
  await group.click();
  await expect(group).toBeChecked();
  const trigger = dialog.getByRole("combobox", { name: "项目组", exact: true });
  await expect(trigger).toHaveText(GROUP_TEXT);
  await trigger.click();
  await expect(page.getByRole("option")).toHaveText([GROUP_TEXT]);
  await page.getByRole("option", { name: GROUP_TEXT, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toHaveText(GROUP_TEXT);

  await expectNoHorizontalOverflow(page);
  const widths = await dialog.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(widths[0], "dialog scrollWidth <= clientWidth").toBeLessThanOrEqual(widths[1] ?? 0);
  const box = (await dialog.boundingBox()) ?? { x: Number.NaN, width: Number.NaN };
  expect(box.x, "dialog left edge >= 0").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "dialog right edge").toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  await shot(page, dialog, `kb-shared-${project}-dialog`);
}

/** 第 2 段之二：保存一次 PUT，自有行按应答整行替换（`documents:7`），列表与范围都不重取，共享库详情仍开着。 */
async function expectSaved({ page, main, ownRow, dialog, log, project }: Walk): Promise<void> {
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    log.filter((item) => item.method === "PUT"),
    "one PUT …/scope",
  ).toStrictEqual([
    {
      method: "PUT",
      pathname: `/api/kb/bases/${OWN_ID}/scope`,
      body: { scope: "group", groupId: "g1" },
      raw: '{"scope":"group","groupId":"g1"}',
    },
  ]);
  await expect(ownRow.getByRole("button")).toHaveText(["项目组可见 · 内网落地专项", "删除知识库"]);
  await expect(main.getByRole("button", { name: "仅自己可见", exact: true })).toHaveCount(0);
  await expect(ownRow.getByRole("cell").nth(3)).toHaveText("7");
  expect(reads(log, LIST_PATH), "list read once").toBe(1);
  expect(reads(log, MY_SCOPE_PATH), "scope read once").toBe(1);
  await expect(main.getByRole("region", { name: "规范库 · 文档", exact: true })).toBeVisible();
  await expect(main.getByRole("region", { name: `${OWN_NAME} · 文档`, exact: true })).toHaveCount(
    0,
  );
  await expectNoHorizontalOverflow(page);
  await shot(page, ownRow, `kb-shared-${project}-saved`);
}
