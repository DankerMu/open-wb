import { randomUUID } from "node:crypto";
import {
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
  test,
} from "@playwright/test";

const DEV_ACCOUNT = "zhangsan";
const DEV_PASSWORD = "demo";
const DEV_ROLE = "成员";
const PRODUCTION_SERVICE_NAME = "workbuddy-app-server";
const PRODUCTION_SERVICE_VERSION = "0.0.0";
const THEME_STORAGE_KEY = "workbuddy-theme";
const SESSION_COOKIE = "workbuddy_session";
const ME_PATH = "/api/auth/me";
const UNAUTHORIZED_NETWORK_LOG =
  "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
const WALK_MARKER = "WORKBUDDY_UI_WALK:";
const FIRST_REPLY_PART = "你好，";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const SESSION_ID = /^[0-9a-f]{32}$/;
const SMOKE_FIXTURE = "smoke-fixture";
const WALK_OUT = "walk-out";

const ROUTES = [
  { path: "/", heading: "会话", label: "会话" },
  { path: "/files", heading: "工作空间", label: "工作空间" },
  { path: "/center", heading: "中心", label: "中心" },
  { path: "/settings", heading: "设置", label: "设置" },
] as const;

type AuthPhase = "initial" | "authenticated" | "post-logout-reload";

type AuthOracle = {
  productionOrigin: string;
  page: Page;
  phase: AuthPhase;
  initialUnauthorized: number;
  postLogoutUnauthorized: number;
  expectedConsole: number;
  unexpectedMe: string[];
  unexpectedConsole: string[];
  pageErrors: string[];
};

test.describe.configure({ mode: "serial" });

test("fresh browser journey logs in, walks four routes, persists dark theme, and logs out", async ({
  baseURL,
  page,
}) => {
  await runWithBrowserErrorOracle(page, baseURL, (oracle) => walkProductionOrigin(page, oracle));
});

async function walkProductionOrigin(page: Page, oracle: AuthOracle): Promise<void> {
  await page.goto("/files");
  await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
  await page.getByLabel("账号").fill(DEV_ACCOUNT);
  await page.getByLabel("密码").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expectAuthenticatedRoute(page, "/files", "工作空间", "工作空间");
  await expectPrincipalFooter(page);
  oracle.phase = "authenticated";

  const navigation = page.getByRole("navigation", { name: "主导航" });
  for (const route of ROUTES) {
    await sidebarLink(navigation, route.label).click();
    await expectAuthenticatedRoute(page, route.path, route.heading, route.label);
    await expectPrincipalFooter(page);
  }

  await sidebarLink(navigation, "工作空间").click();
  await expectAuthenticatedRoute(page, "/files", "工作空间", "工作空间");
  await walkFiles(page);

  await sidebarLink(navigation, "会话").click();
  await expectAuthenticatedRoute(page, "/", "会话", "会话");
  await walkHeldDialogue(page);
  await sidebarLink(navigation, "设置").click();
  await expectAuthenticatedRoute(page, "/settings", "设置", "设置");

  await expect(page.getByText(PRODUCTION_SERVICE_NAME, { exact: true })).toBeVisible();
  await expect(page.getByText(`版本 ${PRODUCTION_SERVICE_VERSION}`, { exact: true })).toBeVisible();

  await page.getByRole("radio", { name: "深色", exact: true }).check();
  await expectDarkTheme(page);
  await page.reload();
  await expectAuthenticatedRoute(page, "/settings", "设置", "设置");
  await expectDarkTheme(page);

  await sidebarFooter(page).getByRole("button", { name: "退出登录" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "退出登录？" })).toBeVisible();
  await expect(
    dialog.getByText("退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeVisible();
  await dialog.getByRole("button", { name: "退出" }).click();
  await expectLoggedOutOnSettings(page);
  oracle.phase = "post-logout-reload";
  await page.reload();
  await expectLoggedOutOnSettings(page);
}

async function runWithBrowserErrorOracle(
  page: Page,
  baseURL: string | undefined,
  journey: (oracle: AuthOracle) => Promise<void>,
): Promise<void> {
  const oracle = attachAuthOracle(page, baseURL);
  let journeyError: unknown;
  try {
    await journey(oracle);
  } catch (error) {
    journeyError = error;
  }
  throwCombinedFailure(journeyError, collectOracleFailures(oracle));
}

function attachAuthOracle(page: Page, baseURL: string | undefined): AuthOracle {
  const oracle: AuthOracle = {
    productionOrigin: configuredOrigin(baseURL),
    page,
    phase: "initial",
    initialUnauthorized: 0,
    postLogoutUnauthorized: 0,
    expectedConsole: 0,
    unexpectedMe: [],
    unexpectedConsole: [],
    pageErrors: [],
  };
  page.on("response", (response) => classifyMeResponse(oracle, response));
  page.on("console", (message) => classifyConsoleMessage(oracle, message));
  page.on("pageerror", (error) => {
    oracle.pageErrors.push(`pageerror: ${error.stack ?? error.message}`);
  });
  return oracle;
}

function configuredOrigin(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error("Playwright baseURL is required for origin-bound auth oracle");
  }

  return new URL(baseURL).origin;
}

