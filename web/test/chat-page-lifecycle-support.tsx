import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { Profiler } from "react";
import { createBrowserRouter, RouterProvider, useLocation } from "react-router";
import { expect, vi } from "vitest";
import { AuthFooter, AuthGuard, AuthProvider, useAuth } from "../src/features/auth/index.js";
import { ChatPage } from "../src/features/chat/index.js";
import type { LoginCredentials, Principal } from "../src/lib/api.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { cleanupChatPage } from "./chat-page-support.js";
import { FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  jsonResponse,
  setBrowserPath,
} from "./support.js";

export type ChatAuthProbe = {
  login(credentials: LoginCredentials): Promise<boolean>;
  principal: Principal | null;
  status: "loading" | "authenticated" | "unauthenticated";
};

const secondPrincipal: Principal = {
  id: "user-2",
  account: "lisi",
  role: "member",
};

let disposeExtraRouter: (() => void) | undefined;

function ChatAuthProbe({ onState }: { onState(state: ChatAuthProbe): void }) {
  const auth = useAuth();
  onState({
    login: auth.login,
    principal: auth.principal,
    status: auth.status,
  });
  return null;
}

function ObservedChatPage({ onCommit }: { onCommit: (html: string, location: string) => void }) {
  const location = useLocation();
  const committedLocation = `${location.pathname}${location.search}${location.hash}`;
  return (
    <Profiler
      id="chat-page-lifecycle"
      onRender={() => {
        onCommit(document.body.innerHTML, committedLocation);
      }}
    >
      <ChatPage />
    </Profiler>
  );
}

export function sessionMessagesPath(sessionId: string) {
  return `/api/sessions/${sessionId}/messages`;
}

export function sessionPromptPath(sessionId: string) {
  return `/api/sessions/${sessionId}/prompt`;
}

function authenticatedChatLifecycleRoutes(routes: FetchRoutes = {}): FetchRoutes {
  return {
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/auth/login": () => jsonResponse(secondPrincipal),
    ...routes,
  };
}

function trackRouter(router: { dispose(): void }) {
  disposeExtraRouter?.();
  disposeExtraRouter = () => {
    router.dispose();
    disposeExtraRouter = undefined;
  };
}

function mountAuthenticatedChatRouter(path: string, element: ReactElement) {
  setBrowserPath(path);
  const router = createBrowserRouter([
    {
      path: "/",
      element,
    },
  ]);
  trackRouter(router);
  const view = render(<RouterProvider router={router} />);
  return { router, view };
}

export function renderObservedChatPage(
  path: string,
  routes: FetchRoutes,
  onCommit: (html: string, location: string) => void,
) {
  const fetchMock = createFetchMock(authenticatedChatLifecycleRoutes(routes));
  resetFakeEventSources();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  const { router, view } = mountAuthenticatedChatRouter(
    path,
    <AuthProvider>
      <AuthGuard>
        <ObservedChatPage onCommit={onCommit} />
        <AuthFooter />
      </AuthGuard>
    </AuthProvider>,
  );
  return { fetchMock, router, view };
}

export function renderChatPageWithAuthProbe(path: string, routes: FetchRoutes) {
  let probe: ChatAuthProbe | undefined;
  const fetchMock = createFetchMock(authenticatedChatLifecycleRoutes(routes));
  resetFakeEventSources();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  const { router, view } = mountAuthenticatedChatRouter(
    path,
    <AuthProvider>
      <ChatAuthProbe onState={(state) => (probe = state)} />
      <AuthGuard>
        <ChatPage />
        <AuthFooter />
      </AuthGuard>
    </AuthProvider>,
  );
  return {
    fetchMock,
    router,
    view,
    getProbe() {
      if (!probe) {
        throw new Error("expected an authenticated chat probe");
      }
      return probe;
    },
  };
}

export async function renewAccount(getProbe: () => ChatAuthProbe) {
  await act(async () => {
    await expect(getProbe().login({ account: "lisi", password: "demo" })).resolves.toBe(true);
  });
}

export function typeDraft(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "给助手发消息" }), {
    target: { value: text },
  });
}

export function clickSend() {
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
}

export async function settleDeferredResponse(
  deferred: { resolve(response: Response): void },
  response: Response,
) {
  const { setImmediate } = await import("node:timers");
  await act(async () => {
    deferred.resolve(response);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
}

export function cleanupChatLifecycle() {
  disposeExtraRouter?.();
  disposeExtraRouter = undefined;
  cleanupChatPage();
}
