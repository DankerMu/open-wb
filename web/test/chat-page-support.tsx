import { cleanup, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  currentLocation,
  jsonResponse,
  setBrowserPath,
} from "./support.js";

export type FetchRoutes = Parameters<typeof createFetchMock>[0];

let disposeRouter: (() => void) | undefined;

function authenticatedChatRoutes(routes: FetchRoutes = {}): FetchRoutes {
  return {
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    ...routes,
  };
}

export function renderChatPage(path: string, routes: FetchRoutes, strict = false) {
  disposeRouter?.();
  resetFakeEventSources();
  const fetchMock = createFetchMock(authenticatedChatRoutes(routes));
  vi.stubGlobal("EventSource", FakeEventSource);
  const mounted = mountAuthenticatedApp(path, fetchMock, strict);
  disposeRouter = () => mounted.router.dispose();
  return mounted;
}

export async function expectChatLocation(expected: string) {
  await waitFor(() => {
    expect(currentLocation()).toBe(expected);
  });
}

export function cleanupChatPage() {
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  vi.unstubAllGlobals();
  resetFakeEventSources();
  document.body.replaceChildren();
  setBrowserPath("/");
}