function classifyMeResponse(oracle: AuthOracle, response: Response): void {
  const url = parseAbsoluteUrl(response.url());
  if (!url || url.pathname !== ME_PATH) {
    return;
  }

  const method = response.request().method();
  const status = response.status();
  if (recordBoundUnauthorizedMe(oracle, url, method, status)) {
    return;
  }
  if (isAllowedAuthenticatedMe(oracle, url, method, status)) {
    return;
  }

  oracle.unexpectedMe.push(
    `${method} ${url.origin}${url.pathname} status=${status} phase=${oracle.phase}`,
  );
}

function recordBoundUnauthorizedMe(
  oracle: AuthOracle,
  url: URL,
  method: string,
  status: number,
): boolean {
  if (!isBoundUnauthorizedMe(oracle, url, method, status)) {
    return false;
  }
  if (oracle.phase === "initial" && oracle.initialUnauthorized === 0) {
    oracle.initialUnauthorized = 1;
    return true;
  }
  if (oracle.phase === "post-logout-reload" && oracle.postLogoutUnauthorized === 0) {
    oracle.postLogoutUnauthorized = 1;
    return true;
  }
  return false;
}

function isBoundUnauthorizedMe(
  oracle: AuthOracle,
  url: URL,
  method: string,
  status: number,
): boolean {
  return method === "GET" && status === 401 && isProductionMeUrl(oracle, url);
}

function isAllowedAuthenticatedMe(
  oracle: AuthOracle,
  url: URL,
  method: string,
  status: number,
): boolean {
  return (
    oracle.phase === "authenticated" &&
    method === "GET" &&
    status === 200 &&
    isProductionMeUrl(oracle, url)
  );
}

function classifyConsoleMessage(oracle: AuthOracle, message: ConsoleMessage): void {
  if (message.type() !== "error") {
    return;
  }

  if (isExpectedUnauthorizedNetworkLog(oracle, message)) {
    oracle.expectedConsole += 1;
    return;
  }

  oracle.unexpectedConsole.push(`console.error: ${message.text()}`);
}

function isExpectedUnauthorizedNetworkLog(oracle: AuthOracle, message: ConsoleMessage): boolean {
  if (message.text() !== UNAUTHORIZED_NETWORK_LOG) {
    return false;
  }

  const url = parseAbsoluteUrl(message.location().url);
  return url !== null && isProductionMeUrl(oracle, url);
}

function isProductionMeUrl(oracle: AuthOracle, url: URL): boolean {
  if (url.origin !== oracle.productionOrigin || url.pathname !== ME_PATH) {
    return false;
  }

  const pageOrigin = pageOriginIfHttp(oracle.page);
  return pageOrigin === null || url.origin === pageOrigin;
}

function pageOriginIfHttp(page: Page): string | null {
  const url = parseAbsoluteUrl(page.url());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return null;
  }

  return url.origin;
}

function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function collectOracleFailures(oracle: AuthOracle): string[] {
  const failures = [
    ...oracle.pageErrors,
    ...oracle.unexpectedMe.map((entry) => `unexpected /api/auth/me: ${entry}`),
    ...oracle.unexpectedConsole,
  ];
  if (oracle.initialUnauthorized !== 1) {
    failures.push(
      `expected exactly one initial GET ${ME_PATH} 401 from ${oracle.productionOrigin}, got ${oracle.initialUnauthorized}`,
    );
  }
  if (oracle.postLogoutUnauthorized !== 1) {
    failures.push(
      `expected exactly one post-logout-reload GET ${ME_PATH} 401 from ${oracle.productionOrigin}, got ${oracle.postLogoutUnauthorized}`,
    );
  }
  const boundUnauthorized = oracle.initialUnauthorized + oracle.postLogoutUnauthorized;
  if (oracle.expectedConsole > boundUnauthorized) {
    failures.push(
      `expected unauthorized console errors ${oracle.expectedConsole} exceed bound /api/auth/me 401 responses ${boundUnauthorized}`,
    );
  }
  return failures;
}

