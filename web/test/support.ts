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
};

export type DeferredResponse = {
  promise: Promise<Response>;
  resolve(response: Response): void;
};

type FetchRouteResult = Error | Promise<Response> | Response;
type FetchRoute = FetchRouteResult | FetchRouteResult[];
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
  return (path: string) => {
    const route = routes[path];
    const result = Array.isArray(route) ? route.shift() : route;
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

export type FetchMock = ReturnType<typeof createFetchMock>;

export function replaceFetchRoutes(fetchMock: FetchMock, routes: FetchRoutes) {
  fetchMock.mockImplementation(fetchRouteHandler(routes));
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
