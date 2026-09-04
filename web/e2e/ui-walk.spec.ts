import {
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
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