function throwCombinedFailure(journeyError: unknown, captured: string[]): void {
  if (captured.length === 0) {
    if (journeyError !== undefined) {
      throw journeyError;
    }
    return;
  }

  const browserFailure = new Error(`Browser errors:\n${captured.join("\n")}`);
  if (journeyError !== undefined) {
    throw new AggregateError([journeyError, browserFailure], "UI walk failed with browser errors");
  }
  throw browserFailure;
}

async function expectAuthenticatedRoute(
  page: Page,
  path: string,
  heading: string,
  currentLabel: string,
) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const currentLinks = navigation.locator("[aria-current=page]");
  await expect(currentLinks).toHaveCount(1);
  const currentLink = sidebarLink(navigation, currentLabel);
  await expect(currentLink).toHaveAttribute("href", path);
  await expect(currentLink).toHaveAttribute("aria-current", "page");
  if (path === "/files") {
    const workspacePage = page.locator("main");
    await expect(workspacePage.getByRole("button", { name: "选择工作空间" })).toBeVisible();
    await expect(
      workspacePage.getByRole("heading", { level: 2, name: "工作空间目录", exact: true }),
    ).toBeVisible();
  }
}

function sidebarLink(navigation: Locator, label: string) {
  return navigation.getByRole("link", { name: label });
}

function sidebarFooter(page: Page) {
  return page.getByRole("complementary", { name: "侧栏" }).locator("footer");
}

async function expectPrincipalFooter(page: Page) {
  const footer = sidebarFooter(page);
  await expect(footer.getByText(DEV_ACCOUNT, { exact: true })).toBeVisible();
  await expect(footer.getByText(DEV_ROLE, { exact: true })).toBeVisible();
}

