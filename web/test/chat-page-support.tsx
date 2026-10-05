import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
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

/**
 * 展开 `root` 内全部收起的工具调用组：步骤默认收在组里，收起时步骤卡不在 DOM 中，断言步骤卡或步骤徽章前先调用。
 */
export function expandToolGroups(root: ParentNode = document) {
  for (const trigger of root.querySelectorAll<HTMLElement>(
    '[data-slot="tool-group-trigger"][aria-expanded="false"]',
  )) {
    fireEvent.click(trigger);
  }
}
