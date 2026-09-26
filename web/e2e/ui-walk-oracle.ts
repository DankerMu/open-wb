// Browser error oracle for the UI walk: exact /api/auth/me 401 accounting plus console/page errors,
// and (when enabled) static-asset requestfailed and cross-origin request accounting.

import type { ConsoleMessage, Page, Request, Response } from "@playwright/test";

const ME_PATH = "/api/auth/me";
const UNAUTHORIZED_NETWORK_LOG =
  "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
const STATIC_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "script"]);
// 导航与 SSE 取消产生的中止不是资源缺失。
const ABORTED = "net::ERR_ABORTED";

type AuthPhase = "initial" | "authenticated" | "post-logout-reload";

export type AuthOracle = {
  productionOrigin: string;
  page: Page;
  phase: AuthPhase;
  initialUnauthorized: number;
  postLogoutUnauthorized: number;
  expectedConsole: number;
  unexpectedMe: string[];
  unexpectedConsole: string[];
  pageErrors: string[];
  failedAssets: string[];
  foreignRequests: string[];
};

/** The inputs the /api/auth/me origin binding needs: the baseURL origin and the page under test. */
export type OriginBinding = Pick<AuthOracle, "productionOrigin" | "page">;

export type OracleOptions = {
  /** Account static-asset requestfailed and non-baseURL-origin requests from the first goto. */
  watchAssets: boolean;
};

export async function runWithBrowserErrorOracle(
  page: Page,
  baseURL: string | undefined,
  options: OracleOptions,
  journey: (oracle: AuthOracle) => Promise<void>,
): Promise<void> {
  const oracle = attachAuthOracle(page, baseURL);
  if (options.watchAssets) attachAssetOracle(oracle);
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
    failedAssets: [],
    foreignRequests: [],
  };
  page.on("response", (response) => classifyMeResponse(oracle, response));
  page.on("console", (message) => classifyConsoleMessage(oracle, message));
  page.on("pageerror", (error) => {
    oracle.pageErrors.push(`pageerror: ${error.stack ?? error.message}`);
  });
  return oracle;
}

function attachAssetOracle(oracle: AuthOracle): void {
  oracle.page.on("requestfailed", (request) => classifyFailedRequest(oracle, request));
  oracle.page.on("request", (request) => classifyRequestOrigin(oracle, request));
}

function classifyFailedRequest(oracle: AuthOracle, request: Request): void {
  const errorText = request.failure()?.errorText ?? "unknown";
  if (!STATIC_RESOURCE_TYPES.has(request.resourceType()) || errorText === ABORTED) {
    return;
  }
  oracle.failedAssets.push(`${request.resourceType()} ${request.url()} ${errorText}`);
}

function classifyRequestOrigin(oracle: AuthOracle, request: Request): void {
  const url = parseAbsoluteUrl(request.url());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return;
  }
  if (url.origin !== oracle.productionOrigin) {
    oracle.foreignRequests.push(`${request.method()} ${request.resourceType()} ${url.href}`);
  }
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

/** The single Chromium network log a bound GET /api/auth/me 401 produces; reused by the pre-paint check. */
export function isExpectedUnauthorizedNetworkLog(
  oracle: OriginBinding,
  message: ConsoleMessage,
): boolean {
  if (message.text() !== UNAUTHORIZED_NETWORK_LOG) {
    return false;
  }

  const url = parseAbsoluteUrl(message.location().url);
  return url !== null && isProductionMeUrl(oracle, url);
}

function isProductionMeUrl(oracle: OriginBinding, url: URL): boolean {
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
    ...oracle.failedAssets.map((entry) => `static asset requestfailed: ${entry}`),
    ...oracle.foreignRequests.map(
      (entry) => `cross-origin request (baseURL ${oracle.productionOrigin}): ${entry}`,
    ),
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