async function expectDarkTheme(page: Page) {
  await expect(page.getByRole("radio", { name: "深色", exact: true })).toBeChecked();
  await expect(page.getByText("当前生效：深色", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBe("dark");
}

async function expectLoggedOutOnSettings(page: Page) {
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeVisible();
  await expectSessionCookieAbsent(page);
}

async function expectSessionCookieAbsent(page: Page) {
  const sessionCookies = (await page.context().cookies()).filter(
    (cookie) => cookie.name === SESSION_COOKIE,
  );
  expect(sessionCookies).toEqual([]);
}

async function walkFiles(page: Page): Promise<void> {
  const files = page.locator("main");
  await files.getByRole("button", { name: "选择工作空间" }).click();
  const switcher = files.getByRole("dialog", { name: "工作空间切换器" });
  await expect(switcher.getByRole("button", { name: "＋ 新建工作空间" })).toBeVisible();
  const existing = switcher.getByRole("button").filter({
    has: page.getByText(SMOKE_FIXTURE, { exact: true }),
  });
  if ((await existing.count()) === 0) {
    await switcher.getByRole("button", { name: "＋ 新建工作空间" }).click();
    const createDialog = files.getByRole("dialog", { name: "新建工作空间" });
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel("工作空间名称").fill(SMOKE_FIXTURE);
    await createDialog.getByRole("button", { name: "创建" }).click();
  } else {
    await existing.click();
  }

  const tree = files.getByRole("navigation", { name: "工作空间目录树" });
  await expectRootFileButtons(tree);
  await expect(
    tree.getByRole("button", { name: new RegExp(`^(展开 |折叠 )?${WALK_OUT}$`) }),
  ).toHaveCount(0);

  const preview = files.getByRole("region", { name: "文件预览" });
  await tree.getByRole("button", { name: "readme.md", exact: true }).click();
  await expect(
    preview.getByRole("heading", { level: 1, name: SMOKE_FIXTURE, exact: true }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "查看源码" }).click();
  const sourceRow = preview.getByRole("row").first();
  await expect(sourceRow.getByRole("cell").nth(0)).toHaveText("1");
  await expect(sourceRow.getByRole("cell").nth(1)).toHaveText(`# ${SMOKE_FIXTURE}`);

  await tree.getByRole("button", { name: "notes.csv", exact: true }).click();
  await expect(preview.getByRole("columnheader", { name: "name", exact: true })).toBeVisible();
  await expect(preview.getByRole("columnheader", { name: "value", exact: true })).toBeVisible();
  await expect(preview.getByRole("row")).toHaveCount(3);
  await expect(preview.getByRole("row", { name: "alpha 1" })).toBeVisible();
  await expect(preview.getByRole("row", { name: "beta 2" })).toBeVisible();
  await expect(preview.getByText("共 2 行 · 大文件仅预览前若干行", { exact: true })).toBeVisible();

  await files.getByRole("button", { name: "新建", exact: true }).click();
  await files.getByRole("menuitem", { name: "新建文件夹" }).click();
  const dirDialog = files.getByRole("dialog", { name: "新建文件夹" });
  await dirDialog.getByLabel("位置").selectOption({ label: "根目录　root" });
  await dirDialog.getByLabel("文件夹名称").fill(WALK_OUT);
  await dirDialog.getByRole("button", { name: "创建" }).click();
  await expect(tree.getByRole("button", { name: `展开 ${WALK_OUT}`, exact: true })).toBeVisible();

  await expect.poll(() => workspaceIdFromUrl(page.url())).toMatch(SESSION_ID);
  const workspaceId = workspaceIdFromUrl(page.url());
  await page.reload();
  await expectAuthenticatedRoute(page, "/files", "工作空间", "工作空间");
  await expect.poll(() => workspaceIdFromUrl(page.url())).toBe(workspaceId);
  await expect(
    files.getByRole("button", { name: "选择工作空间" }).getByText(SMOKE_FIXTURE, { exact: true }),
  ).toBeVisible();
  const restored = files.getByRole("navigation", { name: "工作空间目录树" });
  await expectRootFileButtons(restored);
  await expect(
    restored.getByRole("button", { name: `展开 ${WALK_OUT}`, exact: true }),
  ).toBeVisible();
}

async function expectRootFileButtons(tree: Locator) {
  await expect(tree.getByRole("button", { name: "readme.md", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "notes.csv", exact: true })).toBeVisible();
  await expect(tree.getByRole("button", { name: "logo.png", exact: true })).toBeVisible();
}

async function walkHeldDialogue(page: Page): Promise<void> {
  const gateId = randomUUID();
  const prompt = `${WALK_MARKER}${gateId}`;
  const origin = controlOrigin();
  try {
    await armGate(origin, gateId);
    await page.getByRole("button", { name: "新建会话" }).click();
    await expect.poll(() => sessionIdFromUrl(page.url())).toMatch(SESSION_ID);
    const sessionUrl = page.url();
    const sessionId = sessionIdFromUrl(sessionUrl);
    await page.getByLabel("给助手发消息").fill(prompt);
    const promptAccepted = page.waitForResponse(
      (response) =>
        isSessionPath(response.url(), sessionId, "prompt") &&
        response.request().method() === "POST" &&
        response.status() === 202,
    );
    await page.getByRole("button", { name: "发送" }).click();
    const accepted = await promptAccepted;
    const promptIds = parsePromptIds(await accepted.json());
    await expect.poll(() => gatePhase(origin, gateId)).toBe("held");
    const preReload = await fetchSessionSnapshot(page, sessionId);
    expectRunningSnapshot(preReload, prompt, sessionId, promptIds);
    await expectRunningPrefix(page, sessionId, prompt);

    const postReload = watchSessionTraffic(page, sessionId);
    try {
      await page.reload();
      await expect.poll(() => page.url()).toBe(sessionUrl);
      await postReload.waitForNativeOpen();
      const recovery = await postReload.waitForRecoveryAfterNative();
      expectRunningSnapshot(await recovery.json(), prompt, sessionId, promptIds);
      postReload.assertNoMessagesGetInFlight();
      await expectRunningPrefix(page, sessionId, prompt);
      postReload.forbidFurtherMessagesGet();
      await releaseGate(origin, gateId);
      await expectCompletedPair(page, sessionId, prompt);
      postReload.assertNoForbiddenMessagesGet();
    } finally {
      postReload.detach();
    }

    await page.reload();
    await expect.poll(() => page.url()).toBe(sessionUrl);
    await expectCompletedPair(page, sessionId, prompt);
  } finally {
    await deleteGate(origin, gateId);
  }
}

function controlOrigin(): string {
  const base = process.env.MODEL_UPSTREAM_BASE_URL;
  if (base === undefined || base.length === 0) {
    throw new Error("MODEL_UPSTREAM_BASE_URL is required for the UI walk gate");
  }
  return new URL(base).origin;
}

function controlHeaders(): Record<string, string> {
  const apiKey = process.env.MODEL_UPSTREAM_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("MODEL_UPSTREAM_API_KEY is required for the UI walk gate");
  }
  return { authorization: `Bearer ${apiKey}` };
}

function gateUrl(origin: string, id: string, action?: "release"): string {
  const path = action === "release" ? `/__control/gates/${id}/release` : `/__control/gates/${id}`;
  return `${origin}${path}`;
}

async function armGate(origin: string, id: string): Promise<void> {
  const response = await fetch(gateUrl(origin, id), {
    method: "POST",
    headers: controlHeaders(),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`gate arm failed: ${response.status}`);
  }
}

async function releaseGate(origin: string, id: string): Promise<void> {
  const response = await fetch(gateUrl(origin, id, "release"), {
    method: "POST",
    headers: controlHeaders(),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`gate release failed: ${response.status}`);
  }
}

async function deleteGate(origin: string, id: string): Promise<void> {
  try {
    await fetch(gateUrl(origin, id), { method: "DELETE", headers: controlHeaders() });
  } catch {
    /* finally must not hide the journey error */
  }
}

async function gatePhase(origin: string, id: string): Promise<string> {
  const response = await fetch(gateUrl(origin, id), { headers: controlHeaders() });
  if (response.status < 200 || response.status >= 300) {
    return `status:${response.status}`;
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("phase" in body)) {
    return "missing-phase";
  }
  return String(body.phase);
}

function sessionIdFromUrl(url: string): string {
  return new URL(url).searchParams.get("session") ?? "";
}

function workspaceIdFromUrl(url: string): string {
  return new URL(url).searchParams.get("ws") ?? "";
}

function isSessionPath(
  url: string,
  sessionId: string,
  endpoint: "messages" | "prompt" | "events",
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.pathname === `/api/sessions/${sessionId}/${endpoint}`;
}

function watchSessionTraffic(page: Page, sessionId: string) {
  const nativeOpens: Response[] = [];
  const recoveryRequests: Request[] = [];
  const pendingMessages = new Set<Request>();
  let nativeSeen = false;
  let forbidMessages = false;
  let forbiddenMessages = 0;
  const onRequest = (request: Request): void => {
    if (!isSessionPath(request.url(), sessionId, "messages") || request.method() !== "GET") {
      return;
    }
    pendingMessages.add(request);
    if (forbidMessages) {
      forbiddenMessages += 1;
      return;
    }
    if (nativeSeen) {
      recoveryRequests.push(request);
    }
  };
  const onRequestSettled = (request: Request): void => {
    pendingMessages.delete(request);
  };
  const onResponse = (response: Response): void => {
    if (
      response.request().method() === "GET" &&
      isSessionPath(response.url(), sessionId, "events") &&
      /event-stream/iu.test(response.headers()["content-type"] ?? "")
    ) {
      nativeOpens.push(response);
      nativeSeen = true;
    }
  };
  page.on("request", onRequest);
  page.on("requestfinished", onRequestSettled);
  page.on("requestfailed", onRequestSettled);
  page.on("response", onResponse);
  const detach = (): void => {
    page.off("request", onRequest);
    page.off("requestfinished", onRequestSettled);
    page.off("requestfailed", onRequestSettled);
    page.off("response", onResponse);
  };
  return {
    detach,
    async waitForNativeOpen(): Promise<Response> {
      await expect.poll(() => nativeOpens.length).toBeGreaterThan(0);
      const opened = nativeOpens[0];
      if (opened === undefined) {
        throw new Error("missing native event-stream after reload");
      }
      return opened;
    },
    async waitForRecoveryAfterNative(): Promise<Response> {
      await expect.poll(() => recoveryRequests.length).toBeGreaterThan(0);
      const started = recoveryRequests[0];
      if (started === undefined) {
        throw new Error("missing recovery messages GET after native SSE open");
      }
      await expect.poll(async () => (await started.response()) !== null).toBe(true);
      const recovered = await started.response();
      if (recovered === null) {
        throw new Error("recovery messages GET produced no response");
      }
      await recovered.finished();
      return recovered;
    },
    assertNoMessagesGetInFlight(): void {
      expect(pendingMessages.size).toBe(0);
    },
    forbidFurtherMessagesGet(): void {
      forbidMessages = true;
    },
    assertNoForbiddenMessagesGet(): void {
      expect(forbiddenMessages).toBe(0);
    },
  };
}

async function fetchSessionSnapshot(page: Page, sessionId: string): Promise<unknown> {
  const origin = new URL(page.url()).origin;
  const cookie = (await page.context().cookies())
    .filter((entry) => entry.name === SESSION_COOKIE)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
  const response = await fetch(`${origin}/api/sessions/${sessionId}/messages`, {
    headers: cookie.length === 0 ? {} : { cookie },
  });
  if (!response.ok) {
    throw new Error(`pre-reload messages GET failed: ${response.status}`);
  }
  return response.json();
}

function parsePromptIds(body: unknown): { userMessageId: number; assistantMessageId: number } {
  if (body === null || typeof body !== "object") {
    throw new Error("prompt 202 body is not an object");
  }
  if (!("userMessageId" in body) || !("assistantMessageId" in body)) {
    throw new Error("prompt 202 body missing message ids");
  }
  const userMessageId = body.userMessageId;
  const assistantMessageId = body.assistantMessageId;
  if (typeof userMessageId !== "number" || typeof assistantMessageId !== "number") {
    throw new Error("prompt 202 ids are not numbers");
  }
  return { userMessageId, assistantMessageId };
}

function selectedSessionStatus(page: Page) {
  const current = page.locator('nav[aria-label="会话列表"] button[aria-current="true"]');
  return { current, status: current.getByRole("status") };
}

function generatingStatus(page: Page) {
  return page
    .locator("form")
    .getByRole("status")
    .filter({ hasText: /^生成中$/u });
}

interface DialoguePair {
  user: Locator;
  assistant: Locator;
}

async function dialoguePair(page: Page, sessionId: string, prompt: string): Promise<DialoguePair> {
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(sessionId);
  const user = page.getByRole("article", { name: "用户" });
  const assistant = page.getByRole("article", { name: "助手" });
  await expect(user).toHaveCount(1);
  await expect(assistant).toHaveCount(1);
  await expect(user.locator("p").first()).toHaveText(prompt);
  return { user, assistant };
}

async function expectRunningPrefix(page: Page, sessionId: string, prompt: string): Promise<void> {
  const pair = await dialoguePair(page, sessionId, prompt);
  const selected = selectedSessionStatus(page);
  await expect(selected.current).toHaveCount(1);
  await expect(selected.status).toHaveText("running");
  await expect(generatingStatus(page)).toBeVisible();
  await expect
    .poll(async () =>
      (await pair.assistant.locator("p").first().innerText()).startsWith(FIRST_REPLY_PART),
    )
    .toBe(true);
  await expect(pair.assistant.getByRole("region", { name: "bash" })).toBeVisible();
  await expect(
    page
      .getByRole("status", { name: "bash running" })
      .or(page.getByRole("status", { name: "bash done" })),
  ).toBeVisible();
}

function expectRunningSnapshot(
  body: unknown,
  prompt: string,
  sessionId: string,
  ids: { userMessageId: number; assistantMessageId: number },
): void {
  if (body === null || typeof body !== "object") {
    throw new Error("messages snapshot is not an object");
  }
  const session = "session" in body ? body.session : undefined;
  const rawMessages = "messages" in body ? body.messages : undefined;
  if (session === null || typeof session !== "object") {
    throw new Error("snapshot session missing");
  }
  expect("id" in session ? session.id : undefined).toBe(sessionId);
  expect("status" in session ? session.status : undefined).toBe("running");
  if (!Array.isArray(rawMessages)) {
    throw new Error("snapshot has no messages");
  }
  const messages = rawMessages.filter(
    (message): message is Record<string, unknown> =>
      message !== null && typeof message === "object",
  );
  const user = messages.find((message) => message.id === ids.userMessageId);
  const assistant = messages.find((message) => message.id === ids.assistantMessageId);
  expect(user?.role).toBe("user");
  expect(user?.content).toBe(prompt);
  expect(assistant?.role).toBe("assistant");
  expect(typeof assistant?.content).toBe("string");
  expect(String(assistant?.content).startsWith(FIRST_REPLY_PART)).toBe(true);
  expect(assistant?.status).toBe("running");
}

async function expectCompletedPair(page: Page, sessionId: string, prompt: string): Promise<void> {
  const pair = await dialoguePair(page, sessionId, prompt);
  await expect(pair.assistant.locator("p").first()).toHaveText(EXPECTED_REPLY);
  await expect(page.getByRole("status", { name: "bash done" })).toBeVisible();
  const selected = selectedSessionStatus(page);
  await expect(selected.current).toHaveCount(1);
  await expect(selected.status).toHaveText("done");
  await expect(generatingStatus(page)).toHaveCount(0);
}
