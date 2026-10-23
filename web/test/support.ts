import { screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { ApiError } from "../src/lib/api.js";
import type { ComposerOptions } from "../src/lib/composer-contract.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";

export const authenticatedPrincipal = {
  id: "user-1",
  account: "zhangsan",
  role: "member",
};

export const serviceInfo = {
  name: "workbuddy-app-server",
  version: "0.0.0",
  auth: { provider: "dev-stub" },
};

export type DeferredResponse = {
  promise: Promise<Response>;
  /** 让请求以网络失败告终。 */
  reject(error: Error): void;
  resolve(response: Response): void;
};

type FetchRouteResult = Error | Promise<Response> | Response;
type FetchRouteResolver = (path: string, options?: RequestInit) => FetchRouteResult;
type FetchRoute = FetchRouteResult | FetchRouteResult[] | FetchRouteResolver;
type FetchRoutes = Record<string, FetchRoute>;

export function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function textPreviewResponse(text: string, size = text.length) {
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Workbuddy-Size": String(size),
    },
  });
}

export function unauthorizedResponseCases() {
  return [
    ["a legal", jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401)],
    ["a malformed", jsonResponse({ error: { code: "unauthorized" } }, 401)],
    ["a non-JSON", new Response("private response body", { status: 401 })],
  ] as const;
}

export async function captureApiError(request: Promise<unknown>): Promise<ApiError> {
  return request.then(
    () => {
      throw new Error("expected the API request to reject");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      return error as ApiError;
    },
  );
}

export function expectRequestFailure(error: ApiError, status: number) {
  expect(error).toMatchObject({
    status,
    code: "request_failed",
    message: "请求失败，请稍后重试",
  });
}

/** 会话能力端点的哨兵键：精确键未命中时，`/api/sessions/<id>/capabilities` 回落到它（只有登记了它的表才回落）。 */
export const CAPABILITIES_ROUTE = "/api/sessions/:id/capabilities";
const CAPABILITIES_PATH = /^\/api\/sessions\/[^/]+\/capabilities$/;

