// ui-shots：app 与 demo 的截图对（6 格 × 5 态 × 2 源 = 60 张 PNG + index.html），供 S1e 人工签收。
// 只消费 caller 已启动的服务与仓库内 demo：不 build/start/stop 服务、不下载浏览器、不清理 caller 状态。

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium, request } from "@playwright/test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const REPO_FILE_PATH = pathToFileURL(REPO_ROOT).pathname;
const DEMO_URL = pathToFileURL(join(REPO_ROOT, "resource", "workbuddy-live-demo.html")).href;
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const HOME_DIR = homedir();

const ACCOUNT = "zhangsan";
const PASSWORD = "demo";
const SMOKE_FIXTURE = "smoke-fixture";
const CHAT_PROMPT = "请用一句话介绍你自己";
const APP_THEME_KEY = "workbuddy-theme"; // web/src/features/theme/provider.tsx:20
const ME_PATH = "/api/auth/me";
const UNAUTHORIZED_NETWORK_LOG =
  "Failed to load resource: the server responded with a status of 401 (Unauthorized)";

const ACTION_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CHAT_DONE_TIMEOUT_MS = 60_000;
const APP_TOAST_TIMEOUT_MS = 10_000;
const DEMO_TOAST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const NARROW_MAX_WIDTH = 760;

// demo 常量，行号指 resource/workbuddy-live-demo.html。
const DEMO = {
  themeKey: "wb-demo-theme", // Theme.get/set :1035-1039
  quickLogin: '[data-quick="zhangsan"]', // u1 :1401，快捷登录 :1736、:1748-1749
  // u1 首个 status:'done' 会话 :1447；c2 属 u3，openConversation 拒绝 :2053-2058。
  conversationId: "c5",
  conversationTitle: "内部工具使用情况投票页", // c5 标题 :1447，顶栏 .crumbs b :1941
  // u1 首个工作空间 w1 :1414 → 挂载 r1 :1519；首个 .md 在 out/ 下 :1531-1532。
  outDir: "/data/workbuddy/zhangsan/workbuddy-demo/out",
  readmeFile: "/data/workbuddy/zhangsan/workbuddy-demo/out/周报-第31周.md",
  readmeName: "周报-第31周.md",
  collapse: '[data-action="collapse"]', // :1812；≤760 侧栏为浮层 :307-309
  settingsBody: '[data-od-id="settings-body"]', // :3536
};

