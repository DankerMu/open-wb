import { waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { ApiError } from "../src/lib/api.js";

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
  resolve(response: Response): void;
};

type FetchRouteResult = Error | Promise<Response> | Response;
type FetchRouteResolver = (path: string, options?: RequestInit) => FetchRouteResult;
type FetchRoute = FetchRouteResult | FetchRouteResult[] | FetchRouteResolver;
type FetchRoutes = Record<string, FetchRoute>;

export function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

function fetchRouteHandler(routes: FetchRoutes) {
  return (path: string, options?: RequestInit) => {
    const route = routes[path];
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
