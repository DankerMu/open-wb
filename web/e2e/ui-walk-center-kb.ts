// UI walk：中心「知识库」tab 的检索测试（knowledge-bases「中心「知识库」tab」，s2b-kb-retrieval 任务 8.5、design D10）。
// CI 没有真实 RAGFlow，知识库开启的界面只能在浏览器层桩 API：`/api/kb/status`、`/api/kb/bases`（只应答 GET）、
// `…/documents` 与 `…/retrieval` 由 route 应答，应答体严格按 web 解析器的键集（键集不符界面会直接 requestFailed）；
// `/api/workspaces` 走真实服务。成员 `zhangsan` 打开一个 ready 的库的详情，问句框按 Enter 检索得两条命中，再点 `检索`
// 得 `hits:[]`，两次之后各查一次横向溢出。宽度由两个 project 提供（desktop-light 1440 浅色、mobile-dark 390 深色）。
// 不走失败路径：4xx/5xx 会让 Chromium 记一条 console error，oracle 只放行 /api/auth/me 的 401；失败路径由 jsdom 用例
//（web/test/center-kb-retrieval.test.tsx）覆盖。不对 /center 调 expectAuthenticatedRoute：它会断言知识库 tab 不在，
// 而这里知识库被桩成开启。设了 UI_WALK_SHOT_DIR 才截图（文件名带 project 名），不设时 CI 行为不变。
// 重排模型一行（s2b-kb-retrieval 任务 9.2）：管理员 `lisi` 打开模型 tab（成员读 `GET /api/models` 为 403），
// `/api/kb/status` 与 `GET /api/kb/settings` 由 route 应答（设置严格八键），`/api/models` 走真实服务。不点保存、探活与
// 清除确认：真实服务的知识库是关闭的，写请求会回 503 `kb_disabled`；只点 `清除重排模型` 再 `取消`，并断言没有非 GET
// 的设置请求。写路径由 jsdom 用例（web/test/center-models-kb-rerank.test.tsx）覆盖。