const CELLS = [
  { width: 1440, height: 900, theme: "light" },
  { width: 1440, height: 900, theme: "dark" },
  { width: 1024, height: 768, theme: "light" },
  { width: 1024, height: 768, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
];
const STATES = ["login-default", "chat-welcome", "chat-done", "files-readme", "settings-default"];
const SOURCES = ["demo", "app"];

// 泄漏断言的禁止串；预检后填入，脱敏同样使用（长的在前，避免前缀先被替换）。
const workspaceRoots = [];

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(text) {
  let out = String(text);
  for (const root of workspaceRoots) out = out.replaceAll(root, "<workspace-root>");
  out = out.replaceAll(REPO_FILE_PATH, "<repo>").replaceAll(REPO_ROOT, "<repo>");
  // 家目录最后替换（仓库常位于其下，长前缀先生效）；空串或 "/" 不替换。
  return HOME_DIR.length > 1 ? out.replaceAll(HOME_DIR, "~") : out;
}

function firstLine(text) {
  return text.split("\n", 1)[0] ?? "";
}

function cellLabel(cell) {
  return `${cell.width}-${cell.theme}`;
}

function shotName(source, state, cell) {
  return `${source}-${state}-${cellLabel(cell)}.png`;
}

function utcStamp() {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;
}

function displayPath(target) {
  const rel = relative(REPO_ROOT, target);
  if (rel === "") return "./";
  if (isAbsolute(rel) || rel.split(sep)[0] === "..") return redact(`${target}${sep}`);
  return `${rel}${sep}`;
}

function resolveBaseUrl() {
  const raw = env.UI_SHOTS_BASE_URL || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`UI_SHOTS_BASE_URL 不是合法 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`UI_SHOTS_BASE_URL 只接受 http/https：${raw}`);
  }
  return url.origin;
}

// 相对路径以仓库根解析：npm workspace 的 cwd 是 web/，Make 的 cwd 是仓库根。
function resolveOutDir() {
  const raw = env.UI_SHOTS_OUT;
  if (raw) return resolve(REPO_ROOT, raw);
  return join(REPO_ROOT, "var", "ui-shots", utcStamp());
}

// ---------- 预检（D3） ----------

async function checkHealth(api) {
  let response;
  try {
    response = await api.get("/api/healthz");
  } catch (error) {
    throw new Error(`预检失败：GET /api/healthz 不可达：${messageOf(error)}`);
  }
  if (response.status() !== 200) {
    throw new Error(`预检失败：GET /api/healthz 返回 ${response.status()}`);
  }
}

async function expectOk(response, what) {
  if (!response.ok()) throw new Error(`预检失败：${what} 返回 ${response.status()}`);
  return response;
}

async function listWorkspaces(api) {
  const response = await expectOk(await api.get("/api/workspaces"), "GET /api/workspaces");
  const body = await response.json();
  const list = body !== null && typeof body === "object" ? body.workspaces : undefined;
  if (!Array.isArray(list)) throw new Error("预检失败：GET /api/workspaces 缺 workspaces 数组");
  return list.filter((item) => item !== null && typeof item === "object");
}

async function ensureSmokeFixture(api) {
  let list = await listWorkspaces(api);
  if (!list.some((item) => item.name === SMOKE_FIXTURE)) {
    const created = await api.post("/api/workspaces", { data: { name: SMOKE_FIXTURE } });
    await expectOk(created, "POST /api/workspaces");
    list = await listWorkspaces(api);
  }
  const fixture = list.find((item) => item.name === SMOKE_FIXTURE);
  if (!fixture || typeof fixture.id !== "string") {
    throw new Error(`预检失败：未能取得 ${SMOKE_FIXTURE} 工作空间`);
  }
  const roots = list.map((item) => item.root).filter((root) => typeof root === "string" && root);
  return { smokeId: fixture.id, roots };
}

async function withApi(baseUrl, task) {
  const api = await request.newContext({ baseURL: baseUrl, timeout: REQUEST_TIMEOUT_MS });
  try {
    return await task(api);
  } finally {
    await api.dispose();
  }
}

async function loginAndFixture(api) {
  const login = await api.post("/api/auth/login", {
    data: { account: ACCOUNT, password: PASSWORD },
  });
  await expectOk(login, "POST /api/auth/login");
  return await ensureSmokeFixture(api);
}

// 写 caller DB 的步骤（登录建会话、按需建 smoke-fixture）在浏览器启动、输出目录创建都成功之后才做。
async function prepareRun(baseUrl, outDir) {
  await mkdir(outDir, { recursive: true });
  const fixture = await withApi(baseUrl, loginAndFixture);
  workspaceRoots.push(...fixture.roots.sort((a, b) => b.length - a.length));
  return {
    baseUrl,
    outDir,
    smokeId: fixture.smokeId,
    session: { attempted: false, id: "", reason: "首格未执行" },
    results: new Map(),
  };
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    throw new Error(`浏览器启动失败（不重试、不下载）：${messageOf(error)}`);
  }
}

// ---------- 等待工具 ----------

async function pollUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

function visible(locator, timeout) {
  return locator.waitFor({ state: "visible", timeout });
}

function waitTheme(page, theme) {
  return page.locator(`html[data-theme="${theme}"]`).waitFor({ state: "attached" });
}

function waitToastQuiet(page, source) {
  if (source === "app") {
    const toasts = page.locator(".ui-toast");
    return pollUntil(async () => (await toasts.count()) === 0, APP_TOAST_TIMEOUT_MS, "toast 清空");
  }
  const toasts = page.locator("#toast-root > *");
  return pollUntil(async () => (await toasts.count()) === 0, DEMO_TOAST_TIMEOUT_MS, "toast 清空");
}

function sessionFromUrl(url) {
  return new URL(url).searchParams.get("session") ?? "";
}

// ---------- app 态（D5） ----------

async function appLogin(page, _run, cell) {
  await page.goto("/");
  await visible(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" }));
  await waitTheme(page, cell.theme);
}

async function appWelcome(page, _run, _cell, tracker) {
  await page.getByLabel("账号").fill(ACCOUNT);
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await visible(page.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你", exact: true }));
  tracker.authenticated = true;
  const url = new URL(page.url());
  if (url.pathname !== "/" || url.searchParams.has("session")) {
    throw new Error(`chat-welcome 期望 / 且无 session 参数，实际 ${url.pathname}${url.search}`);
  }
  await visible(page.getByRole("main"));
}

async function waitDoneConversation(page) {
  await visible(page.getByRole("article", { name: "助手" }));
  const generating = page
    .locator("form")
    .getByRole("status")
    .filter({ hasText: /^生成中$/u });
  await pollUntil(async () => (await generating.count()) === 0, ACTION_TIMEOUT_MS, "生成中 消失");
}

async function createDoneSession(page) {
  await page.getByRole("button", { name: "新建会话" }).click();
  await pollUntil(() => sessionFromUrl(page.url()) !== "", ACTION_TIMEOUT_MS, "URL 出现 session");
  const sessionId = sessionFromUrl(page.url());
  const input = page.getByLabel("给助手发消息");
  await input.fill(CHAT_PROMPT);
  await input.press("Enter");
  const status = page
    .locator('nav[aria-label="会话列表"] button[aria-current="true"]')
    .getByRole("status");
  await visible(status.filter({ hasText: /^(已完成|失败)$/u }), CHAT_DONE_TIMEOUT_MS);
  const text = await status.textContent();
  if (text !== "已完成") throw new Error(`chat-done 回合结束状态为 ${text}`);
  await waitDoneConversation(page);
  return sessionId;
}

// 首格（1440-light）真实跑一回合并记下 id；其余格复用该会话。
async function appChatDone(page, run) {
  const session = run.session;
  if (!session.attempted) {
    session.attempted = true;
    try {
      session.id = await createDoneSession(page);
    } catch (error) {
      session.reason = firstLine(redact(messageOf(error)));
      throw error;
    }
    return;
  }
  if (!session.id)
    throw new Error(`依赖首格（1440-light）的 chat-done 会话未就绪：${session.reason}`);
  await page.goto(`/?session=${encodeURIComponent(session.id)}`);
  await waitDoneConversation(page);
}

async function appFiles(page, run) {
  await page.goto(`/files?ws=${encodeURIComponent(run.smokeId)}`);
  const tree = page.getByRole("navigation", { name: "工作空间目录树" });
  await tree.getByRole("button", { name: "readme.md", exact: true }).click();
  const preview = page.getByRole("region", { name: "文件预览" });
  await visible(preview.getByRole("heading", { level: 1, name: SMOKE_FIXTURE, exact: true }));
}

async function appSettings(page) {
  await page.goto("/settings");
  await visible(page.getByRole("heading", { level: 1, name: "设置", exact: true }));
}

// ---------- demo 态（D6） ----------

async function demoLogin(page, _run, cell) {
  await page.goto(DEMO_URL);
  await visible(page.locator(DEMO.quickLogin));
  await waitTheme(page, cell.theme);
}

async function demoWelcome(page, _run, cell) {
  await page.locator(DEMO.quickLogin).click();
  await page.locator("#login-root").waitFor({ state: "hidden" });
  await visible(page.locator("#page-root > *").first());
  if (cell.width > NARROW_MAX_WIDTH) return;
  // 窄屏：与 app "导航覆盖层默认关闭" 同构，折叠一次浮层侧栏；状态存于 demo 内存，后续态沿用。
  await waitToastQuiet(page, "demo");
  await page.locator(DEMO.collapse).click();
  await page.locator(".sidebar.collapsed").waitFor({ state: "attached" });
}

async function demoChatDone(page) {
  await page.evaluate((id) => window.openConversation(id), DEMO.conversationId);
  await visible(page.locator(".crumbs").getByText(DEMO.conversationTitle, { exact: true }));
}

async function demoFiles(page) {
  await page.evaluate(() => {
    location.hash = "/files";
  });
  await visible(page.locator(".fs-layout"));
  const file = page.locator(`[data-file="${DEMO.readmeFile}"]`);
  if ((await file.count()) === 0) await page.locator(`[data-dir="${DEMO.outDir}"]`).click();
  await file.click();
  await visible(page.locator(".fs-preview", { hasText: DEMO.readmeName }));
}

async function demoSettings(page) {
  await page.evaluate(() => {
    location.hash = "/settings";
  });
  await visible(page.locator(DEMO.settingsBody));
}

const STEPS = {
  app: {
    "login-default": appLogin,
    "chat-welcome": appWelcome,
    "chat-done": appChatDone,
    "files-readme": appFiles,
    "settings-default": appSettings,
  },
  demo: {
    "login-default": demoLogin,
    "chat-welcome": demoWelcome,
    "chat-done": demoChatDone,
    "files-readme": demoFiles,
    "settings-default": demoSettings,
  },
};

// ---------- app 断言（D8） ----------

function probeOverflow() {
  const failures = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth) {
    failures.push(`document 横向溢出（scrollWidth ${doc.scrollWidth} > innerWidth ${innerWidth}）`);
  }
  const main = document.querySelector("main");
  if (main && main.scrollWidth > main.clientWidth) {
    failures.push(
      `main 横向溢出（scrollWidth ${main.scrollWidth} > clientWidth ${main.clientWidth}）`,
    );
  }
  return failures;
}

// 只返回命中位置，不返回命中值。
function probeRootLeaks(forbidden) {
  const hits = new Set();
  const leaks = (value) => forbidden.some((root) => value.includes(root));
  if (leaks(document.title)) hits.add("document.title");
  if (leaks(document.body?.textContent ?? "")) hits.add("DOM 文本");
  for (const element of document.querySelectorAll("*")) {
    for (const attr of element.attributes) {
      const watched = attr.name === "title" || attr.name.startsWith("aria-");
      if (watched && leaks(attr.value)) hits.add(`<${element.localName}> ${attr.name} 属性`);
    }
  }
  return [...hits];
}

async function assertAppDom(page) {
  const overflow = await page.evaluate(probeOverflow);
  const leaks = await page.evaluate(probeRootLeaks, workspaceRoots);
  const problems = [...overflow, ...leaks.map((where) => `workspace root 绝对路径出现在 ${where}`)];
  if (problems.length > 0) throw new Error(`断言失败：${problems.join("；")}`);
}

// ---------- console / pageerror（D9） ----------

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isBaseMeUrl(value, origin) {
  const url = parseUrl(value);
  return url !== null && url.origin === origin && url.pathname === ME_PATH;
}

function countUnauthorizedMe(tracker, response, origin) {
  if (tracker.authenticated || response.status() !== 401) return;
  if (response.request().method() !== "GET" || !isBaseMeUrl(response.url(), origin)) return;
  tracker.me401 += 1;
}

function recordError(tracker, text) {
  const list = tracker.errors.get(tracker.state) ?? [];
  list.push(text);
  tracker.errors.set(tracker.state, list);
}

function onConsole(tracker, message, origin) {
  if (message.type() !== "error") return;
  const exemptable =
    origin !== null &&
    message.text() === UNAUTHORIZED_NETWORK_LOG &&
    isBaseMeUrl(message.location().url, origin);
  if (exemptable) {
    tracker.meConsoleStates.push(tracker.state);
    return;
  }
  recordError(tracker, `console.error: ${message.text()}`);
}

function attachErrorTracker(page, source, baseUrl) {
  const origin = source === "app" ? baseUrl : null;
  const tracker = {
    state: STATES[0],
    authenticated: false,
    me401: 0,
    meConsoleStates: [],
    errors: new Map(),
  };
  page.on("pageerror", (error) => recordError(tracker, `pageerror: ${error.message}`));
  page.on("console", (message) => onConsole(tracker, message, origin));
  if (origin !== null) page.on("response", (res) => countUnauthorizedMe(tracker, res, origin));
  return tracker;
}

// 豁免条数不超过未登录阶段观察到的 401 响应数；超出部分归到其发生时的态。
function trackerErrorsFor(tracker, state) {
  const excess = tracker.meConsoleStates
    .slice(tracker.me401)
    .filter((s) => s === state)
    .map(
      () => `console.error: ${ME_PATH} 401 资源错误超出未登录阶段 401 响应数（${tracker.me401}）`,
    );
  return [...(tracker.errors.get(state) ?? []), ...excess];
}

// ---------- 矩阵执行（D4/D7/D10） ----------

function newResult(source, state, cell) {
  return { cell, source, state, file: shotName(source, state, cell), shot: false, reasons: [] };
}

async function runState(page, tracker, run, cell, source, state) {
  tracker.state = state;
  const result = newResult(source, state, cell);
  try {
    await STEPS[source][state](page, run, cell, tracker);
    await waitToastQuiet(page, source);
    if (source === "app") await assertAppDom(page);
    await page.screenshot({ path: join(run.outDir, result.file), fullPage: false });
    result.shot = true;
  } catch (error) {
    result.reasons.push(`${cellLabel(cell)} ${source} ${state}：${messageOf(error)}`);
  }
  return result;
}

async function openContext(browser, run, cell, source) {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    colorScheme: cell.theme,
    reducedMotion: "reduce",
    baseURL: source === "app" ? run.baseUrl : undefined,
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const key = source === "app" ? APP_THEME_KEY : DEMO.themeKey;
  // about:blank 无可用 localStorage，只在真实文档里预置主题。
  await context.addInitScript(
    (seed) => {
      if (location.protocol === "about:") return;
      localStorage.setItem(seed.key, seed.value);
    },
    { key, value: cell.theme },
  );
  return context;
}

// 上下文级失败：未执行的态逐个记失败；全部态已执行（如关闭失败）则记到最后一态。
function markContextFailure(results, cell, source, error) {
  const reason = `${cellLabel(cell)} ${source} 上下文失败：${messageOf(error)}`;
  if (results.length === STATES.length) {
    results.at(-1)?.reasons.push(reason);
    return;
  }
  for (const state of STATES.slice(results.length)) {
    const result = newResult(source, state, cell);
    result.reasons.push(reason);
    results.push(result);
  }
}

async function runSource(browser, run, cell, source) {
  let context;
  let tracker;
  const results = [];
  try {
    context = await openContext(browser, run, cell, source);
    const page = await context.newPage();
    tracker = attachErrorTracker(page, source, run.baseUrl);
    for (const state of STATES) {
      results.push(await runState(page, tracker, run, cell, source, state));
    }
    const closing = context;
    context = undefined;
    await closing.close();
  } catch (error) {
    markContextFailure(results, cell, source, error);
  } finally {
    // 只在已记失败的路径上仍打开；关闭失败不再覆盖已记录的原因。
    await context?.close().catch(() => undefined);
  }
  // 关闭（无论成败）后再归并，迟到的 console/pageerror 也计入其发生时的态。
  if (tracker) {
    for (const result of results) result.reasons.push(...trackerErrorsFor(tracker, result.state));
  }
  return results;
}

function printResult(result) {
  if (result.reasons.length === 0) {
    console.log(`ok   ${result.file}`);
    return;
  }
  console.log(`FAIL ${result.file}${result.shot ? "（截图已保留）" : "（未截图）"}`);
  for (const reason of result.reasons) console.log(`     ${redact(reason)}`);
}

async function runMatrix(browser, run) {
  for (const cell of CELLS) {
    for (const source of SOURCES) {
      const results = await runSource(browser, run, cell, source);
      for (const result of results) {
        run.results.set(result.file, result);
        printResult(result);
      }
    }
  }
}

// ---------- index.html（D11） ----------

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return Array.from(String(text), (ch) => HTML_ESCAPES[ch] ?? ch).join("");
}

function summarize(result) {
  return result.reasons.map((reason) => escapeHtml(firstLine(redact(reason)).slice(0, 400)));
}

function renderCell(result) {
  const reasons = result ? summarize(result) : ["未执行"];
  const notes = reasons.map((reason) => `<p class="reason">${reason}</p>`).join("");
  const file = escapeHtml(result?.file ?? "");
  const caption = `<figcaption>${escapeHtml(result?.state ?? "")} · ${file}</figcaption>`;
  if (result?.shot) {
    const failed = reasons.length > 0 ? '<p class="bad">失败（截图保留）</p>' : "";
    return `<td><figure><img src="${file}" alt="${file}" loading="lazy">${caption}</figure>${failed}${notes}</td>`;
  }
  return `<td><figure><div class="missing">缺失</div>${caption}</figure>${notes}</td>`;
}

function renderSection(run, cell) {
  const rows = STATES.map((state) => {
    const demo = run.results.get(shotName("demo", state, cell));
    const app = run.results.get(shotName("app", state, cell));
    return `<tr>${renderCell(demo)}${renderCell(app)}</tr>`;
  }).join("\n");
  return [
    `<section><h2>${cell.width}×${cell.height} · ${cell.theme}</h2>`,
    "<table><thead><tr><th>demo</th><th>app</th></tr></thead>",
    `<tbody>\n${rows}\n</tbody></table></section>`,
  ].join("\n");
}

const INDEX_STYLE = [
  "body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1f2329;background:#fff}",
  "table{width:100%;table-layout:fixed;border-collapse:collapse;margin-bottom:32px}",
  "th,td{width:50%;vertical-align:top;border:1px solid #d0d3d6;padding:8px}",
  "figure{margin:0}img{max-width:100%;height:auto;border:1px solid #e3e5e7}",
  "figcaption{color:#646a73;font-size:12px}",
  ".missing{padding:48px 0;text-align:center;background:#fdecec;color:#b42318;font-weight:600}",
  ".bad,.reason{color:#b42318;font-size:12px;margin:4px 0;word-break:break-all}",
].join("\n");

async function writeIndex(run) {
  const sections = CELLS.map((cell) => renderSection(run, cell)).join("\n");
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>ui-shots 对照</title>',
    `<style>\n${INDEX_STYLE}\n</style></head><body>`,
    "<h1>ui-shots 对照（左 demo，右 app）</h1>",
    sections,
    "</body></html>",
    "",
  ].join("\n");
  await writeFile(join(run.outDir, "index.html"), html);
}

// ---------- 入口 ----------

function reportSummary(run) {
  const results = [...run.results.values()];
  const failed = results.filter((result) => result.reasons.length > 0);
  const expected = CELLS.length * STATES.length * SOURCES.length;
  const shots = results.filter((result) => result.shot).length;
  console.log(
    `ui-shots: 截图 ${shots}/${expected}，失败 ${failed.length + expected - results.length}`,
  );
  for (const result of failed) console.log(`  FAIL ${result.file}`);
  console.log(`ui-shots: 输出目录 ${displayPath(run.outDir)}`);
  if (failed.length > 0 || results.length !== expected || shots !== expected) process.exitCode = 1;
}

// 矩阵、index.html、关闭浏览器逐步都执行；保留最先出现的错误，汇总后再抛出。
async function runAndFinish(browser, run) {
  let failure;
  try {
    await runMatrix(browser, run);
  } catch (error) {
    failure = error;
  }
  try {
    await writeIndex(run);
  } catch (error) {
    failure ??= error;
  }
  await browser.close().catch((error) => {
    failure ??= error;
  });
  reportSummary(run);
  if (failure !== undefined) throw failure;
}

async function main() {
  const baseUrl = resolveBaseUrl();
  const outDir = resolveOutDir();
  console.log(`ui-shots: 输出目录 ${displayPath(outDir)}`);
  await withApi(baseUrl, checkHealth);
  const browser = await launchBrowser();
  let run;
  try {
    run = await prepareRun(baseUrl, outDir);
  } catch (error) {
    // 建目录/登录/fixture 失败（D3）：关闭浏览器、非零、不写 index.html（已建的空目录保留）。
    await browser.close().catch(() => undefined);
    throw error;
  }
  await runAndFinish(browser, run);
}

main().catch((error) => {
  console.error(`ui-shots: ${redact(messageOf(error))}`);
  process.exitCode = 1;
});