function fetchRouteHandler(routes: FetchRoutes) {
  return (path: string, options?: RequestInit) => {
    const route =
      Object.hasOwn(routes, path) || !CAPABILITIES_PATH.test(path)
        ? routes[path]
        : routes[CAPABILITIES_ROUTE];
    const result =
      typeof route === "function"
        ? route(path, options)
        : Array.isArray(route)
          ? route.shift()
          : route;
    if (result === undefined) {
      throw new Error(`unexpected request ${path}`);
    }

    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
}

export function createFetchMock(routes: FetchRoutes) {
  return vi.fn<(path: string, options?: RequestInit) => Promise<Response>>(
    fetchRouteHandler(routes),
  );
}

/**
 * 路由表里 `GET /api/composer/options` 的一项，缺省应答「缺省配置」。共用的整页路由表把它放在用例的
 * `routes` 之前，用例写同一个键即覆盖。应答是 resolver：`Response` 体只能读一次，同一页可能重取。
 */
export function composerOptionsRoute(
  body: ComposerOptions = DEFAULT_COMPOSER_OPTIONS,
): FetchRoutes {
  return { "/api/composer/options": () => jsonResponse(body) };
}

/**
 * 路由表里输入框的两类读取的缺省应答（chat-web「能力读取时机」）：`GET /api/experts` → `{experts: []}`，
 * 任一会话的 `GET /api/sessions/<id>/capabilities`（哨兵键）→ `{expertId: null, disabledSkills: []}`。凡挂载会话页
 * 输入框的整页路由表都与 `composerOptionsRoute()` 并列展开它，用例写同一个键（精确路径或哨兵键）即覆盖。漏登记
 * 同样被 `fetchResponse` 吞掉，所以计数类用例以精确请求清单写出这两类读取。
 */
export function composerReadRoutes(): FetchRoutes {
  return {
    "/api/experts": () => jsonResponse({ experts: [] }),
    [CAPABILITIES_ROUTE]: () => jsonResponse({ expertId: null, disabledSkills: [] }),
  };
}

/**
 * 路由表里中心「专家」tab 的两个缺省应答：`GET /api/experts` → `{experts: []}`，`GET /api/skills` →
 * `{skills: [], disabledSkills: []}`。凡会落到 `/center` 的整页路由表都展开它（写法同 `composerOptionsRoute`），
 * 用例写同一个键即覆盖。漏登记不会以 `unexpected request` 出现：`api.ts` 的 `fetchResponse` 把它吞成
 * `requestFailed(0)`，只表现为面板错误态——所以落到 `/center` 的用例另用 `expectExpertsTabSettled` 正向断言。
 */
export function centerRoutes(): FetchRoutes {
  return {
    "/api/experts": () => jsonResponse({ experts: [] }),
    "/api/skills": () => jsonResponse({ skills: [], disabledSkills: [] }),
  };
}

/** 缺省应答（没有专家）下「专家」面板稳定后显示的文案。 */
const NO_MATCHING_EXPERTS = "没有匹配的专家";

/**
 * 落到 `/center` 的正向判据：`专家` tab 选中，面板已按缺省 `{experts: []}` 稳定（显示 `没有匹配的专家`），
 * 请求里有 `/api/experts`，且 `main` 内没有 `role="alert"`。路由表漏登记时面板显示错误、本断言变红。
 */
export async function expectExpertsTabSettled(fetchMock: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}) {
  const main = await screen.findByRole("main");
  expect(await within(main).findByText(NO_MATCHING_EXPERTS)).toBeTruthy();
  expect(within(main).getByRole("tab", { name: "专家" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(fetchMock.mock.calls.map(([path]) => path)).toContain("/api/experts");
  expect(within(main).queryByRole("alert")).toBeNull();
}

export function allowWorkspaceListFetch() {
  const fetchMock = vi.mocked(fetch);
  const defaultHandler = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path, options) => {
    if (path === "/api/workspaces") {
      return Promise.resolve(jsonResponse({ workspaces: [] }));
    }
    if (path === "/api/sessions") {
      return Promise.resolve(jsonResponse({ sessions: [] }));
    }
    if (path === "/api/composer/options") {
      return Promise.resolve(jsonResponse(DEFAULT_COMPOSER_OPTIONS));
    }
    if (path === "/api/experts") {
      return Promise.resolve(jsonResponse({ experts: [] }));
    }
    if (path === "/api/skills") {
      return Promise.resolve(jsonResponse({ skills: [], disabledSkills: [] }));
    }
    if (CAPABILITIES_PATH.test(String(path))) {
      return Promise.resolve(jsonResponse({ expertId: null, disabledSkills: [] }));
    }
    if (!defaultHandler) {
      throw new Error(`unexpected request ${String(path)}`);
    }

    return defaultHandler(path, options);
  });
}

export type FetchMock = ReturnType<typeof createFetchMock>;

export function replaceFetchRoutes(fetchMock: FetchMock, routes: FetchRoutes) {
  fetchMock.mockImplementation(fetchRouteHandler(routes));
}

type FetchCall = FetchMock["mock"]["calls"][number];

/** 全部请求路径，按调用顺序；断言多重集合时先 sort。 */
export function paths(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls.map(([path]) => path);
}

/** 断言全部请求路径的多重集合（与顺序无关，但约束总量，杂散请求会使其失败）。 */
export function expectPaths(fetchMock: FetchMock, expected: readonly string[]) {
  expect(paths(fetchMock).sort()).toEqual([...expected].sort());
}

/** 按路径筛出的请求，按调用顺序。 */
export function calls(fetchMock: FetchMock, path: string): FetchCall[] {
  return fetchMock.mock.calls.filter(([calledPath]) => calledPath === path);
}

export function lastCall(fetchMock: FetchMock, path: string): FetchCall {
  const request = calls(fetchMock, path).at(-1);
  if (!request) {
    throw new Error(`expected a ${path} request`);
  }

  return request;
}

export async function requestOptionsAt(fetchMock: FetchMock, callIndex: number) {
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(callIndex + 1);
  });
  const request = fetchMock.mock.calls[callIndex];
  if (!request) {
    throw new Error(`expected fetch call ${callIndex + 1}`);
  }

  return request[1];
}

export function setBrowserPath(path: string) {
  window.history.replaceState(null, "", path);
}

export function currentLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