import { join } from "node:path";
import { env } from "node:process";
import { expect, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { login, logout } from "./ui-walk-composer.js";
import { expectNoHorizontalOverflow, type WalkProject } from "./ui-walk-layout.js";
import type { AuthOracle } from "./ui-walk-oracle.js";

const BASE_ID = "kb-walk";
const BASE_NAME = "检索演示库";
const QUESTION = "销售额怎么统计";
const IDLE = "输入问题后检索，命中切片会带出所属文档";
const EMPTY = "没有命中，换个说法或先把相关文档入库";
const UNBROKEN = "SALES_REVENUE_RECOGNITION_RULE_0123456789_ABCDEFGHIJ";
const LONG_NAME = "Quarterly_Revenue_Recognition_Policy_And_Refund_Handling_Guide_2026_Final.pdf";

const STATUS_ROUTE = "**/api/kb/status";
const BASES_ROUTE = "**/api/kb/bases";
const DOCUMENTS_ROUTE = "**/api/kb/bases/*/documents";
const RETRIEVAL_ROUTE = "**/api/kb/bases/*/retrieval";
const SETTINGS_ROUTE = "**/api/kb/settings";
const RERANK_NAME = "qwen3-rerank";
const RERANK_URL = "https://rerank-gateway.internal.example/v1/RERANK_UPSTREAM_0123456789";

const STATUS = {
  enabled: true,
  available: true,
  embeddingReady: true,
  compileReady: false,
  uploadMaxBytes: 104_857_600,
  uploadMaxFiles: 10,
};
const RETRIEVAL = { threshold: 0.2, vectorWeight: 0.7 };
const BASE = {
  id: BASE_ID,
  name: BASE_NAME,
  template: "naive",
  raptor: false,
  graph: false,
  state: "ready",
  stateMessage: null,
  documents: 1,
  compile: { raptor: "off", graph: "off" },
  retrieval: RETRIEVAL,
  createdAt: 1_760_000_000_000,
};
// `done`：不触发 3 秒刷新。
const DOCUMENT = {
  id: "doc-walk",
  name: "manual.pdf",
  size: 2048,
  source: "upload",
  workspaceId: null,
  path: null,
  status: "done",
  chunkCount: 3,
  message: null,
  sourceChanged: null,
  createdAt: 1_760_000_000_000,
};
const HITS = [
  {
    documentId: "doc-walk",
    name: "manual.pdf",
    similarity: 0.6789,
    content: `销售额按开票口径统计，退款冲减当月。\n规则编号 ${UNBROKEN}`,
  },
  {
    documentId: "doc-long",
    name: LONG_NAME,
    similarity: 0.5,
    content: "季度汇总在次月五日前完成。",
  },
];

const OK_PROBE = { status: "ok", message: null, at: 1_760_000_123_000 };
// 设置读视图恰为八键（web 解析器的键集；多一个少一个界面都会 requestFailed）。
const SETTINGS = {
  embedding: { name: "bge-m3", baseUrl: "https://embed.example/v1", probe: OK_PROBE },
  chatModelId: null,
  rerank: { name: RERANK_NAME, baseUrl: RERANK_URL, probe: OK_PROBE },
  bases: 0,
  compileBases: 0,
  documents: 0,
  rebuilding: 0,
  rebuildFailed: 0,
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** 检索测试一步：登录、装桩、两次检索、卸桩、退出。 */
export async function walkKbRetrieval(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
): Promise<void> {
  await login(page, oracle, project);
  const bodies: unknown[] = [];
  await page.route(STATUS_ROUTE, (route) => json(route, STATUS));
  await page.route(BASES_ROUTE, (route) =>
    route.request().method() === "GET" ? json(route, { bases: [BASE] }) : route.fallback(),
  );
  await page.route(DOCUMENTS_ROUTE, (route) =>
    route.request().method() === "GET" ? json(route, { documents: [DOCUMENT] }) : route.fallback(),
  );
  await page.route(RETRIEVAL_ROUTE, (route) => {
    bodies.push(route.request().postDataJSON());
    return json(route, { hits: bodies.length === 1 ? HITS : [], retrieval: RETRIEVAL });
  });
  try {
    await page.goto("/center?tab=knowledge-bases");
    const main = page.locator("main");
    await main.getByRole("cell", { name: BASE_NAME, exact: true }).click();
    const detail = main.getByRole("region", { name: `${BASE_NAME} · 文档`, exact: true });
    await expect(detail.getByRole("cell", { name: "manual.pdf", exact: true })).toBeVisible();
    const panel = detail.getByRole("region", { name: "检索测试", exact: true });
    await expect(panel.getByText(IDLE, { exact: true })).toBeVisible();

    await panel.getByRole("textbox", { name: "检索问句" }).fill(QUESTION);
    await panel.getByRole("textbox", { name: "检索问句" }).press("Enter");
    await expectHits(panel);
    await expectNoHorizontalOverflow(page);
    await expectPanelFits(panel);
    await shot(page, panel, `kb-retrieval-${project}-hits`);

    await panel.getByRole("button", { name: "检索", exact: true }).click();
    await expect(panel.getByText(EMPTY, { exact: true })).toBeVisible();
    await expect(panel.getByRole("listitem")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectPanelFits(panel);
    await shot(page, panel, `kb-retrieval-${project}-empty`);

    expect(bodies, "two retrieval requests").toHaveLength(2);
    expect(bodies[0], "first retrieval body").toStrictEqual({ question: QUESTION, ...RETRIEVAL });
  } finally {
    await page.unroute(STATUS_ROUTE);
    await page.unroute(BASES_ROUTE);
    await page.unroute(DOCUMENTS_ROUTE);
    await page.unroute(RETRIEVAL_ROUTE);
  }
  await logout(page, oracle, project);
}

/** 重排模型一行：管理员登录、装桩、看一行与三个按钮、打开清除确认框再取消、卸桩、退出。 */
export async function walkKbRerankRow(
  page: Page,
  oracle: AuthOracle,
  project: WalkProject,
): Promise<void> {
  await login(page, oracle, project, "lisi");
  const writes: string[] = [];
  const onRequest = (request: Request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/kb/settings") &&
      request.method() !== "GET"
    )
      writes.push(`${request.method()} ${request.url()}`);
  };
  page.on("request", onRequest);
  await page.route(STATUS_ROUTE, (route) => json(route, STATUS));
  await page.route(SETTINGS_ROUTE, (route) =>
    route.request().method() === "GET" ? json(route, SETTINGS) : route.fallback(),
  );
  try {
    await page.goto("/center?tab=models");
    // 确认框打开时拷入层 alert-dialog 把 `#root` 标为 aria-hidden：区域要连隐藏的一起找。
    const region = page
      .locator("main")
      .getByRole("region", { name: "知识库模型", exact: true, includeHidden: true });
    const rerank = region.locator("dl").filter({ hasText: "重排模型" });
    await expect(rerank.getByText("重排模型", { exact: true })).toBeVisible();
    await expect(rerank.getByText(RERANK_NAME, { exact: true })).toBeVisible();
    await expect(rerank.getByText(RERANK_URL, { exact: true })).toBeVisible();
    await expect(rerank.getByText("正常", { exact: true })).toBeVisible();
    for (const action of ["编辑", "探活", "清除"]) {
      const button = region.getByRole("button", { name: `${action}重排模型`, exact: true });
      await expect(button).toHaveText(action);
    }
    await expectNoHorizontalOverflow(page);
    await expectPanelFits(region);
    await shot(page, region, `kb-rerank-${project}-row`);

    await region.getByRole("button", { name: "清除重排模型", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "清除重排模型？", exact: true });
    await expect(confirm.getByText("清除后检索不再重排。", { exact: true })).toBeVisible();
    await expect(confirm.getByRole("button", { name: "清除", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectPanelFits(region);
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(rerank.getByText(RERANK_NAME, { exact: true })).toBeVisible();
    expect(writes, "no non-GET kb settings request").toEqual([]);
  } finally {
    page.off("request", onRequest);
    await page.unroute(STATUS_ROUTE);
    await page.unroute(SETTINGS_ROUTE);
  }
  await logout(page, oracle, project);
}

/** 两条命中：`#1`、`#2`、两位小数的相似度、原文保留换行；检索结果里没有「切片」字样。 */
async function expectHits(panel: Locator): Promise<void> {
  const items = panel.getByRole("listitem");
  await expect(items).toHaveCount(2);
  const [first, second] = [items.nth(0), items.nth(1)];
  await expect(first.getByText("#1", { exact: true })).toBeVisible();
  await expect(first.getByText("相似度 0.68", { exact: true })).toBeVisible();
  await expect(second.getByText("#2", { exact: true })).toBeVisible();
  await expect(second.getByText(LONG_NAME, { exact: true })).toBeVisible();
  await expect(second.getByText("相似度 0.50", { exact: true })).toBeVisible();
  const content = first.locator("p");
  await expect(content).toHaveCSS("white-space", "pre-wrap");
  expect(await content.textContent(), "hit content keeps its line break").toBe(HITS[0]?.content);
  await expect(panel.getByText("切片")).toHaveCount(0);
}

/**
 * `expectNoHorizontalOverflow` 只看文档与 `main`，看不到中心页 `overflow-auto` 滚动容器里的溢出：检索测试区域
 * 与它最近的横向可滚动祖先（中心页的滚动容器）各自复核 `scrollWidth <= clientWidth`。
 */
async function expectPanelFits(panel: Locator): Promise<void> {
  const widths = await panel.evaluate((el) => {
    let scroller = el.parentElement;
    while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowX)) {
      scroller = scroller.parentElement;
    }
    return {
      panel: { scroll: el.scrollWidth, client: el.clientWidth },
      scroller: scroller ? { scroll: scroller.scrollWidth, client: scroller.clientWidth } : null,
    };
  });
  expect(widths.panel.scroll, "检索测试 scrollWidth <= clientWidth").toBeLessThanOrEqual(
    widths.panel.client,
  );
  expect(widths.scroller, "center scroll wrapper found").not.toBeNull();
  expect(
    widths.scroller?.scroll,
    "center scroll wrapper scrollWidth <= clientWidth",
  ).toBeLessThanOrEqual(widths.scroller?.client ?? 0);
}

async function shot(page: Page, panel: Locator, file: string) {
  const dir = env.UI_WALK_SHOT_DIR;
  if (!dir) return;
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(dir, `${file}.png`) });
}
